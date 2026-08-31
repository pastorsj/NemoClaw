// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { createSession } from "../../../state/onboard-session";
import { handleProviderInferenceState } from "./provider-inference";
import { baseOptions, createDeps } from "./provider-inference.test-support";

function expectedSetupOptions(sessionId: string, harnessPackageAuthority: Record<string, unknown>) {
  return {
    gatewayName: "nemoclaw",
    allowToolsIncompatible: false,
    endpointSource: null,
    reservationSessionId: sessionId,
    harnessPackageAuthority,
    preferredInferenceApi: "openai-responses",
    revalidatePolicyRequirements: expect.any(Function),
  };
}

describe("provider inference package authority", () => {
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
