// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Tests for snapshot versioning and naming added alongside the --name flag:
//   - validateSnapshotName accepts/rejects names
//   - listBackups computes virtual v<N> versions by timestamp-ascending position
//   - findBackup resolves selectors (v<N>, name, exact timestamp)

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { managedStartupE2eProfile } from "../../scripts/checks/generate-managed-startup-profile-fixture.mts";
import { loadAgent } from "../../src/lib/agent/defs";
import { encodeManagedStartupProfile } from "../../src/lib/onboard/managed-startup/profile";
import { stateDirectoryDiscoverySshSource } from "../helpers/snapshot-state-discovery-fixture";

// Override HOME BEFORE importing sandbox-state — it reads process.env.HOME
// at module-load time to compute REBUILD_BACKUPS_DIR. Captured original is
// restored in afterAll so sibling tests running in the same worker don't
// inherit a deleted temp directory.
const ORIGINAL_HOME = process.env.HOME;
const TMP_HOME = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-snap-naming-")));
process.env.HOME = TMP_HOME;
const REPO_ROOT = path.join(import.meta.dirname, "../..");
const { installHomeOpenClawRestorePackageFixture } = await import(
  pathToFileURL(path.join(REPO_ROOT, "test", "helpers", "harness-packages.ts")).href
);
type BackupScalar = string | number | boolean | null | undefined;
type BackupValue = BackupScalar | BackupManifestOverrides | BackupValue[];
type SandboxStateModule = typeof import("../../src/lib/state/sandbox.js");
type SandboxStateModuleCandidate = Partial<SandboxStateModule> | null;
function isSandboxStateModule(value: SandboxStateModuleCandidate): value is SandboxStateModule {
  return (
    value !== null &&
    typeof value.listBackups === "function" &&
    typeof value.findBackup === "function" &&
    typeof value.validateSnapshotName === "function" &&
    typeof value.parseRestoreArgs === "function"
  );
}
const loadedSandboxState = await import(
  pathToFileURL(path.join(REPO_ROOT, "src", "lib", "state", "sandbox.ts")).href
);
if (!isSandboxStateModule(loadedSandboxState)) {
  throw new Error("Expected sandbox-state module exports to be available");
}
const sandboxState = loadedSandboxState;
const { parseRestoreArgs } = sandboxState;
const BACKUPS_ROOT = path.join(TMP_HOME, ".nemoclaw", "rebuild-backups");
const OPENCLAW_PACKAGE = installHomeOpenClawRestorePackageFixture(TMP_HOME).identity;
const registeredAgentIds = new Map<string, string>();
type BackupManifestOverrides = { [key: string]: BackupValue };
function writeBackup(
  sandboxName: string,
  dirName: string,
  overrides: BackupManifestOverrides = {},
): BackupManifestOverrides {
  const dir = path.join(BACKUPS_ROOT, sandboxName, dirName);
  fs.mkdirSync(dir, { recursive: true });
  const manifest = {
    version: 1,
    sandboxName,
    timestamp: dirName,
    agentType: "openclaw",
    agentVersion: null,
    expectedVersion: null,
    stateDirs: [],
    dir: "/sandbox/.openclaw",
    backupPath: dir,
    blueprintDigest: null,
    ...overrides,
  };
  fs.writeFileSync(path.join(dir, "rebuild-manifest.json"), JSON.stringify(manifest, null, 2));
  return manifest;
}
function managedSnapshotAuthority() {
  const encodedProfile = encodeManagedStartupProfile(managedStartupE2eProfile("openclaw"));
  return {
    workload: {
      schemaVersion: 1,
      kind: "managed-image",
      reference: `ghcr.io/nvidia/nemoclaw/openclaw-sandbox@sha256:${"a".repeat(64)}`,
      platform: "linux/amd64",
      release: "v0.0.97",
      sourceRevision: "b".repeat(40),
      sourceCohort: "ghrun-123456-1",
      capabilityContractVersion: 1,
      startupProfileContractVersion: 1,
      encodedProfile,
      startupProfileSha256: createHash("sha256").update(encodedProfile, "utf8").digest("hex"),
      credentialProxyReplayRequired: false,
      shared: true,
    },
    runtimeSnapshot: {
      schemaVersion: 1,
      providerId: "docker",
      providerHandle: "opaque-provider-handle",
      lifecycleState: "running",
      lifecycleGeneration: "generation-1",
      runtime: {
        schemaVersion: 1,
        providerId: "docker",
        runtime: { kind: "docker-container", handle: "opaque-container-id" },
        acceleration: { kind: "none" },
      },
    },
  } as const;
}
afterAll(() => {
  if (ORIGINAL_HOME === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = ORIGINAL_HOME;
  }
  fs.rmSync(TMP_HOME, { recursive: true, force: true });
});
beforeEach(() => {
  fs.rmSync(BACKUPS_ROOT, { recursive: true, force: true });
  registeredAgentIds.clear();
});
function writeExecutable(filePath: string, source: string): void {
  fs.writeFileSync(filePath, source, { mode: 0o755 });
}
function restoreEnv(name: string, value: string | undefined): void {
  value === undefined
    ? Reflect.deleteProperty(process.env, name)
    : Reflect.set(process.env, name, value);
}
function encodePreBackupAuditRows(rows: readonly string[]): string {
  return rows.flatMap((row) => row.split("\t")).join("\0") + (rows.length > 0 ? "\0" : "");
}
function writeAgentRegistry(
  sandboxName: string,
  agent: string | null,
  overrides: Record<string, unknown> = {},
): void {
  const effectiveAgentId = agent || "openclaw";
  registeredAgentIds.set(sandboxName, effectiveAgentId);
  fs.mkdirSync(path.join(TMP_HOME, ".nemoclaw"), { recursive: true });
  fs.writeFileSync(
    path.join(TMP_HOME, ".nemoclaw", "sandboxes.json"),
    JSON.stringify({
      defaultSandbox: sandboxName,
      sandboxes: {
        [sandboxName]: {
          name: sandboxName,
          model: "m",
          provider: "p",
          gpuEnabled: false,
          agent,
          harnessPackage: testHarnessPackage(effectiveAgentId),
          ...overrides,
        },
      },
    }),
  );
}

function testHarnessPackage(agentId: string) {
  if (agentId === "openclaw") return OPENCLAW_PACKAGE;
  return {
    kind: "agent-runtime" as const,
    id: agentId,
    packageVersion: "1.2.3",
    contentDigest: createHash("sha256").update(`snapshot-test:${agentId}`).digest("hex"),
  };
}

function backupRegisteredSandboxState(
  sandboxName: string,
  options: Parameters<typeof sandboxState.backupSandboxState>[1] = {},
) {
  const agentId = registeredAgentIds.get(sandboxName);
  expect(agentId, `No registered test agent for '${sandboxName}'`).toBeDefined();
  return sandboxState.backupSandboxState(sandboxName, {
    agentDefinition: loadAgent(agentId!),
    harnessPackage: testHarnessPackage(agentId!),
    ...options,
  });
}

function restoreRegisteredSandboxState(sandboxName: string, backupPath: string) {
  const agentId = registeredAgentIds.get(sandboxName);
  expect(agentId, `No registered test agent for '${sandboxName}'`).toBeDefined();
  const manifest = sandboxState.getLatestBackup(sandboxName);
  expect(manifest, `No registered test backup for '${sandboxName}'`).toBeDefined();
  const authority = sandboxState.captureSnapshotRestoreAuthority(backupPath, manifest!);
  expect(authority, `Could not capture test backup authority for '${sandboxName}'`).toBeDefined();
  return sandboxState.restoreSandboxState(sandboxName, backupPath, {
    agentDefinition: loadAgent(agentId!),
    authority: authority!,
    validateBeforeMutation: () => undefined,
  });
}

function writeOpenClawRegistry(sandboxName: string, overrides: Record<string, unknown> = {}): void {
  writeAgentRegistry(sandboxName, null, overrides);
}
function writeFakeOpenshell(binDir: string): string {
  const openshell = path.join(binDir, "openshell");
  writeExecutable(
    openshell,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "sandbox" && args[1] === "ssh-config") {
  process.stdout.write("Host openshell-alpha\\n  HostName 127.0.0.1\\n  User sandbox\\n");
  process.exit(0);
}
process.exit(0);
`,
  );
  return openshell;
}
describe("listBackups computes virtual versions", () => {
  it("assigns v1 to the oldest by timestamp and vN to the newest", () => {
    // Written out of chronological order to verify sort-by-timestamp.
    writeBackup("test-sandbox", "2026-04-21T14-05-00-000Z");
    writeBackup("test-sandbox", "2026-04-21T14-01-00-000Z");
    writeBackup("test-sandbox", "2026-04-21T14-10-00-000Z");
    const list = sandboxState.listBackups("test-sandbox");
    // Newest first in display order.
    expect(list.map((b) => [b.snapshotVersion, b.timestamp])).toEqual([
      [3, "2026-04-21T14-10-00-000Z"],
      [2, "2026-04-21T14-05-00-000Z"],
      [1, "2026-04-21T14-01-00-000Z"],
    ]);
  });
  it("ignores any snapshotVersion persisted in legacy manifests", () => {
    // Old on-disk value should be overridden by position-based virtual version.
    writeBackup("test-sandbox", "2026-04-21T14-00-00-000Z", { snapshotVersion: 99 });
    const [entry] = sandboxState.listBackups("test-sandbox");
    expect(entry.snapshotVersion).toBe(1);
  });
  it("surfaces the name field when present", () => {
    writeBackup("test-sandbox", "2026-04-21T14-00-00-000Z", { name: "before-upgrade" });
    const [entry] = sandboxState.listBackups("test-sandbox");
    expect(entry.name).toBe("before-upgrade");
    expect(entry.snapshotVersion).toBe(1);
  });
  it("stops listing a snapshot that was removed as incomplete (#8201)", () => {
    const incomplete = writeBackup("test-sandbox", "2026-04-21T14-00-00-000Z", {
      name: "failtest",
    });
    expect(sandboxState.listBackups("test-sandbox")).toHaveLength(1);

    expect(
      sandboxState.removeSandboxStateBackup("test-sandbox", String(incomplete.backupPath)),
    ).toBe(true);

    expect(sandboxState.listBackups("test-sandbox")).toEqual([]);
    expect(sandboxState.findBackup("test-sandbox", "failtest").match).toBeNull();
    expect(fs.existsSync(String(incomplete.backupPath))).toBe(false);
  });
  it.each([
    {
      scenario: "an explicit directory failure",
      overrides: {
        backupComplete: false,
        stateDirs: ["workspace", "extensions"],
        backedUpDirs: ["extensions"],
        failedBackupDirs: ["workspace"],
      },
    },
    {
      scenario: "a state-file-only failure",
      overrides: {
        backupComplete: false,
        stateDirs: ["workspace"],
        backedUpDirs: ["workspace"],
        failedBackupDirs: [],
        stateFiles: [{ path: "openclaw.json", strategy: "copy" }],
      },
    },
    {
      scenario: "a legacy partial-directory manifest",
      overrides: {
        stateDirs: ["workspace", "extensions"],
        backedUpDirs: ["extensions"],
        failedBackupDirs: ["workspace"],
      },
    },
    {
      scenario: "a legacy state-file manifest without the captured file",
      overrides: {
        stateFiles: [{ path: "openclaw.json", strategy: "copy" }],
      },
    },
  ])("keeps snapshots with $scenario out of snapshot selection (#10639)", ({ overrides }) => {
    const incomplete = writeBackup("test-sandbox", "2026-04-21T14-00-00-000Z", overrides);

    expect(sandboxState.listBackups("test-sandbox")).toEqual([]);
    expect(sandboxState.findBackup("test-sandbox", "v1").match).toBeNull();
    expect(fs.existsSync(String(incomplete.backupPath))).toBe(true);
  });
  it("keeps complete legacy state-file snapshots selectable (#10639)", () => {
    const complete = writeBackup("test-sandbox", "2026-04-21T14-00-00-000Z", {
      stateFiles: [{ path: "openclaw.json", strategy: "copy" }],
    });
    fs.writeFileSync(path.join(String(complete.backupPath), "openclaw.json"), "{}\n");
    expect(sandboxState.listBackups("test-sandbox")).toHaveLength(1);
    expect(sandboxState.findBackup("test-sandbox", "v1").match?.backupPath).toBe(
      complete.backupPath,
    );
  });
  it("restores the versions of surviving snapshots once an incomplete one is removed (#8201)", () => {
    writeBackup("test-sandbox", "2026-04-21T14-01-00-000Z");
    const incomplete = writeBackup("test-sandbox", "2026-04-21T14-05-00-000Z");
    writeBackup("test-sandbox", "2026-04-21T14-10-00-000Z");
    expect(sandboxState.listBackups("test-sandbox").map((b) => b.timestamp)).toEqual([
      "2026-04-21T14-10-00-000Z",
      "2026-04-21T14-05-00-000Z",
      "2026-04-21T14-01-00-000Z",
    ]);

    sandboxState.removeSandboxStateBackup("test-sandbox", String(incomplete.backupPath));

    expect(
      sandboxState.listBackups("test-sandbox").map((b) => [b.snapshotVersion, b.timestamp]),
    ).toEqual([
      [2, "2026-04-21T14-10-00-000Z"],
      [1, "2026-04-21T14-01-00-000Z"],
    ]);
  });

  it("round-trips normalized managed workload and provider runtime authority", () => {
    const authority = managedSnapshotAuthority();
    writeBackup("test-sandbox", "2026-04-21T14-00-00-000Z", {
      workload: { ...authority.workload, ignored: "not-authority" },
      runtimeSnapshot: {
        ...authority.runtimeSnapshot,
        containerName: "not-authority",
      },
    });

    const [entry] = sandboxState.listBackups("test-sandbox");

    expect(entry?.workload).toEqual(authority.workload);
    expect(entry?.runtimeSnapshot).toEqual(authority.runtimeSnapshot);
  });

  it("rejects a managed snapshot manifest without valid provider runtime authority", () => {
    const authority = managedSnapshotAuthority();
    writeBackup("test-sandbox", "2026-04-21T14-00-00-000Z", {
      workload: authority.workload,
    });
    writeBackup("test-sandbox", "2026-04-21T14-01-00-000Z", {
      ...authority,
      runtimeSnapshot: {
        ...authority.runtimeSnapshot,
        lifecycleGeneration: "",
      },
    });

    expect(sandboxState.listBackups("test-sandbox")).toEqual([]);
  });

  it("preserves legacy manifests created before blueprintDigest existed", () => {
    const dir = path.join(BACKUPS_ROOT, "test-sandbox", "2026-04-21T13-59-00-000Z");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "rebuild-manifest.json"),
      JSON.stringify({
        version: 1,
        sandboxName: "test-sandbox",
        timestamp: "2026-04-21T13-59-00-000Z",
        agentType: "openclaw",
        agentVersion: null,
        expectedVersion: null,
        stateDirs: [],
        writableDir: "/sandbox/.openclaw-data",
        backupPath: dir,
      }),
    );
    const [entry] = sandboxState.listBackups("test-sandbox");
    expect(entry?.timestamp).toBe("2026-04-21T13-59-00-000Z");
    expect(entry?.dir).toBe("/sandbox/.openclaw-data");
    expect(entry?.writableDir).toBe("/sandbox/.openclaw-data");
    expect(entry?.blueprintDigest).toBeNull();
  });
  it("ignores rebuild manifests with invalid typed fields", () => {
    const dir = path.join(BACKUPS_ROOT, "test-sandbox", "2026-04-21T14-00-00-000Z");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "rebuild-manifest.json"),
      JSON.stringify({
        version: 1,
        sandboxName: "test-sandbox",
        timestamp: "2026-04-21T14-00-00-000Z",
        agentType: "openclaw",
        agentVersion: null,
        expectedVersion: null,
        stateDirs: "invalid",
        writableDir: "/sandbox/.openclaw-data",
        backupPath: dir,
        blueprintDigest: null,
      }),
    );
    expect(sandboxState.listBackups("test-sandbox")).toEqual([]);
  });
  it("ignores rebuild manifests with unsafe backed-up directory paths", () => {
    writeBackup("test-sandbox", "2026-04-21T14-00-00-000Z", {
      stateDirs: ["workspace"],
      backedUpDirs: ["../outside"],
    });
    expect(sandboxState.listBackups("test-sandbox")).toEqual([]);
  });
  it("ignores rebuild manifests whose backed-up dirs are not declared state dirs", () => {
    writeBackup("test-sandbox", "2026-04-21T14-00-00-000Z", {
      stateDirs: ["workspace"],
      backedUpDirs: ["workspace", "agents"],
    });
    expect(sandboxState.listBackups("test-sandbox")).toEqual([]);
  });
  it("does not restore backed-up directory entries that are plain files", () => {
    const manifest = writeBackup("test-sandbox", "2026-04-21T14-00-00-000Z", {
      stateDirs: ["workspace"],
      backedUpDirs: ["workspace"],
    });
    writeAgentRegistry("test-sandbox", "openclaw");
    fs.writeFileSync(path.join(String(manifest.backupPath), "workspace"), "not a directory");

    const restore = sandboxState.restoreSandboxState("test-sandbox", String(manifest.backupPath));

    expect(restore).toEqual({
      success: true,
      restoredDirs: [],
      failedDirs: [],
      restoredFiles: [],
      failedFiles: [],
    });
  });
});

describe("sandbox directory backup semantics", () => {
  it("refuses to downgrade a registered standard package backup to schema v1", () => {
    const harnessPackage = {
      kind: "agent-runtime",
      id: "openclaw",
      packageVersion: "1.2.3",
      contentDigest: "a".repeat(64),
    };
    writeOpenClawRegistry("alpha", { harnessPackage });

    const backup = sandboxState.backupSandboxState("alpha");

    expect(backup).toMatchObject({
      success: false,
      error:
        "registered harness package snapshot requires its pinned agent definition and package identity",
    });
    expect(backup.manifest).toBeUndefined();
    expect(fs.existsSync(path.join(BACKUPS_ROOT, "alpha"))).toBe(false);
  });

  it("refuses to synthesize a schema-v1 backup for a registered standard sandbox", () => {
    writeOpenClawRegistry("alpha", { harnessPackage: undefined });

    const backup = sandboxState.backupSandboxState("alpha");

    expect(backup).toMatchObject({
      success: false,
      error:
        "registered harness package snapshot requires its pinned agent definition and package identity",
    });
    expect(backup.manifest).toBeUndefined();
    expect(fs.existsSync(path.join(BACKUPS_ROOT, "alpha"))).toBe(false);
  });

  it("refuses to synthesize a schema-v1 backup from malformed package authority", () => {
    writeOpenClawRegistry("alpha", {
      harnessPackage: {
        kind: "agent-runtime",
        id: "openclaw",
        packageVersion: "1.2.3",
        contentDigest: "invalid",
      },
    });

    expect(() => sandboxState.backupSandboxState("alpha")).toThrow(
      "Sandbox registry contains invalid harness package authority",
    );
    expect(fs.existsSync(path.join(BACKUPS_ROOT, "alpha"))).toBe(false);
  });

  it("rejects a custom image backup with missing managed-extension provenance (#6108)", () => {
    writeOpenClawRegistry("custom-openclaw", {
      fromDockerfile: "/tmp/Dockerfile.custom",
    });

    const backup = backupRegisteredSandboxState("custom-openclaw");

    expect(backup.success).toBe(false);
    expect(backup.manifest).toBeUndefined();
    expect(backup.error).toBe(
      "registered managed image extension provenance is missing or invalid",
    );
    expect(fs.existsSync(path.join(BACKUPS_ROOT, "custom-openclaw"))).toBe(false);
  });

  it("backs up declared empty and dynamic directories without trusting undeclared discovery output (#8006)", () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-empty-dirs-"));
    const oldPath = process.env.PATH;
    const oldOpenshell = process.env.NEMOCLAW_OPENSHELL_BIN;
    const oldTmpdir = process.env.TMPDIR;
    try {
      const binDir = path.join(fixture, "bin");
      const openclawDir = path.join(fixture, "sandbox-root", ".openclaw");
      const stagingRoot = path.join(fixture, "staging");
      const sshLog = path.join(fixture, "ssh-log.jsonl");
      const unsafeDiscoveryMarker = path.join(fixture, "unsafe-discovery");
      const existingDirs = [
        "agents",
        "extensions",
        "workspace",
        "skills",
        "hooks",
        "cron",
        "workspace-research",
      ];
      fs.mkdirSync(binDir, { recursive: true });
      fs.mkdirSync(stagingRoot);
      for (const dirName of existingDirs) {
        fs.mkdirSync(path.join(openclawDir, dirName), { recursive: true });
      }
      fs.writeFileSync(path.join(openclawDir, "workspace", "marker.txt"), "marker\n");

      const openshell = writeFakeOpenshell(binDir);
      writeExecutable(
        path.join(binDir, "ssh"),
        stateDirectoryDiscoverySshSource({
          existingDirs,
          openclawDir,
          sshLog,
          stagingRoot,
          unsafeDiscoveryMarker,
        }),
      );

      writeOpenClawRegistry("alpha", {
        fromDockerfile: "/tmp/Dockerfile.custom",
        managedImageExtensions: [],
      });
      process.env.NEMOCLAW_OPENSHELL_BIN = openshell;
      process.env.TMPDIR = stagingRoot;
      process.env.PATH = `${binDir}${path.delimiter}${oldPath || ""}`;

      const backup = backupRegisteredSandboxState("alpha");
      expect(backup.success).toBe(true);
      expect(backup.failedDirs).toEqual([]);
      expect(backup.backedUpDirs).toEqual(existingDirs);
      expect(backup.manifest?.backupComplete).toBe(true);
      expect(backup.manifest?.backupContentSha256).toMatch(/^[0-9a-f]{64}$/u);
      expect(backup.manifest?.backedUpDirs).toEqual(existingDirs);
      expect(backup.manifest?.stateDirs.at(-1)).toBe("workspace-research");
      expect(backup.manifest?.reconcileManagedImageExtensions).toBe(true);
      expect(backup.manifest?.managedImageExtensions).toEqual([]);
      const discoveryCommand = fs
        .readFileSync(sshLog, "utf-8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line).cmd as string)
        .find(
          (command) =>
            command.startsWith("{ [ -d ") ||
            command.startsWith("{ for d ") ||
            command.startsWith("[ -d "),
        );
      expect(discoveryCommand).toContain("'/sandbox/.openclaw/workspace-'*/");
      expect(fs.readdirSync(stagingRoot)).toEqual([]);

      const rejected = backupRegisteredSandboxState("alpha", {
        validateBeforePublish: () => {
          throw new Error("runtime generation changed");
        },
      });
      expect(rejected).toMatchObject({
        success: false,
        error: expect.stringContaining(
          "Snapshot authority changed during backup: runtime generation changed",
        ),
      });
      let publicationChecks = 0;
      const publicationOutcomes = [
        () => undefined,
        () => {
          throw new Error("package changed during digest capture");
        },
      ];
      const rejectedAfterDigest = backupRegisteredSandboxState("alpha", {
        validateBeforePublish: () => {
          publicationChecks += 1;
          publicationOutcomes[publicationChecks - 1]?.();
        },
      });
      expect(rejectedAfterDigest).toMatchObject({
        success: false,
        error: expect.stringContaining(
          "Snapshot authority changed during backup: package changed during digest capture",
        ),
      });
      expect(publicationChecks).toBe(2);
      fs.writeFileSync(unsafeDiscoveryMarker, "hostile newline discovery\n");
      const unsafeDiscovery = backupRegisteredSandboxState("alpha");
      expect(unsafeDiscovery).toMatchObject({
        success: false,
        error: "State directory discovery returned undeclared or unsafe entries",
        backedUpDirs: [],
      });
      const published = fs
        .readdirSync(path.join(BACKUPS_ROOT, "alpha"))
        .filter((entry) =>
          fs.existsSync(path.join(BACKUPS_ROOT, "alpha", entry, "rebuild-manifest.json")),
        );
      expect(published).toHaveLength(1);
      expect(fs.readdirSync(stagingRoot)).toEqual([]);
    } finally {
      restoreEnv("NEMOCLAW_OPENSHELL_BIN", oldOpenshell);
      restoreEnv("TMPDIR", oldTmpdir);
      process.env.PATH = oldPath;
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("returns a structured failure when the archive staging file cannot be created", () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-backup-staging-failure-"));
    const oldPath = process.env.PATH;
    const oldOpenshell = process.env.NEMOCLAW_OPENSHELL_BIN;
    const oldTmpdir = process.env.TMPDIR;
    const originalOpenSync = fs.openSync;
    try {
      const binDir = path.join(fixture, "bin");
      const stagingRoot = path.join(fixture, "staging");
      fs.mkdirSync(binDir);
      fs.mkdirSync(stagingRoot);
      const openshell = writeFakeOpenshell(binDir);
      writeExecutable(
        path.join(binDir, "ssh"),
        `#!/usr/bin/env node
const cmd = process.argv[process.argv.length - 1] || "";
if (
  cmd.startsWith("{ [ -d ") ||
  cmd.startsWith("{ for d ") ||
  cmd.startsWith("[ -d ")
) process.stdout.write("workspace\\n");
if (cmd.includes("openclaw.json") && cmd.includes("cat --")) process.exit(2);
process.exit(0);
`,
      );
      writeOpenClawRegistry("alpha");
      process.env.NEMOCLAW_OPENSHELL_BIN = openshell;
      process.env.TMPDIR = stagingRoot;
      process.env.PATH = `${binDir}${path.delimiter}${oldPath || ""}`;

      fs.openSync = ((filePath, flags, mode) => {
        if (String(filePath).endsWith(`${path.sep}archive.tar`)) {
          const error = new Error("ENOSPC: no space left on device");
          Object.assign(error, { code: "ENOSPC" });
          throw error;
        }
        return originalOpenSync(filePath, flags, mode);
      }) as typeof fs.openSync;
      syncBuiltinESMExports();
      const backup = backupRegisteredSandboxState("alpha");
      expect(backup.success).toBe(false);
      expect(backup.failedDirs).toEqual(["workspace"]);
      expect(backup.error).toMatch(/Failed to create backup archive file.*ENOSPC/);
      expect(fs.readdirSync(stagingRoot)).toEqual([]);
    } finally {
      fs.openSync = originalOpenSync;
      syncBuiltinESMExports();
      restoreEnv("NEMOCLAW_OPENSHELL_BIN", oldOpenshell);
      restoreEnv("TMPDIR", oldTmpdir);
      process.env.PATH = oldPath;
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("classifies tar-failed directories and excludes them from the restorable manifest", () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-partial-tar-"));
    const oldPath = process.env.PATH;
    const oldOpenshell = process.env.NEMOCLAW_OPENSHELL_BIN;
    try {
      const binDir = path.join(fixture, "bin");
      const openclawDir = path.join(fixture, "sandbox-root", ".openclaw");
      const sshLog = path.join(fixture, "ssh-log.jsonl");
      const existingDirs = ["agents", "workspace", "extensions"];
      fs.mkdirSync(binDir, { recursive: true });
      fs.mkdirSync(path.join(openclawDir, "agents", "main", "sessions"), { recursive: true });
      fs.mkdirSync(path.join(openclawDir, "extensions"), { recursive: true });
      fs.mkdirSync(path.join(openclawDir, "workspace"), { recursive: true });
      fs.writeFileSync(path.join(openclawDir, "workspace", "marker.txt"), "marker\n");

      const openshell = writeFakeOpenshell(binDir);
      writeExecutable(
        path.join(binDir, "ssh"),
        `#!/usr/bin/env node
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const cmd = process.argv[process.argv.length - 1] || "";
const existingDirs = ${JSON.stringify(existingDirs)};
fs.appendFileSync(${JSON.stringify(sshLog)}, JSON.stringify({ cmd }) + "\\n");
function readStdin() {
  for (;;) {
    const buf = Buffer.alloc(65536);
    const n = fs.readSync(0, buf, 0, buf.length, null);
    if (n === 0) break;
  }
}
if (
  cmd.startsWith("{ [ -d ") ||
  cmd.startsWith("{ for d ") ||
  cmd.startsWith("[ -d ")
) {
  process.stdout.write(existingDirs.join("\\n") + "\\n");
  process.exit(0);
}
if (cmd.includes("openclaw.json") && cmd.includes("cat --")) {
  process.stdout.write(JSON.stringify({ gateway: { auth: { token: "fresh" } }, channels: {} }));
  process.exit(0);
}
if (cmd.includes("find ")) {
  process.exit(0);
}
if (cmd.includes("-cf -")) {
  const r = spawnSync("tar", ["-cf", "-", "-C", ${JSON.stringify(openclawDir)}, ...existingDirs], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (r.stdout) fs.writeSync(1, r.stdout);
  process.stderr.write("tar: agents/main/sessions/sessions.json: Cannot open: Permission denied\\n");
  process.stderr.write("tar: workspace/marker.txt: Cannot read: Input/output error\\n");
  process.stderr.write("tar: Exiting with failure status due to previous errors\\n");
  process.exit(2);
}
if (cmd.includes("rm -rf") || cmd.includes("tar --no-same-owner")) {
  readStdin();
  process.exit(0);
}
if (cmd.includes("chown") || cmd.includes("[ -r ")) {
  process.exit(0);
}
process.exit(0);
`,
      );

      writeOpenClawRegistry("alpha");
      process.env.NEMOCLAW_OPENSHELL_BIN = openshell;
      process.env.PATH = `${binDir}:${oldPath || ""}`;

      const backup = backupRegisteredSandboxState("alpha");
      expect(backup.success).toBe(false);
      expect(backup.failedDirs).toEqual(["agents", "workspace"]);
      expect(backup.failedDirReasons).toEqual({
        agents: "permission denied",
        workspace: "tar read error",
      });
      expect(backup.backedUpDirs).toEqual(["extensions"]);
      expect(backup.manifest?.backupComplete).toBe(false);
      expect(backup.manifest?.backedUpDirs).toEqual(["extensions"]);
      expect(fs.existsSync(path.join(backup.manifest!.backupPath, "agents"))).toBe(true);

      const restore = restoreRegisteredSandboxState("alpha", backup.manifest!.backupPath);
      expect(restore.success).toBe(true);
      expect(restore.restoredDirs).toEqual(["extensions"]);

      const loggedCommands = fs
        .readFileSync(sshLog, "utf-8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line).cmd as string);
      const cleanupCommand = loggedCommands.find((cmd) => cmd.includes("rm -rf"));
      expect(cleanupCommand).not.toContain("/sandbox/.openclaw/workspace");
      expect(cleanupCommand).toContain("rm -rf -- '/sandbox/.openclaw/extensions'");
      expect(cleanupCommand).not.toContain("/sandbox/.openclaw/agents");
    } finally {
      if (oldOpenshell === undefined) {
        delete process.env.NEMOCLAW_OPENSHELL_BIN;
      } else {
        process.env.NEMOCLAW_OPENSHELL_BIN = oldOpenshell;
      }
      process.env.PATH = oldPath;
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("accepts built-in and custom OpenClaw peer links during the pre-backup audit", () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-audit-whitelist-"));
    const oldPath = process.env.PATH;
    const oldOpenshell = process.env.NEMOCLAW_OPENSHELL_BIN;
    try {
      const binDir = path.join(fixture, "bin");
      const openclawDir = path.join(fixture, "sandbox-root", ".openclaw");
      const existingDirs = ["agents", "extensions", "workspace"];
      fs.mkdirSync(binDir, { recursive: true });
      for (const d of existingDirs) fs.mkdirSync(path.join(openclawDir, d), { recursive: true });
      const auditOutput = encodePreBackupAuditRows([
        "l\t/sandbox/.openclaw/extensions/openclaw-weixin/node_modules/.bin/qrcode-terminal\t../qrcode-terminal/bin/qrcode-terminal.js",
        "l\t/sandbox/.openclaw/extensions/openclaw-weixin/node_modules/openclaw\t/usr/local/lib/node_modules/openclaw",
        "l\t/sandbox/.openclaw/extensions/slack/node_modules/openclaw\t/usr/local/lib/node_modules/openclaw",
        "l\t/sandbox/.openclaw/extensions/whatsapp/node_modules/openclaw\t/usr/local/lib/nemoclaw/openclaw-runtime/node_modules/openclaw",
        "l\t/sandbox/.openclaw/extensions/weather/node_modules/openclaw\t/usr/local/lib/node_modules/openclaw",
      ]);

      const openshell = writeFakeOpenshell(binDir);
      writeExecutable(
        path.join(binDir, "ssh"),
        `#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const cmd = process.argv[process.argv.length - 1] || "";
const existingDirs = ${JSON.stringify(existingDirs)};
if (
  cmd.startsWith("{ [ -d ") ||
  cmd.startsWith("{ for d ") ||
  cmd.startsWith("[ -d ")
) {
  process.stdout.write(existingDirs.join("\\n") + "\\n");
  process.exit(0);
}
if (cmd.includes("find ")) {
  process.stdout.write(${JSON.stringify(auditOutput)});
  process.exit(0);
}
if (cmd.includes("-cf -")) {
  const r = spawnSync("tar", ["-cf", "-", "-C", ${JSON.stringify(openclawDir)}, ...existingDirs], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (r.stdout) fs.writeSync(1, r.stdout);
  process.exit(r.status || 0);
}
process.exit(0);
`,
      );

      writeOpenClawRegistry("alpha");
      process.env.NEMOCLAW_OPENSHELL_BIN = openshell;
      process.env.PATH = `${binDir}:${oldPath || ""}`;

      const backup = backupRegisteredSandboxState("alpha");
      expect(backup.success).toBe(true);
      expect(backup.backedUpDirs).toEqual(existingDirs);
      expect(backup.error).toBeUndefined();
    } finally {
      if (oldOpenshell === undefined) {
        delete process.env.NEMOCLAW_OPENSHELL_BIN;
      } else {
        process.env.NEMOCLAW_OPENSHELL_BIN = oldOpenshell;
      }
      process.env.PATH = oldPath;
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("accepts extension npm .bin symlinks that resolve inside node_modules", () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-audit-npm-bin-"));
    const oldPath = process.env.PATH;
    const oldOpenshell = process.env.NEMOCLAW_OPENSHELL_BIN;
    try {
      const binDir = path.join(fixture, "bin");
      const openclawDir = path.join(fixture, "sandbox-root", ".openclaw");
      const existingDirs = ["extensions"];
      fs.mkdirSync(binDir, { recursive: true });
      fs.mkdirSync(path.join(openclawDir, "extensions"), { recursive: true });

      const auditOutput = encodePreBackupAuditRows([
        "l\t/sandbox/.openclaw/extensions/nemoclaw/node_modules/.bin/json5\t../json5/lib/cli.js",
        "l\t/sandbox/.openclaw/extensions/nemoclaw/node_modules/.bin/yaml\t../yaml/bin.mjs",
        "l\t/sandbox/.openclaw/extensions/nemoclaw/node_modules/.bin/node-which\t../which/bin/node-which",
      ]);

      const openshell = writeFakeOpenshell(binDir);
      writeExecutable(
        path.join(binDir, "ssh"),
        `#!/usr/bin/env node
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const cmd = process.argv[process.argv.length - 1] || "";
const existingDirs = ${JSON.stringify(existingDirs)};
const openclawDir = ${JSON.stringify(openclawDir)};
if (
  cmd.startsWith("{ [ -d ") ||
  cmd.startsWith("{ for d ") ||
  cmd.startsWith("[ -d ")
) {
  process.stdout.write(existingDirs.join("\\n") + "\\n");
  process.exit(0);
}
if (cmd.includes("find ")) {
  process.stdout.write(${JSON.stringify(auditOutput)});
  process.exit(0);
}
if (cmd.includes("-cf -")) {
  const r = spawnSync("tar", ["-cf", "-", "-C", openclawDir, ...existingDirs], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (r.stdout) fs.writeSync(1, r.stdout);
  process.exit(r.status || 0);
}
process.exit(0);
`,
      );

      writeOpenClawRegistry("alpha");
      process.env.NEMOCLAW_OPENSHELL_BIN = openshell;
      process.env.PATH = `${binDir}:${oldPath || ""}`;

      const backup = backupRegisteredSandboxState("alpha");
      expect(backup.success).toBe(true);
      expect(backup.error).toBeUndefined();
    } finally {
      if (oldOpenshell === undefined) {
        delete process.env.NEMOCLAW_OPENSHELL_BIN;
      } else {
        process.env.NEMOCLAW_OPENSHELL_BIN = oldOpenshell;
      }
      process.env.PATH = oldPath;
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("rejects extension npm .bin symlinks that escape node_modules", () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-audit-npm-bin-escape-"));
    const oldPath = process.env.PATH;
    const oldOpenshell = process.env.NEMOCLAW_OPENSHELL_BIN;
    try {
      const binDir = path.join(fixture, "bin");
      const openclawDir = path.join(fixture, "sandbox-root", ".openclaw");
      const existingDirs = ["extensions"];
      fs.mkdirSync(binDir, { recursive: true });
      fs.mkdirSync(path.join(openclawDir, "extensions"), { recursive: true });

      const auditOutput = encodePreBackupAuditRows([
        "l\t/sandbox/.openclaw/extensions/nemoclaw/node_modules/.bin/leak\t../../../../openclaw.json",
      ]);

      const openshell = writeFakeOpenshell(binDir);
      writeExecutable(
        path.join(binDir, "ssh"),
        `#!/usr/bin/env node
const cmd = process.argv[process.argv.length - 1] || "";
const existingDirs = ${JSON.stringify(existingDirs)};
if (
  cmd.startsWith("{ [ -d ") ||
  cmd.startsWith("{ for d ") ||
  cmd.startsWith("[ -d ")
) {
  process.stdout.write(existingDirs.join("\\n") + "\\n");
  process.exit(0);
}
if (cmd.includes("find ")) {
  process.stdout.write(${JSON.stringify(auditOutput)});
  process.exit(0);
}
process.exit(0);
`,
      );

      writeOpenClawRegistry("alpha");
      process.env.NEMOCLAW_OPENSHELL_BIN = openshell;
      process.env.PATH = `${binDir}:${oldPath || ""}`;

      const backup = backupRegisteredSandboxState("alpha");
      expect(backup.success).toBe(false);
      expect(backup.error).toMatch(/node_modules\/\.bin\/leak/);
      expect(backup.error).toMatch(/openclaw\.json/);
    } finally {
      if (oldOpenshell === undefined) {
        delete process.env.NEMOCLAW_OPENSHELL_BIN;
      } else {
        process.env.NEMOCLAW_OPENSHELL_BIN = oldOpenshell;
      }
      process.env.PATH = oldPath;
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("still rejects non-whitelisted symlinks alongside whitelisted ones", () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-audit-mixed-"));
    const oldPath = process.env.PATH;
    const oldOpenshell = process.env.NEMOCLAW_OPENSHELL_BIN;
    try {
      const binDir = path.join(fixture, "bin");
      const openclawDir = path.join(fixture, "sandbox-root", ".openclaw");
      const existingDirs = ["extensions", "workspace"];
      fs.mkdirSync(binDir, { recursive: true });
      for (const d of existingDirs) fs.mkdirSync(path.join(openclawDir, d), { recursive: true });

      const auditOutput = encodePreBackupAuditRows([
        "l\t/sandbox/.openclaw/extensions/openclaw-weixin/node_modules/openclaw\t/usr/local/lib/node_modules/openclaw",
        "l\t/sandbox/.openclaw/workspace/leak\t/etc/passwd",
      ]);

      const openshell = writeFakeOpenshell(binDir);
      writeExecutable(
        path.join(binDir, "ssh"),
        `#!/usr/bin/env node
const cmd = process.argv[process.argv.length - 1] || "";
const existingDirs = ${JSON.stringify(existingDirs)};
if (
  cmd.startsWith("{ [ -d ") ||
  cmd.startsWith("{ for d ") ||
  cmd.startsWith("[ -d ")
) {
  process.stdout.write(existingDirs.join("\\n") + "\\n");
  process.exit(0);
}
if (cmd.includes("find ")) {
  process.stdout.write(${JSON.stringify(auditOutput)});
  process.exit(0);
}
process.exit(0);
`,
      );

      writeOpenClawRegistry("alpha");
      process.env.NEMOCLAW_OPENSHELL_BIN = openshell;
      process.env.PATH = `${binDir}:${oldPath || ""}`;

      const backup = backupRegisteredSandboxState("alpha");
      expect(backup.success).toBe(false);
      expect(backup.error).toMatch(/workspace\/leak/);
      expect(backup.error).not.toMatch(/openclaw-weixin/);
    } finally {
      if (oldOpenshell === undefined) {
        delete process.env.NEMOCLAW_OPENSHELL_BIN;
      } else {
        process.env.NEMOCLAW_OPENSHELL_BIN = oldOpenshell;
      }
      process.env.PATH = oldPath;
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });

  it.each(["weather", "slack"])(
    "rejects a generic %s OpenClaw peer link with a tampered target",
    (extensionName) => {
      // The generic peer path is valid, but its target must remain the exact
      // global OpenClaw install rather than an arbitrary absolute path.
      const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-audit-target-tampered-"));
      const oldPath = process.env.PATH;
      const oldOpenshell = process.env.NEMOCLAW_OPENSHELL_BIN;
      try {
        const binDir = path.join(fixture, "bin");
        const openclawDir = path.join(fixture, "sandbox-root", ".openclaw");
        const existingDirs = ["extensions"];
        fs.mkdirSync(binDir, { recursive: true });
        for (const d of existingDirs) fs.mkdirSync(path.join(openclawDir, d), { recursive: true });

        const auditOutput = encodePreBackupAuditRows([
          `l\t/sandbox/.openclaw/extensions/${extensionName}/node_modules/openclaw\t/etc/passwd`,
        ]);

        const openshell = writeFakeOpenshell(binDir);
        writeExecutable(
          path.join(binDir, "ssh"),
          `#!/usr/bin/env node
const cmd = process.argv[process.argv.length - 1] || "";
const existingDirs = ${JSON.stringify(existingDirs)};
if (
  cmd.startsWith("{ [ -d ") ||
  cmd.startsWith("{ for d ") ||
  cmd.startsWith("[ -d ")
) {
  process.stdout.write(existingDirs.join("\\n") + "\\n");
  process.exit(0);
}
if (cmd.includes("find ")) {
  process.stdout.write(${JSON.stringify(auditOutput)});
  process.exit(0);
}
process.exit(0);
`,
        );

        writeOpenClawRegistry("alpha");
        process.env.NEMOCLAW_OPENSHELL_BIN = openshell;
        process.env.PATH = `${binDir}:${oldPath || ""}`;

        const backup = backupRegisteredSandboxState("alpha");
        expect(backup.success).toBe(false);
        expect(backup.error).toContain(`extensions/${extensionName}`);
        expect(backup.error).toMatch(/\/etc\/passwd/);
      } finally {
        if (oldOpenshell === undefined) {
          delete process.env.NEMOCLAW_OPENSHELL_BIN;
        } else {
          process.env.NEMOCLAW_OPENSHELL_BIN = oldOpenshell;
        }
        process.env.PATH = oldPath;
        fs.rmSync(fixture, { recursive: true, force: true });
      }
    },
  );

  it("marks non-attributed directories failed when they are missing from partial extraction", () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-missing-partial-"));
    const oldPath = process.env.PATH;
    const oldOpenshell = process.env.NEMOCLAW_OPENSHELL_BIN;
    try {
      const binDir = path.join(fixture, "bin");
      const openclawDir = path.join(fixture, "sandbox-root", ".openclaw");
      const existingDirs = ["agents", "workspace", "extensions"];
      fs.mkdirSync(binDir, { recursive: true });
      fs.mkdirSync(path.join(openclawDir, "agents"), { recursive: true });
      fs.mkdirSync(path.join(openclawDir, "workspace"), { recursive: true });
      fs.mkdirSync(path.join(openclawDir, "extensions"), { recursive: true });

      const openshell = writeFakeOpenshell(binDir);
      writeExecutable(
        path.join(binDir, "ssh"),
        `#!/usr/bin/env node
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const cmd = process.argv[process.argv.length - 1] || "";
const existingDirs = ${JSON.stringify(existingDirs)};
if (
  cmd.startsWith("{ [ -d ") ||
  cmd.startsWith("{ for d ") ||
  cmd.startsWith("[ -d ")
) {
  process.stdout.write(existingDirs.join("\\n") + "\\n");
  process.exit(0);
}
if (cmd.includes("find ")) {
  process.exit(0);
}
if (cmd.includes("-cf -")) {
  const r = spawnSync("tar", ["-cf", "-", "-C", ${JSON.stringify(openclawDir)}, "extensions"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (r.stdout) fs.writeSync(1, r.stdout);
  process.stderr.write("tar: agents/sessions.json: Cannot open: Permission denied\\n");
  process.stderr.write("tar: Exiting with failure status due to previous errors\\n");
  process.exit(2);
}
process.exit(0);
`,
      );

      writeOpenClawRegistry("alpha");
      process.env.NEMOCLAW_OPENSHELL_BIN = openshell;
      process.env.PATH = `${binDir}:${oldPath || ""}`;

      const backup = backupRegisteredSandboxState("alpha");
      expect(backup.success).toBe(false);
      expect(backup.backedUpDirs).toEqual(["extensions"]);
      expect(backup.failedDirs).toEqual(["agents", "workspace"]);
      expect(backup.failedDirReasons).toEqual({
        agents: "permission denied",
        workspace: "absent after extraction",
      });
      expect(backup.manifest?.backupComplete).toBe(false);
      expect(backup.manifest?.backedUpDirs).toEqual(["extensions"]);
      expect(sandboxState.listBackups("alpha")).toEqual([]);
      expect(fs.existsSync(backup.manifest!.backupPath)).toBe(true);
      expect(fs.existsSync(path.join(backup.manifest!.backupPath, "workspace"))).toBe(false);
    } finally {
      if (oldOpenshell === undefined) {
        delete process.env.NEMOCLAW_OPENSHELL_BIN;
      } else {
        process.env.NEMOCLAW_OPENSHELL_BIN = oldOpenshell;
      }
      process.env.PATH = oldPath;
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("treats audit-find exit 1 with empty stdout as a successful audit", () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-audit-perm-denied-"));
    const oldPath = process.env.PATH;
    const oldOpenshell = process.env.NEMOCLAW_OPENSHELL_BIN;
    try {
      const binDir = path.join(fixture, "bin");
      const openclawDir = path.join(fixture, "sandbox-root", ".openclaw");
      const existingDirs = ["agents", "extensions", "workspace"];
      fs.mkdirSync(binDir, { recursive: true });
      for (const d of existingDirs) fs.mkdirSync(path.join(openclawDir, d), { recursive: true });

      const openshell = writeFakeOpenshell(binDir);
      writeExecutable(
        path.join(binDir, "ssh"),
        `#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const cmd = process.argv[process.argv.length - 1] || "";
const existingDirs = ${JSON.stringify(existingDirs)};
if (
  cmd.startsWith("{ [ -d ") ||
  cmd.startsWith("{ for d ") ||
  cmd.startsWith("[ -d ")
) {
  process.stdout.write(existingDirs.join("\\n") + "\\n");
  process.exit(0);
}
if (cmd.includes("openclaw.json")) {
  // No openclaw.json in this fixture: the state-file backup command's
  // \`[ ! -e "$src" ] && exit 2\` fires (missing, not a failure). Handled
  // before the generic \`find \` matcher below, which would otherwise catch
  // the command's internal hardlink-check find.
  process.exit(2);
}
if (cmd.includes("find ")) {
  // Simulate a permission-denied subdir: when the audit cmd lacks the
  // \`|| true\` tolerance wrapper (pre-fix shape), exit non-zero so the
  // caller treats it as audit failure. The post-fix shape wraps each
  // \`find\` with \`|| true\` and joins with \`;\`, so the audit cmd as a
  // whole exits 0 even though a remote \`find\` would have exited 1.
  if (!cmd.includes("|| true")) {
    process.stderr.write("find: '/sandbox/.openclaw/extensions/nemoclaw': Permission denied\\n");
    process.exit(1);
  }
  process.exit(0);
}
if (cmd.includes("-cf -")) {
  const r = spawnSync("tar", ["-cf", "-", "-C", ${JSON.stringify(openclawDir)}, ...existingDirs], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (r.stdout) fs.writeSync(1, r.stdout);
  process.exit(r.status || 0);
}
process.exit(0);
`,
      );

      writeOpenClawRegistry("alpha");
      process.env.NEMOCLAW_OPENSHELL_BIN = openshell;
      process.env.PATH = `${binDir}:${oldPath || ""}`;

      const backup = backupRegisteredSandboxState("alpha");
      expect(backup.success).toBe(true);
      expect(backup.error).toBeUndefined();
      expect(backup.backedUpDirs).toEqual(existingDirs);
    } finally {
      if (oldOpenshell === undefined) {
        delete process.env.NEMOCLAW_OPENSHELL_BIN;
      } else {
        process.env.NEMOCLAW_OPENSHELL_BIN = oldOpenshell;
      }
      process.env.PATH = oldPath;
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("still rejects violations from readable dirs even if a sibling find exits non-zero", () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-audit-mixed-perm-"));
    const oldPath = process.env.PATH;
    const oldOpenshell = process.env.NEMOCLAW_OPENSHELL_BIN;
    try {
      const binDir = path.join(fixture, "bin");
      const openclawDir = path.join(fixture, "sandbox-root", ".openclaw");
      const existingDirs = ["agents", "workspace"];
      fs.mkdirSync(binDir, { recursive: true });
      for (const d of existingDirs) fs.mkdirSync(path.join(openclawDir, d), { recursive: true });

      // `agents` simulates perm-denied (no rows emitted); `workspace` emits
      // a symlink that is not in the audit allow-list, which must still be
      // caught even when a sibling find exits non-zero.
      const auditOutput = encodePreBackupAuditRows([
        "l\t/sandbox/.openclaw/workspace/leak\t../openclaw.json",
      ]);

      const openshell = writeFakeOpenshell(binDir);
      writeExecutable(
        path.join(binDir, "ssh"),
        `#!/usr/bin/env node
const cmd = process.argv[process.argv.length - 1] || "";
const existingDirs = ${JSON.stringify(existingDirs)};
if (
  cmd.startsWith("{ [ -d ") ||
  cmd.startsWith("{ for d ") ||
  cmd.startsWith("[ -d ")
) {
  process.stdout.write(existingDirs.join("\\n") + "\\n");
  process.exit(0);
}
if (cmd.includes("find ")) {
  // Match real-shell behaviour: without the \`|| true\` tolerance wrapper
  // the perm-denied sibling \`find\` would have aborted the chain. The
  // post-fix audit cmd still emits the violation stdout because \`;\`
  // joins each per-dir block so the readable sibling's output is
  // preserved.
  if (!cmd.includes("|| true")) {
    process.stderr.write("find: '/sandbox/.openclaw/agents/main': Permission denied\\n");
    process.exit(1);
  }
  process.stdout.write(${JSON.stringify(auditOutput)});
  process.exit(0);
}
process.exit(0);
`,
      );

      writeOpenClawRegistry("alpha");
      process.env.NEMOCLAW_OPENSHELL_BIN = openshell;
      process.env.PATH = `${binDir}:${oldPath || ""}`;

      const backup = backupRegisteredSandboxState("alpha");
      expect(backup.success).toBe(false);
      expect(backup.error).toMatch(/workspace\/leak/);
    } finally {
      if (oldOpenshell === undefined) {
        delete process.env.NEMOCLAW_OPENSHELL_BIN;
      } else {
        process.env.NEMOCLAW_OPENSHELL_BIN = oldOpenshell;
      }
      process.env.PATH = oldPath;
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });
});

describe("Deep Agents Code durable state files", () => {
  it("backs up manifest-declared state while excluding credential-bearing files", () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-deepagents-snapshot-"));
    const oldPath = process.env.PATH;
    const oldOpenshell = process.env.NEMOCLAW_OPENSHELL_BIN;
    try {
      const binDir = path.join(fixture, "bin");
      const fakeRoot = path.join(fixture, "sandbox-root");
      const deepAgentsDir = path.join(fakeRoot, ".deepagents");
      const sshLog = path.join(fixture, "ssh-log.jsonl");
      fs.mkdirSync(binDir, { recursive: true });
      fs.mkdirSync(path.join(deepAgentsDir, ".state"), { recursive: true });
      fs.mkdirSync(path.join(deepAgentsDir, "skills"), { recursive: true });
      fs.mkdirSync(path.join(deepAgentsDir, "agent", "skills", "note-summarizer"), {
        recursive: true,
      });
      fs.writeFileSync(path.join(deepAgentsDir, ".state", "thread.json"), "{}\n");
      fs.writeFileSync(
        path.join(deepAgentsDir, ".state", "auth.json"),
        '{"access_token":"should-not-copy"}\n',
      );
      fs.writeFileSync(
        path.join(deepAgentsDir, ".state", "chatgpt-auth.json"),
        '{"access_token":"should-not-copy","refresh_token":"should-not-copy"}\n',
      );
      fs.writeFileSync(path.join(deepAgentsDir, "skills", "README.md"), "skill\n");
      // skill-creator writes user skills under ~/.deepagents/agent/skills (#5753)
      fs.writeFileSync(
        path.join(deepAgentsDir, "agent", "skills", "note-summarizer", "SKILL.md"),
        "name: note-summarizer\n",
      );
      fs.writeFileSync(path.join(deepAgentsDir, "config.toml"), "generated config\n");
      fs.writeFileSync(path.join(deepAgentsDir, ".env"), "NVIDIA_API_KEY=should-not-copy\n");
      fs.writeFileSync(path.join(deepAgentsDir, ".mcp.json"), '{"token":"should-not-copy"}\n');
      fs.writeFileSync(
        path.join(deepAgentsDir, ".nemoclaw-mcp.json"),
        '{"mcpServers":{"reconstructable":{}}}\n',
      );

      const openshell = path.join(binDir, "openshell");
      writeExecutable(
        openshell,
        `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "sandbox" && args[1] === "ssh-config") {
  process.stdout.write("Host openshell-deepagents\\n  HostName 127.0.0.1\\n  User sandbox\\n");
  process.exit(0);
}
process.exit(0);
`,
      );

      writeExecutable(
        path.join(binDir, "ssh"),
        `#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const root = ${JSON.stringify(fakeRoot)};
const log = ${JSON.stringify(sshLog)};
const cmd = process.argv[process.argv.length - 1] || "";
fs.appendFileSync(log, JSON.stringify({ cmd }) + "\\n");
const deepAgentsDir = path.join(root, ".deepagents");
if (cmd.includes("config.toml") && cmd.includes("cat --")) {
  process.stdout.write(fs.readFileSync(path.join(deepAgentsDir, "config.toml")));
  process.exit(0);
}
if (cmd.includes(".env") || cmd.includes(".mcp.json")) {
  process.exit(99);
}
if (
  cmd.startsWith("{ [ -d ") ||
  cmd.startsWith("{ for d ") ||
  cmd.startsWith("[ -d ")
) {
  process.stdout.write(".state\\nskills\\nagent/skills\\n");
  process.exit(0);
}
if (cmd.includes("find ")) {
  process.exit(0);
}
if (cmd.includes("-cf -")) {
  const r = spawnSync("tar", ["-cf", "-", "-C", deepAgentsDir, ".state", "skills", "agent/skills"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (r.stdout) fs.writeSync(1, r.stdout);
  if (r.stderr) fs.writeSync(2, r.stderr);
  process.exit(r.status || 0);
}
if (cmd.includes("tar --no-same-owner -xf -")) {
  // drain the piped restore tarball in chunks (no full-stream buffering)
  const buf = Buffer.alloc(65536);
  while (fs.readSync(0, buf, 0, buf.length, null) > 0) {
    // discard
  }
  process.exit(0);
}
process.exit(0);
`,
      );

      writeAgentRegistry("deepagents", "langchain-deepagents-code");
      process.env.NEMOCLAW_OPENSHELL_BIN = openshell;
      process.env.PATH = `${binDir}${path.delimiter}${oldPath || ""}`;

      const backup = backupRegisteredSandboxState("deepagents", { name: "deepagents-state" });
      expect(backup.success).toBe(true);
      expect(backup.backedUpDirs).toEqual([".state", "skills", "agent/skills"]);
      expect(backup.backedUpFiles).toEqual(["config.toml"]);
      expect(backup.failedDirs).toEqual([]);
      expect(backup.failedFiles).toEqual([]);
      expect(backup.manifest?.agentType).toBe("langchain-deepagents-code");
      expect(backup.manifest?.stateDirs).toEqual([".state", "skills", "agent/skills"]);
      expect(backup.manifest?.stateFiles).toEqual([{ path: "config.toml", strategy: "copy" }]);
      expect(fs.existsSync(path.join(backup.manifest!.backupPath, ".state", "thread.json"))).toBe(
        true,
      );
      expect(fs.existsSync(path.join(backup.manifest!.backupPath, ".state", "auth.json"))).toBe(
        false,
      );
      expect(
        fs.existsSync(path.join(backup.manifest!.backupPath, ".state", "chatgpt-auth.json")),
      ).toBe(false);
      expect(fs.existsSync(path.join(backup.manifest!.backupPath, "skills", "README.md"))).toBe(
        true,
      );
      expect(fs.readFileSync(path.join(backup.manifest!.backupPath, "config.toml"), "utf-8")).toBe(
        "generated config\n",
      );
      expect(fs.existsSync(path.join(backup.manifest!.backupPath, ".env"))).toBe(false);
      expect(fs.existsSync(path.join(backup.manifest!.backupPath, ".mcp.json"))).toBe(false);
      expect(fs.existsSync(path.join(backup.manifest!.backupPath, ".nemoclaw-mcp.json"))).toBe(
        false,
      );
      const loggedCommands = fs.readFileSync(sshLog, "utf-8");
      expect(loggedCommands).not.toContain(".env");
      expect(loggedCommands).not.toContain(".mcp.json");
      expect(loggedCommands).not.toContain(".nemoclaw-mcp.json");
      // #5753: restore must include agent/skills after backup and recreation.
      const restore = restoreRegisteredSandboxState("deepagents", backup.manifest!.backupPath);
      expect(restore.success).toBe(true);
      expect(restore.restoredDirs).toEqual(
        expect.arrayContaining([".state", "skills", "agent/skills"]),
      );
    } finally {
      oldOpenshell === undefined
        ? delete process.env.NEMOCLAW_OPENSHELL_BIN
        : (process.env.NEMOCLAW_OPENSHELL_BIN = oldOpenshell);
      process.env.PATH = oldPath;
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });
});
