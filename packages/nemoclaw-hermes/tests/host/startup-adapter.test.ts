// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from "node:module";
import path from "node:path";

import type {
  HarnessPackageStartupRequest,
  HarnessStartupAdapterModule,
  HarnessStartupJsonObject,
  HarnessStartupRequest,
  HarnessStartupSettings,
} from "@nvidia/nemoclaw-harness-contract";
import { describe, expect, it } from "vitest";

type StartupPackageConfig = HarnessStartupJsonObject & {
  readonly settings: HarnessStartupSettings;
};
type StartupAdapterRequest =
  | HarnessStartupRequest
  | HarnessPackageStartupRequest<StartupPackageConfig>;

const requireModule = createRequire(import.meta.url);
const adapter = requireModule(
  path.resolve("host/startup-adapter.cts"),
) as HarnessStartupAdapterModule<StartupAdapterRequest>;

function request(): HarnessStartupRequest {
  return {
    packageId: "hermes",
    settings: {
      configuration: {
        agent: "hermes",
        webSearch: { enabled: true, provider: "tavily" },
      },
      inference: {
        routeProvider: "custom",
        upstreamProvider: "anthropic-prod",
        model: "claude-sonnet",
        routedBaseUrl: "https://inference.local/v1",
        upstreamEndpointUrl: null,
        api: "anthropic-messages",
        primaryModelRef: null,
        compatibility: null,
        inputModalities: null,
      },
      proxy: {
        managedHost: "proxy_name",
        managedPort: 43_128,
        hostHttpUrl: "http://proxy.test:8080",
        hostHttpsUrl: "http://proxy.test:3128",
        hostNoProxy: ["localhost"],
      },
      dashboard: {
        agent: "hermes",
        mode: "loopback-forwarded",
        url: "http://127.0.0.1:19189",
        browserUrl: "https://hermes.test:19189",
        publicPort: 19_189,
        internalPort: 29_189,
        tuiEnabled: true,
      },
      tools: { disclosure: "direct", enabledGateways: ["nous-web", "nous-code"] },
      messaging: {
        plan: { schemaVersion: 1, agent: "hermes", workflow: "onboard", channels: [] },
      },
      tuning: {
        contextWindow: 65_536,
        maxTokens: null,
        reasoning: null,
        reasoningEffort: null,
      },
      corporateCa: { bundleSha256: "b".repeat(64) },
    },
    applicationEnvironment: {},
  };
}

function receiptBackedRequest(): HarnessPackageStartupRequest<StartupPackageConfig> {
  const legacy = request();
  return {
    profileKind: "package",
    packageId: legacy.packageId,
    harnessPackage: {
      kind: "agent-runtime",
      id: legacy.packageId,
      packageVersion: "1.0.0",
      contentDigest: "b".repeat(64),
    },
    packageConfig: { settings: legacy.settings } as StartupPackageConfig,
    corporateCa: legacy.settings.corporateCa,
    applicationEnvironment: legacy.applicationEnvironment,
  };
}

describe("Hermes startup adapter", () => {
  it("prepares the existing startup semantics from the generic package input", () => {
    const legacy = request();
    const preparationRequest: Parameters<typeof adapter.prepareStartupProfile>[0] = {
      packageId: "hermes",
      harnessPackage: receiptBackedRequest().harnessPackage,
      phase: "initial",
      previousDesiredState: null,
      input: {
        inference: {
          selectedProvider: legacy.settings.inference.upstreamProvider,
          model: legacy.settings.inference.model,
          endpointUrl: null,
          resolvedContextWindow: null,
          reasoningEnabled: null,
          reasoningEffort: null,
          candidates: [
            {
              requestedApi: null,
              routeProvider: legacy.settings.inference.routeProvider,
              routedBaseUrl: legacy.settings.inference.routedBaseUrl,
              api: legacy.settings.inference.api,
              primaryModelRef: "custom/claude-sonnet",
              compatibility: null,
            },
          ],
        },
        dashboard: {
          managed: true,
          url: legacy.settings.dashboard.browserUrl!,
          port: legacy.settings.dashboard.publicPort!,
          bindAddress: null,
          wslExposure: false,
          forwarding: {
            enabled: true,
            publicPort: legacy.settings.dashboard.publicPort!,
            internalPort: legacy.settings.dashboard.internalPort!,
            tuiEnabled: legacy.settings.dashboard.tuiEnabled!,
          },
        },
        webSearch: { enabled: true, provider: "tavily" },
        tools: legacy.settings.tools,
        messagingPlan: legacy.settings.messaging.plan,
        approvalMode: "disabled",
        observabilityEnabled: false,
        proxy: legacy.settings.proxy,
        environment: { NEMOCLAW_CONTEXT_WINDOW: "65536" },
        corporateCa: legacy.settings.corporateCa,
        credentialProxyPresent: true,
      },
    };
    const result = adapter.prepareStartupProfile(preparationRequest);

    expect(result).toEqual({
      kind: "prepared",
      desiredState: legacy.settings,
      credentialProxyReplayRequired: true,
      dashboardRemoteBindPrepared: false,
    });

    const { webSearch: _webSearch, ...inputWithoutWebSearch } = preparationRequest.input;
    const resultWithoutWebSearch = adapter.prepareStartupProfile({
      ...preparationRequest,
      // Exercise defensive compatibility with a pre-contract payload. Typed callers always
      // provide webSearch, so keep the deliberately incomplete fixture explicit.
      input: inputWithoutWebSearch as unknown as typeof preparationRequest.input,
    });
    expect(resultWithoutWebSearch.kind).toBe("prepared");
    if (resultWithoutWebSearch.kind !== "prepared") throw new Error(resultWithoutWebSearch.reason);
    expect(resultWithoutWebSearch.desiredState.configuration.webSearch).toEqual({
      enabled: false,
      provider: "tavily",
    });
  });

  it("owns initial and reconciled durable package configuration", () => {
    const legacy = request();
    const receipt = receiptBackedRequest();
    const profileRequest = {
      packageId: receipt.packageId,
      harnessPackage: receipt.harnessPackage,
      desiredState: legacy.settings,
    };
    const initial = adapter.buildInitialStartupProfile(profileRequest);
    if (initial.kind !== "package-config") throw new Error(initial.reason);

    expect(initial.packageConfig).toEqual({ settings: legacy.settings });
    expect(
      adapter.buildStartupPlan({
        ...receipt,
        packageConfig: initial.packageConfig as StartupPackageConfig,
      }),
    ).toEqual(adapter.buildStartupPlan(legacy));
    expect(
      adapter.reconcileStartupProfile({
        ...profileRequest,
        currentPackageConfig: {
          settings: { ...legacy.settings, configuration: {} },
        } as unknown as HarnessStartupJsonObject,
      }),
    ).toEqual({ kind: "package-config", packageConfig: initial.packageConfig, changed: true });
    expect(
      adapter.reconcileStartupProfile({
        ...profileRequest,
        currentPackageConfig: initial.packageConfig,
      }),
    ).toEqual({ kind: "package-config", packageConfig: initial.packageConfig, changed: false });
  });

  it("produces the same plan from receipt-backed package settings", () => {
    const packageRequest = receiptBackedRequest();

    expect(Object.keys(packageRequest.packageConfig)).toEqual(["settings"]);
    expect(adapter.buildStartupPlan(packageRequest)).toEqual(adapter.buildStartupPlan(request()));
  });

  it("maps dashboard, gateway, messaging, and runtime state without core dispatch", () => {
    const plan = adapter.buildStartupPlan(request());

    expect(plan.configurationEnvironment).toMatchObject({
      CHAT_UI_URL: "https://hermes.test:19189",
      NEMOCLAW_HERMES_TOOL_GATEWAY_BROKER: "1",
      NEMOCLAW_HERMES_TOOL_GATEWAY_PRESETS_B64: {
        kind: "canonical-json-base64",
        value: ["nous-web", "nous-code"],
      },
    });
    expect(plan.runtimeEnvironment).toMatchObject({
      HERMES_HOME: "/sandbox/.hermes",
      NEMOCLAW_HERMES_DASHBOARD: "1",
      NEMOCLAW_HERMES_DASHBOARD_INTERNAL_PORT: "29189",
      NEMOCLAW_HERMES_DASHBOARD_PORT: "19189",
    });
    expect(plan.applicationRuntime.unsetEnvironment).toHaveLength(8);
    expect(plan.actions.map((action) => action.kind)).toEqual([
      "apply-messaging",
      "generate-config",
      "apply-messaging",
      "seal-config",
    ]);
    expect(plan.actions.at(-1)).toEqual({
      kind: "seal-config",
      runAs: "root",
      committedReplay: "run",
    });
  });

  it("fails closed when a forwarded dashboard has no browser URL", () => {
    const input = request();
    expect(() =>
      adapter.buildStartupPlan({
        ...input,
        settings: {
          ...input.settings,
          dashboard: { ...input.settings.dashboard, browserUrl: undefined },
        },
      }),
    ).toThrow(/no recorded browser URL/u);
  });
});
