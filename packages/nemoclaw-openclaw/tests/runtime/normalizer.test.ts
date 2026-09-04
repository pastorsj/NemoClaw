// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** OpenClaw mutable-config permission behavior at sandbox startup. */

import { type SpawnSyncOptionsWithStringEncoding, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { readOpenClawStartupSource } from "../helpers/startup";

const MUTABLE_CONFIG_NORMALIZER = path.join(
  import.meta.dirname,
  "..",
  "..",
  "runtime",
  "config-permissions.py",
);

function extractShellFunctionFromSource(src: string, name: string): string {
  const match = src.match(new RegExp(`${name}\\(\\) \\{([\\s\\S]*?)^\\}`, "m"));
  if (!match) {
    throw new Error(`Expected ${name} in packages/nemoclaw-openclaw/start.sh`);
  }
  return `${name}() {${match[1]}\n}`;
}

function replaceRequired(source: string, target: string, replacement: string): string {
  const parts = source.split(target);
  expect(parts, `Expected exactly one replacement target: ${target}`).toHaveLength(2);
  return `${parts[0]}${replacement}${parts[1]}`;
}

function normalizeMutableConfigPermsFor(configDir: string): string {
  const startScript = readOpenClawStartupSource();
  const normalizeFunction = replaceRequired(
    extractShellFunctionFromSource(startScript, "normalize_mutable_config_perms"),
    'local config_dir="/sandbox/.openclaw"',
    `local config_dir=${JSON.stringify(configDir)}`,
  );
  const resolveNormalizerFunction = extractShellFunctionFromSource(
    startScript,
    "resolve_mutable_config_normalizer",
  );
  const reclaimFunction = extractShellFunctionFromSource(
    startScript,
    "reclaim_collapsed_mutable_config",
  );
  const classifyFunction = extractShellFunctionFromSource(
    startScript,
    "classify_openclaw_config_seal",
  );
  return [resolveNormalizerFunction, classifyFunction, reclaimFunction, normalizeFunction].join(
    "\n",
  );
}

function modeBits(filePath: string): number {
  return fs.statSync(filePath).mode;
}

function runMutableConfigNormalizer(configDir: string, ownedPaths: string[]) {
  const testRoot = path.dirname(configDir);
  const normalizerPath = path.join(testRoot, "normalize_mutable_config_perms.py");
  fs.copyFileSync(MUTABLE_CONFIG_NORMALIZER, normalizerPath);
  fs.chmodSync(normalizerPath, 0o755);
  const spawnOptions: SpawnSyncOptionsWithStringEncoding = {
    encoding: "utf-8",
    env: {
      ...process.env,
      BASH_ENV: "",
      HOME: testRoot,
      NEMOCLAW_MUTABLE_CONFIG_NORMALIZER: normalizerPath,
    },
    timeout: 5000,
  };
  switch (process.getuid?.()) {
    case 0: {
      const unprivilegedId = 65534;
      for (const ownedPath of [...ownedPaths, normalizerPath]) {
        fs.chownSync(ownedPath, unprivilegedId, unprivilegedId);
      }
      spawnOptions.uid = unprivilegedId;
      spawnOptions.gid = unprivilegedId;
      break;
    }
  }
  return spawnSync(
    "bash",
    [
      "-c",
      [
        "set -euo pipefail",
        normalizeMutableConfigPermsFor(configDir),
        "normalize_mutable_config_perms",
      ].join("\n"),
    ],
    spawnOptions,
  );
}

function mkdtempOnPosixFs(prefix: string): string {
  const roots = process.platform === "linux" ? ["/tmp", os.tmpdir()] : [os.tmpdir()];
  let lastError: unknown = null;
  for (const root of roots) {
    try {
      return fs.mkdtempSync(path.join(root, prefix));
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

describe("OpenClaw mutable config permissions", () => {
  it("restores group-write and setgid on mutable config trees during non-root startup", () => {
    const tmpDir = mkdtempOnPosixFs("nemoclaw-2681-perms-");
    const configDir = path.join(tmpDir, ".openclaw");
    const nestedDir = path.join(configDir, "agents", "main");
    const configFile = path.join(configDir, "openclaw.json");

    try {
      fs.mkdirSync(nestedDir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(configFile, "{}\n", { mode: 0o600 });
      fs.chmodSync(configDir, 0o700);
      fs.chmodSync(nestedDir, 0o700);
      fs.chmodSync(configFile, 0o600);

      const result = runMutableConfigNormalizer(configDir, [
        tmpDir,
        configDir,
        path.join(configDir, "agents"),
        nestedDir,
        configFile,
      ]);

      expect(result.status, result.stderr).toBe(0);
      expect(modeBits(configDir) & 0o7777).toBe(0o2770);
      expect(modeBits(configFile) & 0o7777).toBe(0o660);
      expect(modeBits(configDir) & 0o070).toBe(0o070);
      expect(modeBits(configDir) & 0o020).toBe(0o020);
      expect(modeBits(configFile) & 0o060).toBe(0o060);
      expect(modeBits(configFile) & 0o020).toBe(0o020);
      expect(modeBits(configDir) & 0o2000).toBe(0o2000);
      expect(modeBits(nestedDir) & 0o070).toBe(0o070);
      expect(modeBits(nestedDir) & 0o2000).toBe(0o2000);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("re-normalizes a tree that `openclaw doctor --fix` tightened to 700/600 (#4538)", () => {
    // OpenClaw's `doctor --fix` enforces a single-user 700/600 state layout,
    // which silently breaks NemoClaw's group-writable mutable contract so the
    // gateway UID can no longer persist config edits. A (re)start must restore
    // the setgid + group-writable contract.
    const tmpDir = mkdtempOnPosixFs("nemoclaw-4538-doctor-fix-");
    const configDir = path.join(tmpDir, ".openclaw");
    const nestedDir = path.join(configDir, "agents", "main");
    const configFile = path.join(configDir, "openclaw.json");
    const hashFile = path.join(configDir, ".config-hash");

    try {
      fs.mkdirSync(nestedDir, { recursive: true });
      fs.writeFileSync(configFile, "{}\n");
      fs.writeFileSync(hashFile, "deadbeef\n");
      // Simulate the post-`doctor --fix` single-user 700/600 layout.
      fs.chmodSync(configFile, 0o600);
      fs.chmodSync(hashFile, 0o600);
      fs.chmodSync(nestedDir, 0o700);
      fs.chmodSync(configDir, 0o700);

      // Sanity-check the starting (tightened) state.
      expect(modeBits(configDir) & 0o7777).toBe(0o700);
      expect(modeBits(configFile) & 0o7777).toBe(0o600);

      const result = runMutableConfigNormalizer(configDir, [
        tmpDir,
        configDir,
        path.join(configDir, "agents"),
        nestedDir,
        configFile,
        hashFile,
      ]);

      expect(result.status, result.stderr).toBe(0);
      // Mutable contract restored: setgid + group rwx dir, group rw files.
      expect(modeBits(configDir) & 0o7777).toBe(0o2770);
      expect(modeBits(configFile) & 0o7777).toBe(0o660);
      expect(modeBits(hashFile) & 0o7777).toBe(0o660);
      expect(modeBits(configDir) & 0o2000).toBe(0o2000);
      expect(modeBits(nestedDir) & 0o2000).toBe(0o2000);
      expect(modeBits(nestedDir) & 0o070).toBe(0o070);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("rejects a hardlinked fixed config before changing either alias mode", () => {
    const tmpDir = mkdtempOnPosixFs("nemoclaw-6047-hardlink-");
    const configDir = path.join(tmpDir, ".openclaw");
    const configFile = path.join(configDir, "openclaw.json");
    const earlierTreeAlias = path.join(configDir, ".a");
    const externalAlias = path.join(tmpDir, "external-config");

    try {
      fs.mkdirSync(configDir, { mode: 0o700 });
      fs.writeFileSync(externalAlias, "{}\n", { mode: 0o600 });
      fs.chmodSync(externalAlias, 0o600);
      fs.linkSync(externalAlias, earlierTreeAlias);
      fs.linkSync(externalAlias, configFile);

      const result = runMutableConfigNormalizer(configDir, [tmpDir, configDir, externalAlias]);

      expect(result.status).not.toBe(0);
      expect(fs.statSync(configFile).ino).toBe(fs.statSync(externalAlias).ino);
      expect(fs.statSync(earlierTreeAlias).ino).toBe(fs.statSync(externalAlias).ino);
      expect(modeBits(configFile) & 0o7777).toBe(0o600);
      expect(modeBits(earlierTreeAlias) & 0o7777).toBe(0o600);
      expect(modeBits(externalAlias) & 0o7777).toBe(0o600);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
