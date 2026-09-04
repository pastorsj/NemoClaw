// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { loadAgent } from "../../agent/defs";
import { readStateDirectories, stateDirectoryPaths, stateDirectoryPrefixes } from "./directories";

describe("agent state directory contract", () => {
  it("derives portable and machine-local state from one declaration", () => {
    const directories = readStateDirectories({
      state_dirs: [
        "history",
        { path: "identity", backup: false },
        { path: "agents" },
        { prefix: "agents-", backup: false },
      ],
    });

    expect(stateDirectoryPaths(directories)).toEqual(["history", "identity", "agents"]);
    expect(stateDirectoryPaths(directories, { backup: true })).toEqual(["history", "agents"]);
    expect(stateDirectoryPaths(directories, { backup: false })).toEqual(["identity"]);
    expect(stateDirectoryPrefixes(directories)).toEqual(["agents-"]);
    expect(stateDirectoryPrefixes(directories, { backup: false })).toEqual(["agents-"]);
  });

  it("keeps OpenClaw machine-local authentication state out of snapshots", () => {
    const agent = loadAgent("openclaw");

    expect(agent.nonBackupStateDirs).toEqual(["plugins", "profiles", "identity", "devices"]);
    expect(agent.backupStateDirs).not.toEqual(
      expect.arrayContaining(["plugins", "profiles", "identity", "devices"]),
    );
    expect(agent.stateDirs).toEqual(
      expect.arrayContaining(["plugins", "profiles", "identity", "devices"]),
    );
  });

  it("keeps Hermes machine-local hooks out of snapshots", () => {
    const agent = loadAgent("hermes");

    expect(agent.nonBackupStateDirs).toContain("hooks");
    expect(agent.backupStateDirs).not.toContain("hooks");
  });

  it.each([
    [{ state_dirs: "state" }, /state_dirs.*array/],
    [{ state_dirs: ["../state"] }, /canonical relative path/],
    [{ state_dirs: ["rebuild-manifest.json/nested"] }, /reserved for snapshot metadata/],
    [
      { state_dirs: [{ path: ".nemoclaw-rebuild-recovery.json" }] },
      /reserved for snapshot metadata/,
    ],
    [
      { state_dirs: [`rebuild-policy-handoff.${"a".repeat(64)}.yaml`] },
      /reserved for snapshot metadata/,
    ],
    [{ state_dirs: ["REBUILD-MANIFEST.JSON"] }, /reserved for snapshot metadata/],
    [
      { state_dirs: [{ path: "rebuild" }, { prefix: "rebuild-" }] },
      /can match a path reserved for snapshot metadata/,
    ],
    [
      { state_dirs: [{ path: ".nemoclaw" }, { prefix: ".nemoclaw-" }] },
      /can match a path reserved for snapshot metadata/,
    ],
    [
      { state_dirs: [{ path: "REBUILD" }, { prefix: "REBUILD-" }] },
      /can match a path reserved for snapshot metadata/,
    ],
    [{ state_dirs: [{ path: "/state" }] }, /relative path/],
    [{ state_dirs: [{ path: "state", prefix: "state-" }] }, /exactly one/],
    [{ state_dirs: [{ path: "state", unknown: true }] }, /unknown.*not allowed/],
    [{ state_dirs: [{ path: "state", backup: "yes" }] }, /backup.*boolean/],
    [{ state_dirs: ["state", "state"] }, /repeats path:state/],
    [{ state_dirs: [{ path: "state" }, { prefix: "other-" }] }, /must extend a declared/],
  ])("rejects an invalid state declaration %#", (record, expected) => {
    expect(() => readStateDirectories(record)).toThrow(expected);
  });

  it("rejects an overlapping prefix and exact path", () => {
    expect(() =>
      readStateDirectories({
        state_dirs: [
          { path: "workspace" },
          { prefix: "workspace-" },
          { path: "workspace-dev", backup: false },
        ],
      }),
    ).toThrow(/prefix 'workspace-'.*overlaps exact path 'workspace-dev'/);
  });
});
