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
    packageId: "pi",
    settings: {
      configuration: { agent: "pi" },
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
      dashboard: { agent: "pi", mode: "disabled" },
      tools: { disclosure: "progressive", enabledGateways: [] },
      messaging: { plan: null },
      tuning: {
        contextWindow: 131_072,
        maxTokens: 8192,
        reasoning: true,
        reasoningEffort: null,
      },
      corporateCa: { bundleSha256: null },
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
      contentDigest: "d".repeat(64),
    },
    packageConfig: { settings: legacy.settings } as StartupPackageConfig,
    corporateCa: legacy.settings.corporateCa,
    applicationEnvironment: legacy.applicationEnvironment,
  };
}

describe("Pi startup adapter", () => {
  it("prepares the existing startup semantics from the generic package input", () => {
    const legacy = request();
    const result = adapter.prepareStartupProfile({
      packageId: "pi",
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
              requestedApi: "openai-completions",
              routeProvider: legacy.settings.inference.routeProvider,
              routedBaseUrl: legacy.settings.inference.routedBaseUrl,
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
        environment: {
          NEMOCLAW_CONTEXT_WINDOW: "131072",
          NEMOCLAW_MAX_TOKENS: "8192",
          NEMOCLAW_REASONING: "true",
        },
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

  it("hands tuning to configuration while keeping the long-running route minimal", () => {
    const plan = adapter.buildStartupPlan(request());

    expect(plan.configurationEnvironment).toMatchObject({
      NEMOCLAW_CONTEXT_WINDOW: "131072",
      NEMOCLAW_INFERENCE_BASE_URL: "https://inference.local/v1",
      NEMOCLAW_MAX_TOKENS: "8192",
      NEMOCLAW_REASONING: "true",
    });
    expect(plan.runtimeEnvironment).not.toHaveProperty("NEMOCLAW_INFERENCE_BASE_URL");
    expect(plan.runtimeEnvironment).not.toHaveProperty("NEMOCLAW_CONTEXT_WINDOW");
    expect(plan.materials).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "/usr/local/share/nemoclaw/pi-proxy-host",
          contents: "10.200.0.1\n",
        }),
      ]),
    );
    expect(plan.actions).toEqual([{ kind: "generate-config", runAs: "sandbox" }]);
  });
});
