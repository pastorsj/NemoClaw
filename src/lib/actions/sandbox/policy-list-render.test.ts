// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Regression for #5967: `nemoclaw <sandbox> policy-list` must render `● discord`
// (and any enabled messaging channel preset) once it is active in OpenShell.
// This is the reporter's observation step — the
// rendered marker the operator actually reads — complementing the merge/persist
// tests that cover the upstream state policy-list consumes.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const registryMocks = vi.hoisted(() => ({
  getSandbox: vi.fn<(sandboxName: string) => Record<string, unknown> | null>(),
}));

type PresetInfo = { file: string; name: string; description: string };

const policyMocks = vi.hoisted(() => ({
  listPresets: vi.fn<(_options?: { agent?: string | null }) => PresetInfo[]>(),
  listCustomPresets: vi.fn<(_sandboxName: string) => PresetInfo[]>(),
  getGatewayPresets: vi.fn<(_sandboxName: string) => string[] | null>(),
}));

vi.mock("../../state/registry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/registry")>()),
  getSandbox: registryMocks.getSandbox,
}));

vi.mock("../../policy", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../policy")>();
  return {
    ...actual,
    listPresets: policyMocks.listPresets,
    listCustomPresets: policyMocks.listCustomPresets,
    getGatewayPresets: policyMocks.getGatewayPresets,
  };
});

import { listSandboxPolicies } from "./policy-channel";

describe("listSandboxPolicies rendering (#5967)", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let lines: string[];

  beforeEach(() => {
    lines = [];
    logSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      lines.push(args.join(" "));
    });
    policyMocks.listPresets.mockReturnValue([
      {
        name: "discord",
        description: "Discord API, gateway, and CDN access",
        file: "discord.yaml",
      },
      {
        name: "slack",
        description: "Slack API, Socket Mode, and webhooks access",
        file: "slack.yaml",
      },
      { name: "npm", description: "npm and Yarn registry access", file: "npm.yaml" },
    ]);
    policyMocks.listCustomPresets.mockReturnValue([]);
    registryMocks.getSandbox.mockReturnValue({
      name: "nemoclaw-5967",
      agent: "openclaw",
      policyTier: null,
    });
  });

  afterEach(() => {
    logSpy.mockRestore();
    vi.clearAllMocks();
  });

  // Match the rendered marker + preset name directly. The row may carry a
  // provenance tag (e.g. `● discord [user-added] — …`) between the name and the
  // description, so keying off the marker+name is robust to that suffix.
  const lineFor = (preset: string) =>
    lines.find((line) => new RegExp(`[●○] ${preset}\\b`).test(line)) ?? "";

  it("marks an enabled Discord preset applied when OpenShell reports it", () => {
    // The #5967 fix applies `discord` to OpenShell, so policy-list must render
    // the live state as applied.
    policyMocks.getGatewayPresets.mockReturnValue(["discord", "npm"]);

    listSandboxPolicies("nemoclaw-5967");

    expect(lineFor("discord")).toContain("● discord");
    expect(lineFor("npm")).toContain("● npm");
    // A channel that was never configured stays unapplied.
    expect(lineFor("slack")).toContain("○ slack");
    expect(lineFor("slack")).not.toContain("● slack");
  });

  it("renders the pre-fix regression when OpenShell does not report Discord", () => {
    // Before the fix the explicit-selection path dropped Discord from the
    // reconciled OpenShell policy set.
    policyMocks.getGatewayPresets.mockReturnValue(["npm", "pypi"]);

    listSandboxPolicies("nemoclaw-5967");

    expect(lineFor("discord")).toContain("○ discord");
    expect(lineFor("discord")).not.toContain("● discord");
  });

  it("does not invent local ownership when OpenShell does not report the preset", () => {
    policyMocks.getGatewayPresets.mockReturnValue(["npm"]);

    listSandboxPolicies("nemoclaw-5967");

    expect(lineFor("discord")).toContain("○ discord");
    expect(lineFor("discord")).not.toContain("recorded locally");
  });
});
