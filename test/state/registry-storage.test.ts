// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import {
  failFirstOwnerTempWrite,
  recordLockDirectoryMutations,
  removeRegistryFile,
  removeRegistryTempFiles,
} from "../support/registry-storage";

// Keep this persistence-boundary suite isolated from real user state.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-registry-storage-test-"));
process.env.HOME = tmpDir;

const require = createRequire(import.meta.url);
const registry = require("../../src/lib/state/registry");

const regFile = path.join(tmpDir, ".nemoclaw", "sandboxes.json");

beforeEach(() => {
  removeRegistryFile(regFile);
});

describe("atomic writes", () => {
  const regDir = path.dirname(regFile);

  beforeEach(() => {
    removeRegistryFile(regFile);
    removeRegistryTempFiles(regDir);
  });

  it("save() writes via temp file + rename (no partial writes on disk)", () => {
    registry.registerSandbox({ name: "atomic-test" });
    // File must exist and be valid JSON after save
    const raw = fs.readFileSync(regFile, "utf-8");
    const data = JSON.parse(raw);
    expect(data.sandboxes["atomic-test"].name).toBe("atomic-test");
    // No leftover .tmp files
    const tmpFiles = fs.readdirSync(regDir).filter((f) => f.startsWith("sandboxes.json.tmp."));
    expect(tmpFiles).toHaveLength(0);
  });

  it("save() cleans up temp file when rename fails", () => {
    fs.mkdirSync(regDir, { recursive: true });
    fs.writeFileSync(regFile, '{"sandboxes":{},"defaultSandbox":null}', { mode: 0o600 });

    // Stub renameSync so writeFileSync succeeds (temp file is created)
    // but the rename step throws — exercising the cleanup branch.
    const original = fs.renameSync;
    fs.renameSync = () => {
      throw Object.assign(new Error("EACCES"), { code: "EACCES" });
    };
    try {
      expect(() => registry.save({ sandboxes: {}, defaultSandbox: null })).toThrow(
        /Cannot write config file|EACCES/,
      );
    } finally {
      fs.renameSync = original;
    }
    // The save() catch block should have removed the temp file
    const tmpFiles = fs.readdirSync(regDir).filter((f) => f.startsWith("sandboxes.json.tmp."));
    expect(tmpFiles).toHaveLength(0);
  });
});

describe("advisory file locking", () => {
  const lockDir = regFile + ".lock";
  const ownerFile = path.join(lockDir, "owner");

  beforeEach(() => {
    removeRegistryFile(regFile);
    fs.rmSync(lockDir, { recursive: true, force: true });
  });

  it("acquireLock creates lock directory with owner file and releaseLock removes both", () => {
    registry.acquireLock();
    expect(fs.existsSync(lockDir)).toBe(true);
    expect(fs.existsSync(ownerFile)).toBe(true);
    expect(fs.readFileSync(ownerFile, "utf-8").trim()).toBe(String(process.pid));
    registry.releaseLock();
    expect(fs.existsSync(lockDir)).toBe(false);
  });

  it("withLock releases lock even when callback throws", () => {
    expect(() => {
      registry.withLock(() => {
        expect(fs.existsSync(lockDir)).toBe(true);
        throw new Error("intentional");
      });
    }).toThrow("intentional");
    expect(fs.existsSync(lockDir)).toBe(false);
  });

  it("acquireLock cleans up lock dir when owner file write fails", () => {
    const restoreWrite = failFirstOwnerTempWrite(
      Object.assign(new Error("ENOSPC"), { code: "ENOSPC" }),
    );
    try {
      // First attempt should throw, but no stale lock dir left behind
      expect(() => registry.acquireLock()).toThrow("ENOSPC");
      expect(fs.existsSync(lockDir)).toBe(false);
    } finally {
      restoreWrite();
    }
  });

  it("acquireLock does not treat an owner file EEXIST as lock contention (#7694)", () => {
    const origWrite = fs.writeFileSync;
    fs.writeFileSync = () => {
      throw Object.assign(new Error("owner write EEXIST"), { code: "EEXIST" });
    };
    try {
      expect(() => registry.acquireLock()).toThrow("owner write EEXIST");
      expect(fs.existsSync(lockDir)).toBe(false);
    } finally {
      fs.writeFileSync = origWrite;
    }
  });

  it("acquireLock removes stale lock owned by dead process", () => {
    // Create a lock with a PID that doesn't exist (99999999)
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(ownerFile, "99999999", { mode: 0o600 });

    // Should succeed by detecting the dead owner and removing the stale lock
    registry.acquireLock();
    expect(fs.existsSync(lockDir)).toBe(true);
    expect(fs.readFileSync(ownerFile, "utf-8").trim()).toBe(String(process.pid));
    registry.releaseLock();
  });

  it("mutating operations acquire and release the lock", () => {
    const lockMutations = recordLockDirectoryMutations(lockDir);
    try {
      registry.registerSandbox({ name: "lock-test" });
    } finally {
      lockMutations.restore();
    }
    expect(lockMutations.mkdirCalls.length).toBeGreaterThanOrEqual(1);
    expect(lockMutations.rmCalls.length).toBeGreaterThanOrEqual(1);
    expect(registry.getSandbox("lock-test").name).toBe("lock-test");
  });

  it("concurrent writers do not corrupt the registry", () => {
    const { spawnSync } = require("child_process");
    const registryPath = path.resolve(
      path.join(import.meta.dirname, "..", "..", "src", "lib", "state", "registry.ts"),
    );
    const homeDir = path.dirname(path.dirname(regFile));
    // Script that spawns 4 workers in parallel, each writing 5 sandboxes
    const orchestrator = `
      const { spawn } = require("child_process");
      const workerScript = \`
        process.env.HOME = ${JSON.stringify(homeDir)};
        const reg = require(${JSON.stringify(registryPath)});
        const id = process.argv[1];
        for (let i = 0; i < 5; i++) {
          reg.registerSandbox({ name: id + "-" + i, model: "m" });
        }
      \`;
      const workers = [];
      for (let w = 0; w < 4; w++) {
        workers.push(spawn(process.execPath, ["-e", workerScript, "w" + w]));
      }
      let exitCount = 0;
      let allOk = true;
      for (const child of workers) {
        child.on("exit", (code) => {
          if (code !== 0) allOk = false;
          exitCount++;
          if (exitCount === workers.length) {
            process.exit(allOk ? 0 : 1);
          }
        });
      }
    `;
    const result = spawnSync(process.execPath, ["-e", orchestrator], {
      encoding: "utf-8",
      timeout: 30_000,
    });
    expect(result.status, result.stderr).toBe(0);
    // All 20 sandboxes (4 workers × 5 each) must be present
    const { sandboxes } = registry.listSandboxes();
    expect(sandboxes.length).toBe(20);
  });

  it("clearAll removes all sandboxes and resets default", () => {
    registry.registerSandbox({ name: "alpha" });
    registry.registerSandbox({ name: "beta" });
    registry.setDefault("beta");

    registry.clearAll();

    const { sandboxes, defaultSandbox } = registry.listSandboxes();
    expect(sandboxes).toHaveLength(0);
    expect(defaultSandbox).toBe(null);
  });

  it("clearAll persists empty state to disk", () => {
    registry.registerSandbox({ name: "persist-me" });

    registry.clearAll();

    const data = JSON.parse(fs.readFileSync(regFile, "utf-8"));
    expect(data.sandboxes).toEqual({});
    expect(data.defaultSandbox).toBe(null);
  });

  it("clearAll is safe to call on empty registry", () => {
    registry.clearAll();

    const { sandboxes, defaultSandbox } = registry.listSandboxes();
    expect(sandboxes).toHaveLength(0);
    expect(defaultSandbox).toBe(null);
  });

  describe("malformed sandboxes.json", () => {
    const malformed = '{"sandboxes":{"keep-me":{"name":"keep-me"}},"defaultSandbox":"keep-me",}';

    function writeMalformedRegistry() {
      fs.mkdirSync(path.dirname(regFile), { recursive: true, mode: 0o700 });
      fs.writeFileSync(regFile, malformed, { mode: 0o600 });
    }

    it("reading reports the damage instead of an empty registry", () => {
      writeMalformedRegistry();

      expect(() => registry.listSandboxes()).toThrow(/not valid JSON/);
    });

    it("registerSandbox refuses to replace it and keeps the original bytes", () => {
      writeMalformedRegistry();

      expect(() => registry.registerSandbox({ name: "new-sandbox" })).toThrow(/not valid JSON/);

      expect(fs.readFileSync(regFile, "utf-8")).toBe(malformed);
      expect(fs.existsSync(`${regFile}.lock`)).toBe(false);
      expect(
        fs.readdirSync(path.dirname(regFile)).filter((name) => name.includes(".tmp.")),
      ).toEqual([]);
    });

    it("keeps failing for every reader process until the file is repaired", () => {
      const { spawnSync } = require("child_process");
      writeMalformedRegistry();

      const registryPath = path.resolve(
        path.join(import.meta.dirname, "..", "..", "src", "lib", "state", "registry.ts"),
      );
      const homeDir = path.dirname(path.dirname(regFile));
      const orchestrator = `
        const { spawn } = require("child_process");
        const workerScript = \`
          process.env.HOME = ${JSON.stringify(homeDir)};
          const reg = require(${JSON.stringify(registryPath)});
          try {
            reg.listSandboxes();
          } catch (error) {
            process.exit(error && error.code === "ECONFIGCORRUPT" ? 0 : 2);
          }
          process.exit(3);
        \`;
        const workers = [];
        for (let w = 0; w < 4; w++) {
          workers.push(spawn(process.execPath, ["-e", workerScript, "w" + w]));
        }
        let exitCount = 0;
        let allOk = true;
        for (const child of workers) {
          child.on("exit", (code) => {
            if (code !== 0) allOk = false;
            exitCount++;
            if (exitCount === workers.length) {
              process.exit(allOk ? 0 : 1);
            }
          });
        }
      `;
      const result = spawnSync(process.execPath, ["-e", orchestrator], {
        encoding: "utf-8",
        timeout: 30_000,
      });

      expect(result.status, result.stderr).toBe(0);
      expect(fs.readFileSync(regFile, "utf-8")).toBe(malformed);
    });

    it("recovers once the file holds valid JSON again", () => {
      writeMalformedRegistry();
      expect(() => registry.listSandboxes()).toThrow(/not valid JSON/);

      fs.writeFileSync(regFile, '{"sandboxes":{"keep-me":{"name":"keep-me"}}}', { mode: 0o600 });
      registry.registerSandbox({ name: "new-sandbox" });

      const names = registry.listSandboxes().sandboxes.map((entry: { name: string }) => entry.name);
      expect(names.sort()).toEqual(["keep-me", "new-sandbox"]);
    });
  });
});
