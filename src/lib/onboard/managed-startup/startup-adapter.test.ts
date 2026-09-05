// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Buffer } from "node:buffer";

import type { HarnessStartupRequest } from "@nvidia/nemoclaw-harness-contract";
import { describe, expect, it } from "vitest";

import { buildHarnessStartupPlanFromSource, validateHarnessStartupPlan } from "./agent-environment";

const request: HarnessStartupRequest = {
  packageId: "future-harness",
  settings: {
    configuration: {},
    inference: {
      routeProvider: "inference",
      upstreamProvider: "nvidia",
      model: "nvidia/model",
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
    dashboard: { mode: "disabled" },
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

function sourceFor(plan: unknown): { readonly filename: string; readonly source: string } {
  return {
    filename: "/fixture/startup-adapter.cjs",
    source: `module.exports = { buildStartupPlan() { return ${JSON.stringify(plan)}; } };`,
  };
}

function futurePlan(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    packageId: "future-harness",
    configurationEnvironment: {
      FUTURE_CONFIG_B64: {
        kind: "canonical-json-base64",
        value: { zebra: 1, alpha: true },
      },
    },
    runtimeEnvironment: { FUTURE_MODE: "managed" },
    applicationRuntime: { exportEnvironment: {}, unsetEnvironment: [] },
    materials: [
      {
        kind: "corporate-ca-handoff",
        legacyInput: "NEMOCLAW_CORPORATE_CA_B64",
        expectedSha256: null,
      },
    ],
    actions: [{ kind: "generate-config", runAs: "sandbox" }],
  };
}

describe("harness startup adapter boundary", () => {
  it("loads an unknown package through the same typed finite-plan path", () => {
    const result = buildHarnessStartupPlanFromSource(request, sourceFor(futurePlan()));

    expect(result.agent).toBe("future-harness");
    expect(result.configurationEnvironment.FUTURE_CONFIG_B64).toBe(
      Buffer.from('{"alpha":true,"zebra":1}', "utf8").toString("base64"),
    );
    expect(result.actions).toEqual([{ kind: "generate-config", runAs: "sandbox" }]);
  });

  it("rejects arbitrary command actions and unsafe root material paths", () => {
    expect(() =>
      validateHarnessStartupPlan(
        { ...futurePlan(), actions: [{ kind: "run-command", argv: ["sh", "-c", "id"] }] },
        "future-harness",
      ),
    ).toThrow(/action kind is unsupported/u);
    expect(() =>
      validateHarnessStartupPlan(
        {
          ...futurePlan(),
          materials: [
            ...(futurePlan().materials as unknown[]),
            {
              kind: "root-owned-file",
              legacyInput: "FUTURE_MODE",
              path: "/etc/shadow",
              contents: "bad\n",
              owner: "root",
              group: "root",
              mode: 0o444,
            },
          ],
        },
        "future-harness",
      ),
    ).toThrow(/root-owned material is invalid/u);
  });

  it("rejects credential-shaped environment names and package cross-dispatch", () => {
    expect(() =>
      validateHarnessStartupPlan(
        { ...futurePlan(), runtimeEnvironment: { FUTURE_API_KEY: "not-a-real-secret" } },
        "future-harness",
      ),
    ).toThrow(/unsafe name/u);
    expect(() => validateHarnessStartupPlan(futurePlan(), "another-harness")).toThrow(
      /identity does not match/u,
    );
  });
});
