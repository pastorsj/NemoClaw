// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentDefinition } from "../agent/defs";
import { makeDeps, makeHostState, unexpected } from "./__test-helpers__/setup-nim-flow";
import { detectInferenceProviderHostState } from "./provider-host-state";
import { createSetupNim, type SetupNimFlowDeps, type SetupNimGpu } from "./setup-nim-flow";

afterEach(() => vi.unstubAllEnvs());

describe("fresh Hermes Portable provider selection", () => {
  it("selects managed Ollama without probing or starting host Ollama (#9596)", async () => {
    vi.stubEnv("NEMOCLAW_EXPERIMENTAL_PROFILE", "portable");
    vi.stubEnv("NEMOCLAW_OLLAMA_NO_AUTOSTART", "1");
    const dockerCapture = vi.fn(() => unexpected("default Docker inspection"));
    const hostCommandExists = vi.fn(() => unexpected("host Ollama discovery"));
    const detectHostState = vi.fn((input: Parameters<typeof detectInferenceProviderHostState>[0]) =>
      detectInferenceProviderHostState({
        ...input,
        deps: { dockerCapture, hostCommandExists },
      }),
    );
    const handleRunningOllamaSelection = vi.fn<SetupNimFlowDeps["handleRunningOllamaSelection"]>(
      async () => unexpected("legacy host Ollama selection"),
    );
    const handleInstallOllamaSelection = vi.fn<SetupNimFlowDeps["handleInstallOllamaSelection"]>(
      async () => unexpected("host Ollama installation"),
    );
    const setupNim = createSetupNim(
      makeDeps({
        isNonInteractive: () => true,
        getNonInteractiveProvider: () => "ollama",
        getNonInteractiveModel: () => "qwen3-vl:4b",
        localModelProfileIntegration: {
          resolvePlan: () => null,
          onboard: async () => unexpected("local model profile onboarding"),
        },
        detectInferenceProviderHostState: detectHostState,
        handleRunningOllamaSelection,
        handleInstallOllamaSelection,
      }),
    );

    const result = await setupNim(
      { type: "nvidia" } as SetupNimGpu,
      "portable-hermes",
      { name: "hermes" } as AgentDefinition,
      false,
    );

    expect(detectHostState).not.toHaveBeenCalled();
    expect(dockerCapture).not.toHaveBeenCalled();
    expect(hostCommandExists).not.toHaveBeenCalled();
    expect(handleRunningOllamaSelection).not.toHaveBeenCalled();
    expect(handleInstallOllamaSelection).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      provider: "ollama-local",
      model: "qwen3-vl:4b",
      endpointUrl: null,
      endpointSource: null,
      credentialEnv: null,
      preferredInferenceApi: "openai-completions",
    });
  });

  it("uses the scoped Portable model without showing the OpenClaw Input capability prompt (#9596)", async () => {
    vi.stubEnv("NEMOCLAW_EXPERIMENTAL_PROFILE", "portable");
    const detectHostState = vi.fn(() => makeHostState());
    const handleRunningOllamaSelection = vi.fn(() => unexpected("host Ollama selection"));
    const handleInstallOllamaSelection = vi.fn(() => unexpected("host Ollama installation"));
    const maybePromptForInferenceInputCapability = vi.fn(async () => {});
    const setupNim = createSetupNim(
      makeDeps({
        isNonInteractive: () => false,
        getNonInteractiveProvider: () => "ollama",
        getNonInteractiveModel: () => "qwen3-vl:4b",
        detectInferenceProviderHostState: detectHostState,
        handleRunningOllamaSelection,
        handleInstallOllamaSelection,
        maybePromptForInferenceInputCapability,
      }),
    );

    await expect(
      setupNim(
        { type: "nvidia" } as SetupNimGpu,
        "portable-hermes",
        { name: "hermes" } as AgentDefinition,
        false,
      ),
    ).resolves.toMatchObject({ provider: "ollama-local", model: "qwen3-vl:4b" });

    expect(detectHostState).not.toHaveBeenCalled();
    expect(handleRunningOllamaSelection).not.toHaveBeenCalled();
    expect(handleInstallOllamaSelection).not.toHaveBeenCalled();
    expect(maybePromptForInferenceInputCapability).not.toHaveBeenCalled();
  });

  it("prompts for a Portable model without discovering host runtimes (#9596)", async () => {
    vi.stubEnv("NEMOCLAW_EXPERIMENTAL_PROFILE", "portable");
    const detectHostState = vi.fn(() => makeHostState());
    const handleRunningOllamaSelection = vi.fn(() => unexpected("host Ollama selection"));
    const handleInstallOllamaSelection = vi.fn(() => unexpected("host Ollama installation"));
    const prompt = vi.fn(async () => "prompted-model");
    const setupNim = createSetupNim(
      makeDeps({
        isNonInteractive: () => false,
        getNonInteractiveProvider: () => "ollama",
        getNonInteractiveModel: () => null,
        prompt,
        detectInferenceProviderHostState: detectHostState,
        handleRunningOllamaSelection,
        handleInstallOllamaSelection,
      }),
    );

    await expect(
      setupNim(
        { type: "nvidia" } as SetupNimGpu,
        "portable-hermes",
        { name: "hermes" } as AgentDefinition,
        false,
      ),
    ).resolves.toMatchObject({ provider: "ollama-local", model: "prompted-model" });

    expect(prompt).toHaveBeenCalledWith("  Ollama model id: ");
    expect(detectHostState).not.toHaveBeenCalled();
    expect(handleRunningOllamaSelection).not.toHaveBeenCalled();
    expect(handleInstallOllamaSelection).not.toHaveBeenCalled();
  });

  it("requires an explicit Portable Ollama model in non-interactive mode (#9596)", async () => {
    vi.stubEnv("NEMOCLAW_EXPERIMENTAL_PROFILE", "portable");
    const abortNonInteractive = vi.fn<SetupNimFlowDeps["abortNonInteractive"]>((message) => {
      throw new Error(message);
    });
    const detectHostState = vi.fn(() => makeHostState());
    const setupNim = createSetupNim(
      makeDeps({
        isNonInteractive: () => true,
        getNonInteractiveProvider: () => "ollama",
        getNonInteractiveModel: () => null,
        abortNonInteractive,
        detectInferenceProviderHostState: detectHostState,
      }),
    );

    await expect(
      setupNim(
        { type: "nvidia" } as SetupNimGpu,
        "portable-hermes",
        { name: "hermes" } as AgentDefinition,
        false,
      ),
    ).rejects.toThrow("requires an explicit local model selection");

    expect(abortNonInteractive).toHaveBeenCalledOnce();
    expect(detectHostState).not.toHaveBeenCalled();
  });

  it("keeps the exact Hermes Portable shortcut out of receipt-backed package onboarding", async () => {
    vi.stubEnv("NEMOCLAW_EXPERIMENTAL_PROFILE", "portable");
    const detectHostState = vi.fn(() =>
      makeHostState({ hasOllama: true, ollamaHost: "127.0.0.1", ollamaRunning: true }),
    );
    const handleRunningOllamaSelection = vi.fn<SetupNimFlowDeps["handleRunningOllamaSelection"]>(
      async (_gpu, _requestedModel, _recoveredModel, _ollamaRunning, state) => {
        expect(state.ollamaContextWindowFloor).toBe(64_000);
        state.model = "qwen3-vl:4b";
        state.provider = "ollama-local";
        state.endpointUrl = "http://127.0.0.1:11434/v1";
        state.credentialEnv = null;
        state.preferredInferenceApi = "openai-completions";
        return "selected";
      },
    );
    const setupNim = createSetupNim(
      makeDeps({
        isNonInteractive: () => true,
        getNonInteractiveProvider: () => "ollama",
        getNonInteractiveModel: () => "qwen3-vl:4b",
        detectInferenceProviderHostState: detectHostState,
        handleRunningOllamaSelection,
      }),
    );
    const agent = {
      name: "hermes",
      inference: {
        contextWindowRequirements: [{ provider: "ollama-local", minimumTokens: 64_000 }],
      },
    } as unknown as AgentDefinition;

    await expect(
      setupNim(
        { type: "nvidia" } as SetupNimGpu,
        "portable-hermes",
        agent,
        false,
        null,
        null,
        undefined,
        undefined,
        undefined,
        undefined,
        {
          kind: "agent-runtime",
          id: "hermes",
          packageVersion: "1.0.0-test",
          contentDigest: "a".repeat(64),
        },
      ),
    ).resolves.toMatchObject({ provider: "ollama-local", model: "qwen3-vl:4b" });

    expect(detectHostState).toHaveBeenCalledOnce();
    expect(handleRunningOllamaSelection).toHaveBeenCalledOnce();
  });
});
