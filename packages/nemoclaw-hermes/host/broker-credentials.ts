// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/* global AbortSignal, fetch, URLSearchParams */

/**
 * Host credential authority for the Hermes managed-tool broker.
 *
 * Raw refresh credentials remain in process memory. Durable state contains
 * hashes and the transaction metadata required for rotation and clone recovery.
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { RuntimeRefreshCredentialStore } = require("./refresh-credentials.ts");
const {
  boundedControlDeadline,
  isValidActivationToken,
  isValidControlRequestId,
  isValidSandboxName,
  isValidProviderName,
  remainingControlTime,
} = require("./tool-contract.ts");

const STATE_DIR = process.env.HERMES_TOOL_GATEWAY_STATE_DIR;
const PORTAL_BASE_URL = (
  process.env.NOUS_PORTAL_BASE_URL || "https://portal.nousresearch.com"
).replace(/\/+$/, "");
const CLIENT_ID = process.env.HERMES_TOOL_GATEWAY_CLIENT_ID || "hermes-cli";
const OPENSHELL_BIN = process.env.NEMOCLAW_OPENSHELL_BIN || "openshell";
const CREDENTIAL_ENV =
  process.env.HERMES_TOOL_GATEWAY_REFRESH_CREDENTIAL_ENV ||
  "NEMOCLAW_HERMES_TOOL_GATEWAY_REFRESH_TOKEN";
const HERMES_INFERENCE_PROVIDER_NAME =
  process.env.HERMES_INFERENCE_PROVIDER_NAME || "hermes-provider";
const HERMES_INFERENCE_CREDENTIAL_ENV =
  process.env.HERMES_INFERENCE_CREDENTIAL_ENV || "OPENAI_API_KEY";
function readPositiveIntEnv(name, fallback, min) {
  const parsed = parseInt(process.env[name] || String(fallback), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, parsed);
}

const AGENT_KEY_MIN_TTL_SECONDS = readPositiveIntEnv(
  "HERMES_INFERENCE_AGENT_KEY_MIN_TTL_SECONDS",
  1800,
  300,
);
const AGENT_KEY_REFRESH_INTERVAL_MS = readPositiveIntEnv(
  "HERMES_INFERENCE_AGENT_KEY_REFRESH_INTERVAL_MS",
  600000,
  60_000,
);
const UPSTREAM_REQUEST_TIMEOUT_MS = readPositiveIntEnv(
  "HERMES_TOOL_GATEWAY_UPSTREAM_TIMEOUT_MS",
  60_000,
  1000,
);
const STAGED_CLONE_BINDING_TTL_MS = 5 * 60 * 1000;
const DEFAULT_INFERENCE_BASE_URL = "https://inference-api.nousresearch.com/v1";
const TRUSTED_INFERENCE_BASE_URLS = new Set([DEFAULT_INFERENCE_BASE_URL]);

if (!STATE_DIR) {
  console.error("HERMES_TOOL_GATEWAY_STATE_DIR required");
  process.exit(1);
}
const accessTokenCache = new Map();
const stagedCloneBindings = new Map();
const stagedCloneRequests = new Map();

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

const runtimeRefreshCredentials = new RuntimeRefreshCredentialStore(sha256);
function stateFiles() {
  try {
    return fs
      .readdirSync(STATE_DIR)
      .filter((name) => name.endsWith(".json"))
      .map((name) => path.join(STATE_DIR, name));
  } catch {
    return [];
  }
}

function loadStateFile(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!parsed || typeof parsed !== "object") return null;
    if (!parsed.refresh_token_sha256 || !parsed.provider_name) return null;
    return { file, state: parsed };
  } catch {
    return null;
  }
}

function loadStateForSandbox(sandboxName) {
  const sandbox = String(sandboxName || "").trim();
  if (!isValidSandboxName(sandbox)) return null;
  return loadStateFile(path.join(STATE_DIR, `${sandbox}.json`));
}

function findStateByRefreshToken(refreshToken) {
  const digest = sha256(refreshToken);
  for (const file of stateFiles()) {
    const loaded = loadStateFile(file);
    if (!loaded) continue;
    if (timingSafeEqualString(String(loaded.state.refresh_token_sha256 || ""), digest)) {
      return loaded;
    }
  }
  return null;
}

function findStateByBrokerToken(brokerToken) {
  const digest = sha256(brokerToken);
  for (const file of stateFiles()) {
    const loaded = loadStateFile(file);
    if (!loaded) continue;
    const brokerTokenHash = loaded.state.broker_token_sha256;
    if (!brokerTokenHash) continue;
    if (timingSafeEqualString(String(brokerTokenHash), digest)) {
      return loaded;
    }
  }
  return null;
}

function findCredentialState(token) {
  const brokerMatch = findStateByBrokerToken(token);
  if (brokerMatch) return { loaded: brokerMatch, kind: "broker" };
  const refreshMatch = findStateByRefreshToken(token);
  if (refreshMatch) return { loaded: refreshMatch, kind: "refresh" };
  return null;
}

function timingSafeEqualString(a, b) {
  const aBuf = Buffer.from(String(a || ""));
  const bBuf = Buffer.from(String(b || ""));
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

function resolveRuntimeRefreshToken(loaded) {
  return runtimeRefreshCredentials.resolve(loaded?.state);
}

function registerInitialRuntimeRefreshCredential() {
  const refreshToken = String(process.env[CREDENTIAL_ENV] || "").trim();
  if (!refreshToken) return;
  const exactSandbox = String(process.env.HERMES_TOOL_GATEWAY_INITIAL_SANDBOX || "").trim();
  const digest = sha256(refreshToken);
  for (const file of stateFiles()) {
    const loaded = loadStateFile(file);
    if (
      loaded &&
      (!exactSandbox || loaded.state.sandbox === exactSandbox) &&
      timingSafeEqualString(String(loaded.state.refresh_token_sha256 || ""), digest)
    ) {
      runtimeRefreshCredentials.register(loaded.state, refreshToken);
    }
  }
  delete process.env[CREDENTIAL_ENV];
  delete process.env.HERMES_TOOL_GATEWAY_INITIAL_SANDBOX;
}

function tokenExpiresSoon(cacheEntry) {
  if (!cacheEntry?.expiresAt) return true;
  return cacheEntry.expiresAt - Date.now() < 120_000;
}

function timestampExpiresSoon(isoTimestamp, skewMs = 300_000) {
  if (typeof isoTimestamp !== "string" || !isoTimestamp.trim()) return true;
  const ms = Date.parse(isoTimestamp);
  if (!Number.isFinite(ms)) return true;
  return ms - Date.now() < skewMs;
}

function atomicWriteJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${Date.now()}.${Math.random()
      .toString(36)
      .slice(2)}.tmp`,
  );
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
}

function updateOpenshellRefreshProvider(state) {
  const providerName = String(state.provider_name || "");
  if (!providerName) return;
  const providerCredential =
    typeof state.broker_token === "string" ? state.broker_token.trim() : "";
  if (!providerCredential) {
    throw Object.assign(new Error("broker_credential_unavailable"), {
      code: "broker_credential_unavailable",
    });
  }
  const result = spawnSync(
    OPENSHELL_BIN,
    ["provider", "update", providerName, "--credential", CREDENTIAL_ENV],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, [CREDENTIAL_ENV]: providerCredential },
      timeout: 30_000,
    },
  );
  if (result.status !== 0) {
    throw Object.assign(new Error("openshell_provider_update_failed"), {
      code: "openshell_provider_update_failed",
    });
  }
}

function operationTimeout(deadlineAtMs, capMs = UPSTREAM_REQUEST_TIMEOUT_MS) {
  if (deadlineAtMs === undefined || deadlineAtMs === null) return capMs;
  const timeout = remainingControlTime(deadlineAtMs, capMs);
  if (timeout === 0) {
    throw Object.assign(new Error("clone_control_deadline_exceeded"), {
      code: "clone_control_deadline_exceeded",
    });
  }
  return timeout;
}

function updateOpenshellInferenceProvider(state, apiKey, baseUrl, deadlineAtMs = null) {
  const providerName = String(state.inference_provider_name || HERMES_INFERENCE_PROVIDER_NAME);
  const args = [
    "provider",
    "update",
    providerName,
    "--credential",
    HERMES_INFERENCE_CREDENTIAL_ENV,
  ];
  if (typeof baseUrl === "string" && baseUrl.trim()) {
    args.push("--config", `OPENAI_BASE_URL=${baseUrl.trim()}`);
  }
  const result = spawnSync(OPENSHELL_BIN, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, [HERMES_INFERENCE_CREDENTIAL_ENV]: apiKey },
    timeout: operationTimeout(deadlineAtMs, 30_000),
  });
  if (result.status !== 0) {
    throw Object.assign(new Error("openshell_inference_provider_update_failed"), {
      code: "openshell_inference_provider_update_failed",
    });
  }
}

async function refreshAccessToken(refreshToken, loaded, deadlineAtMs = null) {
  const digest = sha256(refreshToken);
  const cached = accessTokenCache.get(digest);
  if (cached?.accessToken && !tokenExpiresSoon(cached)) {
    return cached.accessToken;
  }

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: loaded.state.client_id || CLIENT_ID,
  });
  const resp = await fetch(`${PORTAL_BASE_URL}/api/oauth/token`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
      "x-nous-refresh-token": refreshToken,
    },
    body,
    signal: AbortSignal.timeout(operationTimeout(deadlineAtMs)),
  });

  if (!resp.ok) {
    const code = resp.status === 400 || resp.status === 401 ? "reauth_required" : "refresh_failed";
    throw Object.assign(new Error(`refresh_failed_http_${resp.status}`), { code });
  }

  const payload = await resp.json();
  if (!payload?.access_token) {
    throw Object.assign(new Error("token_response_missing_access_token"), {
      code: "refresh_failed",
    });
  }

  const expiresIn =
    typeof payload.expires_in === "number" && Number.isFinite(payload.expires_in)
      ? payload.expires_in
      : 900;
  const nextRefreshToken =
    typeof payload.refresh_token === "string" && payload.refresh_token
      ? payload.refresh_token
      : refreshToken;
  const nextDigest = sha256(nextRefreshToken);
  accessTokenCache.delete(digest);
  accessTokenCache.set(nextDigest, {
    accessToken: payload.access_token,
    expiresAt: Date.now() + expiresIn * 1000,
  });

  if (nextDigest !== digest) {
    updateOpenshellRefreshProvider(loaded.state);
    const nextState = {
      ...loaded.state,
      refresh_token_sha256: nextDigest,
      rotated_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    atomicWriteJson(loaded.file, nextState);
    loaded.state = nextState;
    runtimeRefreshCredentials.rotate(nextState, nextRefreshToken);
  }

  return payload.access_token;
}

function agentKeyExpiresAt() {
  return new Date(Date.now() + AGENT_KEY_MIN_TTL_SECONDS * 1000).toISOString();
}

function stageRequestMatches(request, sandbox, refreshToken, inferenceProviderName) {
  return (
    request.sandbox === sandbox &&
    request.original_refresh_token_sha256 === sha256(refreshToken) &&
    request.inference_provider_name === inferenceProviderName
  );
}

async function stageCloneBinding(
  sandbox,
  refreshToken,
  inferenceProviderName,
  requestId,
  deadlineAtMs,
) {
  if (!isValidSandboxName(sandbox)) {
    throw Object.assign(new Error("invalid_stage_sandbox"), { code: "invalid_stage_sandbox" });
  }
  if (!isValidProviderName(inferenceProviderName)) {
    throw Object.assign(new Error("invalid_stage_provider"), { code: "invalid_stage_provider" });
  }
  if (!isValidControlRequestId(requestId)) {
    throw Object.assign(new Error("invalid_stage_request_id"), {
      code: "invalid_stage_request_id",
    });
  }
  const boundedDeadline = boundedControlDeadline(deadlineAtMs);
  if (boundedDeadline === null) {
    throw Object.assign(new Error("invalid_stage_deadline"), { code: "invalid_stage_deadline" });
  }
  const existing = stagedCloneRequests.get(requestId);
  if (existing) {
    if (!stageRequestMatches(existing, sandbox, refreshToken, inferenceProviderName)) {
      throw Object.assign(new Error("stage_request_identity_mismatch"), {
        code: "stage_request_identity_mismatch",
      });
    }
    if (existing.state === "discarded") {
      throw Object.assign(new Error("stage_request_already_discarded"), {
        code: "stage_request_already_discarded",
      });
    }
    if (existing.state === "pending") return existing.promise;
    return {
      activationToken: existing.activation_token,
      brokerToken: existing.broker_token,
      state: existing.state,
    };
  }

  const request = {
    request_id: requestId,
    sandbox,
    original_refresh_token_sha256: sha256(refreshToken),
    inference_provider_name: inferenceProviderName,
    expires_at_ms: Date.now() + STAGED_CLONE_BINDING_TTL_MS,
    state: "pending",
    promise: null,
  };
  const operation = (async () => {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: CLIENT_ID,
    });
    const refreshResponse = await fetch(`${PORTAL_BASE_URL}/api/oauth/token`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
        "x-nous-refresh-token": refreshToken,
      },
      body,
      signal: AbortSignal.timeout(operationTimeout(boundedDeadline)),
    });
    if (!refreshResponse.ok) {
      const code =
        refreshResponse.status === 400 || refreshResponse.status === 401
          ? "reauth_required"
          : "refresh_failed";
      throw Object.assign(new Error(`refresh_failed_http_${refreshResponse.status}`), { code });
    }
    const refreshed = await refreshResponse.json();
    if (!refreshed?.access_token) {
      throw Object.assign(new Error("token_response_missing_access_token"), {
        code: "refresh_failed",
      });
    }
    const nextRefreshToken =
      typeof refreshed.refresh_token === "string" && refreshed.refresh_token
        ? refreshed.refresh_token
        : refreshToken;
    const agentKey = await mintAgentKey(refreshed.access_token, boundedDeadline);
    const activationToken = `nc_activate_${crypto.randomBytes(32).toString("base64url")}`;
    const brokerToken = `nc_broker_${crypto.randomBytes(32).toString("base64url")}`;
    const runtime_credential_state = {
      sandbox: `staged:${activationToken}`,
      refresh_token_sha256: sha256(nextRefreshToken),
    };
    if (!runtimeRefreshCredentials.register(runtime_credential_state, nextRefreshToken)) {
      throw Object.assign(new Error("staged_runtime_registration_failed"), {
        code: "staged_runtime_registration_failed",
      });
    }
    Object.assign(request, {
      state: "staged",
      activation_token: activationToken,
      broker_token: brokerToken,
      runtime_credential_state,
      inference_api_key: agentKey.api_key,
      inference_base_url: trustedInferenceBaseUrl(agentKey.inference_base_url),
      inference_agent_key_expires_at: agentKeyExpiresAt(),
    });
    stagedCloneBindings.set(activationToken, request);
    const expiryTimer = setTimeout(() => {
      if (request.state === "staged") discardStagedCloneBinding(activationToken);
      stagedCloneBindings.delete(activationToken);
      stagedCloneRequests.delete(requestId);
    }, STAGED_CLONE_BINDING_TTL_MS);
    expiryTimer.unref?.();
    return { activationToken, brokerToken, state: request.state };
  })();
  request.promise = operation;
  stagedCloneRequests.set(requestId, request);
  try {
    return await operation;
  } catch (error) {
    if (stagedCloneRequests.get(requestId) === request) stagedCloneRequests.delete(requestId);
    throw error;
  }
}

function stagedCloneBinding(activationToken, sandbox) {
  const staged = stagedCloneBindings.get(activationToken);
  if (
    !staged ||
    staged.sandbox !== sandbox ||
    staged.state !== "staged" ||
    staged.expires_at_ms <= Date.now()
  ) {
    if (staged?.state === "staged") discardStagedCloneBinding(activationToken);
    return null;
  }
  return staged;
}

function discardStagedCloneBinding(activationToken) {
  const staged = stagedCloneBindings.get(activationToken);
  if (!staged) return false;
  if (staged.state === "discarded") return true;
  if (staged.state === "activated") return false;
  if (staged?.runtime_credential_state?.sandbox) {
    runtimeRefreshCredentials.unregister(staged.runtime_credential_state.sandbox);
  }
  staged.state = "discarded";
  return true;
}

function activateStagedCloneBinding(sandbox, activationToken, deadlineAtMs) {
  const known = stagedCloneBindings.get(activationToken);
  if (known?.sandbox === sandbox && known.state === "activated") return true;
  const staged = stagedCloneBinding(activationToken, sandbox);
  const loaded = loadStateForSandbox(sandbox);
  const stagedRefreshToken = runtimeRefreshCredentials.resolve(staged?.runtime_credential_state);
  if (
    !staged ||
    !stagedRefreshToken ||
    !loaded ||
    loaded.state.refresh_token_sha256 !== staged.original_refresh_token_sha256 ||
    loaded.state.broker_token !== staged.broker_token ||
    loaded.state.inference_provider_name !== staged.inference_provider_name
  ) {
    throw Object.assign(new Error("staged_binding_mismatch"), {
      code: "staged_binding_mismatch",
    });
  }
  const nextState = {
    ...loaded.state,
    refresh_token_sha256: sha256(stagedRefreshToken),
    inference_credential_env: HERMES_INFERENCE_CREDENTIAL_ENV,
    inference_base_url: staged.inference_base_url,
    inference_agent_key_expires_at: staged.inference_agent_key_expires_at,
    inference_agent_key_rotated_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  const restoreRuntimeCredential = runtimeRefreshCredentials.replace(nextState, stagedRefreshToken);
  if (!restoreRuntimeCredential) {
    throw Object.assign(new Error("staged_runtime_registration_failed"), {
      code: "staged_runtime_registration_failed",
    });
  }
  try {
    updateOpenshellInferenceProvider(
      loaded.state,
      staged.inference_api_key,
      staged.inference_base_url,
      deadlineAtMs,
    );
    atomicWriteJson(loaded.file, nextState);
    loaded.state = nextState;
  } catch (error) {
    restoreRuntimeCredential();
    throw error;
  }
  runtimeRefreshCredentials.unregister(staged.runtime_credential_state.sandbox);
  staged.state = "activated";
  return true;
}

function cloneBindingStatus(requestId, activationToken) {
  const request = isValidControlRequestId(requestId)
    ? stagedCloneRequests.get(requestId)
    : isValidActivationToken(activationToken)
      ? stagedCloneBindings.get(activationToken)
      : null;
  if (!request) return null;
  return {
    request_id: request.request_id,
    activation_token: request.activation_token,
    broker_token: request.broker_token,
    state: request.state,
  };
}

function trustedInferenceBaseUrl(value) {
  const normalized = String(value || "")
    .trim()
    .replace(/\/+$/, "");
  for (const candidate of TRUSTED_INFERENCE_BASE_URLS) {
    if (normalized === candidate) return candidate;
  }
  return DEFAULT_INFERENCE_BASE_URL;
}

async function mintAgentKey(accessToken, deadlineAtMs = null) {
  const resp = await fetch(`${PORTAL_BASE_URL}/api/oauth/agent-key`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ min_ttl_seconds: AGENT_KEY_MIN_TTL_SECONDS }),
    signal: AbortSignal.timeout(operationTimeout(deadlineAtMs)),
  });
  if (!resp.ok) {
    const code =
      resp.status === 400 || resp.status === 401 ? "reauth_required" : "agent_key_failed";
    throw Object.assign(new Error(`agent_key_failed_http_${resp.status}`), { code });
  }
  const payload = await resp.json();
  if (!payload?.api_key) {
    throw Object.assign(new Error("agent_key_response_missing_api_key"), {
      code: "agent_key_failed",
    });
  }
  return payload;
}

async function ensureInferenceAgentKey(loaded, refreshToken, options = {}) {
  if (!options.force && !timestampExpiresSoon(loaded?.state?.inference_agent_key_expires_at)) {
    return false;
  }
  const accessToken = await refreshAccessToken(refreshToken, loaded);
  const agentKey = await mintAgentKey(accessToken);
  const inferenceBaseUrl = trustedInferenceBaseUrl(agentKey.inference_base_url);
  updateOpenshellInferenceProvider(loaded.state, agentKey.api_key, inferenceBaseUrl);
  const nextState = {
    ...loaded.state,
    inference_provider_name: loaded.state.inference_provider_name || HERMES_INFERENCE_PROVIDER_NAME,
    inference_credential_env: HERMES_INFERENCE_CREDENTIAL_ENV,
    inference_base_url: inferenceBaseUrl,
    inference_agent_key_expires_at: agentKeyExpiresAt(),
    inference_agent_key_rotated_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  atomicWriteJson(loaded.file, nextState);
  loaded.state = nextState;
  return true;
}

async function refreshManagedInferenceForRuntimeCredentials(options = {}) {
  for (const file of stateFiles()) {
    const loaded = loadStateFile(file);
    if (!loaded) continue;
    const refreshToken = resolveRuntimeRefreshToken(loaded);
    if (!refreshToken) continue;
    try {
      await ensureInferenceAgentKey(loaded, refreshToken, options);
    } catch (err) {
      const code = errorCode(err) || "agent_key_refresh_failed";
      console.error(`Hermes inference provider refresh failed: ${code}`);
    }
  }
}
function errorCode(err) {
  return err && typeof err === "object" && typeof err.code === "string" ? err.code : null;
}

async function registerRuntimeRefreshCredential(sandbox, refreshToken) {
  const loaded = loadStateForSandbox(sandbox);
  const restoreRuntimeCredential = loaded
    ? runtimeRefreshCredentials.replace(loaded.state, refreshToken)
    : null;
  if (!loaded || !restoreRuntimeCredential) return false;
  try {
    await ensureInferenceAgentKey(loaded, refreshToken);
  } catch (error) {
    restoreRuntimeCredential();
    throw error;
  }
  return true;
}

function unregisterRuntimeRefreshCredential(sandbox) {
  runtimeRefreshCredentials.unregister(sandbox);
}

module.exports = {
  AGENT_KEY_REFRESH_INTERVAL_MS,
  UPSTREAM_REQUEST_TIMEOUT_MS,
  activateStagedCloneBinding,
  cloneBindingStatus,
  discardStagedCloneBinding,
  ensureInferenceAgentKey,
  errorCode,
  findCredentialState,
  refreshAccessToken,
  refreshManagedInferenceForRuntimeCredentials,
  registerInitialRuntimeRefreshCredential,
  registerRuntimeRefreshCredential,
  resolveRuntimeRefreshToken,
  stageCloneBinding,
  stagedCloneBinding,
  unregisterRuntimeRefreshCredential,
};
