// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

import { agentRuntimeListDependencies } from "../../lib/agent/list-command";
import type { HarnessInventoryView } from "../../lib/harness/package-list";
import AgentsListCommand from "./list";

const rootDir = process.cwd();
const OPENCLAW_IDENTITY = {
  kind: "agent-runtime",
  id: "openclaw",
  packageVersion: "0.1.0",
  contractVersion: 1,
  contentDigest: "a".repeat(64),
} as const;
const INSTALLED_VIEW: HarnessInventoryView = {
  schemaVersion: 1,
  installed: [
    {
      id: "openclaw",
      displayName: "OpenClaw",
      health: "healthy",
      identity: OPENCLAW_IDENTITY,
    },
  ],
  available: [
    {
      displayName: "OpenClaw",
      identity: OPENCLAW_IDENTITY,
      installationState: "active",
    },
  ],
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
    vi.spyOn(agentRuntimeListDependencies, "createHarnessInventoryView").mockReturnValue(
      INSTALLED_VIEW,
    );

    await AgentsListCommand.run([], rootDir);

    expect(log).toHaveBeenCalledWith(
      "openclaw  Gateway-based AI agent with plugin ecosystem (openclaw.ai)",
    );
    expect(agentRuntimeListDependencies.createHarnessInventoryView).toHaveBeenCalledOnce();
  });

  it("retains the exact empty message without reading host package state", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(agentRuntimeListDependencies, "createHarnessInventoryView").mockReturnValue({
      schemaVersion: 1,
      installed: [],
      available: [],
    });

    await AgentsListCommand.run([], rootDir);

    expect(log).toHaveBeenCalledWith("No agent runtimes are installed.");
  });
});
