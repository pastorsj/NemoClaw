// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { hashSnapshotBackupContent } from "./snapshot/content-digest.js";
import {
  __test,
  clearRebuildPolicyHandoff,
  inspectRebuildManifestHarnessPackage,
  readRebuildPolicyHandoff,
  readSandboxStateBackupManifest,
  type RebuildManifest,
  validateSnapshotBackupContent,
  writeRebuildPolicyHandoff,
} from "./sandbox.js";

const tempDirs: string[] = [];

const OPENCLAW_PACKAGE = {
  kind: "agent-runtime" as const,
  id: "openclaw",
  packageVersion: "1.2.3",
  contentDigest: "a".repeat(64),
};

const FUTURE_PACKAGE = {
  ...OPENCLAW_PACKAGE,
  id: "future-harness",
};

const MANAGED_EXTENSIONS = {
  support: "managed" as const,
  controller: { command: ["/usr/local/bin/extension-state"], timeout_seconds: 10 },
  state_directory: "extensions",
  preserved_directories: [],
  allowed_symlinks: [],
};

const LEGACY_OPENCLAW_EXTENSION = {
  id: "weather",
  installPath: "/sandbox/.openclaw/extensions/weather",
  loadPaths: ["/sandbox/.openclaw/extensions/weather/index.js"],
};

function manifest(backupPath: string): RebuildManifest {
  return {
    version: 2,
    sandboxName: "alpha",
    timestamp: "2026-07-27T21-00-00-000Z",
    agentType: "openclaw",
    agentVersion: null,
    expectedVersion: null,
    harnessPackage: OPENCLAW_PACKAGE,
    stateDirs: [],
    failedBackupDirs: [],
    backupComplete: true,
    stateFiles: [],
    dir: "/sandbox",
    backupPath,
    blueprintDigest: "digest",
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("rebuild manifest publication", () => {
  it("selects snapshot extensions from a future package lifecycle declaration", () => {
    const stateLifecycle = {
      backup_quiescence: { kind: "not-required" as const },
      snapshot_restore: [],
      rebuild: {
        managed_extensions: {
          support: "managed" as const,
          controller: { command: ["/usr/local/bin/future-state"], timeout_seconds: 10 },
          state_directory: "addons",
          preserved_directories: ["builtin"],
          allowed_symlinks: [],
        },
        preserved_environment: {
          files: [
            {
              path: "routing.env",
              patterns: ["FUTURE_*_ROUTE"],
              render_target: "~/.future/routes.env",
            },
          ],
        },
        scheduled_work: {
          support: "disabled" as const,
          reason: "Test package has no scheduled work.",
        },
        post_restore: { kind: "not-required" as const },
      },
    };

    expect(__test.resolveAgentSnapshotFeatures("future-harness", true, stateLifecycle)).toEqual({
      legacyImagePluginProvenanceRequired: false,
      managedExtensions: stateLifecycle.rebuild.managed_extensions,
      preservedEnvironmentInventory: [
        {
          path: "routing.env",
          patterns: ["FUTURE_*_ROUTE"],
          render_target: "~/.future/routes.env",
        },
      ],
    });
    expect(
      __test.resolveAgentSnapshotFeatures("openclaw", true, {
        ...stateLifecycle,
        rebuild: {
          ...stateLifecycle.rebuild,
          managed_extensions: {
            support: "disabled",
            reason: "Test package has no managed extensions.",
          },
          preserved_environment: undefined,
        },
      }),
    ).toEqual({
      legacyImagePluginProvenanceRequired: false,
      managedExtensions: null,
      preservedEnvironmentInventory: [],
    });
    expect(
      __test.shouldDiscoverFreshManagedImageExtensions({
        targetAgentType: "future-harness",
        agentDefinition: { stateLifecycle } as never,
      }),
    ).toBe(true);
    expect(
      __test.shouldDiscoverFreshManagedImageExtensions({
        targetAgentType: "openclaw",
        agentDefinition: {
          stateLifecycle: {
            ...stateLifecycle,
            rebuild: {
              ...stateLifecycle.rebuild,
              managed_extensions: {
                support: "disabled",
                reason: "Test package has no managed extensions.",
              },
            },
          },
        } as never,
      }),
    ).toBe(false);
  });

  it("rejects retired OpenClaw extension state for a fresh same-ID package receipt", () => {
    expect(
      __test.resolveManagedExtensionBackupMetadata(
        MANAGED_EXTENSIONS,
        {
          name: "alpha",
          agent: "openclaw",
          harnessPackage: OPENCLAW_PACKAGE,
          fromDockerfile: "/tmp/Dockerfile.custom",
          openclawImagePluginInstalls: [LEGACY_OPENCLAW_EXTENSION],
        },
        "/sandbox/.openclaw",
      ),
    ).toEqual({
      reconcileManagedImageExtensions: true,
      error: "registered managed image extension provenance is missing or invalid",
    });
  });

  it("migrates retired OpenClaw extension state only with recorded package migration", () => {
    expect(
      __test.resolveManagedExtensionBackupMetadata(
        MANAGED_EXTENSIONS,
        {
          name: "alpha",
          agent: "openclaw",
          harnessPackage: OPENCLAW_PACKAGE,
          harnessPackageMigration: {
            schemaVersion: 1,
            source: "legacy-current-bundle",
            // A null legacy agent is the canonical persisted identity for the
            // historical default OpenClaw row.
            legacyAgent: null,
            migratedAt: "2026-09-06T12:00:00.000Z",
          },
          fromDockerfile: "/tmp/Dockerfile.custom",
          openclawImagePluginInstalls: [LEGACY_OPENCLAW_EXTENSION],
        },
        "/sandbox/.openclaw",
      ),
    ).toEqual({
      reconcileManagedImageExtensions: true,
      extensions: [
        {
          id: "weather",
          directory: "weather",
          configPaths: ["/sandbox/.openclaw/extensions/weather/index.js"],
        },
      ],
    });
  });

  it("publishes a complete private manifest with no visible temporary file", () => {
    const backupPath = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-manifest-"));
    tempDirs.push(backupPath);

    const expected = manifest(backupPath);
    __test.writeManifest(backupPath, expected);

    const manifestPath = path.join(backupPath, "rebuild-manifest.json");
    expect(JSON.parse(fs.readFileSync(manifestPath, "utf8"))).toEqual(expected);
    expect(fs.statSync(manifestPath).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(backupPath)).toEqual(["rebuild-manifest.json"]);
    expect(__test.readManifest(backupPath)?.harnessPackage).toEqual(OPENCLAW_PACKAGE);
    const publicManifest = readSandboxStateBackupManifest(backupPath);
    expect(publicManifest).toEqual(expected);
    expect(Object.isFrozen(publicManifest)).toBe(true);
  });

  it("keeps legacy omission and migrated package-null authority distinct from repository authority", () => {
    const legacyPath = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-manifest-legacy-"));
    const migratedPath = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-manifest-migrated-"));
    const repositoryPath = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-manifest-repository-"));
    tempDirs.push(legacyPath, migratedPath, repositoryPath);

    const legacy = { ...manifest(legacyPath), version: 1 };
    delete legacy.harnessPackage;
    __test.writeManifest(legacyPath, legacy);
    __test.writeManifest(migratedPath, {
      ...manifest(migratedPath),
      agentType: "pi",
      harnessPackage: null,
    });
    __test.writeManifest(repositoryPath, {
      ...manifest(repositoryPath),
      agentType: "nemocua",
      harnessPackage: null,
    });

    expect(__test.readManifest(legacyPath)).not.toHaveProperty("harnessPackage");
    const migrated = __test.readManifest(migratedPath);
    expect(migrated).toMatchObject({ version: 2, agentType: "pi", harnessPackage: null });
    expect(inspectRebuildManifestHarnessPackage(migrated!)).toEqual({ status: "legacy" });
    expect(__test.readManifest(repositoryPath)).toMatchObject({
      version: 2,
      agentType: "nemocua",
      harnessPackage: null,
    });
  });

  it("rejects a present non-string dir instead of using the legacy writableDir", () => {
    const backupPath = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-manifest-invalid-dir-"));
    tempDirs.push(backupPath);
    const value = {
      ...manifest(backupPath),
      version: 1,
      dir: null,
      writableDir: "/sandbox/legacy-state",
    } as Record<string, unknown>;
    delete value.harnessPackage;
    __test.writeManifest(backupPath, value as unknown as RebuildManifest);

    expect(__test.readManifest(backupPath)).toBeNull();
  });

  it.each([
    ["unknown schema", { version: 3 }],
    ["v1 package field", { version: 1 }],
    ["standard null authority", { harnessPackage: null }],
    ["mismatched package id", { harnessPackage: { ...OPENCLAW_PACKAGE, id: "hermes" } }],
    [
      "malformed package identity",
      { harnessPackage: { ...OPENCLAW_PACKAGE, contentDigest: "bad" } },
    ],
    ["non-boolean backup completion", { backupComplete: "true" }],
    ["malformed backup content digest", { backupContentSha256: "not-a-sha256" }],
    ["owner-only package migration metadata", { harnessPackageMigration: { schemaVersion: 1 } }],
  ] as const)("rejects $0", (_label, override) => {
    const backupPath = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-manifest-invalid-"));
    tempDirs.push(backupPath);
    const value = { ...manifest(backupPath), ...override } as Record<string, unknown>;
    __test.writeManifest(backupPath, value as unknown as RebuildManifest);

    expect(__test.readManifest(backupPath)).toBeNull();
  });

  it("rejects owner-only package migration metadata from a legacy manifest", () => {
    const backupPath = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-manifest-invalid-"));
    tempDirs.push(backupPath);
    const value = {
      ...manifest(backupPath),
      version: 1,
      harnessPackageMigration: { schemaVersion: 1 },
    } as Record<string, unknown>;
    delete value.harnessPackage;
    __test.writeManifest(backupPath, value as unknown as RebuildManifest);

    expect(__test.readManifest(backupPath)).toBeNull();
  });

  it("rejects schema v2 when package authority is omitted", () => {
    const backupPath = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-manifest-invalid-"));
    tempDirs.push(backupPath);
    const value = { ...manifest(backupPath) } as Record<string, unknown>;
    delete value.harnessPackage;
    __test.writeManifest(backupPath, value as unknown as RebuildManifest);

    expect(__test.readManifest(backupPath)).toBeNull();
  });

  it("accepts package-authoritative extension state without recognizing the harness id", () => {
    const backupPath = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-manifest-package-"));
    tempDirs.push(backupPath);
    __test.writeManifest(backupPath, {
      ...manifest(backupPath),
      agentType: FUTURE_PACKAGE.id,
      harnessPackage: FUTURE_PACKAGE,
      managedImageExtensions: [
        { id: "future-weather", directory: "future-weather", configPaths: [] },
      ],
      reconcileManagedImageExtensions: true,
      preservedEnv: [],
    });

    expect(
      __test.readManifest(backupPath, {
        resolvePackageStateLifecycle: () => ({
          backup_quiescence: { kind: "not-required" },
          snapshot_restore: [],
          rebuild: {
            managed_extensions: {
              support: "managed",
              controller: { command: ["/usr/local/bin/future-state"], timeout_seconds: 10 },
              state_directory: "addons",
              preserved_directories: [],
              allowed_symlinks: [],
            },
            preserved_environment: {
              files: [
                {
                  path: ".env",
                  patterns: ["*_HOME_CHANNEL"],
                  render_target: "~/.future/routes.env",
                },
              ],
            },
            scheduled_work: { support: "disabled", reason: "Test package has no scheduled work." },
            post_restore: { kind: "not-required" },
          },
        }),
      }),
    ).toMatchObject({
      agentType: FUTURE_PACKAGE.id,
      harnessPackage: FUTURE_PACKAGE,
      reconcileManagedImageExtensions: true,
      managedImageExtensions: [
        { id: "future-weather", directory: "future-weather", configPaths: [] },
      ],
      preservedEnv: [],
    });
  });

  it("rejects the same extension state from an unreceipted unknown harness", () => {
    const backupPath = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-manifest-legacy-"));
    tempDirs.push(backupPath);
    const value = {
      ...manifest(backupPath),
      version: 1,
      agentType: FUTURE_PACKAGE.id,
      managedImageExtensions: [],
      reconcileManagedImageExtensions: true,
      preservedEnv: [],
    } as Record<string, unknown>;
    delete value.harnessPackage;
    __test.writeManifest(backupPath, value as unknown as RebuildManifest);

    expect(__test.readManifest(backupPath)).toBeNull();
  });

  it("rejects receipt-backed extension state that its package did not declare", () => {
    const backupPath = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-manifest-package-"));
    tempDirs.push(backupPath);
    __test.writeManifest(backupPath, {
      ...manifest(backupPath),
      agentType: FUTURE_PACKAGE.id,
      harnessPackage: FUTURE_PACKAGE,
      managedImageExtensions: [],
      reconcileManagedImageExtensions: true,
      preservedEnv: [],
    });

    expect(
      __test.readManifest(backupPath, {
        resolvePackageStateLifecycle: () => ({
          backup_quiescence: { kind: "not-required" },
          snapshot_restore: [],
          rebuild: {
            managed_extensions: {
              support: "disabled",
              reason: "Test package has no managed extensions.",
            },
            scheduled_work: { support: "disabled", reason: "Test package has no scheduled work." },
            post_restore: { kind: "not-required" },
          },
        }),
      }),
    ).toBeNull();
  });

  it("removes the unpublished temporary manifest when rename fails", () => {
    const remove = vi.fn();
    const rename = vi.fn(() => {
      throw new Error("rename failed");
    });

    expect(() =>
      __test.writeManifest("/backup", manifest("/backup"), {
        write: vi.fn(),
        rename,
        remove,
      }),
    ).toThrow("rename failed");

    const tempPath = path.join("/backup", `.rebuild-manifest.json.tmp.${String(process.pid)}`);
    expect(rename).toHaveBeenCalledWith(tempPath, path.join("/backup", "rebuild-manifest.json"));
    expect(remove).toHaveBeenCalledWith(tempPath, { force: true });
  });

  it("preserves the publish failure when temporary cleanup also fails", () => {
    expect(() =>
      __test.writeManifest("/backup", manifest("/backup"), {
        write: vi.fn(() => {
          throw new Error("write failed");
        }),
        rename: vi.fn(),
        remove: vi.fn(() => {
          throw new Error("cleanup failed");
        }),
      }),
    ).toThrow("write failed");
  });
});

describe("bounded rebuild policy handoff", () => {
  it("keeps the post-publication handoff outside the restorable payload digest", () => {
    const backupPath = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-policy-integrity-"));
    tempDirs.push(backupPath);
    const workspacePath = path.join(backupPath, "workspace");
    fs.mkdirSync(workspacePath);
    fs.writeFileSync(path.join(workspacePath, "note.txt"), "published\n");
    const published = {
      ...manifest(backupPath),
      stateDirs: ["workspace"],
      backedUpDirs: ["workspace"],
      backupContentSha256: hashSnapshotBackupContent(backupPath),
    };
    __test.writeManifest(backupPath, published);

    const withHandoff = writeRebuildPolicyHandoff(published, "version: 1\nnetwork_policies: {}\n");

    expect(validateSnapshotBackupContent(withHandoff)).toEqual({
      ok: true,
      contentSha256: published.backupContentSha256,
    });

    fs.writeFileSync(path.join(workspacePath, "note.txt"), "changed\n");
    expect(validateSnapshotBackupContent(withHandoff)).toEqual({
      ok: false,
      reason: "backup payload changed after publication",
    });
  });

  it("binds exact content, rejects tampering, and retires manifest authority before cleanup", () => {
    const backupPath = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-policy-handoff-"));
    tempDirs.push(backupPath);
    const published = manifest(backupPath);
    __test.writeManifest(backupPath, published);

    const policy = "version: 1\nnetwork_policies:\n  host_preserved: {}\n";
    const withHandoff = writeRebuildPolicyHandoff(published, policy);
    const handoffPath = path.join(backupPath, withHandoff.rebuildPolicyHandoff!.file);
    expect(readRebuildPolicyHandoff(withHandoff)).toBe(policy);
    const descriptor = fs.openSync(handoffPath, fs.constants.O_RDWR | fs.constants.O_NOFOLLOW);
    try {
      expect(fs.fstatSync(descriptor).mode & 0o777).toBe(0o600);
      fs.ftruncateSync(descriptor, 0);
      fs.writeSync(descriptor, `${policy}  raced: {}\n`, 0, "utf8");
      fs.fsyncSync(descriptor);
      expect(readRebuildPolicyHandoff(withHandoff)).toBeNull();
      fs.ftruncateSync(descriptor, 0);
      fs.writeSync(descriptor, policy, 0, "utf8");
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }

    expect(clearRebuildPolicyHandoff(withHandoff)).toBe(true);
    expect(fs.existsSync(handoffPath)).toBe(false);
    expect(
      JSON.parse(fs.readFileSync(path.join(backupPath, "rebuild-manifest.json"), "utf8")),
    ).not.toHaveProperty("rebuildPolicyHandoff");
  });

  it("retains cleanup identity after deletion fails and removes it on retry", () => {
    const backupPath = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-policy-cleanup-"));
    tempDirs.push(backupPath);
    const published = manifest(backupPath);
    __test.writeManifest(backupPath, published);
    const withHandoff = writeRebuildPolicyHandoff(published, "version: 1\nnetwork_policies: {}\n");
    const handoffPath = path.join(backupPath, withHandoff.rebuildPolicyHandoff!.file);

    expect(
      clearRebuildPolicyHandoff(withHandoff, {
        remove: vi.fn(() => {
          throw new Error("injected deletion failure");
        }),
      }),
    ).toBe(false);
    expect(withHandoff.rebuildPolicyHandoff).toMatchObject({ retired: true });
    expect(readRebuildPolicyHandoff(withHandoff)).toBeNull();
    expect(fs.existsSync(handoffPath)).toBe(true);
    expect(
      JSON.parse(fs.readFileSync(path.join(backupPath, "rebuild-manifest.json"), "utf8")),
    ).toMatchObject({ rebuildPolicyHandoff: { retired: true } });

    expect(clearRebuildPolicyHandoff(withHandoff)).toBe(true);
    expect(fs.existsSync(handoffPath)).toBe(false);
    expect(withHandoff).not.toHaveProperty("rebuildPolicyHandoff");
  });

  it.each([
    ["permissive mode", (filePath: string) => fs.chmodSync(filePath, 0o640)],
    ["extra hard link", (filePath: string) => fs.linkSync(filePath, `${filePath}.linked`)],
  ] as const)("rejects a digest-matching handoff with %s", (_unsafeMetadata, makeUnsafe) => {
    const backupPath = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-policy-authority-"));
    tempDirs.push(backupPath);
    const published = manifest(backupPath);
    __test.writeManifest(backupPath, published);
    const policy = "version: 1\nnetwork_policies: {}\n";
    const withHandoff = writeRebuildPolicyHandoff(published, policy);
    const handoffPath = path.join(backupPath, withHandoff.rebuildPolicyHandoff!.file);

    makeUnsafe(handoffPath);

    expect(readRebuildPolicyHandoff(withHandoff)).toBeNull();
    expect(() => writeRebuildPolicyHandoff(withHandoff, policy)).toThrow(
      "Existing rebuild policy handoff does not match its content identity",
    );
  });

  it("rejects a credential-bearing handoff before publishing an artifact or manifest field", () => {
    const backupPath = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-policy-credential-"));
    tempDirs.push(backupPath);
    const published = manifest(backupPath);
    __test.writeManifest(backupPath, published);
    const manifestPath = path.join(backupPath, "rebuild-manifest.json");
    const originalManifest = fs.readFileSync(manifestPath, "utf8");

    expect(() =>
      writeRebuildPolicyHandoff(
        published,
        "version: 1\nprocess:\n  environment:\n    SERVICE_API_KEY: opaque-retained-credential\n",
      ),
    ).toThrow("Cannot persist a credential-bearing rebuild policy handoff");
    expect(published).not.toHaveProperty("rebuildPolicyHandoff");
    expect(fs.readFileSync(manifestPath, "utf8")).toBe(originalManifest);
    expect(fs.readdirSync(backupPath).filter((file) => file.includes("policy-handoff"))).toEqual(
      [],
    );
  });

  it("retains a retired handoff tombstone until the owning recovery marker is removed", () => {
    const backupPath = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-policy-retirement-"));
    tempDirs.push(backupPath);
    const published = manifest(backupPath);
    __test.writeManifest(backupPath, published);
    const withHandoff = writeRebuildPolicyHandoff(published, "version: 1\nnetwork_policies: {}\n");
    const handoffPath = path.join(backupPath, withHandoff.rebuildPolicyHandoff!.file);

    expect(clearRebuildPolicyHandoff(withHandoff, { retainRetirement: true })).toBe(true);
    expect(fs.existsSync(handoffPath)).toBe(false);
    expect(withHandoff.rebuildPolicyHandoff).toMatchObject({ retired: true });
    expect(
      JSON.parse(fs.readFileSync(path.join(backupPath, "rebuild-manifest.json"), "utf8")),
    ).toMatchObject({ rebuildPolicyHandoff: { retired: true } });

    expect(clearRebuildPolicyHandoff(withHandoff)).toBe(true);
    expect(withHandoff).not.toHaveProperty("rebuildPolicyHandoff");
  });
});
