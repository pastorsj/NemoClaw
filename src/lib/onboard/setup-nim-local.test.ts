// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { VllmProfile } from "../inference/vllm";
import * as onboardSession from "../state/onboard-session";
import { makeDeps, makeHostState, unexpected } from "./__test-helpers__/setup-nim-flow";
import type { LocalModelProfilePlan } from "./local-model-profile/integration";
import { createSetupNim, type SetupNimFlowDeps } from "./setup-nim-flow";

beforeEach(() => {
  vi.spyOn(onboardSession, "loadSession").mockReturnValue(null);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("createSetupNim local runtime selection", () => {
  it("rejects an incompatible gateway route before managed llama.cpp install effects", async () => {
    const selection = {
      recipe: {
        metadata: { id: "test.llama.recipe" },
        spec: { model: { servedName: "nvidia-nemotron-3-nano-30b-a3b" } },
      },
    } as never;
    const installManagedLlamaCpp = vi.fn();
    const setupNim = createSetupNim(
      makeDeps({
        isNonInteractive: () => true,
        getNonInteractiveProvider: () => "install-llama-cpp",
        resolveManagedLlamaCppSelection: () => ({ kind: "selected", selection }),
        installManagedLlamaCpp: installManagedLlamaCpp as never,
      }),
    );
    const routeConflict = new Error("gateway route conflicts with managed llama.cpp");
    const routeGuard = vi.fn(() => {
      throw routeConflict;
    });

    await expect(
      setupNim(
        { platform: "spark" } as never,
        "spark-agent",
        null,
        true,
        null,
        "nemoclaw",
        routeGuard,
      ),
    ).rejects.toThrow(routeConflict);
    expect(installManagedLlamaCpp).not.toHaveBeenCalled();
  });

  it("omits managed llama.cpp from the interactive menu when canonical readiness rejects it", async () => {
    const resolveManagedLlamaCppSelection = vi.fn(() => ({
      kind: "rejected" as const,
      reason: "host readiness requirements are unmet",
    }));
    const selectFromNumberedMenu = vi.fn<SetupNimFlowDeps["selectFromNumberedMenu"]>(
      (_rawChoice, _defaultIndex, options) => {
        expect(options.map(({ key }) => key)).not.toContain("install-llama-cpp");
        return options.find(({ key }) => key === "build")!;
      },
    );
    const handleRemoteProviderSelection = vi.fn<SetupNimFlowDeps["handleRemoteProviderSelection"]>(
      async (_args, state) => {
        state.provider = "nvidia-prod";
        state.model = "nvidia/nemotron-3-super-120b-a12b";
        state.endpointUrl = "https://integrate.api.nvidia.com/v1";
        state.credentialEnv = "NVIDIA_INFERENCE_API_KEY";
        state.preferredInferenceApi = "openai-completions";
        return "selected";
      },
    );
    const setupNim = createSetupNim(
      makeDeps({
        prompt: async () => "1",
        selectFromNumberedMenu,
        resolveManagedLlamaCppSelection,
        handleRemoteProviderSelection,
      }),
    );

    await expect(setupNim({ platform: "spark" } as never, "spark-agent")).resolves.toMatchObject({
      provider: "nvidia-prod",
    });
    expect(resolveManagedLlamaCppSelection).toHaveBeenCalledOnce();
  });

  it("keeps existing Spark providers available when optional managed llama.cpp discovery fails", async () => {
    const selectFromNumberedMenu = vi.fn<SetupNimFlowDeps["selectFromNumberedMenu"]>(
      (_rawChoice, _defaultIndex, options) => {
        expect(options.map(({ key }) => key)).not.toContain("install-llama-cpp");
        return options.find(({ key }) => key === "build")!;
      },
    );
    const handleRemoteProviderSelection = vi.fn<SetupNimFlowDeps["handleRemoteProviderSelection"]>(
      async (_args, state) => {
        state.provider = "nvidia-prod";
        state.model = "nvidia/nemotron-3-super-120b-a12b";
        state.endpointUrl = "https://integrate.api.nvidia.com/v1";
        state.credentialEnv = "NVIDIA_INFERENCE_API_KEY";
        state.preferredInferenceApi = "openai-completions";
        return "selected";
      },
    );
    const setupNim = createSetupNim(
      makeDeps({
        prompt: async () => "1",
        selectFromNumberedMenu,
        resolveManagedLlamaCppSelection: () => {
          throw new Error("managed-inference catalog is unavailable");
        },
        handleRemoteProviderSelection,
      }),
    );

    await expect(setupNim({ platform: "spark" } as never, "spark-agent")).resolves.toMatchObject({
      provider: "nvidia-prod",
    });
  });

  it("routes a gated local model profile through its dedicated onboarder", async () => {
    const profile = { name: "DGX Spark", platform: "spark" } as VllmProfile;
    const plan = { runtime: "vllm" } as LocalModelProfilePlan;
    const onboard = vi.fn<NonNullable<SetupNimFlowDeps["localModelProfileIntegration"]>["onboard"]>(
      async (_plan, host, state) => {
        expect(host).toMatchObject({
          hasVllmImage: true,
          sparkHost: true,
          vllmProfile: profile,
          vllmRunning: false,
        });
        state.provider = "vllm-local";
        state.model = "catalog/model";
        state.endpointUrl = "http://127.0.0.1:8000/v1";
        state.credentialEnv = null;
        state.preferredInferenceApi = "openai-completions";
        return "selected";
      },
    );
    const setupNim = createSetupNim(
      makeDeps({
        isNonInteractive: () => true,
        localModelProfileIntegration: { resolvePlan: () => plan, onboard },
        detectInferenceProviderHostState: () =>
          makeHostState({ vllmProfile: profile, hasVllmImage: true }),
        selectFromNumberedMenu: () => unexpected("provider menu"),
      }),
    );

    await expect(
      setupNim({ type: "nvidia", spark: true, platform: "spark" } as never),
    ).resolves.toMatchObject({ provider: "vllm-local", model: "catalog/model" });
    expect(onboard).toHaveBeenCalledOnce();
  });

  it("returns interactive occupied-port selection to the provider menu", async () => {
    vi.stubEnv("NEMOCLAW_PROVIDER", "");
    const profile = { name: "DGX Spark" } as VllmProfile;
    const prompt = vi.fn(async () => "1");
    const error = vi.fn();
    const installVllm = vi.fn<SetupNimFlowDeps["installVllm"]>();
    const handleVllmSelection = vi.fn<SetupNimFlowDeps["handleVllmSelection"]>();
    const selectedKeys = ["install-vllm", "build"];
    const selectFromNumberedMenu = vi.fn<SetupNimFlowDeps["selectFromNumberedMenu"]>(
      (_rawChoice, _defaultIndex, options) => {
        const key = selectedKeys.shift();
        const selected = options.find((option) => option.key === key);
        expect(selected, `missing provider option ${String(key)}`).toBeDefined();
        return selected!;
      },
    );
    const handleRemoteProviderSelection = vi.fn<SetupNimFlowDeps["handleRemoteProviderSelection"]>(
      async ({ selected }, state) => {
        expect(selected.key).toBe("build");
        state.model = "nvidia/nemotron-3-super-120b-a12b";
        state.provider = "nvidia-prod";
        state.endpointUrl = "https://integrate.api.nvidia.com/v1";
        state.credentialEnv = "NVIDIA_INFERENCE_API_KEY";
        state.preferredInferenceApi = "openai-completions";
        return "selected";
      },
    );
    const setupNim = createSetupNim(
      makeDeps({
        prompt,
        error,
        selectFromNumberedMenu,
        detectInferenceProviderHostState: () =>
          makeHostState({
            vllmRunning: true,
            vllmProfile: profile,
            hasVllmImage: true,
            vllmEntries: [{ key: "install-vllm", label: "Start vLLM (DGX Spark)" }],
          }),
        installVllm,
        handleVllmSelection,
        handleRemoteProviderSelection,
      }),
    );

    await expect(setupNim(null)).resolves.toMatchObject({ provider: "nvidia-prod" });
    expect(prompt).toHaveBeenCalledTimes(2);
    expect(selectFromNumberedMenu).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("only if no other gateway or distributed deployment uses it"),
    );
    expect(error).toHaveBeenCalledWith(expect.stringContaining("NEMOCLAW_VLLM_PORT"));
    expect(installVllm).not.toHaveBeenCalled();
    expect(handleVllmSelection).not.toHaveBeenCalled();
    expect(handleRemoteProviderSelection).toHaveBeenCalledOnce();
  });
});
