// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  buildConfig,
  buildLocalOllamaSmallContextCompaction,
  buildManagedInferenceSafeguardCompaction,
} from "../../config/generate-config.mts";

describe("OpenClaw managed-route compaction policy (#5468, #4781)", () => {
  it("emits a lowered compaction reserve for a small Local Ollama window", () => {
    const config = buildConfig({
      NEMOCLAW_MODEL: "qwen2.5:0.5b",
      NEMOCLAW_PROVIDER_KEY: "inference",
      NEMOCLAW_UPSTREAM_PROVIDER: "ollama-local",
      NEMOCLAW_PRIMARY_MODEL_REF: "inference/qwen2.5:0.5b",
      NEMOCLAW_INFERENCE_BASE_URL: "https://inference.local/v1",
      NEMOCLAW_INFERENCE_API: "openai-completions",
      NEMOCLAW_CONTEXT_WINDOW: "16384",
      NEMOCLAW_MAX_TOKENS: "4096",
      NEMOCLAW_AGENT_TIMEOUT: "600",
    });
    // Reserve exactly the reply budget so the first-turn prompt budget grows
    // from ~8k (OpenClaw default) to contextWindow - maxTokens = 12288.
    expect(config.agents.defaults.compaction).toEqual({
      reserveTokens: 4096,
      reserveTokensFloor: 4096,
    });
  });

  it("uses safeguard compaction for remote managed inference (#4781)", () => {
    const config = buildConfig({
      NEMOCLAW_MODEL: "nvidia/nemotron-3-super-120b-a12b",
      NEMOCLAW_PROVIDER_KEY: "inference",
      NEMOCLAW_UPSTREAM_PROVIDER: "nvidia-prod",
      NEMOCLAW_PRIMARY_MODEL_REF: "inference/nvidia/nemotron-3-super-120b-a12b",
      NEMOCLAW_INFERENCE_BASE_URL: "https://inference.local/v1",
      NEMOCLAW_INFERENCE_API: "openai-completions",
      NEMOCLAW_CONTEXT_WINDOW: "16384",
      NEMOCLAW_MAX_TOKENS: "4096",
      NEMOCLAW_AGENT_TIMEOUT: "600",
    });
    expect(config.agents.defaults.compaction).toEqual({
      mode: "safeguard",
      timeoutSeconds: 120,
      maxHistoryShare: 0.35,
      recentTurnsPreserve: 1,
      qualityGuard: { enabled: true, maxRetries: 0 },
      notifyUser: true,
      truncateAfterCompaction: true,
    });
  });

  it("treats a missing legacy upstream provider as remote managed inference (#4781)", () => {
    expect(
      buildManagedInferenceSafeguardCompaction(
        "inference",
        undefined,
        "https://inference.local/v1",
      ),
    ).toEqual({
      mode: "safeguard",
      timeoutSeconds: 120,
      maxHistoryShare: 0.35,
      recentTurnsPreserve: 1,
      qualityGuard: { enabled: true, maxRetries: 0 },
      notifyUser: true,
      truncateAfterCompaction: true,
    });
  });

  it("leaves OpenClaw's default reserve intact for large Local Ollama windows", () => {
    const config = buildConfig({
      NEMOCLAW_MODEL: "qwen2.5:7b",
      NEMOCLAW_PROVIDER_KEY: "inference",
      NEMOCLAW_UPSTREAM_PROVIDER: "ollama-local",
      NEMOCLAW_PRIMARY_MODEL_REF: "inference/qwen2.5:7b",
      NEMOCLAW_INFERENCE_BASE_URL: "https://inference.local/v1",
      NEMOCLAW_INFERENCE_API: "openai-completions",
      NEMOCLAW_CONTEXT_WINDOW: "131072",
      NEMOCLAW_MAX_TOKENS: "4096",
      NEMOCLAW_AGENT_TIMEOUT: "600",
    });
    expect(config.agents.defaults.compaction).toBeUndefined();
  });

  it("does not enable managed-inference safeguards outside inference.local (#4781)", () => {
    expect(
      buildManagedInferenceSafeguardCompaction(
        "inference",
        "nvidia-prod",
        "https://integrate.api.nvidia.com/v1",
      ),
    ).toBeUndefined();
  });

  it.each(["https://inference.local.evil/v1", "https://inference.local@evil.example/v1"])(
    "rejects a confusing managed-inference hostname %s (#4781)",
    (baseUrl) => {
      expect(
        buildManagedInferenceSafeguardCompaction("inference", "nvidia-prod", baseUrl),
      ).toBeUndefined();
    },
  );

  it("does not enable managed-inference safeguards for another provider key (#4781)", () => {
    expect(
      buildManagedInferenceSafeguardCompaction(
        "nvidia-prod",
        "nvidia-prod",
        "https://inference.local/v1",
      ),
    ).toBeUndefined();
  });

  it("clamps the reserve so the prompt budget never drops below OpenClaw's 8k minimum", () => {
    // A pathological maxTokens must not make the window worse than the default.
    const compaction = buildLocalOllamaSmallContextCompaction("ollama-local", 16384, 99999);
    expect(compaction).toEqual({ reserveTokens: 8384, reserveTokensFloor: 8384 });
    expect(16384 - 8384).toBe(8000);
  });

  it("applies at the 28k threshold boundary and not just above it", () => {
    expect(buildLocalOllamaSmallContextCompaction("ollama-local", 28000, 4096)).toEqual({
      reserveTokens: 4096,
      reserveTokensFloor: 4096,
    });
    expect(buildLocalOllamaSmallContextCompaction("ollama-local", 28001, 4096)).toBeUndefined();
  });
});
