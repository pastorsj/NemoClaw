// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { HarnessConfigAdapterModule } from "@nvidia/nemoclaw-harness-contract";
import { describe, expect, it } from "vitest";

import { loadPackageHostModule } from "../helpers/host-module";

const adapter = loadPackageHostModule<HarnessConfigAdapterModule>("config-adapter.cts");
const target = {
  directory: "/sandbox/.deepagents",
  file: "config.toml",
  format: "toml",
  sensitiveFiles: ["/sandbox/.deepagents/.config-hash", "/sandbox/.deepagents/.env"],
} as const;

describe("Deep Agents inference configuration adapter", () => {
  it("explicitly refuses runtime mutation of its image-owned config", () => {
    const reason =
      "This configuration is materialized by the sandbox image. Re-onboard to change it.";
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
