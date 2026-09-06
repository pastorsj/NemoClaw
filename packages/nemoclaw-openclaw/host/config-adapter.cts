// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
"use strict";
const CONFIG_DIRECTORY = "/sandbox/.openclaw";
const CONFIG_FILE = "openclaw.json";
const CONFIG_GUARD = "/usr/local/lib/nemoclaw/openclaw-config-guard.py";
const CONFIG_NORMALIZER = "/usr/local/lib/nemoclaw/normalize_mutable_config_perms.py";
const MAX_CONFIG_BYTES = 16 * 1024 * 1024;
const UPSTREAM_PROVIDER_HEADER = "X-NemoClaw-Upstream-Provider";
const DEFAULT_ANTHROPIC_MAX_TOKENS = 4096;
function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}
function requireTarget(target) {
  if (
    target.directory !== CONFIG_DIRECTORY ||
    target.file !== CONFIG_FILE ||
    target.format !== "json"
  ) {
    throw new Error("OpenClaw configuration target does not match its package manifest");
  }
}
function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function cloneConfig(config) {
  return JSON.parse(JSON.stringify(config));
}
function cloneObject(value) {
  return isObject(value) ? { ...value } : {};
}
function ensureObject(parent, key) {
  const existing = parent[key];
  if (isObject(existing)) return existing;
  const created = {};
  parent[key] = created;
  return created;
}
function updatePrimaryModel(config, primaryModelRef) {
  const agents = ensureObject(config, "agents");
  const defaults = ensureObject(agents, "defaults");
  ensureObject(defaults, "model").primary = primaryModelRef;
  if (!Array.isArray(agents.list)) return;
  let defaultAgent;
  for (const entry of agents.list) {
    if (!isObject(entry)) continue;
    if (entry.id === "main") {
      if (typeof entry.model === "string") entry.model = primaryModelRef;
      return;
    }
    if (!defaultAgent && entry.default === true) defaultAgent = entry;
  }
  if (defaultAgent && typeof defaultAgent.model === "string") {
    defaultAgent.model = primaryModelRef;
  }
}
function positiveReplyBudget(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}
function readPrimaryReplyBudget(config) {
  const agents = isObject(config.agents) ? config.agents : null;
  const defaults = agents && isObject(agents.defaults) ? agents.defaults : null;
  const selectedModel = defaults && isObject(defaults.model) ? defaults.model : null;
  const primary = selectedModel?.primary;
  if (typeof primary !== "string") return undefined;
  const separator = primary.indexOf("/");
  if (separator <= 0 || separator === primary.length - 1) return undefined;
  const providerKey = primary.slice(0, separator);
  const modelId = primary.slice(separator + 1);
  const models = isObject(config.models) ? config.models : null;
  const providers = models && isObject(models.providers) ? models.providers : null;
  const provider = providers && isObject(providers[providerKey]) ? providers[providerKey] : null;
  if (!provider || !Array.isArray(provider.models)) return undefined;
  for (const entry of provider.models) {
    if (!isObject(entry)) continue;
    if (entry.name === primary || entry.id === modelId) return positiveReplyBudget(entry.maxTokens);
  }
  return undefined;
}
function applyReasoning(modelEntry, request) {
  const canCarry =
    request.route.upstreamProvider === "compatible-endpoint" &&
    request.route.api === "openai-completions";
  if (!request.reasoning.explicit && canCarry) return;
  const params = cloneObject(modelEntry.params);
  const extraBody = cloneObject(params.extra_body);
  if (request.reasoning.effort && canCarry) {
    extraBody.reasoning_effort = request.reasoning.effort;
  } else {
    delete extraBody.reasoning_effort;
  }
  if (Object.keys(extraBody).length > 0) params.extra_body = extraBody;
  else delete params.extra_body;
  if (Object.keys(params).length > 0) modelEntry.params = params;
  else delete modelEntry.params;
}
function withUpstreamProviderHeader(providerConfig, upstreamProvider) {
  const headers = cloneObject(providerConfig.headers);
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === UPSTREAM_PROVIDER_HEADER.toLowerCase()) delete headers[key];
  }
  headers[UPSTREAM_PROVIDER_HEADER] = upstreamProvider;
  return { ...providerConfig, headers };
}
function readPreviousInferenceApi(config) {
  const agents = isObject(config.agents) ? config.agents : null;
  const defaults = agents && isObject(agents.defaults) ? agents.defaults : null;
  const model = defaults && isObject(defaults.model) ? defaults.model : null;
  const primary = model?.primary;
  if (typeof primary !== "string") return null;
  const separator = primary.indexOf("/");
  if (separator <= 0) return null;
  const providerKey = primary.slice(0, separator);
  const models = isObject(config.models) ? config.models : null;
  const providers = models && isObject(models.providers) ? models.providers : null;
  const provider = providers && isObject(providers[providerKey]) ? providers[providerKey] : null;
  const api = provider?.api;
  if (api === "openai-completions" || api === "anthropic-messages" || api === "openai-responses") {
    return api;
  }
  if (providerKey === "anthropic") return "anthropic-messages";
  return providerKey === "inference" || providerKey === "openai" ? "openai-completions" : null;
}
function applyInferenceRoute(config, request) {
  const primaryModelRef = request.route.primaryModelRef;
  if (primaryModelRef === null) {
    throw new Error("OpenClaw inference configuration requires a primary model reference");
  }
  const inheritedMaxTokens = readPrimaryReplyBudget(config);
  updatePrimaryModel(config, primaryModelRef);
  const models = ensureObject(config, "models");
  models.mode = "merge";
  const providers = ensureObject(models, "providers");
  const existingProvider = cloneObject(providers[request.route.providerKey]);
  const previousModel = Array.isArray(existingProvider.models)
    ? cloneObject(existingProvider.models[0])
    : {};
  delete previousModel.compat;
  previousModel.id = request.route.model;
  previousModel.name = primaryModelRef;
  if (request.contextWindow !== null) previousModel.contextWindow = request.contextWindow;
  if (request.route.api === "anthropic-messages") {
    previousModel.maxTokens =
      positiveReplyBudget(previousModel.maxTokens) ??
      inheritedMaxTokens ??
      DEFAULT_ANTHROPIC_MAX_TOKENS;
  }
  if (request.route.compatibility) {
    previousModel.compat = { ...request.route.compatibility };
  }
  applyReasoning(previousModel, request);
  const providerConfig = withUpstreamProviderHeader(
    {
      ...existingProvider,
      baseUrl: request.route.baseUrl,
      apiKey:
        typeof existingProvider.apiKey === "string" && existingProvider.apiKey
          ? existingProvider.apiKey
          : "unused",
      api: request.route.api,
      models: [previousModel],
    },
    request.route.upstreamProvider,
  );
  providers[request.route.providerKey] = providerConfig;
}
function validationCommand(target) {
  const candidateTemplate = `${target.directory}/.nemoclaw-openclaw-config.XXXXXX`;
  const script = [
    "set -eu",
    "umask 077",
    `candidate="$(mktemp ${shellQuote(candidateTemplate)})"`,
    `trap 'rm -f -- "$candidate"' EXIT HUP INT TERM`,
    `head -c ${String(MAX_CONFIG_BYTES + 1)} > "$candidate"`,
    'candidate_size="$(wc -c < "$candidate")"',
    `test "$candidate_size" -le ${String(MAX_CONFIG_BYTES)}`,
    'HOME=/sandbox OPENCLAW_CONFIG_PATH="$candidate" /usr/local/bin/openclaw config validate --json',
  ].join("\n");
  return {
    command: [
      "timeout",
      "--signal=TERM",
      "--kill-after=5s",
      "30s",
      "/usr/bin/setpriv",
      "--reuid=gateway",
      "--regid=gateway",
      "--init-groups",
      "--",
      "sh",
      "-c",
      script,
    ],
    timeoutSeconds: 360,
    failureMessage:
      "OpenClaw rejected the configuration candidate; the existing configuration was not changed.",
    success: { kind: "exit-zero" },
  };
}
function writeCommand(target, expectedConfigSha256) {
  return {
    command: [
      "timeout",
      "--signal=TERM",
      "--kill-after=5s",
      "5m",
      "python3",
      "-I",
      CONFIG_GUARD,
      "write-config",
      "--config-dir",
      target.directory,
      "--expected-config-sha256",
      expectedConfigSha256,
    ],
    timeoutSeconds: 360,
    failureMessage: "OpenClaw could not commit the validated configuration transaction.",
    recoveryGuidance: [
      "Rebuild the sandbox if its installed OpenClaw configuration guard is unavailable.",
    ],
    success: {
      kind: "config-transaction",
      action: "write-config",
      configDirectory: target.directory,
      protectedFiles: [target.file, ".config-hash", "fabric.json"],
    },
  };
}
function mutableConfigRepair(request) {
  if (request.sandboxUid === null || request.sandboxGid === null) return null;
  return {
    command: [
      "/usr/bin/timeout",
      "--signal=TERM",
      "--kill-after=5s",
      "15s",
      "/usr/bin/python3",
      "-I",
      CONFIG_NORMALIZER,
      request.target.directory,
      request.sandboxUid,
      request.sandboxGid,
    ],
    timeoutSeconds: 25,
    failureMessage: "OpenClaw mutable configuration permissions could not be repaired.",
    success: { kind: "exit-zero" },
  };
}
const configAdapter = {
  describeInferenceConfig(request) {
    requireTarget(request.target);
    return { kind: "mutable", providerApiOverrides: [] };
  },
  prepareInferenceConfig(request) {
    requireTarget(request.target);
    const config = cloneConfig(request.config);
    const before = JSON.stringify(config);
    const previousApi = readPreviousInferenceApi(config);
    applyInferenceRoute(config, request);
    return {
      kind: "mutation",
      config,
      changed: before !== JSON.stringify(config),
      postCommit: {
        configSync: "best-effort",
        gatewayRestart: { kind: "when-api-changes", previousApi },
        sandboxReconcile: {
          kind: "command",
          trigger: "when-config-changes",
          command: [
            "/usr/bin/python3",
            "-I",
            "/usr/local/lib/nemoclaw/openclaw-startup/inference-reconcile.py",
          ],
          timeoutSeconds: 90,
        },
      },
    };
  },
  prepareConfigUpdate(request) {
    requireTarget(request.target);
    return {
      kind: "transaction",
      content: request.serializedConfig,
      validation: validationCommand(request.target),
      write: writeCommand(request.target, request.expectedConfigSha256),
      restart: {
        kind: "managed",
        guidance: ["Some configuration changes require a sandbox restart to take effect."],
      },
    };
  },
  classifyConfigUrl(request) {
    const segments = [...request.key.split("."), ...request.relativePath];
    const safe = !segments.some((segment) =>
      ["__proto__", "constructor", "prototype", "toString", "hasOwnProperty"].includes(segment),
    );
    return {
      allowPrivateUrls: false,
      allowOpenShellBridge:
        safe &&
        segments.length === 4 &&
        segments[0] === "models" &&
        segments[1] === "providers" &&
        segments[2].length > 0 &&
        !/^\d+$/.test(segments[2]) &&
        segments[3] === "baseUrl",
    };
  },
  describeMutableConfig(request) {
    requireTarget(request.target);
    return {
      kind: "stat",
      directoryMode: "2770",
      directoryOwner: "sandbox:sandbox",
      fileMode: "660",
      fileOwner: "sandbox:sandbox",
      repair: mutableConfigRepair(request),
    };
  },
};
module.exports = configAdapter;
