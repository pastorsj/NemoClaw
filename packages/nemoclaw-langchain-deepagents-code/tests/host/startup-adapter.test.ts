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
    packageId: "langchain-deepagents-code",
    settings: {
      configuration: {
        agent: "langchain-deepagents-code",
        autoApprovalMode: "thread-opt-in",
        observabilityEnabled: true,
      },
      inference: {
        routeProvider: "inference",
        upstreamProvider: "openrouter",
        model: "openai/gpt",
        routedBaseUrl: "https://inference.local/v1",
        upstreamEndpointUrl: "https://openrouter.test/v1",
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
      dashboard: { agent: "langchain-deepagents-code", mode: "disabled" },
      tools: { disclosure: "progressive", enabledGateways: [] },
      messaging: { plan: null },
      tuning: {
        contextWindow: null,
        maxTokens: null,
        reasoning: null,
        reasoningEffort: "high",
      },
      corporateCa: { bundleSha256: "c".repeat(64) },
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
      contentDigest: "c".repeat(64),
    },
    packageConfig: { settings: legacy.settings } as StartupPackageConfig,
    corporateCa: legacy.settings.corporateCa,
    applicationEnvironment: legacy.applicationEnvironment,
  };
}

describe("LangChain Deep Agents Code startup adapter", () => {
  it("produces the same plan from receipt-backed package settings", () => {
    const packageRequest = receiptBackedRequest();

    expect(Object.keys(packageRequest.packageConfig)).toEqual(["settings"]);
    expect(adapter.buildStartupPlan(packageRequest)).toEqual(adapter.buildStartupPlan(request()));
  });

  it("keeps native route controls in root-owned materials", () => {
    const plan = adapter.buildStartupPlan(request());

    expect(plan.configurationEnvironment).toMatchObject({
      NEMOCLAW_INFERENCE_BASE_URL: "https://inference.local/v1",
      NEMOCLAW_REASONING_EFFORT: "high",
      NEMOCLAW_UPSTREAM_ENDPOINT_URL: "https://openrouter.test/v1",
    });
    expect(plan.runtimeEnvironment).toMatchObject({ NEMOCLAW_OBSERVABILITY: "1" });
    expect(plan.runtimeEnvironment).not.toHaveProperty("NEMOCLAW_INFERENCE_BASE_URL");
    expect(plan.materials).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "/usr/local/share/nemoclaw/dcode-auto-approval",
          contents: "thread-opt-in\n",
        }),
        expect.objectContaining({
          path: "/usr/local/share/nemoclaw/dcode-upstream-provider",
          contents: "openrouter\n",
        }),
      ]),
    );
    expect(plan.actions).toEqual([{ kind: "generate-config", runAs: "sandbox" }]);
  });
});
