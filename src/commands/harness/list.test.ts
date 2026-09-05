// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

import { PUBLIC_DISPLAY_ENTRIES } from "../../lib/cli/public-display-defaults";
import type { HarnessInventoryView } from "../../lib/agent-runtime/package/inventory";
import HarnessCommand from "../harness";
import HarnessListCommand, { harnessListCommandDependencies } from "./list";

const rootDir = process.cwd();
const DIGEST = "a".repeat(64);
const IDENTITY = {
  kind: "agent-runtime",
  id: "openclaw",
  packageVersion: "0.1.0",
  contentDigest: DIGEST,
} as const;
const PI_IDENTITY = {
  kind: "agent-runtime",
  id: "pi",
  packageVersion: "0.1.0",
  contentDigest: "b".repeat(64),
} as const;
const EMPTY_VIEW: HarnessInventoryView = {
  schemaVersion: 1,
  installed: [],
  available: [{ displayName: "OpenClaw", identity: IDENTITY, installationState: "not-installed" }],
};
const DAMAGED_VIEW: HarnessInventoryView = {
  schemaVersion: 1,
  installed: [{ id: "openclaw", displayName: "OpenClaw", health: "damaged", identity: null }],
  available: [{ displayName: "OpenClaw", identity: IDENTITY, installationState: "damaged" }],
};
const HEALTHY_VIEW: HarnessInventoryView = {
  schemaVersion: 1,
  installed: [
    { id: "openclaw", displayName: "OpenClaw", health: "healthy", identity: { ...IDENTITY } },
  ],
  available: [{ displayName: "OpenClaw", identity: { ...IDENTITY }, installationState: "active" }],
};
const PI_VIEW: HarnessInventoryView = {
  schemaVersion: 1,
  installed: [{ id: "pi", displayName: "Pi", health: "healthy", identity: PI_IDENTITY }],
  available: [{ displayName: "Pi", identity: PI_IDENTITY, installationState: "active" }],
};

describe("harness inventory oclif commands", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("publishes the focused harness topic actions", () => {
    expect(HarnessCommand.summary).toBe("Manage and validate agent runtime packages");
    expect(HarnessCommand.usage).toEqual(["harness <activate|install|list|remove|validate>"]);
  });

  it("prints the empty installed state and reviewed available package", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(harnessListCommandDependencies, "createHarnessInventoryView").mockReturnValue(
      EMPTY_VIEW,
    );

    await HarnessListCommand.run([], rootDir);

    expect(log).toHaveBeenCalledWith(expect.stringContaining("No harnesses are installed."));
    expect(log).toHaveBeenCalledWith(expect.stringContaining("openclaw | OpenClaw"));
  });

  it("prints installed and damaged health without package mutation", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(harnessListCommandDependencies, "createHarnessInventoryView").mockReturnValue(
      DAMAGED_VIEW,
    );

    await HarnessListCommand.run([], rootDir);

    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("installed identity could not be verified"),
    );
    expect(harnessListCommandDependencies.createHarnessInventoryView).toHaveBeenCalledOnce();
  });

  it("returns the same closed inventory model through oclif JSON output", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const renderText = vi.spyOn(harnessListCommandDependencies, "renderHarnessInventoryText");
    vi.spyOn(harnessListCommandDependencies, "createHarnessInventoryView").mockReturnValue(
      HEALTHY_VIEW,
    );

    const result = await HarnessListCommand.run(["--json"], rootDir);
    const output = JSON.parse(String(log.mock.calls.at(-1)?.[0]));

    expect(HarnessListCommand.enableJsonFlag).toBe(true);
    expect(result).toEqual(HEALTHY_VIEW);
    expect(output).toEqual(HEALTHY_VIEW);
    expect(renderText).not.toHaveBeenCalled();
  });

  it("hides an unqualified candidate from available packages but retains its installed row", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(harnessListCommandDependencies, "createHarnessInventoryView").mockReturnValue(PI_VIEW);
    vi.spyOn(harnessListCommandDependencies, "isCandidateAgent").mockReturnValue(true);
    vi.spyOn(harnessListCommandDependencies, "isCandidateAgentSelectable").mockReturnValue(false);

    const result = await HarnessListCommand.run(["--json"], rootDir);

    expect(result).toEqual({ ...PI_VIEW, available: [] });
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toEqual({
      ...PI_VIEW,
      available: [],
    });
  });

  it("lists a qualified candidate as available", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(harnessListCommandDependencies, "createHarnessInventoryView").mockReturnValue(PI_VIEW);
    vi.spyOn(harnessListCommandDependencies, "isCandidateAgent").mockReturnValue(true);
    vi.spyOn(harnessListCommandDependencies, "isCandidateAgentSelectable").mockReturnValue(true);

    await expect(HarnessListCommand.run(["--json"], rootDir)).resolves.toEqual(PI_VIEW);
  });

  it("rejects positional input before reading the catalogue", async () => {
    const createView = vi.spyOn(harnessListCommandDependencies, "createHarnessInventoryView");

    await expect(HarnessListCommand.run(["openclaw"], rootDir)).rejects.toThrow();

    expect(createView).not.toHaveBeenCalled();
  });

  it("publishes one list row without a duplicate topic row", () => {
    expect(PUBLIC_DISPLAY_ENTRIES["harness:list"]).toEqual([
      {
        usage: "nemoclaw harness list",
        description: "List installed and reviewed available harness packages",
        flags: undefined,
        group: "Getting Started",
        deprecated: undefined,
        hidden: undefined,
        scope: "global",
        order: 1.55,
      },
    ]);
    expect(PUBLIC_DISPLAY_ENTRIES.harness).toBeUndefined();
  });
});
