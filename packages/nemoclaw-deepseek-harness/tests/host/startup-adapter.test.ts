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

function legacyRequest(): HarnessStartupRequest {
  return {
    packageId: "deepseek-harness",
    settings: {
      configuration: { agent: "deepseek-harness" },
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
      dashboard: { agent: "deepseek-harness", mode: "disabled" },
      tools: { disclosure: "progressive", enabledGateways: [] },
      messaging: { plan: null },
      tuning: {
        contextWindow: null,
        maxTokens: null,
        reasoning: null,
        reasoningEffort: null,
      },
      corporateCa: { bundleSha256: null },
    },
    applicationEnvironment: {},
  };
}

function packageIdentity() {
  return {
    kind: "agent-runtime" as const,
    id: "deepseek-harness",
    packageVersion: "0.1.0",
    contentDigest: "d".repeat(64),
  };
}

describe("DeepSeek Harness startup adapter", () => {
  it("prepares its supported terminal profile from generic core input", () => {
    const legacy = legacyRequest();
    const result = adapter.prepareStartupProfile({
      packageId: legacy.packageId,
      harnessPackage: packageIdentity(),
      phase: "initial",
      previousDesiredState: null,
      input: {
        inference: {
          selectedProvider: "nvidia",
          model: legacy.settings.inference.model,
          endpointUrl: null,
          resolvedContextWindow: null,
          reasoningEnabled: null,
          reasoningEffort: null,
          candidates: [
            {
              requestedApi: "openai-completions",
              routeProvider: "inference",
              routedBaseUrl: "https://inference.local/v1",
              api: "openai-completions",
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
        tools: legacy.settings.tools,
        messagingPlan: null,
        approvalMode: "disabled",
        observabilityEnabled: false,
        proxy: legacy.settings.proxy,
        environment: {},
        corporateCa: legacy.settings.corporateCa,
        credentialProxyPresent: false,
      },
    });

    expect(result).toEqual({
      kind: "prepared",
      desiredState: legacy.settings,
      credentialProxyReplayRequired: false,
      dashboardRemoteBindPrepared: false,
    });
  });

  it("builds equivalent plans from initial and receipt-backed configuration", () => {
    const legacy = legacyRequest();
    const initial = adapter.buildInitialStartupProfile({
      packageId: legacy.packageId,
      harnessPackage: packageIdentity(),
      desiredState: legacy.settings,
    });
    if (initial.kind !== "package-config") throw new Error(initial.reason);

    const receiptRequest: HarnessPackageStartupRequest<StartupPackageConfig> = {
      profileKind: "package",
      packageId: legacy.packageId,
      harnessPackage: packageIdentity(),
      packageConfig: initial.packageConfig as StartupPackageConfig,
      corporateCa: legacy.settings.corporateCa,
      applicationEnvironment: {},
    };
    expect(adapter.buildStartupPlan(receiptRequest)).toEqual(adapter.buildStartupPlan(legacy));
    expect(
      adapter.reconcileStartupProfile({
        packageId: legacy.packageId,
        harnessPackage: packageIdentity(),
        desiredState: legacy.settings,
        currentPackageConfig: initial.packageConfig,
      }),
    ).toEqual({ kind: "package-config", packageConfig: initial.packageConfig, changed: false });
  });

  it("owns the image inputs, state effects, and trusted proxy material", () => {
    const plan = adapter.buildStartupPlan(legacyRequest());

    expect(plan.configurationEnvironment).toEqual({
      NEMOCLAW_INFERENCE_API: "openai-completions",
      NEMOCLAW_INFERENCE_BASE_URL: "https://inference.local/v1",
      NEMOCLAW_MODEL: "nvidia/nemotron",
    });
    expect(plan.managedState).toEqual({
      root: "/sandbox/.deepseek-harness",
      files: ["fabric.json"],
      directories: ["sessions", "logs", "cache", "fabric-artifacts"],
    });
    expect(plan.materials).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "/usr/local/share/nemoclaw/deepseek-proxy-host",
          contents: "10.200.0.1\n",
        }),
      ]),
    );
    expect(plan.actions).toEqual([{ kind: "generate-config", runAs: "sandbox" }]);
  });
});
