// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { AgentDefinition } from "../agent/defs";
import { mergePresetNamesIntoPolicy } from "./index";
import { listPackagePolicyPresets, loadPackagePolicyPreset } from "./package-preset";

const temporaryRoots: string[] = [];

function writePackagePreset(
  presetName: string,
  contents = [
    "preset:",
    `  name: ${presetName}`,
    '  description: "Future service access"',
    "network_policies:",
    "  future_service:",
    "    name: future_service",
    "    endpoints: []",
    "    binaries: []",
    "",
  ].join("\n"),
): AgentDefinition {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-package-policy-"));
  temporaryRoots.push(agentDir);
  const presetDirectory = path.join(agentDir, "policies", "presets");
  fs.mkdirSync(presetDirectory, { recursive: true });
  fs.writeFileSync(path.join(presetDirectory, `${presetName}.yaml`), contents);
  return {
    name: "future-harness",
    agentDir,
    policyCapability: {
      owned_presets: [presetName],
      automatic_presets: [],
      baseline_exclusion_impacts: {},
    },
  } as unknown as AgentDefinition;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("package policy presets", () => {
  it("loads a convention-based asset for an unknown package identity", () => {
    const agent = writePackagePreset("future-tools");

    expect(loadPackagePolicyPreset(agent, "future-tools")).toMatchObject({
      file: "future-tools.yaml",
      name: "future-tools",
      description: "Future service access",
    });
    expect(listPackagePolicyPresets(agent).map((preset) => preset.name)).toEqual(["future-tools"]);
  });

  it("does not let an undeclared package asset shadow a core preset", () => {
    const agent = writePackagePreset("future-tools");

    expect(loadPackagePolicyPreset(agent, "another-service")).toBeNull();
  });

  it("uses a receipt definition for create-time messaging policy composition", () => {
    const agent = writePackagePreset(
      "discord",
      [
        "preset:",
        "  name: discord",
        '  description: "Package-owned Discord access"',
        "network_policies:",
        "  package_discord:",
        "    name: package_discord",
        "    endpoints:",
        "      - host: package-discord.example.test",
        "        port: 443",
        "        credential_binding: future-{sandboxName}-discord-bridge",
        "    binaries: []",
        "",
      ].join("\n"),
    );

    const result = mergePresetNamesIntoPolicy(
      "version: 1\nnetwork_policies:\n  base: {}\n",
      ["discord"],
      {
        agent: agent.name,
        agentDefinition: agent,
        sandboxName: "alpha",
        credentialBoundMessagingChannels: ["discord"],
      },
    );

    expect(result.missingPresets).toEqual([]);
    expect(result.policy).toContain("package-discord.example.test");
    expect(result.policy).toContain("future-alpha-discord-bridge");
  });

  it("fails closed when declared metadata and the asset disagree", () => {
    const agent = writePackagePreset(
      "future-tools",
      [
        "preset:",
        "  name: wrong-tools",
        '  description: "Wrong service"',
        "network_policies: {}",
        "",
      ].join("\n"),
    );

    expect(() => loadPackagePolicyPreset(agent, "future-tools")).toThrow(/does not match/u);
  });

  it("refuses a symlink in place of a package policy asset", () => {
    const agent = writePackagePreset("future-tools");
    const target = path.join(agent.agentDir, "target.yaml");
    const preset = path.join(agent.agentDir, "policies", "presets", "future-tools.yaml");
    fs.writeFileSync(target, fs.readFileSync(preset));
    fs.rmSync(preset);
    fs.symlinkSync(target, preset);

    expect(() => loadPackagePolicyPreset(agent, "future-tools")).toThrow(/unavailable/u);
  });
});
