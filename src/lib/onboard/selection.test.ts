// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";

const requireDist = createRequire(import.meta.url);
const onboardSession = requireDist("../state/onboard-session.js");
const { selection } = requireDist(
  "./sandbox-registration.ts",
) as typeof import("./sandbox-registration");

describe("selection", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not borrow endpoint credential or NIM metadata from an unrelated session", () => {
    vi.spyOn(onboardSession, "loadSession").mockReturnValue({
      sandboxName: "other",
      provider: "compatible-endpoint",
      model: "llama",
      endpointUrl: "https://wrong.test/v1",
      credentialEnv: "WRONG_KEY",
      compatibleEndpointReasoning: "true",
      compatibleEndpointReasoningEffort: null,
      nimContainer: "wrong",
    });

    expect(
      selection("demo", "compatible-endpoint", "llama", "openai-completions", "onboard"),
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
    vi.spyOn(onboardSession, "loadSession").mockReturnValue({
      sandboxName: "demo",
      provider: "compatible-endpoint",
      model: "llama",
      endpointUrl: "https://right.test/v1",
      credentialEnv: "COMPATIBLE_API_KEY",
      compatibleEndpointReasoning: "true",
      compatibleEndpointReasoningEffort: "high",
      nimContainer: "nim-right",
    });

    expect(
      selection("demo", "compatible-endpoint", "llama", "openai-completions", "onboard"),
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
