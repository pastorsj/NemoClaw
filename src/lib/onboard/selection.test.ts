// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { buildRegistryInferenceSelection } from "./sandbox-registration";

describe("buildRegistryInferenceSelection", () => {
  it("does not borrow endpoint credential or NIM metadata from an unrelated session", () => {
    const unrelatedSession = {
      sandboxName: "other",
      provider: "compatible-endpoint",
      model: "llama",
      endpointUrl: "https://wrong.test/v1",
      credentialEnv: "WRONG_KEY",
      compatibleEndpointReasoning: "true",
      compatibleEndpointReasoningEffort: null,
      nimContainer: "wrong",
    } as const;

    expect(
      buildRegistryInferenceSelection(
        "demo",
        "compatible-endpoint",
        "llama",
        "openai-completions",
        "onboard",
        unrelatedSession,
      ),
    ).toEqual({
      provider: "compatible-endpoint",
      model: "llama",
      endpointUrl: null,
      endpointSource: null,
      credentialEnv: null,
      preferredInferenceApi: "openai-completions",
      compatibleEndpointReasoning: null,
      compatibleEndpointReasoningEffort: null,
      nimContainer: null,
    });
  });

  it("borrows session-scoped metadata only when sandbox provider and model match", () => {
    const matchingSession = {
      sandboxName: "demo",
      provider: "compatible-endpoint",
      model: "llama",
      endpointUrl: "https://right.test/v1",
      credentialEnv: "COMPATIBLE_API_KEY",
      compatibleEndpointReasoning: "true",
      compatibleEndpointReasoningEffort: "high",
      nimContainer: "nim-right",
    } as const;

    expect(
      buildRegistryInferenceSelection(
        "demo",
        "compatible-endpoint",
        "llama",
        "openai-completions",
        "onboard",
        matchingSession,
      ),
    ).toEqual({
      provider: "compatible-endpoint",
      model: "llama",
      endpointUrl: "https://right.test/v1",
      endpointSource: "onboard",
      credentialEnv: "COMPATIBLE_API_KEY",
      preferredInferenceApi: "openai-completions",
      compatibleEndpointReasoning: "true",
      compatibleEndpointReasoningEffort: "high",
      nimContainer: "nim-right",
    });
  });
});
