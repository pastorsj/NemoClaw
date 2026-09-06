// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
"use strict";
const PACKAGE_ID = "openclaw";
const APPLICATION_RUNTIME_INPUTS = [
  ["NEMOCLAW_AUTO_PAIR_DEADLINE_SECS", "positive-finite-seconds"],
  ["NEMOCLAW_AUTO_PAIR_FAST_DEADLINE_SECS", "positive-finite-seconds"],
  ["NEMOCLAW_AUTO_PAIR_FAST_REENTRY_INTERVAL_SECS", "positive-finite-seconds"],
  ["NEMOCLAW_AUTO_PAIR_FAST_REENTRY_POLLS", "positive-safe-integer"],
  ["NEMOCLAW_AUTO_PAIR_RUN_TIMEOUT_SECS", "positive-finite-seconds"],
  ["NEMOCLAW_AUTO_PAIR_SLOW_INTERVAL_SECS", "positive-finite-seconds"],
];
function fail(message) {
  throw new Error(`Cannot build OpenClaw startup plan: ${message}`);
}
function booleanFlag(value) {
  return value ? "1" : "0";
}
function required(value, name) {
  return value === undefined ? fail(`${name} is required`) : value;
}
function normalizeStartupRequest(request) {
  if (request.profileKind !== "package") return request;
  const keys = Object.keys(request.packageConfig);
  const settings = request.packageConfig.settings;
  if (
    request.harnessPackage.id !== request.packageId ||
    keys.length !== 1 ||
    keys[0] !== "settings" ||
    typeof settings !== "object" ||
    settings === null ||
    Array.isArray(settings)
  ) {
    fail("receipt-backed package config is inconsistent");
  }
  return {
    packageId: request.packageId,
    settings: { ...settings, corporateCa: request.corporateCa },
    applicationEnvironment: request.applicationEnvironment,
  };
}
function encodedJson(value) {
  return { kind: "canonical-json-base64", value };
}
function jsonObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function applicationRuntimePlan(environment) {
  const exportEnvironment = {};
  for (const [name, kind] of APPLICATION_RUNTIME_INPUTS) {
    const raw = environment[name];
    if (raw === undefined) continue;
    if (raw.includes("\0") || /[\r\n]/u.test(raw)) fail(`${name} must be single-line text`);
    const value = Number(raw.trim());
    const valid =
      kind === "positive-safe-integer"
        ? Number.isSafeInteger(value) && value > 0
        : Number.isFinite(value) && value > 0;
    if (!valid) {
      fail(
        `${name} must be ${kind === "positive-safe-integer" ? "a positive safe integer" : "finite positive seconds"}`,
      );
    }
    exportEnvironment[name] = String(value);
  }
  return { exportEnvironment, unsetEnvironment: [] };
}
function appendHostProxy(environment, request) {
  const proxy = request.settings.proxy;
  if (proxy.hostHttpUrl === null && proxy.hostHttpsUrl === null && proxy.hostNoProxy.length === 0) {
    return;
  }
  const noProxy = proxy.hostNoProxy.join(",");
  Object.assign(environment, {
    HTTP_PROXY: proxy.hostHttpUrl ?? "",
    HTTPS_PROXY: proxy.hostHttpsUrl ?? "",
    NO_PROXY: noProxy,
    http_proxy: proxy.hostHttpUrl ?? "",
    https_proxy: proxy.hostHttpsUrl ?? "",
    no_proxy: noProxy,
  });
}
function messagingManagedFiles(plan) {
  if (plan === null || !jsonObject(plan)) return [];
  const files = new Set();
  const addTarget = (target) => {
    if (typeof target !== "string") return;
    if (target === "openclaw.json") files.add(target);
    else if (target.startsWith("~/.openclaw/")) files.add(target.slice("~/.openclaw/".length));
    else if (target.startsWith("/sandbox/.openclaw/")) {
      files.add(target.slice("/sandbox/.openclaw/".length));
    }
  };
  if (Array.isArray(plan.agentRender)) {
    for (const entry of plan.agentRender) {
      if (jsonObject(entry)) addTarget(entry.target);
    }
  }
  if (Array.isArray(plan.buildSteps)) {
    for (const step of plan.buildSteps) {
      if (!jsonObject(step)) continue;
      const value = step.value;
      if (jsonObject(value)) addTarget(value.path);
    }
  }
  return [...files].sort();
}
function buildStartupPlan(adapterRequest) {
  const request = normalizeStartupRequest(adapterRequest);
  const { settings } = request;
  const config = settings.configuration;
  const dashboard = settings.dashboard;
  if (
    request.packageId !== PACKAGE_ID ||
    config.agent !== PACKAGE_ID ||
    dashboard.agent !== PACKAGE_ID ||
    settings.inference.primaryModelRef === null ||
    settings.inference.inputModalities === null ||
    settings.tuning.contextWindow === null ||
    settings.tuning.maxTokens === null ||
    settings.tuning.reasoning === null ||
    settings.tuning.reasoningEffort === null
  ) {
    fail("profile state is inconsistent");
  }
  const webSearch = required(config.webSearch, "configuration.webSearch");
  const otel = required(config.otel, "configuration.otel");
  const deviceAuth = required(config.deviceAuth, "configuration.deviceAuth");
  const extraAgents = required(config.extraAgents, "configuration.extraAgents");
  const agentTimeoutSeconds = required(
    config.agentTimeoutSeconds,
    "configuration.agentTimeoutSeconds",
  );
  const minimalBootstrap = required(config.minimalBootstrap, "configuration.minimalBootstrap");
  const dashboardUrl = required(dashboard.url, "dashboard.url");
  const dashboardPort = required(dashboard.port, "dashboard.port");
  const dashboardBind = required(dashboard.bindAddress, "dashboard.bindAddress");
  const wslExposure = required(dashboard.wslExposure, "dashboard.wslExposure");
  const configurationEnvironment = {
    CHAT_UI_URL: dashboardUrl,
    NEMOCLAW_AGENT_HEARTBEAT_EVERY: config.heartbeatEvery ?? "",
    NEMOCLAW_AGENT_TIMEOUT: String(agentTimeoutSeconds),
    NEMOCLAW_CONTEXT_WINDOW: String(settings.tuning.contextWindow),
    NEMOCLAW_DASHBOARD_BIND: dashboardBind === "0.0.0.0" ? dashboardBind : "",
    NEMOCLAW_DISABLE_DEVICE_AUTH: booleanFlag(deviceAuth.disabled),
    NEMOCLAW_DEVICE_AUTH_OPT_OUT_SOURCE: deviceAuth.optOutSource,
    NEMOCLAW_EXTRA_AGENTS_JSON_B64: encodedJson(extraAgents),
    NEMOCLAW_INFERENCE_API: settings.inference.api,
    NEMOCLAW_INFERENCE_BASE_URL: settings.inference.routedBaseUrl,
    NEMOCLAW_INFERENCE_COMPAT_B64: encodedJson(settings.inference.compatibility ?? {}),
    NEMOCLAW_INFERENCE_INPUTS: settings.inference.inputModalities.join(","),
    NEMOCLAW_INFERENCE_PROVIDER_ID: settings.inference.routeProvider,
    NEMOCLAW_MAX_TOKENS: String(settings.tuning.maxTokens),
    NEMOCLAW_MODEL: settings.inference.model,
    NEMOCLAW_OPENCLAW_OTEL: booleanFlag(otel.enabled),
    NEMOCLAW_OPENCLAW_OTEL_ENDPOINT: otel.endpointUrl,
    NEMOCLAW_OPENCLAW_OTEL_SAMPLE_RATE: String(otel.sampleRate),
    NEMOCLAW_OPENCLAW_OTEL_SERVICE_NAME: otel.serviceName,
    NEMOCLAW_PRIMARY_MODEL_REF: settings.inference.primaryModelRef,
    NEMOCLAW_PROXY_HOST: settings.proxy.managedHost,
    NEMOCLAW_PROXY_PORT: String(settings.proxy.managedPort),
    NEMOCLAW_REASONING: String(settings.tuning.reasoning),
    NEMOCLAW_REASONING_EFFORT: settings.tuning.reasoningEffort,
    NEMOCLAW_TOOL_DISCLOSURE: settings.tools.disclosure,
    NEMOCLAW_UPSTREAM_PROVIDER: settings.inference.upstreamProvider,
    NEMOCLAW_WEB_SEARCH_ENABLED: booleanFlag(webSearch.enabled),
    NEMOCLAW_WEB_SEARCH_PROVIDER: webSearch.provider,
    NEMOCLAW_WSL_DASHBOARD_EXPOSURE: booleanFlag(wslExposure),
  };
  if (settings.messaging.plan !== null) {
    const { workflow: _workflow, ...imagePlan } = settings.messaging.plan;
    configurationEnvironment.NEMOCLAW_MESSAGING_PLAN_B64 = encodedJson(imagePlan);
  }
  const runtimeEnvironment = { ...configurationEnvironment };
  delete runtimeEnvironment.NEMOCLAW_MESSAGING_PLAN_B64;
  runtimeEnvironment.NEMOCLAW_DASHBOARD_PORT = String(dashboardPort);
  runtimeEnvironment.NEMOCLAW_MINIMAL_BOOTSTRAP = booleanFlag(minimalBootstrap);
  appendHostProxy(runtimeEnvironment, request);
  const messagingMode = settings.messaging.plan === null ? "clear" : "apply";
  return {
    schemaVersion: 1,
    packageId: PACKAGE_ID,
    configurationEnvironment,
    runtimeEnvironment,
    applicationRuntime: applicationRuntimePlan(request.applicationEnvironment),
    managedState: {
      root: "/sandbox/.openclaw",
      files: [
        ...new Set([
          ".config-hash",
          "fabric.json",
          "openclaw.json",
          ...messagingManagedFiles(settings.messaging.plan),
        ]),
      ].sort(),
      directories: [],
    },
    materials: [
      {
        kind: "corporate-ca-handoff",
        legacyInput: "NEMOCLAW_CORPORATE_CA_B64",
        expectedSha256: settings.corporateCa.bundleSha256,
      },
    ],
    actions: [
      { kind: "apply-messaging", mode: messagingMode, phase: "runtime-setup", runAs: "root" },
      { kind: "generate-config", runAs: "sandbox" },
      {
        kind: "apply-messaging",
        mode: messagingMode,
        phase: "post-agent-install",
        runAs: "sandbox",
      },
      { kind: "seal-config", runAs: "sandbox", committedReplay: "skip" },
    ],
  };
}
function requireStartupProfileAuthority(request) {
  if (request.packageId !== PACKAGE_ID || request.harnessPackage.id !== PACKAGE_ID) {
    fail("startup profile identity is inconsistent");
  }
}
function preparationValue(request, name) {
  const value = request.input.environment[name];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}
function positiveInteger(request, name, fallback, maximum = 1_000_000_000) {
  const raw = preparationValue(request, name);
  if (raw === null) return fallback;
  if (!/^[1-9][0-9]*$/u.test(raw)) fail(`${name} must be a positive integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value > maximum) {
    fail(`${name} must be a positive integer no greater than ${String(maximum)}`);
  }
  return value;
}
function reasoningEffort(request) {
  const value = preparationValue(request, "NEMOCLAW_REASONING_EFFORT")?.toLowerCase() ?? "default";
  if (value === "default" || value === "low" || value === "medium" || value === "high") {
    return value;
  }
  return fail("NEMOCLAW_REASONING_EFFORT is invalid");
}
function inputModalities(request) {
  const raw = preparationValue(request, "NEMOCLAW_INFERENCE_INPUTS");
  if (raw === null) return ["text"];
  const values = raw.split(",").map((value) => value.trim());
  if (
    values.length === 0 ||
    values.some((value) => value !== "text" && value !== "image") ||
    new Set(values).size !== values.length
  ) {
    fail("NEMOCLAW_INFERENCE_INPUTS must contain unique text/image values");
  }
  return values;
}
function extraAgents(request) {
  const raw = preparationValue(request, "NEMOCLAW_EXTRA_AGENTS_JSON");
  const encoded = preparationValue(request, "NEMOCLAW_EXTRA_AGENTS_JSON_B64");
  if (raw !== null && encoded !== null) fail("extra-agent inputs conflict");
  if (raw === null && encoded === null) {
    return { agents: [], defaults: { subagents: {} }, main: {} };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw ?? decodeCanonicalBase64(encoded));
  } catch {
    return fail("extra-agent input must contain JSON");
  }
  if (Array.isArray(parsed)) return { agents: parsed, defaults: { subagents: {} }, main: {} };
  if (parsed === null || typeof parsed !== "object")
    return fail("extra-agent input must be an object or array");
  const record = parsed;
  if (
    !Array.isArray(record.agents) ||
    typeof record.defaults !== "object" ||
    typeof record.main !== "object"
  ) {
    return fail("extra-agent object is incomplete");
  }
  return {
    agents: record.agents,
    defaults: record.defaults,
    main: record.main,
  };
}
function decodeCanonicalBase64(value) {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    return fail("NEMOCLAW_EXTRA_AGENTS_JSON_B64 must contain canonical base64");
  }
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const bytes = [];
  for (let offset = 0; offset < value.length; offset += 4) {
    const digits = value
      .slice(offset, offset + 4)
      .split("")
      .map((character) => (character === "=" ? 0 : alphabet.indexOf(character)));
    const bits = (digits[0] << 18) | (digits[1] << 12) | (digits[2] << 6) | digits[3];
    bytes.push((bits >> 16) & 0xff);
    if (value[offset + 2] !== "=") bytes.push((bits >> 8) & 0xff);
    if (value[offset + 3] !== "=") bytes.push(bits & 0xff);
  }
  return decodeURIComponent(bytes.map((byte) => `%${byte.toString(16).padStart(2, "0")}`).join(""));
}
function prepareStartupProfile(request) {
  if (request.packageId !== PACKAGE_ID || request.harnessPackage.id !== PACKAGE_ID) {
    fail("startup profile identity is inconsistent");
  }
  const input = request.input;
  const candidate = input.inference.candidates[0] ?? fail("inference candidate is required");
  if (!input.dashboard.managed || input.dashboard.port < 1024) {
    fail("managed dashboard state is required");
  }
  const bind = input.dashboard.bindAddress;
  if (bind !== null && bind !== "0.0.0.0") fail("dashboard bind address is invalid");
  let dashboardHost;
  try {
    dashboardHost = new URL(input.dashboard.url).hostname;
  } catch {
    return fail("dashboard URL is invalid");
  }
  const remote =
    bind === "0.0.0.0" ||
    input.dashboard.wslExposure ||
    !["127.0.0.1", "localhost", "::1", "[::1]"].includes(dashboardHost);
  const webSearch = input.webSearch ?? { enabled: false, provider: null };
  const otelEnabled = preparationValue(request, "NEMOCLAW_OPENCLAW_OTEL");
  const reasoning = preparationValue(request, "NEMOCLAW_REASONING");
  if (reasoning !== null && reasoning !== "true" && reasoning !== "false") {
    fail("NEMOCLAW_REASONING must be true or false");
  }
  const heartbeatEvery = preparationValue(request, "NEMOCLAW_AGENT_HEARTBEAT_EVERY");
  if (heartbeatEvery !== null && !/^\d+(?:s|m|h)$/u.test(heartbeatEvery)) {
    fail("NEMOCLAW_AGENT_HEARTBEAT_EVERY is invalid");
  }
  const sampleRate = Number(
    preparationValue(request, "NEMOCLAW_OPENCLAW_OTEL_SAMPLE_RATE") ?? "1.0",
  );
  if (!Number.isFinite(sampleRate) || sampleRate < 0 || sampleRate > 1) {
    fail("NEMOCLAW_OPENCLAW_OTEL_SAMPLE_RATE is invalid");
  }
  const minimalBootstrap = preparationValue(request, "NEMOCLAW_MINIMAL_BOOTSTRAP");
  if (minimalBootstrap !== null && minimalBootstrap !== "0" && minimalBootstrap !== "1") {
    fail("NEMOCLAW_MINIMAL_BOOTSTRAP must be 0 or 1");
  }
  const previous = request.previousDesiredState;
  const targetChanged =
    previous !== null &&
    (previous.inference.model !== input.inference.model ||
      previous.inference.upstreamProvider !== input.inference.selectedProvider);
  const contextWindow =
    request.phase === "rebuild" && input.inference.resolvedContextWindow !== null
      ? input.inference.resolvedContextWindow
      : targetChanged
        ? fail(
            `cannot determine a context window for '${input.inference.selectedProvider ?? candidate.routeProvider}/${input.inference.model}'`,
          )
        : positiveInteger(
            request,
            "NEMOCLAW_CONTEXT_WINDOW",
            previous?.tuning.contextWindow ?? 131_072,
            4_194_304,
          );
  const preparedReasoning =
    request.phase === "rebuild"
      ? input.inference.selectedProvider === "compatible-endpoint" &&
        input.inference.reasoningEnabled === true
      : reasoning === "true";
  const preparedReasoningEffort =
    request.phase === "rebuild"
      ? input.inference.selectedProvider === "compatible-endpoint" &&
        candidate.api === "openai-completions"
        ? (input.inference.reasoningEffort ?? "default")
        : "default"
      : reasoningEffort(request);
  const desiredState = {
    configuration: {
      agent: PACKAGE_ID,
      webSearch: { enabled: webSearch.enabled, provider: webSearch.provider ?? "brave" },
      otel: {
        enabled:
          otelEnabled !== null && !["0", "false", "no", "off"].includes(otelEnabled.toLowerCase()),
        endpointUrl:
          preparationValue(request, "NEMOCLAW_OPENCLAW_OTEL_ENDPOINT") ??
          "http://host.openshell.internal:4318",
        serviceName:
          preparationValue(request, "NEMOCLAW_OPENCLAW_OTEL_SERVICE_NAME") ?? "openclaw-gateway",
        sampleRate,
      },
      agentTimeoutSeconds: positiveInteger(request, "NEMOCLAW_AGENT_TIMEOUT", 600),
      heartbeatEvery,
      extraAgents: extraAgents(request),
      deviceAuth: { disabled: true, optOutSource: "managed-onboard" },
      minimalBootstrap: minimalBootstrap === "1",
    },
    inference: {
      routeProvider: candidate.routeProvider,
      upstreamProvider: input.inference.selectedProvider ?? candidate.routeProvider,
      model: input.inference.model,
      routedBaseUrl: candidate.routedBaseUrl,
      upstreamEndpointUrl: null,
      api: candidate.api,
      primaryModelRef: candidate.primaryModelRef,
      compatibility: candidate.compatibility ?? {},
      inputModalities: inputModalities(request),
    },
    proxy: input.proxy,
    dashboard: {
      agent: PACKAGE_ID,
      mode: remote ? "remote" : "loopback",
      url: input.dashboard.url,
      port: input.dashboard.port,
      bindAddress: bind === "0.0.0.0" ? bind : "127.0.0.1",
      wslExposure: input.dashboard.wslExposure,
    },
    tools: { disclosure: input.tools.disclosure, enabledGateways: [] },
    messaging: { plan: input.messagingPlan },
    tuning: {
      contextWindow,
      maxTokens: positiveInteger(request, "NEMOCLAW_MAX_TOKENS", 4096),
      reasoning: preparedReasoning,
      reasoningEffort: preparedReasoningEffort,
    },
    corporateCa: input.corporateCa,
  };
  buildStartupPlan({ packageId: PACKAGE_ID, settings: desiredState, applicationEnvironment: {} });
  return {
    kind: "prepared",
    desiredState,
    credentialProxyReplayRequired: input.credentialProxyPresent,
    dashboardRemoteBindPrepared: remote,
  };
}
function packageConfigForDesiredState(request) {
  requireStartupProfileAuthority(request);
  buildStartupPlan({
    packageId: request.packageId,
    settings: request.desiredState,
    applicationEnvironment: {},
  });
  return { settings: request.desiredState };
}
function canonicalStartupJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalStartupJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalStartupJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? fail("startup profile contains a non-JSON value");
}
function buildInitialStartupProfile(request) {
  return { kind: "package-config", packageConfig: packageConfigForDesiredState(request) };
}
function reconcileStartupProfile(request) {
  normalizeStartupRequest({
    profileKind: "package",
    packageId: request.packageId,
    harnessPackage: request.harnessPackage,
    packageConfig: request.currentPackageConfig,
    corporateCa: request.desiredState.corporateCa,
    applicationEnvironment: {},
  });
  const packageConfig = packageConfigForDesiredState(request);
  return {
    kind: "package-config",
    packageConfig,
    changed:
      canonicalStartupJson(packageConfig) !== canonicalStartupJson(request.currentPackageConfig),
  };
}
const startupAdapter = {
  buildStartupPlan,
  prepareStartupProfile,
  buildInitialStartupProfile,
  reconcileStartupProfile,
};
module.exports = startupAdapter;
