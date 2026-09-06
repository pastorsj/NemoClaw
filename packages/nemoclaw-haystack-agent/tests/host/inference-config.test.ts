// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { HarnessConfigAdapterModule } from "@nvidia/nemoclaw-harness-contract";
import { describe, expect, it } from "vitest";

import { loadPackageHostModule } from "../helpers/host-module";

const adapter = loadPackageHostModule<HarnessConfigAdapterModule>("config-adapter.cts");
const target = {
  directory: "/sandbox/.haystack-agent",
  file: "fabric.json",
  format: "json",
  sensitiveFiles: [],
} as const;

describe("Haystack Agent inference configuration adapter", () => {
  it("explicitly refuses runtime mutation of its generated config", () => {
    const reason =
      "The sandbox image generates the Haystack Agent config. Re-onboard to change it.";
    expect(adapter.describeInferenceConfig({ target })).toEqual({ kind: "unsupported", reason });
    expect(
      adapter.prepareInferenceConfig({
        target,
        config: {},
        route: {
          upstreamProvider: "nvidia-prod",
          model: "nvidia/model",
          providerKey: "inference",
          primaryModelRef: "inference/nvidia/model",
          baseUrl: "https://inference.local/v1",
          api: "openai-completions",
          compatibility: null,
        },
        contextWindow: null,
        reasoning: { effort: null, explicit: false },
      }),
    ).toEqual({ kind: "unsupported", reason });
  });
});
