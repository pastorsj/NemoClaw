// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from "node:module";
import path from "node:path";

import type {
  HarnessStartupAdapterModule,
  HarnessStartupRequest,
} from "@nvidia/nemoclaw-harness-contract";
import { describe, expect, it } from "vitest";

const requireModule = createRequire(import.meta.url);
const adapter = requireModule(
  path.resolve("host/startup-adapter.cts"),
) as HarnessStartupAdapterModule;

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

describe("Pi startup adapter", () => {
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
    expect(plan.integrity).toEqual({ kind: "none" });
  });
});
