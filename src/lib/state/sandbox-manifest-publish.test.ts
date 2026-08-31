// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { __test, readSandboxStateBackupManifest, type RebuildManifest } from "./sandbox.js";

const tempDirs: string[] = [];

const OPENCLAW_PACKAGE = {
  kind: "agent-runtime" as const,
  id: "openclaw",
  packageVersion: "1.2.3",
  contentDigest: "a".repeat(64),
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
    policyPresets: [],
    customPolicies: [],
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("rebuild manifest publication", () => {
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

  it("keeps legacy omission distinct from explicit candidate authority", () => {
    const legacyPath = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-manifest-legacy-"));
    const candidatePath = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-manifest-candidate-"));
    tempDirs.push(legacyPath, candidatePath);

    const legacy = { ...manifest(legacyPath), version: 1 };
    delete legacy.harnessPackage;
    __test.writeManifest(legacyPath, legacy);
    __test.writeManifest(candidatePath, {
      ...manifest(candidatePath),
      agentType: "pi",
      harnessPackage: null,
    });

    expect(__test.readManifest(legacyPath)).not.toHaveProperty("harnessPackage");
    expect(__test.readManifest(candidatePath)).toMatchObject({
      version: 2,
      agentType: "pi",
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
