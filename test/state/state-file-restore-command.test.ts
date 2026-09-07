// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.join(import.meta.dirname, "../..");
const sandboxState = (await import(
  pathToFileURL(path.join(REPO_ROOT, "src", "lib", "state", "sandbox.ts")).href
)) as typeof import("../../src/lib/state/sandbox.js");

const spec = { path: "openclaw.json", strategy: "copy" } as const;

describe("buildStateFileRestoreCommand (#5202)", () => {
  it("refreshes the OpenClaw .last-good anchor before swapping the live config", () => {
    const cmd = sandboxState.buildStateFileRestoreCommand("/sandbox/.openclaw", spec, true, [
      "openclaw.json",
      "fabric.json",
    ]);

    // The anchor write targets openclaw.json.last-good and rejects symlinks.
    expect(cmd).toContain('last_good="${dst}.last-good"');
    expect(cmd).toContain("refusing symlinked last-good target");

    // The anchor is staged through a temp and installed via atomic rename, and
    // fails closed (exit 14) so a partial write never reaches .last-good.
    expect(cmd).toContain(".nemoclaw-lastgood.XXXXXX");
    expect(cmd).toContain('mv -f "$anchor_tmp" "$last_good"');
    expect(cmd).toContain("exit 14");

    // Anchor must be installed BEFORE the live file is swapped, so OpenClaw's
    // integrity watcher never observes a config that disagrees with .last-good.
    const anchorIdx = cmd.indexOf('mv -f "$anchor_tmp" "$last_good"');
    const swapIdx = cmd.indexOf('mv -f "$tmp" "$dst"');
    expect(anchorIdx).toBeGreaterThanOrEqual(0);
    expect(swapIdx).toBeGreaterThan(anchorIdx);

    // The complete future .config-hash is staged from the incoming config and
    // each protected companion before either live file changes.
    expect(cmd).toContain('sha256sum -- "$tmp"');
    expect(cmd).toContain('sha256sum -- "$protected_0"');
    const hashStageIdx = cmd.indexOf('hash_tmp="$(mktemp');
    const hashInstallIdx = cmd.indexOf('mv -f "$hash_tmp" "$hash_file"');
    expect(hashStageIdx).toBeGreaterThanOrEqual(0);
    expect(anchorIdx).toBeGreaterThan(hashStageIdx);
    expect(hashInstallIdx).toBeGreaterThan(swapIdx);
    expect(cmd).toContain('chmod 660 "$tmp"');

    // Fabric is validated before either recovery anchor or live config moves.
    const fabricCheckIdx = cmd.indexOf("protected config is not a regular file");
    expect(fabricCheckIdx).toBeGreaterThanOrEqual(0);
    expect(anchorIdx).toBeGreaterThan(fabricCheckIdx);
  });

  it("rejects unsafe supplemental integrity inputs before changing OpenClaw state", () => {
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-state-restore-protected-")),
    );
    try {
      const configPath = path.join(root, "openclaw.json");
      const lastGoodPath = `${configPath}.last-good`;
      const fabricTarget = path.join(root, "fabric-target.json");
      fs.writeFileSync(configPath, '{"state":"live"}\n');
      fs.writeFileSync(lastGoodPath, '{"state":"anchor"}\n');
      fs.writeFileSync(fabricTarget, "{}\n");
      fs.symlinkSync(fabricTarget, path.join(root, "fabric.json"));

      const cmd = sandboxState.buildStateFileRestoreCommand(root, spec, true, [
        "openclaw.json",
        "fabric.json",
      ]);
      const result = spawnSync("bash", ["-c", cmd], {
        input: Buffer.from('{"state":"restored"}\n'),
      });

      expect(result.status).toBe(19);
      expect(result.stderr.toString()).toContain("refusing symlinked protected config");
      expect(fs.readFileSync(configPath, "utf8")).toBe('{"state":"live"}\n');
      expect(fs.readFileSync(lastGoodPath, "utf8")).toBe('{"state":"anchor"}\n');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects non-canonical integrity input paths", () => {
    expect(() =>
      sandboxState.buildStateFileRestoreCommand("/sandbox/.openclaw", spec, true, [
        "openclaw.json",
        "../fabric.json",
      ]),
    ).toThrow("Config hash inputs must be unique canonical relative paths");
  });

  it("does not touch the .last-good anchor for non-OpenClaw state restores", () => {
    const cmd = sandboxState.buildStateFileRestoreCommand("/sandbox/.openclaw", spec, false);
    expect(cmd).not.toContain("last-good");
    expect(cmd).not.toContain("sha256sum");
    expect(cmd).toContain('mv -f "$tmp" "$dst"');
    expect(cmd).toContain('chmod 640 "$tmp"');
  });

  it("isolates SQLite restore from an agent-managed Python environment (#7144)", () => {
    const cmd = sandboxState.buildStateFileRestoreCommand(
      "/sandbox/.hermes",
      { path: "kanban.db", strategy: "sqlite_backup" },
      false,
    );

    expect(cmd).toContain("/usr/bin/python3 -I -S -c");
    expect(cmd).not.toMatch(/(?:^|[; ])python3 -c/u);
  });

  const SANDBOX_PYTHON = "/usr/bin/python3";
  const canRunSqliteRestore = process.platform === "linux" && fs.existsSync(SANDBOX_PYTHON);
  const makeDb = (file: string, table: string) => {
    const result = spawnSync(SANDBOX_PYTHON, [
      "-c",
      `import sqlite3; c = sqlite3.connect(${JSON.stringify(file)}); c.execute("CREATE TABLE ${table}(x)"); c.commit(); c.close()`,
    ]);
    expect(result.status).toBe(0);
  };

  it.skipIf(!canRunSqliteRestore)(
    "restores over a gateway-owned SQLite database the restoring user cannot write (#7312)",
    () => {
      const dir = fs.realpathSync(
        fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-sqlite-restore-")),
      );
      try {
        const dst = path.join(dir, "state.db");
        makeDb(dst, "live");
        // The Hermes gateway creates the live database as the gateway user
        // with no group-write bit; group-read-only reproduces that boundary
        // for the restoring user.
        fs.chmodSync(dst, 0o440);
        fs.writeFileSync(`${dst}-wal`, "stale");
        fs.writeFileSync(`${dst}-shm`, "stale");
        const backupDb = path.join(dir, "backup.db");
        makeDb(backupDb, "restored");

        const cmd = sandboxState.buildStateFileRestoreCommand(
          dir,
          { path: "state.db", strategy: "sqlite_backup" },
          false,
        );
        const result = spawnSync("sh", ["-c", cmd], { input: fs.readFileSync(backupDb) });

        expect(result.stderr.toString()).toBe("");
        expect(result.status).toBe(0);
        const tables = spawnSync(SANDBOX_PYTHON, [
          "-c",
          `import sqlite3; print(sqlite3.connect(${JSON.stringify(dst)}).execute("SELECT name FROM sqlite_master").fetchall())`,
        ]);
        expect(tables.stdout.toString()).toContain("restored");
        expect(fs.existsSync(`${dst}-wal`)).toBe(false);
        expect(fs.existsSync(`${dst}-shm`)).toBe(false);
        expect(fs.statSync(dst).mode & 0o777).toBe(0o660);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(!canRunSqliteRestore)(
    "preserves the live SQLite database and sidecars when backup validation fails (#7312)",
    () => {
      const dir = fs.realpathSync(
        fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-sqlite-restore-invalid-")),
      );
      try {
        const dst = path.join(dir, "state.db");
        makeDb(dst, "live");
        const originalDatabase = fs.readFileSync(dst);
        fs.chmodSync(dst, 0o440);
        fs.writeFileSync(`${dst}-wal`, "live wal");
        fs.writeFileSync(`${dst}-shm`, "live shm");

        const cmd = sandboxState.buildStateFileRestoreCommand(
          dir,
          { path: "state.db", strategy: "sqlite_backup" },
          false,
        );
        const result = spawnSync("sh", ["-c", cmd], {
          input: Buffer.from("not a sqlite database"),
        });

        expect(result.status).not.toBe(0);
        expect(fs.readFileSync(dst)).toEqual(originalDatabase);
        expect(fs.statSync(dst).mode & 0o777).toBe(0o440);
        expect(fs.readFileSync(`${dst}-wal`, "utf8")).toBe("live wal");
        expect(fs.readFileSync(`${dst}-shm`, "utf8")).toBe("live shm");
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it.each([
    ["copy", "root"],
    ["copy", "nested parent"],
    ["sqlite_backup", "root"],
    ["sqlite_backup", "nested parent"],
  ] as const)(
    "refuses a symlinked %s state %s without changing its external target",
    (strategy, linkLocation) => {
      const root = fs.realpathSync(
        fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-state-parent-link-")),
      );
      try {
        const externalParent = path.join(root, "external");
        const stateRoot = path.join(root, "state");
        const sentinel = path.join(externalParent, "sentinel.txt");
        fs.mkdirSync(externalParent);
        fs.writeFileSync(sentinel, "outside remains unchanged\n");
        const createLinkedStateRoot = {
          root: () => fs.symlinkSync(externalParent, stateRoot, "dir"),
          "nested parent": () => {
            fs.mkdirSync(stateRoot);
            fs.symlinkSync(externalParent, path.join(stateRoot, "runtime"), "dir");
          },
        };
        createLinkedStateRoot[linkLocation]();

        const cmd = sandboxState.buildStateFileRestoreCommand(
          stateRoot,
          { path: "runtime/state.db", strategy },
          false,
        );
        const result = spawnSync("sh", ["-c", cmd], {
          input: Buffer.from("untrusted restore bytes"),
        });

        expect(result.status).toBe(10);
        expect(result.stderr.toString()).toContain("unsafe state parent");
        expect(fs.readFileSync(sentinel, "utf8")).toBe("outside remains unchanged\n");
        expect(fs.existsSync(path.join(externalParent, "state.db"))).toBe(false);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.each(["copy", "sqlite_backup"] as const)(
    "refuses a %s restore through a symlinked component inside the absolute state root",
    (strategy) => {
      const root = fs.realpathSync(
        fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-state-root-ancestor-link-")),
      );
      try {
        const declaredRoot = path.join(root, "declared");
        const externalRoot = path.join(root, "external");
        const externalAgent = path.join(externalRoot, "agent");
        const stateRoot = path.join(declaredRoot, "alias", "agent");
        const sentinel = path.join(externalAgent, "sentinel.txt");
        fs.mkdirSync(declaredRoot);
        fs.mkdirSync(externalAgent, { recursive: true });
        fs.writeFileSync(sentinel, "outside remains unchanged\n");
        fs.symlinkSync(externalRoot, path.join(declaredRoot, "alias"), "dir");

        const cmd = sandboxState.buildStateFileRestoreCommand(
          stateRoot,
          { path: "runtime/state.db", strategy },
          false,
        );
        const result = spawnSync("sh", ["-c", cmd], {
          input: Buffer.from("untrusted restore bytes"),
        });

        expect(result.status).toBe(10);
        expect(result.stderr.toString()).toContain("unsafe state parent");
        expect(fs.readFileSync(sentinel, "utf8")).toBe("outside remains unchanged\n");
        expect(fs.existsSync(path.join(externalAgent, "runtime", "state.db"))).toBe(false);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.each([
    ["copy", "directory"],
    ["copy", "fifo"],
    ["sqlite_backup", "directory"],
    ["sqlite_backup", "fifo"],
  ] as const)(
    "refuses a %s restore over a non-regular %s target without leaving staged files",
    (strategy, targetKind) => {
      const root = fs.realpathSync(
        fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-state-target-type-")),
      );
      try {
        const stateRoot = path.join(root, "state");
        const runtimeRoot = path.join(stateRoot, "runtime");
        const target = path.join(runtimeRoot, "state.db");
        fs.mkdirSync(runtimeRoot, { recursive: true });
        const createTarget = {
          directory: () => {
            fs.mkdirSync(target);
            fs.writeFileSync(path.join(target, "sentinel.txt"), "target remains unchanged\n");
          },
          fifo: () => {
            const fifo = spawnSync("mkfifo", [target]);
            expect(fifo.status, fifo.stderr.toString()).toBe(0);
          },
        };
        createTarget[targetKind]();

        const cmd = sandboxState.buildStateFileRestoreCommand(
          stateRoot,
          { path: "runtime/state.db", strategy },
          false,
        );
        const result = spawnSync("sh", ["-c", cmd], {
          input: Buffer.from("untrusted restore bytes"),
        });

        expect(result.status).toBe(11);
        expect(result.stderr.toString()).toContain("unsafe");
        expect(fs.lstatSync(target)[targetKind === "directory" ? "isDirectory" : "isFIFO"]()).toBe(
          true,
        );
        const assertTargetUnchanged = {
          directory: () =>
            expect(fs.readFileSync(path.join(target, "sentinel.txt"), "utf8")).toBe(
              "target remains unchanged\n",
            ),
          fifo: () => expect(fs.lstatSync(target).isFIFO()).toBe(true),
        };
        assertTargetUnchanged[targetKind]();
        expect(fs.readdirSync(runtimeRoot).sort()).toEqual(["state.db"]);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("preflights SQLite sidecars before replacing the live database", () => {
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-sqlite-sidecar-type-")),
    );
    try {
      const stateRoot = path.join(root, "state");
      const runtimeRoot = path.join(stateRoot, "runtime");
      const target = path.join(runtimeRoot, "state.db");
      const wal = `${target}-wal`;
      fs.mkdirSync(runtimeRoot, { recursive: true });
      fs.writeFileSync(target, "live database remains unchanged\n");
      fs.mkdirSync(wal);
      fs.writeFileSync(path.join(wal, "sentinel.txt"), "sidecar remains unchanged\n");

      const cmd = sandboxState.buildStateFileRestoreCommand(
        stateRoot,
        { path: "runtime/state.db", strategy: "sqlite_backup" },
        false,
      );
      const result = spawnSync("sh", ["-c", cmd], {
        input: Buffer.from("untrusted restore bytes"),
      });

      expect(result.status).toBe(12);
      expect(result.stderr.toString()).toContain("unsafe sqlite WAL target");
      expect(fs.readFileSync(target, "utf8")).toBe("live database remains unchanged\n");
      expect(fs.readFileSync(path.join(wal, "sentinel.txt"), "utf8")).toBe(
        "sidecar remains unchanged\n",
      );
      expect(fs.readdirSync(runtimeRoot).sort()).toEqual(["state.db", "state.db-wal"]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.skipIf(!canRunSqliteRestore)(
    "refuses a symlinked SQLite target without replacing its destination (#7312)",
    () => {
      const dir = fs.realpathSync(
        fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-sqlite-target-link-")),
      );
      try {
        const realDatabase = path.join(dir, "real.db");
        const linkedDatabase = path.join(dir, "state.db");
        makeDb(realDatabase, "live");
        const originalDatabase = fs.readFileSync(realDatabase);
        fs.symlinkSync(realDatabase, linkedDatabase);

        const cmd = sandboxState.buildStateFileRestoreCommand(
          dir,
          { path: "state.db", strategy: "sqlite_backup" },
          false,
        );
        const result = spawnSync("sh", ["-c", cmd], {
          input: Buffer.from("not a sqlite database"),
        });

        expect(result.status).toBe(11);
        expect(fs.lstatSync(linkedDatabase).isSymbolicLink()).toBe(true);
        expect(fs.readFileSync(realDatabase)).toEqual(originalDatabase);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
