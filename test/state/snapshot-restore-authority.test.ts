// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { loadAgent } from "../../src/lib/agent/defs";

const ORIGINAL_HOME = process.env.HOME;
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-snapshot-restore-authority-"));
process.env.HOME = TMP_HOME;
const sandboxState = await import("../../src/lib/state/sandbox.js");
const BACKUPS_ROOT = path.join(TMP_HOME, ".nemoclaw", "rebuild-backups");

type BackupManifestOverrides = Record<string, unknown>;

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

function testHarnessPackage(agentId: string) {
  return {
    kind: "agent-runtime" as const,
    id: agentId,
    packageVersion: "1.2.3",
    contentDigest: "a".repeat(64),
  };
}

function writeOpenClawRegistry(sandboxName: string): void {
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
          policies: [],
          agent: null,
          harnessPackage: testHarnessPackage("openclaw"),
        },
      },
    }),
  );
}

function writeExecutable(filePath: string, source: string): void {
  fs.writeFileSync(filePath, source, { mode: 0o755 });
}

function restoreEnv(name: string, value: string | undefined): void {
  value === undefined
    ? Reflect.deleteProperty(process.env, name)
    : Reflect.set(process.env, name, value);
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

afterAll(() => {
  ORIGINAL_HOME === undefined
    ? Reflect.deleteProperty(process.env, "HOME")
    : Reflect.set(process.env, "HOME", ORIGINAL_HOME);
  fs.rmSync(TMP_HOME, { recursive: true, force: true });
});

beforeEach(() => {
  fs.rmSync(BACKUPS_ROOT, { recursive: true, force: true });
});

describe("snapshot restore content authority", () => {
  it("binds the selected manifest and payload bytes to one digest", () => {
    const manifest = writeBackup("alpha", "2026-04-21T14-00-00-000Z", {
      backedUpDirs: ["workspace"],
      stateDirs: ["workspace"],
    });
    const backupPath = String(manifest.backupPath);
    fs.mkdirSync(path.join(backupPath, "workspace"));
    fs.writeFileSync(path.join(backupPath, "workspace", "state.txt"), "before\n");
    const selected = sandboxState.getLatestBackup("alpha");
    expect(selected).not.toBeNull();

    const authority = sandboxState.captureSnapshotRestoreAuthority(backupPath, selected!);
    expect(authority).toMatchObject({
      schemaVersion: 1,
      backupPath,
      contentSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });

    fs.writeFileSync(path.join(backupPath, "workspace", "state.txt"), "after\n");
    expect(sandboxState.captureSnapshotRestoreAuthority(backupPath)?.contentSha256).not.toBe(
      authority?.contentSha256,
    );
  });

  it("restores the prepared payload after the selected snapshot is removed", () => {
    const manifest = writeBackup("alpha", "2026-04-21T14-00-00-000Z", {
      stateDirs: ["workspace"],
      backedUpDirs: ["workspace"],
    });
    const backupPath = String(manifest.backupPath);
    const payloadPath = path.join(backupPath, "workspace", "state.txt");
    fs.mkdirSync(path.dirname(payloadPath));
    fs.writeFileSync(payloadPath, "selected payload\n");
    const snapshotMtime = new Date("2001-02-03T04:05:06.000Z");
    fs.utimesSync(payloadPath, snapshotMtime, snapshotMtime);
    fs.utimesSync(path.dirname(payloadPath), snapshotMtime, snapshotMtime);
    const selected = sandboxState.getLatestBackup("alpha");
    expect(selected).not.toBeNull();
    writeOpenClawRegistry("alpha");

    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-prepared-restore-"));
    const binDir = path.join(fixture, "bin");
    const stagingRoot = path.join(fixture, "staging");
    const capturedArchive = path.join(fixture, "restore.tar");
    fs.mkdirSync(binDir);
    fs.mkdirSync(stagingRoot);
    const openshell = writeFakeOpenshell(binDir);
    writeExecutable(
      path.join(binDir, "ssh"),
      `#!/usr/bin/env node
const fs = require("node:fs");
const command = process.argv[process.argv.length - 1] || "";
const input = fs.readFileSync(0);
if (command.includes("tar --no-same-owner")) {
  fs.writeFileSync(${JSON.stringify(capturedArchive)}, input);
}
process.exit(0);
`,
    );
    const oldOpenshell = process.env.NEMOCLAW_OPENSHELL_BIN;
    const oldPath = process.env.PATH;
    const oldTmpdir = process.env.TMPDIR;
    process.env.NEMOCLAW_OPENSHELL_BIN = openshell;
    process.env.PATH = `${binDir}${path.delimiter}${oldPath ?? ""}`;
    process.env.TMPDIR = stagingRoot;
    const validateBeforeMutation = vi.fn();
    let prepared: ReturnType<typeof sandboxState.prepareSnapshotRestoreContent> = null;

    try {
      prepared = sandboxState.prepareSnapshotRestoreContent(backupPath, selected!);
      expect(prepared).not.toBeNull();
      expect(
        fs.readFileSync(path.join(prepared!.stagedBackupPath, "workspace", "state.txt"), "utf8"),
      ).toBe("selected payload\n");
      expect(
        Math.trunc(
          fs.statSync(path.join(prepared!.stagedBackupPath, "workspace", "state.txt")).mtimeMs,
        ),
      ).toBe(snapshotMtime.getTime());
      expect(
        Math.trunc(fs.statSync(path.join(prepared!.stagedBackupPath, "workspace")).mtimeMs),
      ).toBe(snapshotMtime.getTime());

      fs.rmSync(backupPath, { recursive: true, force: true });
      const result = sandboxState.restoreSandboxState("alpha", backupPath, {
        agentDefinition: loadAgent("openclaw"),
        authority: prepared!.authority,
        preparedContent: prepared!,
        validateBeforeMutation,
      });

      expect(result).toMatchObject({
        success: true,
        restoredDirs: ["workspace"],
        failedDirs: [],
      });
      expect(validateBeforeMutation).toHaveBeenCalledOnce();
      const extracted = spawnSync("tar", ["-xOf", capturedArchive, "workspace/state.txt"], {
        encoding: "utf8",
      });
      expect(extracted.status).toBe(0);
      expect(extracted.stdout).toBe("selected payload\n");
      const extractedRoot = path.join(fixture, "extracted");
      fs.mkdirSync(extractedRoot);
      expect(spawnSync("tar", ["-xf", capturedArchive, "-C", extractedRoot]).status).toBe(0);
      expect(
        Math.trunc(fs.statSync(path.join(extractedRoot, "workspace", "state.txt")).mtimeMs / 1000),
      ).toBe(snapshotMtime.getTime() / 1000);
      expect(Math.trunc(fs.statSync(path.join(extractedRoot, "workspace")).mtimeMs / 1000)).toBe(
        snapshotMtime.getTime() / 1000,
      );
    } finally {
      prepared?.cleanup();
      restoreEnv("NEMOCLAW_OPENSHELL_BIN", oldOpenshell);
      restoreEnv("TMPDIR", oldTmpdir);
      process.env.PATH = oldPath;
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("fails preparation when the selected snapshot changes before its private copy", () => {
    const manifest = writeBackup("alpha", "2026-04-21T14-00-00-000Z", {
      stateDirs: ["workspace"],
      backedUpDirs: ["workspace"],
    });
    const backupPath = String(manifest.backupPath);
    const payloadPath = path.join(backupPath, "workspace", "state.txt");
    fs.mkdirSync(path.dirname(payloadPath));
    fs.writeFileSync(payloadPath, "selected payload\n");
    const selected = sandboxState.getLatestBackup("alpha");
    expect(selected).not.toBeNull();

    const stagingRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-preparation-race-"));
    const oldTmpdir = process.env.TMPDIR;
    process.env.TMPDIR = stagingRoot;
    const originalMkdtempSync = fs.mkdtempSync;
    const mutableFs = fs as unknown as { mkdtempSync: typeof fs.mkdtempSync };
    let privateCopyStarted = false;

    try {
      mutableFs.mkdtempSync = ((prefix, options) => {
        const stagingPath = originalMkdtempSync(prefix, options as never);
        const privateCopy = String(prefix).includes("nemoclaw-snapshot-restore-");
        privateCopyStarted ||= privateCopy;
        privateCopy && fs.writeFileSync(payloadPath, "changed before private copy\n");
        return stagingPath;
      }) as typeof fs.mkdtempSync;
      syncBuiltinESMExports();

      expect(sandboxState.prepareSnapshotRestoreContent(backupPath, selected!)).toBeNull();
      expect(privateCopyStarted).toBe(true);
      expect(fs.readdirSync(stagingRoot)).toEqual([]);
    } finally {
      mutableFs.mkdtempSync = originalMkdtempSync;
      syncBuiltinESMExports();
      restoreEnv("TMPDIR", oldTmpdir);
      fs.rmSync(stagingRoot, { recursive: true, force: true });
    }
  });

  it("removes a read-only prepared tree when cleanup is repeated", () => {
    const manifest = writeBackup("alpha", "2026-04-21T14-00-00-000Z", {
      stateDirs: ["workspace"],
      backedUpDirs: ["workspace"],
    });
    const backupPath = String(manifest.backupPath);
    const workspacePath = path.join(backupPath, "workspace");
    fs.mkdirSync(workspacePath);
    fs.writeFileSync(path.join(workspacePath, "state.txt"), "read only\n");
    fs.chmodSync(workspacePath, 0o555);
    const selected = sandboxState.getLatestBackup("alpha");
    expect(selected).not.toBeNull();
    const prepared = sandboxState.prepareSnapshotRestoreContent(backupPath, selected!);
    expect(prepared).not.toBeNull();
    const stagedBackupPath = prepared!.stagedBackupPath;

    fs.chmodSync(stagedBackupPath, 0o555);
    prepared!.cleanup();
    prepared!.cleanup();

    expect(fs.existsSync(stagedBackupPath)).toBe(false);
    fs.chmodSync(workspacePath, 0o700);
  });

  it("rejects an mtime-only substitution before private staging", () => {
    const manifest = writeBackup("alpha", "2026-04-21T14-00-00-000Z", {
      stateDirs: ["workspace"],
      backedUpDirs: ["workspace"],
    });
    const backupPath = String(manifest.backupPath);
    const workspacePath = path.join(backupPath, "workspace");
    const payloadPath = path.join(workspacePath, "payload.txt");
    fs.mkdirSync(workspacePath);
    fs.writeFileSync(payloadPath, "unchanged payload\n");
    const selectedMtime = new Date("2001-02-03T04:05:06.000Z");
    fs.utimesSync(payloadPath, selectedMtime, selectedMtime);
    const selected = sandboxState.getLatestBackup("alpha");
    expect(selected).not.toBeNull();
    const authority = sandboxState.captureSnapshotRestoreAuthority(backupPath, selected!);
    expect(authority).not.toBeNull();

    const substitutedMtime = new Date("2001-02-03T04:06:06.000Z");
    fs.utimesSync(payloadPath, substitutedMtime, substitutedMtime);
    expect(sandboxState.captureSnapshotRestoreAuthority(backupPath)?.contentSha256).not.toBe(
      authority!.contentSha256,
    );
    fs.utimesSync(payloadPath, selectedMtime, selectedMtime);

    const originalMkdtempSync = fs.mkdtempSync;
    const mutableFs = fs as unknown as { mkdtempSync: typeof fs.mkdtempSync };
    try {
      mutableFs.mkdtempSync = ((prefix, options) => {
        const stagingPath = originalMkdtempSync(prefix, options as never);
        String(prefix).includes("nemoclaw-snapshot-restore-") &&
          fs.utimesSync(payloadPath, substitutedMtime, substitutedMtime);
        return stagingPath;
      }) as typeof fs.mkdtempSync;
      syncBuiltinESMExports();

      expect(sandboxState.prepareSnapshotRestoreContent(backupPath, selected!)).toBeNull();
    } finally {
      mutableFs.mkdtempSync = originalMkdtempSync;
      syncBuiltinESMExports();
    }
  });

  it("rejects a mode-only substitution before SSH or restore mutation", async () => {
    const manifest = writeBackup("alpha", "2026-04-21T14-00-00-000Z", {
      stateDirs: ["workspace"],
      backedUpDirs: ["workspace"],
    });
    const backupPath = String(manifest.backupPath);
    const workspacePath = path.join(backupPath, "workspace");
    const payloadPath = path.join(workspacePath, "payload.txt");
    fs.mkdirSync(workspacePath);
    fs.writeFileSync(payloadPath, "unchanged payload\n");
    fs.chmodSync(workspacePath, 0o700);
    fs.chmodSync(payloadPath, 0o600);
    const selected = sandboxState.getLatestBackup("alpha");
    expect(selected).not.toBeNull();
    const authority = sandboxState.captureSnapshotRestoreAuthority(backupPath, selected!);
    expect(authority).not.toBeNull();

    fs.chmodSync(payloadPath, 0o640);
    expect(sandboxState.captureSnapshotRestoreAuthority(backupPath)?.contentSha256).not.toBe(
      authority?.contentSha256,
    );
    fs.chmodSync(payloadPath, 0o600);
    expect(sandboxState.captureSnapshotRestoreAuthority(backupPath)?.contentSha256).toBe(
      authority?.contentSha256,
    );
    fs.chmodSync(workspacePath, 0o750);
    expect(sandboxState.captureSnapshotRestoreAuthority(backupPath)?.contentSha256).not.toBe(
      authority?.contentSha256,
    );

    writeOpenClawRegistry("alpha");
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-mode-substitution-"));
    const binDir = path.join(fixture, "bin");
    const stagingRoot = path.join(fixture, "staging");
    const remoteMutationMarker = path.join(fixture, "remote-command-ran");
    fs.mkdirSync(binDir);
    fs.mkdirSync(stagingRoot);
    const openshell = path.join(binDir, "openshell");
    writeExecutable(
      openshell,
      `#!/usr/bin/env node
require("node:fs").writeFileSync(${JSON.stringify(remoteMutationMarker)}, "openshell invoked\n");
process.stdout.write("Host openshell-alpha\\n  HostName 127.0.0.1\\n  User sandbox\\n");
`,
    );
    writeExecutable(
      path.join(binDir, "ssh"),
      `#!/usr/bin/env node
require("node:fs").writeFileSync(${JSON.stringify(remoteMutationMarker)}, "ssh invoked\n");
`,
    );
    const oldOpenshell = process.env.NEMOCLAW_OPENSHELL_BIN;
    const oldPath = process.env.PATH;
    const oldTmpdir = process.env.TMPDIR;
    process.env.NEMOCLAW_OPENSHELL_BIN = openshell;
    process.env.PATH = `${binDir}${path.delimiter}${oldPath ?? ""}`;
    process.env.TMPDIR = stagingRoot;
    const validateBeforeMutation = vi.fn();
    const { loadAgent } = await import("../../src/lib/agent/defs.js");

    try {
      const result = sandboxState.restoreSandboxState("alpha", backupPath, {
        agentDefinition: loadAgent("openclaw"),
        authority: authority!,
        validateBeforeMutation,
      });

      expect(result).toMatchObject({
        success: false,
        error: expect.stringContaining("snapshot"),
      });
      expect(validateBeforeMutation).not.toHaveBeenCalled();
      expect(fs.existsSync(remoteMutationMarker)).toBe(false);
      expect(fs.readFileSync(payloadPath, "utf8")).toBe("unchanged payload\n");
      expect(fs.statSync(workspacePath).mode & 0o777).toBe(0o750);
      expect(fs.readdirSync(stagingRoot)).toEqual([]);
    } finally {
      restoreEnv("NEMOCLAW_OPENSHELL_BIN", oldOpenshell);
      restoreEnv("TMPDIR", oldTmpdir);
      process.env.PATH = oldPath;
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("removes its operation-owned tree after a successful restore", async () => {
    const manifest = writeBackup("alpha", "2026-04-21T14-00-00-000Z");
    const backupPath = String(manifest.backupPath);
    const selected = sandboxState.getLatestBackup("alpha");
    expect(selected).not.toBeNull();
    const authority = sandboxState.captureSnapshotRestoreAuthority(backupPath, selected!);
    expect(authority).not.toBeNull();
    writeOpenClawRegistry("alpha");
    const stagingRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-restore-cleanup-"));
    const oldTmpdir = process.env.TMPDIR;
    process.env.TMPDIR = stagingRoot;
    const validateBeforeMutation = vi.fn();
    const { loadAgent } = await import("../../src/lib/agent/defs.js");

    try {
      const result = sandboxState.restoreSandboxState("alpha", backupPath, {
        agentDefinition: loadAgent("openclaw"),
        authority: authority!,
        validateBeforeMutation,
      });

      expect(result).toEqual({
        success: true,
        restoredDirs: [],
        failedDirs: [],
        restoredFiles: [],
        failedFiles: [],
      });
      expect(validateBeforeMutation).toHaveBeenCalledOnce();
      expect(fs.readdirSync(stagingRoot)).toEqual([]);
    } finally {
      restoreEnv("TMPDIR", oldTmpdir);
      fs.rmSync(stagingRoot, { recursive: true, force: true });
    }
  });

  it("removes its operation-owned tree after a post-staging authority failure", async () => {
    const manifest = writeBackup("alpha", "2026-04-21T14-00-00-000Z");
    const backupPath = String(manifest.backupPath);
    const selected = sandboxState.getLatestBackup("alpha");
    expect(selected).not.toBeNull();
    const authority = sandboxState.captureSnapshotRestoreAuthority(backupPath, selected!);
    expect(authority).not.toBeNull();
    writeOpenClawRegistry("alpha");
    const stagingRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-restore-cleanup-"));
    const oldTmpdir = process.env.TMPDIR;
    process.env.TMPDIR = stagingRoot;
    const { loadAgent } = await import("../../src/lib/agent/defs.js");

    try {
      const result = sandboxState.restoreSandboxState("alpha", backupPath, {
        agentDefinition: loadAgent("openclaw"),
        authority: authority!,
        validateBeforeMutation: () => {
          throw new Error("sandbox authority changed");
        },
      });

      expect(result).toMatchObject({
        success: false,
        error: "Runtime authority changed before filesystem mutation: sandbox authority changed",
      });
      expect(fs.readdirSync(stagingRoot)).toEqual([]);
    } finally {
      restoreEnv("TMPDIR", oldTmpdir);
      fs.rmSync(stagingRoot, { recursive: true, force: true });
    }
  });

  it("stages files from a valid read-only snapshot directory before the runtime fence", async () => {
    const manifest = writeBackup("alpha", "2026-04-21T14-00-00-000Z", {
      stateDirs: ["workspace"],
      backedUpDirs: ["workspace"],
    });
    const backupPath = String(manifest.backupPath);
    const workspacePath = path.join(backupPath, "workspace");
    fs.mkdirSync(workspacePath, { mode: 0o755 });
    fs.writeFileSync(path.join(workspacePath, "state.txt"), "preserved\n");
    fs.chmodSync(workspacePath, 0o555);
    const selected = sandboxState.getLatestBackup("alpha");
    expect(selected).not.toBeNull();
    const authority = sandboxState.captureSnapshotRestoreAuthority(backupPath, selected!);
    expect(authority).not.toBeNull();
    writeOpenClawRegistry("alpha");
    const runtimeFixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-readonly-staging-"));
    const binDir = path.join(runtimeFixture, "bin");
    fs.mkdirSync(binDir);
    const openshell = writeFakeOpenshell(binDir);
    const oldOpenshell = process.env.NEMOCLAW_OPENSHELL_BIN;
    const oldPath = process.env.PATH;
    process.env.NEMOCLAW_OPENSHELL_BIN = openshell;
    process.env.PATH = `${binDir}${path.delimiter}${oldPath ?? ""}`;
    const validateBeforeMutation = vi.fn(() => {
      throw new Error("stop after private staging");
    });

    try {
      const result = sandboxState.restoreSandboxState("alpha", backupPath, {
        agentDefinition: loadAgent("openclaw"),
        authority: authority!,
        validateBeforeMutation,
      });

      expect(result).toMatchObject({
        success: false,
        error: "Runtime authority changed before filesystem mutation: stop after private staging",
      });
      expect(validateBeforeMutation).toHaveBeenCalledOnce();
      expect(fs.readFileSync(path.join(workspacePath, "state.txt"), "utf8")).toBe("preserved\n");
      expect(fs.statSync(workspacePath).mode & 0o777).toBe(0o555);
    } finally {
      fs.chmodSync(workspacePath, 0o700);
      restoreEnv("NEMOCLAW_OPENSHELL_BIN", oldOpenshell);
      process.env.PATH = oldPath;
      fs.rmSync(runtimeFixture, { recursive: true, force: true });
    }
  });

  it("rejects a substituted backup root before its root state file or tar payload can mutate the sandbox", async () => {
    const manifest = writeBackup("alpha", "2026-04-21T14-00-00-000Z", {
      stateDirs: ["workspace"],
      backedUpDirs: ["workspace"],
      stateFiles: [{ path: "state.bin", strategy: "copy" }],
    });
    const backupPath = String(manifest.backupPath);
    fs.mkdirSync(path.join(backupPath, "workspace"));
    fs.writeFileSync(path.join(backupPath, "workspace", "payload.txt"), "selected tar payload\n");
    fs.writeFileSync(path.join(backupPath, "state.bin"), "selected root state\n");
    const selected = sandboxState.getLatestBackup("alpha");
    expect(selected).not.toBeNull();
    const authority = sandboxState.captureSnapshotRestoreAuthority(backupPath, selected!);
    expect(authority).not.toBeNull();

    const selectedRoot = `${backupPath}-selected`;
    fs.renameSync(backupPath, selectedRoot);
    fs.mkdirSync(path.join(backupPath, "workspace"), { recursive: true });
    fs.writeFileSync(
      path.join(backupPath, "rebuild-manifest.json"),
      fs.readFileSync(path.join(selectedRoot, "rebuild-manifest.json")),
    );
    fs.writeFileSync(
      path.join(backupPath, "workspace", "payload.txt"),
      "substituted tar payload\n",
    );
    fs.writeFileSync(path.join(backupPath, "state.bin"), "substituted root state\n");
    const substitutedRoot = `${backupPath}-substituted`;
    writeOpenClawRegistry("alpha");

    const runtimeFixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-root-swap-"));
    const binDir = path.join(runtimeFixture, "bin");
    const remoteMutationMarker = path.join(runtimeFixture, "remote-command-ran");
    fs.mkdirSync(binDir, { recursive: true });
    const openshell = path.join(binDir, "openshell");
    writeExecutable(
      openshell,
      `#!/usr/bin/env node
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(remoteMutationMarker)}, "openshell invoked\n");
process.stdout.write("Host openshell-alpha\\n  HostName 127.0.0.1\\n  User sandbox\\n");
`,
    );
    writeExecutable(
      path.join(binDir, "ssh"),
      `#!/usr/bin/env node
require("node:fs").writeFileSync(${JSON.stringify(remoteMutationMarker)}, "ssh invoked\n");
`,
    );
    const oldOpenshell = process.env.NEMOCLAW_OPENSHELL_BIN;
    const oldPath = process.env.PATH;
    process.env.NEMOCLAW_OPENSHELL_BIN = openshell;
    process.env.PATH = `${binDir}${path.delimiter}${oldPath ?? ""}`;
    const validateBeforeMutation = vi.fn();
    const { loadAgent } = await import("../../src/lib/agent/defs.js");
    const originalLstatSync = fs.lstatSync;
    const mutableFs = fs as unknown as { lstatSync: typeof fs.lstatSync };
    let rootStateFileChecks = 0;

    try {
      mutableFs.lstatSync = ((target, options) => {
        const stat = originalLstatSync(target, options as never);
        const isRootStateFile =
          path.resolve(String(target)) === path.resolve(path.join(backupPath, "state.bin"));
        rootStateFileChecks += Number(isRootStateFile);
        const shouldRestoreSelectedRoot = isRootStateFile && rootStateFileChecks === 2;
        // Return the substituted file's stable stat, then restore the
        // selected root. The old implementation consumed substituted tar and
        // state bytes before its path-based final hash saw this root.
        shouldRestoreSelectedRoot && fs.renameSync(backupPath, substitutedRoot);
        shouldRestoreSelectedRoot && fs.renameSync(selectedRoot, backupPath);
        return stat;
      }) as typeof fs.lstatSync;
      syncBuiltinESMExports();
      const result = sandboxState.restoreSandboxState("alpha", backupPath, {
        agentDefinition: loadAgent("openclaw"),
        authority: authority!,
        validateBeforeMutation,
      });

      expect(result).toMatchObject({
        success: false,
        error: expect.stringContaining("snapshot"),
      });
      expect(rootStateFileChecks).toBeGreaterThanOrEqual(2);
      expect(validateBeforeMutation).not.toHaveBeenCalled();
      expect(fs.existsSync(remoteMutationMarker)).toBe(false);
      expect(fs.readFileSync(path.join(backupPath, "state.bin"), "utf8")).toBe(
        "selected root state\n",
      );
      expect(fs.readFileSync(path.join(backupPath, "workspace", "payload.txt"), "utf8")).toBe(
        "selected tar payload\n",
      );
    } finally {
      mutableFs.lstatSync = originalLstatSync;
      syncBuiltinESMExports();
      restoreEnv("NEMOCLAW_OPENSHELL_BIN", oldOpenshell);
      process.env.PATH = oldPath;
      fs.rmSync(runtimeFixture, { recursive: true, force: true });
      fs.rmSync(substitutedRoot, { recursive: true, force: true });
      fs.rmSync(selectedRoot, { recursive: true, force: true });
    }
  });
});

// ordering permutations, and error cases for a missing or flag-shaped value.
