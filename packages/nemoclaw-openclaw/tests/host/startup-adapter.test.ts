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
    packageId: "openclaw",
    settings: {
      configuration: {
        agent: "openclaw",
        webSearch: { enabled: true, provider: "brave" },
        otel: {
          enabled: true,
          endpointUrl: "http://host.openshell.internal:4318",
          serviceName: "openclaw-gateway",
          sampleRate: 0.5,
        },
        agentTimeoutSeconds: 900,
        heartbeatEvery: "30m",
        extraAgents: { agents: [], defaults: {}, main: {} },
        deviceAuth: { disabled: true, optOutSource: "managed-onboard" },
        minimalBootstrap: true,
      },
      inference: {
        routeProvider: "inference",
        upstreamProvider: "nvidia-prod",
        model: "nvidia/model",
        routedBaseUrl: "https://inference.local/v1",
        upstreamEndpointUrl: null,
        api: "openai-responses",
        primaryModelRef: "inference/nvidia/model",
        compatibility: { maxRetries: 2 },
        inputModalities: ["text", "image"],
      },
      proxy: {
        managedHost: "10.200.0.1",
        managedPort: 3128,
        hostHttpUrl: "http://proxy.test:8080",
        hostHttpsUrl: null,
        hostNoProxy: ["localhost"],
      },
      dashboard: {
        agent: "openclaw",
        mode: "remote",
        url: "https://dashboard.test:18789",
        port: 18_789,
        bindAddress: "0.0.0.0",
        wslExposure: true,
      },
      tools: { disclosure: "progressive", enabledGateways: [] },
      messaging: {
        plan: {
          schemaVersion: 1,
          agent: "openclaw",
          workflow: "onboard",
          channels: [],
        },
      },
      tuning: {
        contextWindow: 131_072,
        maxTokens: 8192,
        reasoning: true,
        reasoningEffort: "high",
      },
      corporateCa: { bundleSha256: "a".repeat(64) },
    },
    applicationEnvironment: { NEMOCLAW_AUTO_PAIR_FAST_REENTRY_POLLS: "03" },
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
      contentDigest: "a".repeat(64),
    },
    packageConfig: { settings: legacy.settings } as StartupPackageConfig,
    corporateCa: legacy.settings.corporateCa,
    applicationEnvironment: legacy.applicationEnvironment,
  };
}

describe("OpenClaw startup adapter", () => {
  it("prepares the existing startup semantics from the generic package input", () => {
    const legacy = request();
    const result = adapter.prepareStartupProfile({
      packageId: "openclaw",
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
              primaryModelRef: legacy.settings.inference.primaryModelRef!,
              compatibility: legacy.settings.inference.compatibility,
            },
          ],
        },
        dashboard: {
          managed: true,
          url: legacy.settings.dashboard.url!,
          port: legacy.settings.dashboard.port!,
          bindAddress: legacy.settings.dashboard.bindAddress!,
          wslExposure: legacy.settings.dashboard.wslExposure!,
          forwarding: { enabled: false, publicPort: null, internalPort: null, tuiEnabled: false },
        },
        webSearch: { enabled: true, provider: "brave" },
        tools: legacy.settings.tools,
        messagingPlan: legacy.settings.messaging.plan,
        approvalMode: "disabled",
        observabilityEnabled: false,
        proxy: legacy.settings.proxy,
        environment: {
          NEMOCLAW_AGENT_HEARTBEAT_EVERY: "30m",
          NEMOCLAW_AGENT_TIMEOUT: "900",
          NEMOCLAW_CONTEXT_WINDOW: "131072",
          NEMOCLAW_EXTRA_AGENTS_JSON: '{"agents":[],"defaults":{},"main":{}}',
          NEMOCLAW_INFERENCE_INPUTS: "text,image",
          NEMOCLAW_MAX_TOKENS: "8192",
          NEMOCLAW_MINIMAL_BOOTSTRAP: "1",
          NEMOCLAW_OPENCLAW_OTEL: "1",
          NEMOCLAW_OPENCLAW_OTEL_ENDPOINT: "http://host.openshell.internal:4318",
          NEMOCLAW_OPENCLAW_OTEL_SAMPLE_RATE: "0.5",
          NEMOCLAW_OPENCLAW_OTEL_SERVICE_NAME: "openclaw-gateway",
          NEMOCLAW_REASONING: "true",
          NEMOCLAW_REASONING_EFFORT: "high",
        },
        corporateCa: legacy.settings.corporateCa,
        credentialProxyPresent: true,
      },
    });

    expect(result).toEqual({
      kind: "prepared",
      desiredState: legacy.settings,
      credentialProxyReplayRequired: true,
      dashboardRemoteBindPrepared: true,
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

  it("maps native startup inputs into the finite NemoClaw plan", () => {
    const plan = adapter.buildStartupPlan(request());

    expect(plan.packageId).toBe("openclaw");
    expect(plan.configurationEnvironment).toMatchObject({
      CHAT_UI_URL: "https://dashboard.test:18789",
      NEMOCLAW_INFERENCE_BASE_URL: "https://inference.local/v1",
      NEMOCLAW_PRIMARY_MODEL_REF: "inference/nvidia/model",
      NEMOCLAW_MESSAGING_PLAN_B64: {
        kind: "canonical-json-base64",
        value: expect.not.objectContaining({ workflow: expect.anything() }),
      },
    });
    expect(plan.runtimeEnvironment).toMatchObject({
      HTTP_PROXY: "http://proxy.test:8080",
      NEMOCLAW_DASHBOARD_PORT: "18789",
      NEMOCLAW_MINIMAL_BOOTSTRAP: "1",
    });
    expect(plan.runtimeEnvironment).not.toHaveProperty("NEMOCLAW_MESSAGING_PLAN_B64");
    expect(plan.applicationRuntime).toEqual({
      exportEnvironment: { NEMOCLAW_AUTO_PAIR_FAST_REENTRY_POLLS: "3" },
      unsetEnvironment: [],
    });
    expect(plan.actions.map((action) => action.kind)).toEqual([
      "apply-messaging",
      "generate-config",
      "apply-messaging",
      "seal-config",
    ]);
    expect(plan.actions.at(-1)).toEqual({
      kind: "seal-config",
      runAs: "sandbox",
      committedReplay: "skip",
    });
  });

  it("rejects another package and invalid public runtime controls", () => {
    expect(() => adapter.buildStartupPlan({ ...request(), packageId: "future-harness" })).toThrow(
      /profile state is inconsistent/u,
    );
    expect(() =>
      adapter.buildStartupPlan({
        ...request(),
        applicationEnvironment: { NEMOCLAW_AUTO_PAIR_FAST_REENTRY_POLLS: "1.5" },
      }),
    ).toThrow(/positive safe integer/u);
  });
});
