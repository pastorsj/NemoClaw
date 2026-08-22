// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readdirSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { discoverTargets } from "../scripts/validate-configs.mts";

describe("config validation target discovery", () => {
  const targets = discoverTargets();
  const filesBySchema = new Map(targets.map((target) => [target.schema, target.files]));
  const sandboxPolicyFiles = filesBySchema.get("schemas/sandbox-policy.schema.json") ?? [];
  const presetFiles = filesBySchema.get("schemas/policy-preset.schema.json") ?? [];
  const repositoryRoot = path.resolve(import.meta.dirname, "..");

  const packagePolicyFiles = readdirSync(path.join(repositoryRoot, "packages"), {
    withFileTypes: true,
  })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("nemoclaw-"))
    .flatMap((packageDirectory) => {
      const packageRoot = path.join(repositoryRoot, "packages", packageDirectory.name);
      return readdirSync(packageRoot, { withFileTypes: true })
        .filter(
          (entry) =>
            entry.isFile() &&
            /^(?:policy-additions|policy-permissive[^/]*)\.yaml$/u.test(entry.name),
        )
        .map((entry) => `packages/${packageDirectory.name}/${entry.name}`);
    })
    .sort();

  it("includes every binary-scoped sandbox policy family", () => {
    expect(sandboxPolicyFiles).toEqual(
      expect.arrayContaining([
        "nemoclaw-blueprint/policies/openclaw-sandbox.yaml",
        "nemoclaw-blueprint/policies/openclaw-sandbox-permissive.yaml",
        "agents/nemocua/policy-additions.yaml",
        "agents/pi/policy-additions.yaml",
        "packages/nemoclaw-hermes/policy-additions.yaml",
        "packages/nemoclaw-hermes/policy-permissive.yaml",
        "packages/nemoclaw-langchain-deepagents-code/policy-additions.yaml",
        "packages/nemoclaw-openclaw/policy-permissive.yaml",
      ]),
    );
  });

  it("discovers every harness package policy once", () => {
    expect(sandboxPolicyFiles.filter((file) => file.startsWith("packages/nemoclaw-"))).toEqual(
      packagePolicyFiles,
    );
    expect(new Set(sandboxPolicyFiles).size).toBe(sandboxPolicyFiles.length);
  });

  it("discovers model-specific setup manifests", () => {
    expect(filesBySchema.get("nemoclaw-blueprint/model-specific-setup/schema.json") ?? []).toEqual(
      expect.arrayContaining([
        "nemoclaw-blueprint/model-specific-setup/openclaw/kimi-k2.6-managed-inference.json",
      ]),
    );
  });

  it("discovers channel-owned messaging policy presets", () => {
    expect(presetFiles).toEqual(
      expect.arrayContaining([
        "src/lib/messaging/channels/slack/policy/openclaw.yaml",
        "src/lib/messaging/channels/slack/policy/hermes.yaml",
        "src/lib/messaging/channels/telegram/policy/openclaw.yaml",
        "src/lib/messaging/channels/telegram/policy/hermes.yaml",
      ]),
    );
  });

  it("includes the onboard performance budget config", () => {
    expect(filesBySchema.get("schemas/onboard-config.schema.json") ?? []).toEqual([
      "ci/onboard-performance-budget.json",
    ]);
  });
});
