// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type { HostLocalInferenceStartupSelection } from "../../runtime-provider/host-local-inference-routing";
import { createSession } from "../../../state/onboard-session";
import { handleProviderInferenceState } from "./provider-inference";
import { baseOptions, baseSelection, createDeps } from "./provider-inference.test-support";

function mismatchedSelection(
  application: "openclaw" | "hermes",
  service: "ollama" | "vllm",
): HostLocalInferenceStartupSelection {
  return {
    runtimeProviderId: "mxc",
    request: { application, service } as HostLocalInferenceStartupSelection["request"],
    resolveRuntimeProvider: () => null,
    prepareGatewayMutation: async () => ({ commit: () => {}, rollback: () => {} }),
  };
}

describe("provider inference host-local authority", () => {
  it("rejects a resolver result for a different accepted application", async () => {
    const setupNim = vi.fn(async () => ({
      ...baseSelection,
      provider: "ollama-local",
      model: "qwen3.5-9b",
      endpointUrl: null,
      credentialEnv: null,
      preferredInferenceApi: "openai-completions",
    }));
    const { deps, calls } = createDeps({
      setupNim,
      resolveHostLocalInferenceStartupSelection: () => mismatchedSelection("hermes", "ollama"),
    });

    await expect(
      handleProviderInferenceState({
        ...baseOptions(deps, createSession()),
        agent: { name: "openclaw" },
        sandboxName: "openclaw-sandbox",
      }),
    ).rejects.toThrow("accepted application");
    expect(calls.setupInference).not.toHaveBeenCalled();
  });

  it("rejects a resolver result cross-wired to a different accepted provider", async () => {
    const setupNim = vi.fn(async () => ({
      ...baseSelection,
      provider: "ollama-local",
      model: "qwen3.5-9b",
      endpointUrl: null,
      credentialEnv: null,
      preferredInferenceApi: "openai-completions",
    }));
    const { deps, calls } = createDeps({
      setupNim,
      resolveHostLocalInferenceStartupSelection: () => mismatchedSelection("openclaw", "vllm"),
    });

    await expect(
      handleProviderInferenceState({
        ...baseOptions(deps, createSession()),
        sandboxName: "openclaw-sandbox",
      }),
    ).rejects.toThrow("accepted provider");
    expect(calls.setupInference).not.toHaveBeenCalled();
  });
});
