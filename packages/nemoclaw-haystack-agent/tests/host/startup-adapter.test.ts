// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  HarnessPackageStartupRequest,
  HarnessStartupAdapterModule,
  HarnessStartupJsonObject,
  HarnessStartupRequest,
  HarnessStartupSettings,
} from "@nvidia/nemoclaw-harness-contract";
import { describe, expect, it } from "vitest";

import { loadPackageHostModule } from "../helpers/host-module";

interface HaystackRuntimeConfig extends HarnessStartupJsonObject {
  readonly temperature: number;
  readonly maxTurns: number;
  readonly systemInstruction: string;
}

type StartupPackageConfig = HarnessStartupJsonObject & {
  readonly settings: HarnessStartupSettings;
  readonly runtime: HaystackRuntimeConfig;
};

type StartupAdapterRequest =
  | HarnessStartupRequest
  | HarnessPackageStartupRequest<StartupPackageConfig>;

const adapter =
  loadPackageHostModule<HarnessStartupAdapterModule<StartupAdapterRequest>>("startup-adapter.cts");

function startupRequest(): HarnessStartupRequest {
  return {
    packageId: "haystack-agent",
    settings: {
      configuration: { agent: "haystack-agent" },
      inference: {
        routeProvider: "inference",
        upstreamProvider: "nvidia",
        model: "nvidia/nemotron",
        routedBaseUrl: "https://inference.local/v1",
        upstreamEndpointUrl: null,
        api: "openai-completions",
        primaryModelRef: null,
        compatibility: null,
        inputModalities: null,
      },
      proxy: {
        managedHost: "10.200.0.1",
        managedPort: 3128,
        hostHttpUrl: null,
        hostHttpsUrl: null,
        hostNoProxy: [],
      },
      dashboard: { agent: "haystack-agent", mode: "disabled" },
      tools: { disclosure: "progressive", enabledGateways: [] },
      messaging: { plan: null },
      tuning: {
        contextWindow: null,
        maxTokens: null,
        reasoning: null,
        reasoningEffort: null,
      },
      corporateCa: { bundleSha256: "c".repeat(64) },
    },
    applicationEnvironment: {},
  };
}

function packageIdentity() {
  return {
    kind: "agent-runtime" as const,
    id: "haystack-agent",
    packageVersion: "0.1.0",
    contentDigest: "d".repeat(64),
  };
}

function preparationInput(request: HarnessStartupRequest) {
  return {
    inference: {
      selectedProvider: request.settings.inference.upstreamProvider,
      model: request.settings.inference.model,
      endpointUrl: null,
      resolvedContextWindow: null,
      reasoningEnabled: null,
      reasoningEffort: null,
      candidates: [
        {
          requestedApi: "openai-completions" as const,
          routeProvider: request.settings.inference.routeProvider,
          routedBaseUrl: request.settings.inference.routedBaseUrl,
          api: "openai-completions" as const,
          primaryModelRef: "inference/nvidia/nemotron",
          compatibility: null,
        },
      ],
    },
    dashboard: {
      managed: false,
      url: "",
      port: 0,
      bindAddress: null,
      wslExposure: false,
      forwarding: { enabled: false, publicPort: null, internalPort: null, tuiEnabled: false },
    },
    webSearch: null,
    tools: request.settings.tools,
    messagingPlan: null,
    approvalMode: "disabled" as const,
    observabilityEnabled: false,
    proxy: request.settings.proxy,
    environment: {},
    corporateCa: request.settings.corporateCa,
    credentialProxyPresent: false,
  };
}

describe("Haystack Agent startup adapter", () => {
  it("prepares the supported headless profile from generic core input", () => {
    const request = startupRequest();

    expect(
      adapter.prepareStartupProfile({
        packageId: request.packageId,
        harnessPackage: packageIdentity(),
        phase: "initial",
        previousDesiredState: null,
        input: preparationInput(request),
      }),
    ).toEqual({
      kind: "prepared",
      desiredState: request.settings,
      credentialProxyReplayRequired: false,
      dashboardRemoteBindPrepared: false,
    });
  });

  it("owns durable defaults and preserves them while reconciling core settings", () => {
    const request = startupRequest();
    const profileRequest = {
      packageId: request.packageId,
      harnessPackage: packageIdentity(),
      desiredState: request.settings,
    };
    const initial = adapter.buildInitialStartupProfile(profileRequest);
    if (initial.kind !== "package-config") throw new Error(initial.reason);

    expect(initial.packageConfig).toEqual({
      settings: request.settings,
      runtime: {
        temperature: 0,
        maxTurns: 8,
        systemInstruction:
          "Answer the user's request directly. Do not claim tools or durable memory.",
      },
    });
    const receiptRequest: HarnessPackageStartupRequest<StartupPackageConfig> = {
      profileKind: "package",
      packageId: request.packageId,
      harnessPackage: packageIdentity(),
      packageConfig: initial.packageConfig as StartupPackageConfig,
      corporateCa: request.settings.corporateCa,
      applicationEnvironment: {},
    };
    expect(adapter.buildStartupPlan(receiptRequest)).toEqual(adapter.buildStartupPlan(request));
    expect(
      adapter.reconcileStartupProfile({
        ...profileRequest,
        currentPackageConfig: initial.packageConfig,
      }),
    ).toEqual({ kind: "package-config", packageConfig: initial.packageConfig, changed: false });

    const currentPackageConfig = {
      ...initial.packageConfig,
      runtime: {
        temperature: 0.25,
        maxTurns: 12,
        systemInstruction: "Answer briefly.",
      },
    } as StartupPackageConfig;
    const desiredState = {
      ...request.settings,
      inference: { ...request.settings.inference, model: "nvidia/updated-model" },
    };
    expect(
      adapter.reconcileStartupProfile({
        ...profileRequest,
        desiredState,
        currentPackageConfig,
      }),
    ).toEqual({
      kind: "package-config",
      packageConfig: { settings: desiredState, runtime: currentPackageConfig.runtime },
      changed: true,
    });
  });

  it("renders finite image inputs, state effects, corporate CA, and trusted proxy material", () => {
    const plan = adapter.buildStartupPlan(startupRequest());

    expect(plan.configurationEnvironment).toEqual({
      NEMOCLAW_INFERENCE_API: "openai-completions",
      NEMOCLAW_INFERENCE_BASE_URL: "https://inference.local/v1",
      NEMOCLAW_MAX_TURNS: "8",
      NEMOCLAW_MODEL: "nvidia/nemotron",
      NEMOCLAW_SYSTEM_INSTRUCTION:
        "Answer the user's request directly. Do not claim tools or durable memory.",
      NEMOCLAW_TEMPERATURE: "0",
    });
    expect(plan.managedState).toEqual({
      root: "/sandbox/.haystack-agent",
      files: ["fabric.json"],
      directories: ["fabric-artifacts"],
    });
    expect(plan.materials).toEqual([
      {
        kind: "corporate-ca-handoff",
        legacyInput: "NEMOCLAW_CORPORATE_CA_B64",
        expectedSha256: "c".repeat(64),
      },
      expect.objectContaining({
        path: "/usr/local/share/nemoclaw/haystack-proxy-host",
        contents: "10.200.0.1\n",
      }),
      expect.objectContaining({
        path: "/usr/local/share/nemoclaw/haystack-proxy-port",
        contents: "3128\n",
      }),
    ]);
    expect(plan.actions).toEqual([{ kind: "generate-config", runAs: "sandbox" }]);
  });

  it("rejects undeclared tuning and unsupported capability input", () => {
    const request = startupRequest();
    expect(() =>
      adapter.prepareStartupProfile({
        packageId: request.packageId,
        harnessPackage: packageIdentity(),
        phase: "initial",
        previousDesiredState: null,
        input: { ...preparationInput(request), environment: { NEMOCLAW_TEMPERATURE: "0.5" } },
      }),
    ).toThrow("package-specific startup environment is not supported");
    expect(() =>
      adapter.buildStartupPlan({
        ...request,
        settings: {
          ...request.settings,
          dashboard: { agent: "haystack-agent", mode: "loopback" },
        },
      }),
    ).toThrow("unsupported package behavior");

    const initial = adapter.buildInitialStartupProfile({
      packageId: request.packageId,
      harnessPackage: packageIdentity(),
      desiredState: request.settings,
    });
    if (initial.kind !== "package-config") throw new Error(initial.reason);
    expect(() =>
      adapter.buildStartupPlan({
        profileKind: "package",
        packageId: request.packageId,
        harnessPackage: packageIdentity(),
        packageConfig: {
          ...initial.packageConfig,
          runtime: { maxTurns: 33, temperature: 0, systemInstruction: "Answer directly." },
        } as StartupPackageConfig,
        corporateCa: request.settings.corporateCa,
        applicationEnvironment: {},
      }),
    ).toThrow("maxTurns must be an integer between 1 and 32");
  });
});
