#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const { spawn, spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

type HarnessProviderBrokerControllerRequest =
  import("@nvidia/nemoclaw-harness-contract").HarnessProviderBrokerControllerRequest;
type HarnessProviderBrokerControllerResult =
  import("@nvidia/nemoclaw-harness-contract").HarnessProviderBrokerControllerResult;

const PORT = 11436;
const CREDENTIAL_ENV = "NEMOCLAW_HERMES_TOOL_GATEWAY_REFRESH_TOKEN";
const INPUT_LIMIT = 256 * 1024;
const OUTPUT_LIMIT = 256 * 1024;
const SCRIPT = path.join(__dirname, "tool-broker.ts");
const MATRIX = path.join(__dirname, "tool-matrix.json");
const stateRoot = path.join(process.env.HOME || os.homedir(), ".nemoclaw");
const brokerStateDir = path.join(stateRoot, "hermes-tool-gateway");
const pidPath = path.join(stateRoot, "hermes-tool-gateway-broker.pid");
const hashPath = path.join(stateRoot, "hermes-tool-gateway-broker.hash");
const socketPath = path.join(stateRoot, "hermes-tool-gateway-broker.sock");

function privateDirectory(directory: string): void {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
}

function validSandboxName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 19 &&
    /^(?!.*--)[a-z](?:[a-z0-9-]*[a-z0-9])?$/u.test(value)
  );
}

function providerName(sandboxName: string): string {
  return `${sandboxName}-hermes-tool-gateway`;
}

function sha256(value: string | Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function atomicJson(file: string, value: Record<string, unknown>): void {
  privateDirectory(path.dirname(file));
  const temporary = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${String(process.pid)}.tmp`,
  );
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
  fs.chmodSync(file, 0o600);
}

function statePath(sandboxName: string): string {
  privateDirectory(brokerStateDir);
  return path.join(brokerStateDir, `${sandboxName}.json`);
}

function registerRefreshProvider(
  request: Extract<
    HarnessProviderBrokerControllerRequest,
    { operation: "register-refresh-provider" }
  >,
): HarnessProviderBrokerControllerResult {
  const token = request.refreshToken.trim();
  if (!token) return { ok: false, message: "provider-broker refresh credential is empty" };
  const file = statePath(request.sandboxName);
  const previous = readJson(file);
  const previousToken = typeof previous?.broker_token === "string" ? previous.broker_token : "";
  const brokerToken = previousToken || `nc_broker_${crypto.randomBytes(32).toString("base64url")}`;
  atomicJson(file, {
    version: 1,
    sandbox: request.sandboxName,
    provider_name: providerName(request.sandboxName),
    inference_provider_name: `${request.sandboxName}-hermes-inference`,
    inference_credential_env: "OPENAI_API_KEY",
    credential_env: CREDENTIAL_ENV,
    broker_token: brokerToken,
    broker_token_sha256: sha256(brokerToken),
    refresh_token_sha256: sha256(token),
    updated_at: new Date().toISOString(),
  });
  return {
    ok: true,
    providerName: providerName(request.sandboxName),
    credentialEnv: CREDENTIAL_ENV,
    credentialValue: brokerToken,
  };
}

function runtimeHash(): string {
  return sha256(
    [SCRIPT, MATRIX, "broker-credentials.ts", "clone-control.ts", "request-proxy.ts"]
      .map((file) => {
        const resolved = path.isAbsolute(file) ? file : path.join(__dirname, file);
        return `${path.basename(resolved)}:${sha256(fs.readFileSync(resolved))}`;
      })
      .join("\0"),
  );
}

function readPid(): number | null {
  try {
    const pid = Number.parseInt(fs.readFileSync(pidPath, "utf8").trim(), 10);
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function isOwnedProcess(pid: number | null): boolean {
  if (!pid) return false;
  const processResult = spawnSync("ps", ["-p", String(pid), "-o", "args="], {
    encoding: "utf8",
    timeout: 2_000,
  });
  return processResult.status === 0 && processResult.stdout.includes(SCRIPT);
}

type BrokerListenerInspection =
  | { readonly kind: "absent" }
  | { readonly kind: "indeterminate" }
  | { readonly kind: "present"; readonly pids: readonly number[] };

function inspectBrokerListener(): BrokerListenerInspection {
  const result = spawnSync("lsof", ["-ti", `:${String(PORT)}`, "-sTCP:LISTEN"], {
    encoding: "utf8",
    timeout: 2_000,
  });
  if (result.error || result.signal) return { kind: "indeterminate" };
  const output = typeof result.stdout === "string" ? result.stdout.trim() : "";
  if (result.status === 1 && !output) return { kind: "absent" };
  if (result.status !== 0) return { kind: "indeterminate" };
  const pids = output
    .split(/\r?\n/u)
    .map((value) => Number.parseInt(value, 10))
    .filter((value) => Number.isSafeInteger(value) && value > 0);
  return pids.length > 0 ? { kind: "present", pids } : { kind: "indeterminate" };
}

function isOwnedHealthy(pid: number | null): boolean {
  if (!isOwnedProcess(pid)) return false;
  const health = spawnSync(
    "curl",
    ["-sf", "--connect-timeout", "2", "--max-time", "3", `http://127.0.0.1:${String(PORT)}/health`],
    {
      stdio: "ignore",
      timeout: 4_000,
    },
  );
  if (health.status !== 0) return false;
  const listener = inspectBrokerListener();
  return listener.kind === "present" && listener.pids.includes(pid!);
}

function registerWithRunningBroker(sandboxName: string, refreshToken: string): boolean {
  if (!fs.existsSync(socketPath)) return false;
  const result = spawnSync(
    "curl",
    [
      "-sf",
      "--unix-socket",
      socketPath,
      "-H",
      "Content-Type: application/json",
      "-d",
      "@-",
      "http://localhost/credentials/register",
    ],
    {
      input: JSON.stringify({ sandbox: sandboxName, refresh_token: refreshToken }),
      stdio: ["pipe", "ignore", "ignore"],
      timeout: 8_000,
    },
  );
  return result.status === 0;
}

function requestBrokerControl(
  route: "inspect" | "unregister",
  sandboxName: string,
): Record<string, unknown> | null {
  if (!fs.existsSync(socketPath)) return null;
  const result = spawnSync(
    "curl",
    [
      "-sf",
      "--unix-socket",
      socketPath,
      "-H",
      "Content-Type: application/json",
      "-d",
      "@-",
      `http://localhost/credentials/${route}`,
    ],
    {
      encoding: "utf8",
      input: JSON.stringify({ sandbox: sandboxName }),
      maxBuffer: 16 * 1024,
      stdio: ["pipe", "pipe", "ignore"],
      timeout: 8_000,
    },
  );
  if (result.status !== 0 || typeof result.stdout !== "string") return null;
  try {
    const response: unknown = JSON.parse(result.stdout);
    return response && typeof response === "object" && !Array.isArray(response)
      ? (response as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function unregisterFromRunningBroker(sandboxName: string): boolean {
  return requestBrokerControl("unregister", sandboxName)?.ok === true;
}

function inspectRunningBrokerCredential(sandboxName: string): boolean | null {
  const result = requestBrokerControl("inspect", sandboxName);
  return result?.ok === true && typeof result.registered === "boolean" ? result.registered : null;
}

function processExists(pid: number): boolean {
  const result = spawnSync("kill", ["-0", String(pid)], { stdio: "ignore", timeout: 2_000 });
  return result.status === 0;
}

function clearRuntimeState(): boolean {
  const pid = readPid();
  if (pid && processExists(pid)) {
    if (!isOwnedProcess(pid)) return false;
    const stopped = spawnSync("kill", [String(pid)], { stdio: "ignore", timeout: 2_000 });
    if (stopped.status !== 0) return false;
    for (let attempt = 0; attempt < 20 && processExists(pid); attempt += 1) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
    if (processExists(pid)) return false;
  }
  for (const file of [pidPath, hashPath, socketPath]) {
    try {
      fs.unlinkSync(file);
    } catch {
      /* absent */
    }
  }
  return [pidPath, hashPath, socketPath].every((file) => !fs.existsSync(file));
}

function ensureBroker(
  request: Extract<HarnessProviderBrokerControllerRequest, { operation: "ensure-broker" }>,
): HarnessProviderBrokerControllerResult {
  const refreshToken = request.refreshToken.trim();
  if (!refreshToken) return { ok: false, message: "provider-broker refresh credential is empty" };
  const desiredHash = runtimeHash();
  const pid = readPid();
  let existingHash = "";
  try {
    existingHash = fs.readFileSync(hashPath, "utf8").trim();
  } catch {
    /* absent */
  }
  if (isOwnedHealthy(pid)) {
    if (existingHash !== desiredHash) {
      return { ok: false, message: "provider-broker runtime changed while its process is active" };
    }
    return registerWithRunningBroker(request.sandboxName, refreshToken)
      ? { ok: true, providerName: providerName(request.sandboxName) }
      : { ok: false, message: "provider-broker rejected the refresh credential" };
  }
  if (!clearRuntimeState()) {
    return { ok: false, message: "provider-broker stale process ownership could not be proven" };
  }
  privateDirectory(stateRoot);
  const child = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", SCRIPT], {
    cwd: path.dirname(__dirname),
    detached: true,
    stdio: "ignore",
    env: {
      HOME: process.env.HOME || os.homedir(),
      PATH: process.env.PATH || "",
      HERMES_TOOL_GATEWAY_PORT: String(PORT),
      HERMES_TOOL_GATEWAY_STATE_DIR: brokerStateDir,
      HERMES_TOOL_GATEWAY_MATRIX_PATH: MATRIX,
      HERMES_TOOL_GATEWAY_CONTROL_SOCKET: socketPath,
      HERMES_TOOL_GATEWAY_INITIAL_SANDBOX: request.sandboxName,
      HERMES_TOOL_GATEWAY_REFRESH_CREDENTIAL_ENV: CREDENTIAL_ENV,
      [CREDENTIAL_ENV]: refreshToken,
      NEMOCLAW_OPENSHELL_BIN: process.env.NEMOCLAW_OPENSHELL_BIN || "openshell",
      NOUS_PORTAL_BASE_URL: process.env.NOUS_PORTAL_BASE_URL || "https://portal.nousresearch.com",
    },
  });
  child.unref();
  if (!child.pid) return { ok: false, message: "provider-broker process did not start" };
  fs.writeFileSync(pidPath, `${String(child.pid)}\n`, { mode: 0o600 });
  fs.writeFileSync(hashPath, `${desiredHash}\n`, { mode: 0o600 });
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (isOwnedHealthy(child.pid)) {
      return { ok: true, providerName: providerName(request.sandboxName) };
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  }
  return { ok: false, message: "provider-broker process did not become ready" };
}

function brokerSandboxStateFiles(): string[] {
  try {
    return fs
      .readdirSync(brokerStateDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function inspectBroker(
  request: Extract<HarnessProviderBrokerControllerRequest, { operation: "inspect-broker" }>,
): HarnessProviderBrokerControllerResult {
  const file = path.join(brokerStateDir, `${request.sandboxName}.json`);
  const state = readJson(file);
  if (!fs.existsSync(file)) {
    return {
      ok: true,
      providerName: providerName(request.sandboxName),
      brokerReady: false,
      sandboxRegistered: false,
    };
  }
  if (
    !state ||
    state.sandbox !== request.sandboxName ||
    state.provider_name !== providerName(request.sandboxName)
  ) {
    return { ok: false, message: "provider-broker sandbox state could not be validated" };
  }
  const pid = readPid();
  if (!pid || !isOwnedHealthy(pid)) {
    return {
      ok: true,
      providerName: providerName(request.sandboxName),
      brokerReady: false,
      sandboxRegistered: false,
    };
  }
  const sandboxRegistered = inspectRunningBrokerCredential(request.sandboxName);
  if (sandboxRegistered === null) {
    return { ok: false, message: "provider-broker credential readiness could not be inspected" };
  }
  return {
    ok: true,
    providerName: providerName(request.sandboxName),
    brokerReady: true,
    sandboxRegistered,
  };
}

function teardownBroker(
  request: Extract<HarnessProviderBrokerControllerRequest, { operation: "teardown-broker" }>,
): HarnessProviderBrokerControllerResult {
  const file = path.join(brokerStateDir, `${request.sandboxName}.json`);
  const state = readJson(file);
  if (fs.existsSync(file) && !state) {
    return { ok: false, message: "provider-broker sandbox state could not be validated" };
  }
  if (
    state &&
    (state.sandbox !== request.sandboxName ||
      state.provider_name !== providerName(request.sandboxName))
  ) {
    return { ok: false, message: "provider-broker sandbox state ownership changed" };
  }
  const remaining = brokerSandboxStateFiles().filter(
    (entry) => entry !== `${request.sandboxName}.json`,
  );
  const pid = readPid();
  if (remaining.length > 0) {
    if (!pid || !isOwnedHealthy(pid)) {
      return { ok: false, message: "provider-broker shared process ownership could not be proven" };
    }
    if (!unregisterFromRunningBroker(request.sandboxName)) {
      return { ok: false, message: "provider-broker shared credential teardown was not confirmed" };
    }
  } else {
    const runtimeEvidence = [pidPath, hashPath, socketPath].some((path) => fs.existsSync(path));
    const listener = inspectBrokerListener();
    if ((runtimeEvidence || listener.kind !== "absent") && (!pid || !isOwnedHealthy(pid))) {
      return { ok: false, message: "provider-broker process ownership could not be proven" };
    }
  }
  if (state) fs.unlinkSync(file);
  if (remaining.length === 0) {
    if (!clearRuntimeState()) {
      return { ok: false, message: "provider-broker process did not stop cleanly" };
    }
    try {
      fs.rmdirSync(brokerStateDir);
    } catch {
      /* non-empty or already absent */
    }
    if (
      fs.existsSync(file) ||
      fs.existsSync(pidPath) ||
      fs.existsSync(hashPath) ||
      fs.existsSync(socketPath)
    ) {
      return { ok: false, message: "provider-broker cleanup residue remains" };
    }
  }
  return {
    ok: true,
    providerName: providerName(request.sandboxName),
    teardownComplete: true,
  };
}

function parseRequest(input: string): HarnessProviderBrokerControllerRequest {
  if (Buffer.byteLength(input, "utf8") > INPUT_LIMIT) throw new Error("input exceeds boundary");
  const request: unknown = JSON.parse(input);
  if (!request || typeof request !== "object" || Array.isArray(request))
    throw new Error("invalid request");
  const value = request as Record<string, unknown>;
  if (!validSandboxName(value.sandboxName)) throw new Error("invalid request");
  if (value.operation === "inspect-broker" || value.operation === "teardown-broker") {
    if (value.refreshToken !== undefined) throw new Error("invalid request");
    return value as unknown as HarnessProviderBrokerControllerRequest;
  }
  if (
    (value.operation !== "register-refresh-provider" && value.operation !== "ensure-broker") ||
    typeof value.refreshToken !== "string" ||
    value.refreshToken.length === 0 ||
    Buffer.byteLength(value.refreshToken, "utf8") > 128 * 1024
  )
    throw new Error("invalid request");
  return value as unknown as HarnessProviderBrokerControllerRequest;
}

function writeResult(result: HarnessProviderBrokerControllerResult): void {
  const output = JSON.stringify(result);
  if (Buffer.byteLength(output, "utf8") > OUTPUT_LIMIT) throw new Error("output exceeds boundary");
  process.stdout.write(output);
}

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  input += chunk;
  if (Buffer.byteLength(input, "utf8") > INPUT_LIMIT) process.stdin.destroy();
});
process.stdin.on("end", () => {
  try {
    const request = parseRequest(input);
    writeResult(
      request.operation === "register-refresh-provider"
        ? registerRefreshProvider(request)
        : request.operation === "ensure-broker"
          ? ensureBroker(request)
          : request.operation === "inspect-broker"
            ? inspectBroker(request)
            : teardownBroker(request),
    );
  } catch {
    writeResult({ ok: false, message: "provider-broker controller rejected its request" });
  }
});
