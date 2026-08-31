// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

import { agentRuntimeListDependencies } from "../../lib/agent/list-command";
import type { HarnessPackageInventory } from "../../lib/agent-runtime/package/catalog";
import AgentsListCommand from "./list";

const rootDir = process.cwd();
const OPENCLAW_IDENTITY = {
  kind: "agent-runtime",
  id: "openclaw",
  packageVersion: "0.1.0",
  contentDigest: "a".repeat(64),
} as const;
const INSTALLED_INVENTORY: HarnessPackageInventory = {
  installed: [
    {
      state: "installed",
      id: "openclaw",
      displayName: "OpenClaw",
      description: "Gateway-based AI agent with plugin ecosystem (openclaw.ai)",
      aliases: ["nemoclaw", "nemo-claw"],
      aliasSummary: null,
      isDefaultOnboardingChoice: true,
      defaultSandboxName: "my-assistant",
      identity: OPENCLAW_IDENTITY,
      packageRoot: "/private/store/openclaw",
      matchesAvailableIdentity: true,
    },
  ],
  available: [],
};

describe("agents list oclif command", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("retains the compatibility command metadata", () => {
    expect(AgentsListCommand.id).toBe("agents:list");
    expect(AgentsListCommand.strict).toBe(true);
    expect(AgentsListCommand.summary).toBe("List available agent runtimes for onboard --agent");
    expect(AgentsListCommand.description).toBe(
      "List installed agent runtimes that can be selected with onboard --agent.",
    );
    expect(AgentsListCommand.usage).toEqual(["agents list"]);
    expect(AgentsListCommand.examples).toEqual(["<%= config.bin %> agents list"]);
    expect(AgentsListCommand.aliases).toEqual([]);
  });

  it("prints the installed-only compatibility projection", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(agentRuntimeListDependencies, "listHarnessPackageInventory").mockReturnValue(
      INSTALLED_INVENTORY,
    );

    await AgentsListCommand.run([], rootDir);

    expect(log).toHaveBeenCalledWith(
      "openclaw  Gateway-based AI agent with plugin ecosystem (openclaw.ai)",
    );
    expect(agentRuntimeListDependencies.listHarnessPackageInventory).toHaveBeenCalledOnce();
  });

  it("retains the exact empty message without reading host package state", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(agentRuntimeListDependencies, "listHarnessPackageInventory").mockReturnValue({
      installed: [],
      available: [],
    });

    await AgentsListCommand.run([], rootDir);

    expect(log).toHaveBeenCalledWith("No agent runtimes are installed.");
  });
});
