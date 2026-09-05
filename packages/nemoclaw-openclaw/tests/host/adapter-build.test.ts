// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  assertHarnessAdapterArtifactsCurrent,
  buildHarnessAdapterArtifacts,
} from "@nvidia/nemoclaw-harness-contract/build-adapters";

const PACKAGE_ROOT = path.resolve(import.meta.dirname, "../..");

function packedPaths(): string[] {
  const report = JSON.parse(
    execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
      cwd: PACKAGE_ROOT,
      encoding: "utf8",
    }),
  ) as Array<{ files?: Array<{ path?: string }> }>;
  return (report[0]?.files ?? []).flatMap((entry) =>
    typeof entry.path === "string" ? [entry.path] : [],
  );
}

describe("OpenClaw host adapter build", () => {
  it("keeps the checked-in runtime artifact synchronized with typed source", () => {
    expect(() => assertHarnessAdapterArtifactsCurrent(PACKAGE_ROOT)).not.toThrow();

    const artifact = fs.readFileSync(path.join(PACKAGE_ROOT, "host/config-adapter.cts"), "utf8");
    expect(artifact.startsWith("// SPDX-FileCopyrightText:")).toBe(true);
    expect(artifact).toContain("module.exports = configAdapter;");
    expect(artifact).not.toMatch(/\brequire\s*\(/u);

    const startupArtifact = fs.readFileSync(
      path.join(PACKAGE_ROOT, "host/startup-adapter.cts"),
      "utf8",
    );
    expect(startupArtifact).toContain("buildInitialStartupProfile");
    expect(startupArtifact).toContain("reconcileStartupProfile");
    expect(startupArtifact).toContain("module.exports = startupAdapter;");
    expect(startupArtifact).not.toMatch(/\brequire\s*\(/u);

    const mcpArtifact = fs.readFileSync(path.join(PACKAGE_ROOT, "host/mcp-adapter.cts"), "utf8");
    expect(mcpArtifact).toContain("buildMcpSnapshotRestorePlan");
    expect(mcpArtifact).toContain("module.exports = exportedAdapter;");

    const restoreArtifact = fs.readFileSync(
      path.join(PACKAGE_ROOT, "host/restore-adapter.cts"),
      "utf8",
    );
    expect(restoreArtifact).toContain("mergeConfigState");
    expect(restoreArtifact).toContain("module.exports = exportedAdapter;");
  });

  it("publishes generated MCP and restore artifacts without their authoring source", () => {
    const paths = packedPaths();
    expect(paths).toContain("host/mcp-adapter.cts");
    expect(paths).toContain("host/restore-adapter.cts");
    expect(paths.some((candidate) => candidate.startsWith("host/source/"))).toBe(false);
  });

  it("rejects a stale generated artifact", () => {
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-adapter-build-"));
    try {
      fs.mkdirSync(path.join(fixtureRoot, "host/source"), { recursive: true });
      fs.copyFileSync(
        path.join(PACKAGE_ROOT, "host/source/config-adapter.cts"),
        path.join(fixtureRoot, "host/source/config-adapter.cts"),
      );
      fs.mkdirSync(path.join(fixtureRoot, "node_modules"));
      fs.symlinkSync(
        path.join(PACKAGE_ROOT, "node_modules", "typescript"),
        path.join(fixtureRoot, "node_modules", "typescript"),
        "dir",
      );
      fs.mkdirSync(path.join(fixtureRoot, "node_modules", "@nvidia"));
      fs.symlinkSync(
        path.join(PACKAGE_ROOT, "node_modules", "@nvidia", "nemoclaw-harness-contract"),
        path.join(fixtureRoot, "node_modules", "@nvidia", "nemoclaw-harness-contract"),
        "dir",
      );
      fs.writeFileSync(path.join(fixtureRoot, "host/config-adapter.cts"), "stale\n");

      expect(() => buildHarnessAdapterArtifacts(fixtureRoot, true)).toThrow(
        "host/config-adapter.cts is stale",
      );
    } finally {
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });
});
