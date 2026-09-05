// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  HarnessStartupAdapterModule,
  HarnessStartupEnvironmentValue,
  HarnessStartupPlan,
  HarnessStartupRequest,
  HarnessStartupRootFileMaterial,
} from "@nvidia/nemoclaw-harness-contract";

const PACKAGE_ID = "pi";
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
  throw new Error(`Cannot build Pi startup plan: ${message}`);
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

function buildStartupPlan(request: HarnessStartupRequest): HarnessStartupPlan {
  const { settings } = request;
  if (
    request.packageId !== PACKAGE_ID ||
    settings.configuration.agent !== PACKAGE_ID ||
    settings.dashboard.agent !== PACKAGE_ID ||
    settings.dashboard.mode !== "disabled" ||
    settings.messaging.plan !== null
  ) {
    fail("profile state is inconsistent");
  }
  const configurationEnvironment: Record<string, HarnessStartupEnvironmentValue> = {
    NEMOCLAW_CONTEXT_WINDOW:
      settings.tuning.contextWindow === null ? "" : String(settings.tuning.contextWindow),
    NEMOCLAW_INFERENCE_API: settings.inference.api,
    NEMOCLAW_INFERENCE_BASE_URL: settings.inference.routedBaseUrl,
    NEMOCLAW_INFERENCE_PROVIDER_ID: settings.inference.routeProvider,
    NEMOCLAW_MAX_TOKENS:
      settings.tuning.maxTokens === null ? "" : String(settings.tuning.maxTokens),
    NEMOCLAW_MODEL: settings.inference.model,
    NEMOCLAW_REASONING: settings.tuning.reasoning === null ? "" : String(settings.tuning.reasoning),
    NEMOCLAW_TOOL_DISCLOSURE: settings.tools.disclosure,
    NEMOCLAW_UPSTREAM_PROVIDER: settings.inference.upstreamProvider,
  };
  appendHostProxy(configurationEnvironment, request);
  const runtimeEnvironment = { ...configurationEnvironment };
  delete runtimeEnvironment.NEMOCLAW_INFERENCE_BASE_URL;
  delete runtimeEnvironment.NEMOCLAW_CONTEXT_WINDOW;
  delete runtimeEnvironment.NEMOCLAW_MAX_TOKENS;
  delete runtimeEnvironment.NEMOCLAW_REASONING;
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
      root: "/sandbox/.pi",
      files: ["agent/fabric.json", "agent/models.json"],
      directories: ["agent"],
    },
    materials: [
      {
        kind: "corporate-ca-handoff",
        legacyInput: "NEMOCLAW_CORPORATE_CA_B64",
        expectedSha256: settings.corporateCa.bundleSha256,
      },
      rootFile(
        "NEMOCLAW_PROXY_HOST",
        "/usr/local/share/nemoclaw/pi-proxy-host",
        settings.proxy.managedHost,
      ),
      rootFile(
        "NEMOCLAW_PROXY_PORT",
        "/usr/local/share/nemoclaw/pi-proxy-port",
        String(settings.proxy.managedPort),
      ),
    ],
    actions: [{ kind: "generate-config", runAs: "sandbox" }],
  };
}

const startupAdapter: HarnessStartupAdapterModule = { buildStartupPlan };

export = startupAdapter;
