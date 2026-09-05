// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  HarnessStartupAdapterModule,
  HarnessStartupApplicationRuntimePlan,
  HarnessStartupEnvironmentValue,
  HarnessStartupJsonValue,
  HarnessStartupPlan,
  HarnessStartupRequest,
} from "@nvidia/nemoclaw-harness-contract";

const PACKAGE_ID = "openclaw";
const APPLICATION_RUNTIME_INPUTS = [
  ["NEMOCLAW_AUTO_PAIR_DEADLINE_SECS", "positive-finite-seconds"],
  ["NEMOCLAW_AUTO_PAIR_FAST_DEADLINE_SECS", "positive-finite-seconds"],
  ["NEMOCLAW_AUTO_PAIR_FAST_REENTRY_INTERVAL_SECS", "positive-finite-seconds"],
  ["NEMOCLAW_AUTO_PAIR_FAST_REENTRY_POLLS", "positive-safe-integer"],
  ["NEMOCLAW_AUTO_PAIR_RUN_TIMEOUT_SECS", "positive-finite-seconds"],
  ["NEMOCLAW_AUTO_PAIR_SLOW_INTERVAL_SECS", "positive-finite-seconds"],
] as const;

function fail(message: string): never {
  throw new Error(`Cannot build OpenClaw startup plan: ${message}`);
}

function booleanFlag(value: boolean): "0" | "1" {
  return value ? "1" : "0";
}

function required<T>(value: T | undefined, name: string): T {
  return value === undefined ? fail(`${name} is required`) : value;
}

function encodedJson(value: HarnessStartupJsonValue): HarnessStartupEnvironmentValue {
  return { kind: "canonical-json-base64", value };
}

function applicationRuntimePlan(
  environment: Readonly<Record<string, string>>,
): HarnessStartupApplicationRuntimePlan {
  const exportEnvironment: Record<string, string> = {};
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

function appendHostProxy(
  environment: Record<string, HarnessStartupEnvironmentValue>,
  request: HarnessStartupRequest,
): void {
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

function buildStartupPlan(request: HarnessStartupRequest): HarnessStartupPlan {
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

  const configurationEnvironment: Record<string, HarnessStartupEnvironmentValue> = {
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
    ],
    integrity: { kind: "validated-json-config" },
  };
}

const startupAdapter: HarnessStartupAdapterModule = { buildStartupPlan };

export = startupAdapter;
