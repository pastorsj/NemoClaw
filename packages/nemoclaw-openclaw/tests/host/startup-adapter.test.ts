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

describe("OpenClaw startup adapter", () => {
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
