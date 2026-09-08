// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { HarnessConfigAdapterModule } from "@nvidia/nemoclaw-harness-contract";
import { describe, expect, it } from "vitest";

import { loadPackageHostModule } from "../helpers/host-module";

const adapter = loadPackageHostModule<HarnessConfigAdapterModule>("config-adapter.cts");
const target = {
  directory: "/sandbox/.hermes",
  file: "config.yaml",
  format: "yaml",
  sensitiveFiles: ["/sandbox/.hermes/.config-hash", "/sandbox/.hermes/.env"],
} as const;

describe("Hermes inference configuration adapter", () => {
  it("describes inference configuration as mutable with its provider override", () => {
    expect(adapter.describeInferenceConfig({ target })).toEqual({
      kind: "mutable",
      providerApiOverrides: [
        { provider: "compatible-anthropic-endpoint", api: "openai-completions" },
      ],
    });
  });

  it("describes the package-owned mutable configuration probe", () => {
    expect(
      adapter.describeMutableConfig({ target, sandboxUid: null, sandboxGid: null }),
    ).toMatchObject({
      kind: "probe",
      probe: {
        command: expect.arrayContaining([
          "/usr/bin/setpriv",
          "/sandbox/.hermes",
          "/sandbox/.hermes/config.yaml",
          "/sandbox/.hermes/.config-hash",
          "/sandbox/.hermes/.env",
        ]),
        timeoutSeconds: 20,
        failureMessage: "Hermes mutable configuration posture could not be verified.",
        success: { kind: "exit-zero" },
      },
    });
  });

  it("translates a managed route into the complete Hermes provider grammar", () => {
    const plan = adapter.prepareInferenceConfig({
      target,
      config: {
        _nemoclaw_upstream: {
          provider: "old-provider",
          provider_key: "old-provider",
          model: "old-model",
        },
        model: { default: "old-model", temperature: 0.2 },
        providers: { "old-provider": { name: "old-provider" }, retained: { name: "retained" } },
        custom_providers: [{ name: "old-provider" }, { name: "retained" }],
        terminal: { backend: "local" },
      },
      route: {
        upstreamProvider: "anthropic-prod",
        model: "claude-sonnet-4-6",
        providerKey: "anthropic",
        primaryModelRef: "anthropic/claude-sonnet-4-6",
        baseUrl: "https://inference.local",
        api: "anthropic-messages",
        compatibility: null,
      },
      contextWindow: 200_000,
      reasoning: { effort: null, explicit: false },
    });

    expect(plan).toMatchObject({
      kind: "mutation",
      changed: true,
      postCommit: {
        configSync: "required",
        gatewayRestart: { kind: "not-required" },
        sandboxReconcile: {
          kind: "command",
          trigger: "after-config-sync",
          command: ["/usr/bin/python3", "-I", "/usr/local/lib/nemoclaw/inference-reconcile.py"],
          timeoutSeconds: 30,
        },
      },
      config: {
        _nemoclaw_upstream: {
          provider: "anthropic-prod",
          provider_key: "anthropic-prod",
          model: "claude-sonnet-4-6",
        },
        model: {
          default: "claude-sonnet-4-6",
          provider: "custom",
          base_url: "https://inference.local",
          api_key: "sk-OPENSHELL-PROXY-REWRITE",
          api_mode: "anthropic_messages",
          context_length: 200_000,
        },
        providers: {
          retained: { name: "retained" },
          "anthropic-prod": {
            name: "anthropic-prod",
            api: "https://inference.local",
            api_key: "sk-OPENSHELL-PROXY-REWRITE",
            default_model: "claude-sonnet-4-6",
            discover_models: true,
            transport: "anthropic_messages",
          },
        },
        custom_providers: [
          { name: "retained" },
          {
            name: "anthropic-prod",
            base_url: "https://inference.local",
            api_key: "sk-OPENSHELL-PROXY-REWRITE",
            discover_models: true,
            api_mode: "anthropic_messages",
          },
        ],
        terminal: { backend: "local" },
      },
    });
  });
});
