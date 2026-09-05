// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  HarnessPackageStartupRequest,
  HarnessStartupAdapterModule,
  HarnessStartupEnvironmentValue,
  HarnessStartupJsonObject,
  HarnessStartupPlan,
  HarnessStartupRequest,
  HarnessStartupRootFileMaterial,
  HarnessStartupSettings,
} from "@nvidia/nemoclaw-harness-contract";

const PACKAGE_ID = "langchain-deepagents-code";
type StartupPackageConfig = HarnessStartupJsonObject & {
  readonly settings: HarnessStartupSettings;
};
type StartupAdapterRequest =
  | HarnessStartupRequest
  | HarnessPackageStartupRequest<StartupPackageConfig>;
const PROXY_ENVIRONMENT_NAMES = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
] as const;
const UNSUPPORTED_RUNTIME_INPUTS = [
  "NEMOCLAW_AUTO_PAIR_DEADLINE_SECS",
  "NEMOCLAW_AUTO_PAIR_FAST_DEADLINE_SECS",
  "NEMOCLAW_AUTO_PAIR_FAST_REENTRY_INTERVAL_SECS",
  "NEMOCLAW_AUTO_PAIR_FAST_REENTRY_POLLS",
  "NEMOCLAW_AUTO_PAIR_RUN_TIMEOUT_SECS",
  "NEMOCLAW_AUTO_PAIR_SLOW_INTERVAL_SECS",
  "NEMOCLAW_DASHBOARD_BIND",
  "NEMOCLAW_MINIMAL_BOOTSTRAP",
] as const;

function fail(message: string): never {
  throw new Error(`Cannot build LangChain Deep Agents Code startup plan: ${message}`);
}

function booleanFlag(value: boolean): "0" | "1" {
  return value ? "1" : "0";
}

function normalizeStartupRequest(request: StartupAdapterRequest): HarnessStartupRequest {
  if (request.profileKind !== "package") return request;
  const keys = Object.keys(request.packageConfig);
  const settings = request.packageConfig.settings as unknown;
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
    settings: { ...(settings as HarnessStartupSettings), corporateCa: request.corporateCa },
    applicationEnvironment: request.applicationEnvironment,
  };
}

function rootFile(
  legacyInput: string,
  path: HarnessStartupRootFileMaterial["path"],
  value: string,
): HarnessStartupRootFileMaterial {
  return {
    kind: "root-owned-file",
    legacyInput,
    path,
    contents: `${value}\n`,
    owner: "root",
    group: "root",
    mode: 0o444,
  };
}

function appendHostProxy(
  environment: Record<string, HarnessStartupEnvironmentValue>,
  request: HarnessStartupRequest,
): void {
  const proxy = request.settings.proxy;
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

function buildStartupPlan(adapterRequest: StartupAdapterRequest): HarnessStartupPlan {
  const request = normalizeStartupRequest(adapterRequest);
  const { settings } = request;
  const config = settings.configuration;
  if (
    request.packageId !== PACKAGE_ID ||
    config.agent !== PACKAGE_ID ||
    settings.dashboard.agent !== PACKAGE_ID ||
    settings.dashboard.mode !== "disabled" ||
    settings.messaging.plan !== null ||
    config.autoApprovalMode === undefined ||
    config.observabilityEnabled === undefined
  ) {
    fail("profile state is inconsistent");
  }
  const reasoningEffort =
    settings.tuning.reasoningEffort === null || settings.tuning.reasoningEffort === "default"
      ? ""
      : settings.tuning.reasoningEffort;
  const configurationEnvironment: Record<string, HarnessStartupEnvironmentValue> = {
    NEMOCLAW_INFERENCE_API: settings.inference.api,
    NEMOCLAW_INFERENCE_BASE_URL: settings.inference.routedBaseUrl,
    NEMOCLAW_INFERENCE_PROVIDER_ID: settings.inference.routeProvider,
    NEMOCLAW_MODEL: settings.inference.model,
    NEMOCLAW_REASONING_EFFORT: reasoningEffort,
    NEMOCLAW_TOOL_DISCLOSURE: settings.tools.disclosure,
    NEMOCLAW_UPSTREAM_ENDPOINT_URL: settings.inference.upstreamEndpointUrl ?? "",
    NEMOCLAW_UPSTREAM_PROVIDER: settings.inference.upstreamProvider,
  };
  appendHostProxy(configurationEnvironment, request);
  const runtimeEnvironment: Record<string, HarnessStartupEnvironmentValue> = {
    ...configurationEnvironment,
    NEMOCLAW_OBSERVABILITY: booleanFlag(config.observabilityEnabled),
  };
  delete runtimeEnvironment.NEMOCLAW_INFERENCE_BASE_URL;
  delete runtimeEnvironment.NEMOCLAW_REASONING_EFFORT;
  delete runtimeEnvironment.NEMOCLAW_UPSTREAM_PROVIDER;
  for (const name of PROXY_ENVIRONMENT_NAMES) delete runtimeEnvironment[name];

  return {
    schemaVersion: 1,
    packageId: PACKAGE_ID,
    configurationEnvironment,
    runtimeEnvironment,
    applicationRuntime: {
      exportEnvironment: {},
      unsetEnvironment: [...UNSUPPORTED_RUNTIME_INPUTS],
    },
    managedState: {
      root: "/sandbox/.deepagents",
      files: ["config.toml", "fabric.json"],
      directories: [".state", "skills"],
    },
    materials: [
      {
        kind: "corporate-ca-handoff",
        legacyInput: "NEMOCLAW_CORPORATE_CA_B64",
        expectedSha256: settings.corporateCa.bundleSha256,
      },
      rootFile(
        "NEMOCLAW_DCODE_AUTO_APPROVAL",
        "/usr/local/share/nemoclaw/dcode-auto-approval",
        config.autoApprovalMode,
      ),
      rootFile(
        "NEMOCLAW_INFERENCE_BASE_URL",
        "/usr/local/share/nemoclaw/dcode-inference-base-url",
        settings.inference.routedBaseUrl,
      ),
      rootFile(
        "NEMOCLAW_UPSTREAM_PROVIDER",
        "/usr/local/share/nemoclaw/dcode-upstream-provider",
        settings.inference.upstreamProvider,
      ),
      rootFile(
        "NEMOCLAW_PROXY_HOST",
        "/usr/local/share/nemoclaw/dcode-proxy-host",
        settings.proxy.managedHost,
      ),
      rootFile(
        "NEMOCLAW_PROXY_PORT",
        "/usr/local/share/nemoclaw/dcode-proxy-port",
        String(settings.proxy.managedPort),
      ),
      rootFile(
        "NEMOCLAW_REASONING_EFFORT",
        "/usr/local/share/nemoclaw/dcode-reasoning-effort",
        reasoningEffort,
      ),
    ],
    actions: [{ kind: "generate-config", runAs: "sandbox" }],
  };
}

const startupAdapter: HarnessStartupAdapterModule<StartupAdapterRequest> = { buildStartupPlan };

export = startupAdapter;
