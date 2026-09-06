// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { HarnessConfigAdapterModule } from "@nvidia/nemoclaw-harness-contract";
import { describe, expect, it } from "vitest";

import { loadPackageHostModule } from "../helpers/host-module";

const adapter = loadPackageHostModule<HarnessConfigAdapterModule>("config-adapter.cts");
const target = {
  directory: "/sandbox/.openclaw",
  file: "openclaw.json",
  format: "json",
  sensitiveFiles: ["/sandbox/.openclaw/.config-hash"],
} as const;

describe("OpenClaw inference configuration adapter", () => {
  it("translates a managed route without losing package-native model metadata", () => {
    const plan = adapter.prepareInferenceConfig({
      target,
      config: {
        agents: {
          defaults: { model: { primary: "inference/old-model" } },
          list: [{ id: "main", default: true, model: "inference/old-model" }],
        },
        models: {
          providers: {
            inference: {
              api: "openai-completions",
              apiKey: "unused",
              headers: { "X-Existing": "keep" },
              models: [{ id: "old-model", maxTokens: 8192, reasoning: true }],
            },
          },
        },
      },
      route: {
        upstreamProvider: "compatible-endpoint",
        model: "anthropic/claude-sonnet",
        providerKey: "anthropic",
        primaryModelRef: "anthropic/anthropic/claude-sonnet",
        baseUrl: "https://inference.local",
        api: "anthropic-messages",
        compatibility: { supportsStore: false },
      },
      contextWindow: 131_072,
      reasoning: { effort: null, explicit: false },
    });

    expect(plan).toMatchObject({
      kind: "mutation",
      changed: true,
      postCommit: {
        configSync: "best-effort",
        gatewayRestart: {
          kind: "when-api-changes",
          previousApi: "openai-completions",
        },
        sandboxReconcile: {
          kind: "command",
          trigger: "when-config-changes",
          command: [
            "/usr/bin/python3",
            "-I",
            "/usr/local/lib/nemoclaw/openclaw-startup/inference-reconcile.py",
          ],
          timeoutSeconds: 90,
        },
      },
      config: {
        agents: {
          defaults: { model: { primary: "anthropic/anthropic/claude-sonnet" } },
          list: [{ id: "main", default: true, model: "anthropic/anthropic/claude-sonnet" }],
        },
        models: {
          mode: "merge",
          providers: {
            anthropic: {
              api: "anthropic-messages",
              apiKey: "unused",
              baseUrl: "https://inference.local",
              headers: { "X-NemoClaw-Upstream-Provider": "compatible-endpoint" },
              models: [
                {
                  id: "anthropic/claude-sonnet",
                  name: "anthropic/anthropic/claude-sonnet",
                  contextWindow: 131_072,
                  maxTokens: 8192,
                  compat: { supportsStore: false },
                },
              ],
            },
          },
        },
      },
    });
  });

  it("rejects a target outside the package manifest", () => {
    expect(() =>
      adapter.prepareInferenceConfig({
        target: { ...target, directory: "/sandbox/.other" },
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
    ).toThrow(/target does not match/u);
  });
});
