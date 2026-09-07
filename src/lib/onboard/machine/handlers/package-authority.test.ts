// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { createSession } from "../../../state/onboard-session";
import { handleProviderInferenceState } from "./provider-inference";
import { baseOptions, baseSelection, createDeps } from "./provider-inference.test-support";

function expectedSetupOptions(sessionId: string, harnessPackageAuthority: Record<string, unknown>) {
  return {
    gatewayName: "nemoclaw",
    allowToolsIncompatible: false,
    endpointSource: null,
    reservationSessionId: sessionId,
    harnessPackageAuthority,
    preferredInferenceApi: "openai-responses",
    providerAuthMethod: null,
  };
}

describe("provider inference package authority", () => {
  it("uses a future package's receipt-pinned provider/API override during onboarding", async () => {
    const harnessPackageAuthority = {
      harnessPackage: {
        kind: "agent-runtime" as const,
        id: "future-harness",
        packageVersion: "1.0.0-test",
        contentDigest: "f".repeat(64),
      },
      harnessPackageMigration: null,
    } as const;
    const setupNim = vi.fn(async () => ({
      ...baseSelection,
      provider: "compatible-anthropic-endpoint",
      preferredInferenceApi: "anthropic-messages",
    }));
    const { deps, calls } = createDeps({
      setupNim,
      revalidateHarnessPackageAuthority: () => harnessPackageAuthority,
    });
    const session = createSession({
      agent: "future-harness",
      harnessPackage: harnessPackageAuthority.harnessPackage,
    });
    calls.complete.mockResolvedValue(session);

    await handleProviderInferenceState({
      ...baseOptions(deps, session),
      agent: {
        name: "future-harness",
        inference: {
          providerApiOverrides: [
            { provider: "compatible-anthropic-endpoint", api: "openai-completions" },
          ],
        },
      },
    });

    const setupCalls = setupNim.mock.calls as unknown as readonly (readonly unknown[])[];
    expect(setupCalls[0]?.[9]).toEqual(harnessPackageAuthority.harnessPackage);

    expect(calls.setupInference).toHaveBeenCalledWith(
      "my-assistant",
      "nvidia/test",
      "compatible-anthropic-endpoint",
      "https://integrate.api.nvidia.com/v1",
      "NVIDIA_INFERENCE_API_KEY",
      null,
      [],
      expect.objectContaining({
        harnessPackageAuthority,
        providerAuthMethod: null,
        preferredInferenceApi: "openai-completions",
      }),
    );
  });

  it("passes the exact Session package authority into inference setup", async () => {
    const harnessPackageAuthority = {
      harnessPackage: {
        kind: "agent-runtime" as const,
        id: "openclaw",
        packageVersion: "1.0.0-test",
        contentDigest: "a".repeat(64),
      },
      harnessPackageMigration: null,
    } as const;
    const revalidateHarnessPackageAuthority = vi.fn(() => harnessPackageAuthority);
    const { deps, calls } = createDeps({ revalidateHarnessPackageAuthority });
    const session = createSession({
      harnessPackage: harnessPackageAuthority.harnessPackage,
      harnessPackageMigration: null,
    });
    calls.complete.mockResolvedValue(session);

    await handleProviderInferenceState(baseOptions(deps, session));

    expect(calls.setupInference).toHaveBeenCalledWith(
      "my-assistant",
      "nvidia/test",
      "nvidia-prod",
      "https://integrate.api.nvidia.com/v1",
      "NVIDIA_INFERENCE_API_KEY",
      null,
      [],
      expectedSetupOptions(session.sessionId, harnessPackageAuthority),
    );
    expect(revalidateHarnessPackageAuthority).toHaveBeenCalled();
  });

  it("rejects package drift before provider, credential, or route mutation", async () => {
    const revalidateHarnessPackageAuthority = vi.fn(() => {
      throw new Error("onboarding session harness package authority changed");
    });
    const { deps, calls } = createDeps({ revalidateHarnessPackageAuthority });

    await expect(handleProviderInferenceState(baseOptions(deps))).rejects.toThrow(
      /harness package authority changed/u,
    );

    expect(calls.setupNim).not.toHaveBeenCalled();
    expect(calls.setupInference).not.toHaveBeenCalled();
    expect(calls.reconcileRouter).not.toHaveBeenCalled();
    expect(calls.reupsertRoutedProvider).not.toHaveBeenCalled();
    expect(calls.reserveRoute).not.toHaveBeenCalled();
    expect(calls.updateSandbox).not.toHaveBeenCalled();
    expect(calls.deleteEnv).not.toHaveBeenCalled();
  });
});
