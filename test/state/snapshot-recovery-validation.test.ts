// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { hashSnapshotBackupContent } from "../../src/lib/state/snapshot/content-digest.js";

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-recovery-validation-"));
vi.stubEnv("HOME", TMP_HOME);
const REPO_ROOT = path.join(import.meta.dirname, "../..");
const sandboxState = (await import(
  pathToFileURL(path.join(REPO_ROOT, "src", "lib", "state", "sandbox.ts")).href
)) as typeof import("../../src/lib/state/sandbox.js");
const BACKUPS_ROOT = path.join(TMP_HOME, ".nemoclaw", "rebuild-backups");
const OPENCLAW_PACKAGE = {
  kind: "agent-runtime" as const,
  id: "openclaw",
  packageVersion: "1.0.0-test",
  contentDigest: "a".repeat(64),
};
const OPENCLAW_OWNER = {
  agent: "openclaw",
  harnessPackage: OPENCLAW_PACKAGE,
};

function writeBackup(
  sandboxName: string,
  timestamp: string,
  overrides: Record<string, unknown> = {},
  options: {
    payloadFiles?: Readonly<Record<string, string>>;
    publishContentDigest?: boolean;
  } = {},
): Record<string, unknown> {
  const backupPath = path.join(BACKUPS_ROOT, sandboxName, timestamp);
  fs.mkdirSync(backupPath, { recursive: true });
  for (const [relativePath, contents] of Object.entries(options.payloadFiles ?? {})) {
    const payloadPath = path.join(backupPath, relativePath);
    fs.mkdirSync(path.dirname(payloadPath), { recursive: true });
    fs.writeFileSync(payloadPath, contents);
  }
  const manifest = {
    version: 1,
    sandboxName,
    timestamp,
    agentType: "openclaw",
    agentVersion: null,
    expectedVersion: null,
    stateDirs: [],
    dir: "/sandbox/.openclaw",
    backupPath,
    blueprintDigest: null,
    ...overrides,
  } as Record<string, unknown>;
  manifest.version === 2 &&
    options.publishContentDigest !== false &&
    Object.assign(manifest, { backupContentSha256: hashSnapshotBackupContent(backupPath) });
  fs.writeFileSync(
    path.join(backupPath, "rebuild-manifest.json"),
    JSON.stringify(manifest, null, 2),
  );
  return manifest;
}

afterAll(() => {
  vi.unstubAllEnvs();
  fs.rmSync(TMP_HOME, { recursive: true, force: true });
});

beforeEach(() => {
  fs.rmSync(BACKUPS_ROOT, { recursive: true, force: true });
});

describe("prepared rebuild backup recovery validation (#6114)", () => {
  it("removes only an exact backup child owned by the target sandbox (#10639)", () => {
    const manifest = writeBackup("alpha", "2026-07-01T06-50-42-043Z");
    const outsidePath = path.join(TMP_HOME, "outside-backup");
    fs.mkdirSync(outsidePath, { recursive: true });

    expect(sandboxState.removeSandboxStateBackup("alpha", String(manifest.backupPath))).toBe(true);
    expect(fs.existsSync(String(manifest.backupPath))).toBe(false);
    expect(sandboxState.removeSandboxStateBackup("alpha", outsidePath)).toBe(false);
    expect(fs.existsSync(outsidePath)).toBe(true);
  });

  it("refuses to remove a backup path that is a symbolic link (#10639)", () => {
    const sandboxBackupRoot = path.join(BACKUPS_ROOT, "alpha");
    const backupPath = path.join(sandboxBackupRoot, "2026-07-01T06-50-42-043Z");
    const outsidePath = path.join(TMP_HOME, "outside-backup");
    const outsideMarker = path.join(outsidePath, "keep.txt");
    fs.mkdirSync(sandboxBackupRoot, { recursive: true });
    fs.mkdirSync(outsidePath, { recursive: true });
    fs.writeFileSync(outsideMarker, "keep");
    fs.symlinkSync(outsidePath, backupPath, "dir");

    expect(sandboxState.removeSandboxStateBackup("alpha", backupPath)).toBe(false);
    expect(fs.readFileSync(outsideMarker, "utf8")).toBe("keep");
  });

  it("does not expose a latest backup with a missing or malformed manifest", () => {
    const backupPath = path.join(BACKUPS_ROOT, "alpha", "2026-07-01T06-50-41-044Z");
    fs.mkdirSync(backupPath, { recursive: true });

    expect(sandboxState.getLatestBackup("alpha")).toBeNull();

    fs.writeFileSync(path.join(backupPath, "rebuild-manifest.json"), "{malformed");
    expect(sandboxState.getLatestBackup("alpha")).toBeNull();
  });

  it("does not follow a snapshot manifest symbolic link", () => {
    const manifest = writeBackup("alpha", "2026-07-01T06-50-41-045Z");
    const manifestPath = path.join(String(manifest.backupPath), "rebuild-manifest.json");
    const outsideManifestPath = path.join(TMP_HOME, "outside-rebuild-manifest.json");
    fs.copyFileSync(manifestPath, outsideManifestPath);
    fs.rmSync(manifestPath);
    fs.symlinkSync(outsideManifestPath, manifestPath);

    expect(sandboxState.getLatestBackup("alpha")).toBeNull();
    expect(
      sandboxState.validateRebuildRecoveryManifest("alpha", "openclaw", manifest as never),
    ).toEqual({
      ok: false,
      reason: "latest backup manifest is missing, malformed, or unsupported",
    });
  });

  it("rejects a sandbox backup root that resolves through a symbolic link", () => {
    const manifest = writeBackup("alpha", "2026-07-01T06-50-41-046Z");
    const sandboxBackupRoot = path.join(BACKUPS_ROOT, "alpha");
    const externalBackupRoot = path.join(TMP_HOME, "external-alpha-backups");
    fs.rmSync(externalBackupRoot, { recursive: true, force: true });
    fs.renameSync(sandboxBackupRoot, externalBackupRoot);
    fs.symlinkSync(externalBackupRoot, sandboxBackupRoot, "dir");

    try {
      expect(
        sandboxState.validateRebuildRecoveryManifest("alpha", "openclaw", manifest as never),
      ).toEqual({
        ok: false,
        reason: "backup path or one of its NemoClaw state ancestors is a symbolic link",
      });
    } finally {
      fs.unlinkSync(sandboxBackupRoot);
      fs.rmSync(externalBackupRoot, { recursive: true, force: true });
    }
  });

  it("accepts an exact sandbox and agent identity from its timestamped backup path", () => {
    writeBackup("alpha", "2026-07-01T06-50-42-044Z", {
      agentVersion: "2026.5.27",
      expectedVersion: "2026.5.27",
    });
    const latest = sandboxState.getLatestBackup("alpha");

    expect(latest).not.toBeNull();
    expect(sandboxState.validateRebuildRecoveryManifest("alpha", null, latest!)).toEqual({
      ok: true,
      manifest: expect.objectContaining({
        sandboxName: "alpha",
        agentType: "openclaw",
        timestamp: "2026-07-01T06-50-42-044Z",
      }),
    });
  });

  it.each([1, 2] as const)("rejects an explicitly incomplete schema v%s backup", (version) => {
    const manifest = writeBackup("alpha", `2026-07-01T06-50-42-05${String(version)}Z`, {
      version,
      ...(version === 2 ? { harnessPackage: OPENCLAW_PACKAGE } : {}),
      backupComplete: false,
    });
    const incomplete = sandboxState.readSandboxStateBackupManifest(String(manifest.backupPath));

    expect(sandboxState.getLatestBackup("alpha")).toBeNull();
    expect(incomplete).not.toBeNull();
    expect(
      sandboxState.validateRebuildRecoveryManifest(
        "alpha",
        version === 2 ? OPENCLAW_OWNER : "openclaw",
        incomplete!,
      ),
    ).toEqual({
      ok: false,
      reason: "backup manifest records an incomplete capture",
    });
  });

  it("rejects automatic recovery from a legacy manifest with failed directory captures", () => {
    const manifest = writeBackup("alpha", "2026-07-01T06-50-42-052Z", {
      version: 1,
      stateDirs: ["workspace"],
      failedBackupDirs: ["workspace"],
    });
    const incomplete = sandboxState.readSandboxStateBackupManifest(String(manifest.backupPath));

    expect(sandboxState.getLatestBackup("alpha")).toBeNull();
    expect(incomplete).not.toBeNull();
    expect(sandboxState.validateRebuildRecoveryManifest("alpha", "openclaw", incomplete!)).toEqual({
      ok: false,
      reason: "legacy backup manifest records failed directory captures",
    });
  });

  it("requires explicit completion evidence for schema v2 recovery", () => {
    writeBackup("alpha", "2026-07-01T06-50-42-053Z", {
      version: 2,
      harnessPackage: OPENCLAW_PACKAGE,
    });
    const latest = sandboxState.getLatestBackup("alpha");

    expect(latest).not.toBeNull();
    expect(sandboxState.validateRebuildRecoveryManifest("alpha", OPENCLAW_OWNER, latest!)).toEqual({
      ok: false,
      reason: "schema v2 backup manifest lacks completion evidence",
    });
  });

  it("accepts a complete schema v2 recovery manifest", () => {
    writeBackup("alpha", "2026-07-01T06-50-42-054Z", {
      version: 2,
      harnessPackage: OPENCLAW_PACKAGE,
      backupComplete: true,
    });
    const latest = sandboxState.getLatestBackup("alpha");

    expect(latest).not.toBeNull();
    expect(sandboxState.validateRebuildRecoveryManifest("alpha", OPENCLAW_OWNER, latest!)).toEqual({
      ok: true,
      manifest: expect.objectContaining({
        version: 2,
        backupComplete: true,
        backupContentSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
      }),
    });
  });

  it("requires publication-time content integrity evidence for schema v2 recovery", () => {
    writeBackup(
      "alpha",
      "2026-07-01T06-50-42-055Z",
      {
        version: 2,
        harnessPackage: OPENCLAW_PACKAGE,
        backupComplete: true,
      },
      { publishContentDigest: false },
    );
    const latest = sandboxState.getLatestBackup("alpha");

    expect(latest).not.toBeNull();
    expect(sandboxState.validateRebuildRecoveryManifest("alpha", OPENCLAW_OWNER, latest!)).toEqual({
      ok: false,
      reason: "schema v2 backup manifest lacks content integrity evidence",
    });
  });

  it("does not authorize automatic recovery after published payload bytes change", () => {
    const timestamp = "2026-07-01T06-50-42-056Z";
    writeBackup(
      "alpha",
      timestamp,
      {
        version: 2,
        harnessPackage: OPENCLAW_PACKAGE,
        backupComplete: true,
        stateDirs: ["workspace"],
        backedUpDirs: ["workspace"],
      },
      { payloadFiles: { "workspace/note.txt": "published\n" } },
    );
    const latest = sandboxState.getLatestBackup("alpha");
    expect(latest).not.toBeNull();

    fs.writeFileSync(
      path.join(BACKUPS_ROOT, "alpha", timestamp, "workspace", "note.txt"),
      "changed\n",
    );

    expect(sandboxState.validateRebuildRecoveryManifest("alpha", OPENCLAW_OWNER, latest!)).toEqual({
      ok: false,
      reason: "backup payload changed after publication",
    });
  });

  it("does not authorize a selected backup after its manifest disappears", () => {
    const manifest = writeBackup("alpha", "2026-07-01T06-50-42-057Z", {
      version: 2,
      harnessPackage: OPENCLAW_PACKAGE,
      backupComplete: true,
    });
    const latest = sandboxState.getLatestBackup("alpha");
    expect(latest).not.toBeNull();
    fs.rmSync(path.join(String(manifest.backupPath), "rebuild-manifest.json"));

    expect(sandboxState.validateSnapshotBackupContent(latest!)).toEqual({
      ok: false,
      reason: "persisted backup manifest changed during payload validation",
    });
  });

  it("does not capture manual restore authority from a damaged schema v2 payload", () => {
    const timestamp = "2026-07-01T06-50-42-057Z";
    const manifest = writeBackup(
      "alpha",
      timestamp,
      {
        version: 2,
        harnessPackage: OPENCLAW_PACKAGE,
        backupComplete: true,
        stateDirs: ["workspace"],
        backedUpDirs: ["workspace"],
      },
      { payloadFiles: { "workspace/state.txt": "published\n" } },
    );
    const latest = sandboxState.getLatestBackup("alpha");
    expect(latest).not.toBeNull();
    expect(
      sandboxState.captureSnapshotRestoreAuthority(String(manifest.backupPath), latest!),
    ).not.toBeNull();

    fs.writeFileSync(path.join(String(manifest.backupPath), "workspace", "state.txt"), "changed\n");

    expect(
      sandboxState.captureSnapshotRestoreAuthority(String(manifest.backupPath), latest!),
    ).toBeNull();
  });

  it("keeps a schema v2 snapshot selectable for manual salvage without publication evidence", () => {
    const manifest = writeBackup(
      "alpha",
      "2026-07-01T06-50-42-058Z",
      {
        version: 2,
        harnessPackage: OPENCLAW_PACKAGE,
        backupComplete: true,
      },
      { publishContentDigest: false },
    );
    const latest = sandboxState.getLatestBackup("alpha");
    expect(latest).not.toBeNull();

    expect(
      sandboxState.captureSnapshotRestoreAuthority(String(manifest.backupPath), latest!),
    ).toMatchObject({
      schemaVersion: 1,
      backupPath: String(manifest.backupPath),
      contentSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
  });

  it("round-trips validated OpenClaw image-plugin provenance through recovery", () => {
    const openclawImagePluginInstalls = [
      {
        id: "weather",
        installPath: "/sandbox/.openclaw/extensions/weather",
        loadPaths: [],
      },
      {
        id: "npm-plugin",
        installPath: "/sandbox/.openclaw/npm/node_modules/npm-plugin",
        loadPaths: [],
      },
    ];
    writeBackup("alpha", "2026-07-01T06-50-42-045Z", {
      reconcileOpenClawImagePluginProvenance: true,
      openclawImagePluginInstalls,
    });
    const latest = sandboxState.getLatestBackup("alpha");

    expect(latest?.openclawImagePluginInstalls).toEqual(openclawImagePluginInstalls);
    expect(latest?.reconcileOpenClawImagePluginProvenance).toBe(true);
    expect(sandboxState.validateRebuildRecoveryManifest("alpha", "openclaw", latest!)).toEqual({
      ok: true,
      manifest: expect.objectContaining({
        reconcileOpenClawImagePluginProvenance: true,
        openclawImagePluginInstalls,
      }),
    });
  });

  it("rejects a marked manifest without explicit image-plugin provenance", () => {
    const manifest = writeBackup("alpha", "2026-07-01T06-50-42-045Z", {
      reconcileOpenClawImagePluginProvenance: true,
    });

    expect(sandboxState.getLatestBackup("alpha")).toBeNull();
    expect(
      sandboxState.restoreRecreatedSandboxState("alpha", String(manifest.backupPath), {
        targetAgentType: "openclaw",
        freshOpenClawImagePluginInstalls: [],
      }),
    ).toMatchObject({
      success: false,
      error: sandboxState.OPENCLAW_IMAGE_PLUGIN_PROVENANCE_RESTORE_ERROR,
    });
  });

  it.each([
    ["a non-array value", { weather: "/sandbox/.openclaw/extensions/weather" }],
    [
      "an unsafe plugin id",
      [
        {
          id: "../weather",
          installPath: "/sandbox/.openclaw/extensions/weather",
          loadPaths: [],
        },
      ],
    ],
    [
      "a relative install path",
      [{ id: "weather", installPath: "extensions/weather", loadPaths: [] }],
    ],
    [
      "duplicate install paths",
      [
        {
          id: "weather",
          installPath: "/sandbox/.openclaw/extensions/weather",
          loadPaths: [],
        },
        {
          id: "weather-copy",
          installPath: "/sandbox/.openclaw/extensions/weather",
          loadPaths: [],
        },
      ],
    ],
  ])("rejects image-plugin provenance with %s", (_case, openclawImagePluginInstalls) => {
    writeBackup("alpha", "2026-07-01T06-50-42-046Z", { openclawImagePluginInstalls });

    expect(sandboxState.getLatestBackup("alpha")).toBeNull();
  });

  it("rejects a persisted manifest that disappears or becomes malformed after discovery", () => {
    const candidate = writeBackup("alpha", "2026-07-01T06-50-42-044Z", {
      agentVersion: "2026.5.27",
      expectedVersion: "2026.5.27",
    });
    const manifestPath = path.join(
      BACKUPS_ROOT,
      "alpha",
      "2026-07-01T06-50-42-044Z",
      "rebuild-manifest.json",
    );

    fs.unlinkSync(manifestPath);
    expect(sandboxState.validateRebuildRecoveryManifest("alpha", null, candidate as never)).toEqual(
      {
        ok: false,
        reason: "latest backup manifest is missing, malformed, or unsupported",
      },
    );

    fs.writeFileSync(manifestPath, "{malformed");
    expect(sandboxState.validateRebuildRecoveryManifest("alpha", null, candidate as never)).toEqual(
      {
        ok: false,
        reason: "latest backup manifest is missing, malformed, or unsupported",
      },
    );
  });

  it("rejects sandbox, agent, and backup-path identity mismatches", () => {
    writeBackup("alpha", "2026-07-01T06-50-42-044Z", {
      sandboxName: "beta",
      agentType: "hermes",
    });
    const mismatched = sandboxState.getLatestBackup("alpha");

    expect(mismatched).not.toBeNull();
    expect(sandboxState.validateRebuildRecoveryManifest("alpha", "hermes", mismatched!)).toEqual({
      ok: false,
      reason: "manifest sandbox 'beta' does not match 'alpha'",
    });

    writeBackup("alpha", "2026-07-01T06-50-43-044Z", { agentType: "hermes" });
    const agentMismatch = sandboxState.getLatestBackup("alpha");
    expect(agentMismatch).not.toBeNull();
    expect(
      sandboxState.validateRebuildRecoveryManifest("alpha", "openclaw", agentMismatch!),
    ).toEqual({
      ok: false,
      reason: "manifest agent 'hermes' does not match registry agent 'openclaw'",
    });

    const exact = writeBackup("alpha", "2026-07-01T06-51-42-044Z", {
      backupPath: path.join(BACKUPS_ROOT, "alpha", "some-other-backup"),
    });
    expect(sandboxState.validateRebuildRecoveryManifest("alpha", null, exact as never)).toEqual({
      ok: false,
      reason: "backup path does not match 'alpha' and timestamp '2026-07-01T06-51-42-044Z'",
    });
  });

  it("requires a non-empty managed-image fingerprint", () => {
    expect(sandboxState.hasPositiveManagedImageEvidence({ nemoclawVersion: "0.0.71" })).toBe(true);
    expect(sandboxState.hasPositiveManagedImageEvidence({ nemoclawVersion: null })).toBe(false);
    expect(sandboxState.hasPositiveManagedImageEvidence({ nemoclawVersion: "  " })).toBe(false);
    expect(sandboxState.hasPositiveManagedImageEvidence({ nemoclawVersion: 123 } as never)).toBe(
      false,
    );
    expect(sandboxState.hasPositiveManagedImageEvidence({ nemoclawVersion: {} } as never)).toBe(
      false,
    );
  });

  it("allows legacy managed-image recovery only with per-row authority and no custom image (#6114)", () => {
    expect(
      sandboxState.isManagedImageRecoveryAllowed(
        { nemoclawVersion: "0.0.71", fromDockerfile: undefined },
        false,
      ),
    ).toBe(true);
    expect(
      sandboxState.isManagedImageRecoveryAllowed(
        { nemoclawVersion: "0.0.71", fromDockerfile: "/tmp/custom.Dockerfile" },
        false,
      ),
    ).toBe(false);
    expect(
      sandboxState.isManagedImageRecoveryAllowed(
        { nemoclawVersion: null, fromDockerfile: undefined },
        true,
      ),
    ).toBe(true);
    expect(
      sandboxState.isManagedImageRecoveryAllowed(
        { nemoclawVersion: null, fromDockerfile: null },
        true,
      ),
    ).toBe(true);
    expect(
      sandboxState.isManagedImageRecoveryAllowed(
        { nemoclawVersion: null, fromDockerfile: undefined },
        false,
      ),
    ).toBe(false);
    expect(
      sandboxState.isManagedImageRecoveryAllowed(
        { nemoclawVersion: null, fromDockerfile: "/tmp/custom.Dockerfile" },
        true,
      ),
    ).toBe(false);
  });
});
