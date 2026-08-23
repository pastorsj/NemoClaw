// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { existsSync, readdirSync } from "node:fs";
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
  const packagePresetFiles = readdirSync(path.join(repositoryRoot, "packages"), {
    withFileTypes: true,
  })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("nemoclaw-"))
    .flatMap((packageDirectory) => {
      const relativeDirectory = `packages/${packageDirectory.name}/policies/presets`;
      const directory = path.join(repositoryRoot, relativeDirectory);
      return existsSync(directory)
        ? readdirSync(directory, { withFileTypes: true })
            .filter((entry) => entry.isFile() && entry.name.endsWith(".yaml"))
            .map((entry) => `${relativeDirectory}/${entry.name}`)
        : [];
    })
    .sort();
  const packageModelSetupFiles = readdirSync(path.join(repositoryRoot, "packages"), {
    withFileTypes: true,
  })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("nemoclaw-"))
    .flatMap((packageDirectory) => {
      const packageRoot = path.join(repositoryRoot, "packages", packageDirectory.name);
      const modelSetupRoot = path.join(packageRoot, "model-specific-setup");
      const walk = (directory: string): string[] =>
        existsSync(directory)
          ? readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
              const candidate = path.join(directory, entry.name);
              return entry.isDirectory()
                ? walk(candidate)
                : entry.isFile() && entry.name.endsWith(".json") && entry.name !== "schema.json"
                  ? [path.relative(repositoryRoot, candidate).split(path.sep).join("/")]
                  : [];
            })
          : [];
      return walk(modelSetupRoot);
    })
    .sort();

  it("includes every binary-scoped sandbox policy family", () => {
    expect(sandboxPolicyFiles).toEqual(
      expect.arrayContaining([
        "packages/nemoclaw-openclaw/policy-additions.yaml",
        "packages/nemoclaw-openclaw/policy-permissive-default.yaml",
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

  it("discovers every harness package model-specific setup manifest once", () => {
    const modelSetupFiles =
      filesBySchema.get("nemoclaw-blueprint/model-specific-setup/schema.json") ?? [];
    expect(modelSetupFiles.filter((file) => file.startsWith("packages/nemoclaw-"))).toEqual(
      packageModelSetupFiles,
    );
    expect(new Set(modelSetupFiles).size).toBe(modelSetupFiles.length);
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

  it("discovers every harness package policy preset once", () => {
    expect(presetFiles.filter((file) => file.startsWith("packages/nemoclaw-"))).toEqual(
      packagePresetFiles,
    );
    expect(new Set(presetFiles).size).toBe(presetFiles.length);
  });

  it("includes the onboard performance budget config", () => {
    expect(filesBySchema.get("schemas/onboard-config.schema.json") ?? []).toEqual([
      "ci/onboard-performance-budget.json",
    ]);
  });
});
