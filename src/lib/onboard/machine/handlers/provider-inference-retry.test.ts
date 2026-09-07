// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { createSession } from "../../../state/onboard-session";
import { handleProviderInferenceState } from "./provider-inference";
import { baseOptions, baseSelection, createDeps } from "./provider-inference.test-support";

function setupOptions(session: { sessionId: string }, overrides: Record<string, unknown> = {}) {
  return {
    gatewayName: "nemoclaw",
    allowToolsIncompatible: false,
    endpointSource: null,
    reservationSessionId: session.sessionId,
    harnessPackageAuthority: { harnessPackage: null, harnessPackageMigration: null },
    providerAuthMethod: null,
    ...overrides,
  };
}

describe("handleProviderInferenceState retries", () => {
  it("returns to provider selection when inference setup requests a retry", async () => {
    const setupNim = vi
      .fn()
      .mockResolvedValueOnce({ ...baseSelection, model: "bad" })
      .mockResolvedValueOnce({ ...baseSelection, model: "good" });
    const setupInference = vi
      .fn()
      .mockResolvedValueOnce({ retry: "selection" as const })
      .mockResolvedValueOnce({ ok: true as const });
    const { deps, calls } = createDeps({ setupNim, setupInference });

    const result = await handleProviderInferenceState(baseOptions(deps));

    expect(setupNim).toHaveBeenCalledTimes(2);
    expect(setupNim).toHaveBeenNthCalledWith(
      1,
      { type: "nvidia" },
      null,
      null,
      true,
      "nemoclaw",
      expect.any(Function),
      expect.any(Function),
      expect.any(String),
      expect.any(Function),
    );
    expect(setupNim).toHaveBeenNthCalledWith(
      2,
      { type: "nvidia" },
      "my-assistant",
      null,
      false,
      "nemoclaw",
      expect.any(Function),
      expect.any(Function),
      expect.any(String),
      expect.any(Function),
    );
    expect(setupInference).toHaveBeenCalledTimes(2);
    expect(result.model).toBe("good");
    expect(calls.startStep).toHaveBeenCalledWith("provider_selection");
    expect(result.retryStateResults).toEqual([
      {
        type: "transition",
        next: "provider_selection",
        transitionKind: "retry",
        updates: undefined,
        metadata: {
          state: "inference",
          provider: "nvidia-prod",
          model: "bad",
          reason: "selection_retry",
        },
      },
    ]);
    expect(result.stateResult).toMatchObject({ next: "sandbox", transitionKind: "advance" });
    expect(
      result.stateResults.map((stateResult) => [stateResult.next, stateResult.transitionKind]),
    ).toEqual([
      ["inference", "advance"],
      ["provider_selection", "retry"],
      ["inference", "advance"],
      ["sandbox", "advance"],
    ]);
  });

  it("forwards allowToolsIncompatible from provider selection into setupInference (#4241)", async () => {
    const setupNim = vi.fn(async () => ({
      ...baseSelection,
      provider: "ollama-local",
      model: "tinyllama:1.1b",
      endpointUrl: "http://127.0.0.1:11434/v1",
      credentialEnv: null,
      allowToolsIncompatible: true,
    }));
    const { deps, calls } = createDeps({ setupNim });
    const session = createSession();
    calls.complete.mockResolvedValue(session);

    await handleProviderInferenceState(baseOptions(deps, session));

    expect(calls.setupInference).toHaveBeenCalledWith(
      "my-assistant",
      "tinyllama:1.1b",
      "ollama-local",
      "http://127.0.0.1:11434/v1",
      null,
      null,
      [],
      setupOptions(session, {
        allowToolsIncompatible: true,
        preferredInferenceApi: "openai-responses",
      }),
    );
  });
});
