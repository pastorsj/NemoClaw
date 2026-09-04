// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildStateFileRestoreCommand } from "./state-file-restore";

const STATE_FILE = { path: "openclaw.json", strategy: "copy" } as const;
const fixtures: string[] = [];

function runRestore(
  refreshOpenClawConfigHash: boolean,
  occupy: (stateDir: string) => void = () => undefined,
): { configPath: string; stateDir: string; status: number | null } {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-state-file-mode-"));
  fixtures.push(fixture);
  const stateDir = path.join(fixture, ".openclaw");
  fs.mkdirSync(stateDir);
  occupy(stateDir);
  const command = buildStateFileRestoreCommand(stateDir, STATE_FILE, refreshOpenClawConfigHash);
  const result = spawnSync("bash", ["-c", command], {
    input: Buffer.from('{"gateway":{"mode":"local"}}\n'),
  });
  return { configPath: path.join(stateDir, STATE_FILE.path), stateDir, status: result.status };
}

function mode(filePath: string): number {
  return fs.statSync(filePath).mode & 0o777;
}

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    fs.rmSync(fixture, { force: true, recursive: true });
  }
});

describe("state-file restore modes", () => {
  it("restores an OpenClaw config with the mutable managed-guard mode", () => {
    const { configPath, stateDir, status } = runRestore(true);

    expect(status).toBe(0);
    expect(mode(configPath)).toBe(0o660);
    expect(mode(`${configPath}.last-good`)).toBe(0o660);
    expect(mode(path.join(stateDir, ".config-hash"))).toBe(0o660);

    // A sandbox that cannot publish the config hash must not report a restore.
    const blocked = runRestore(true, (dir) => fs.mkdirSync(path.join(dir, ".config-hash")));
    expect(blocked.status).not.toBe(0);
  });

  it("keeps the restricted mode for ordinary copied state files", () => {
    const { configPath, status } = runRestore(false);

    expect(status).toBe(0);
    expect(mode(configPath)).toBe(0o640);
  });

  it("writes an exact hash record for every protected configuration file", () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-state-file-hash-"));
    fixtures.push(fixture);
    const stateDir = path.join(fixture, ".agent");
    const configPath = path.join(stateDir, "config.json");
    const fabricPath = path.join(stateDir, "fabric.json");
    fs.mkdirSync(stateDir);
    fs.writeFileSync(configPath, '{"state":"current"}\n');
    fs.writeFileSync(fabricPath, '{"adapter":"selected"}\n');

    const command = buildStateFileRestoreCommand(
      stateDir,
      { path: "config.json", strategy: "copy" },
      true,
      ["config.json", "fabric.json"],
    );
    const result = spawnSync("bash", ["-c", command], {
      input: Buffer.from('{"state":"restored"}\n'),
    });

    expect(result.status).toBe(0);
    const configDigest = createHash("sha256").update(fs.readFileSync(configPath)).digest("hex");
    const fabricDigest = createHash("sha256").update(fs.readFileSync(fabricPath)).digest("hex");
    expect(fs.readFileSync(path.join(stateDir, ".config-hash"), "utf8")).toBe(
      `${configDigest}  config.json\n${fabricDigest}  fabric.json\n`,
    );
  });

  it("refuses an unsafe hash target before changing config or recovery state", () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-state-file-hash-refusal-"));
    fixtures.push(fixture);
    const stateDir = path.join(fixture, ".agent");
    const configPath = path.join(stateDir, "config.json");
    const lastGoodPath = `${configPath}.last-good`;
    const fabricPath = path.join(stateDir, "fabric.json");
    const redirectedHashPath = path.join(fixture, "outside-hash");
    fs.mkdirSync(stateDir);
    fs.writeFileSync(configPath, '{"state":"current"}\n');
    fs.writeFileSync(lastGoodPath, '{"state":"last-good"}\n');
    fs.writeFileSync(fabricPath, '{"adapter":"selected"}\n');
    fs.writeFileSync(redirectedHashPath, "outside remains unchanged\n");
    fs.symlinkSync(redirectedHashPath, path.join(stateDir, ".config-hash"));

    const command = buildStateFileRestoreCommand(
      stateDir,
      { path: "config.json", strategy: "copy" },
      true,
      ["config.json", "fabric.json"],
    );
    const result = spawnSync("bash", ["-c", command], {
      input: Buffer.from('{"state":"restored"}\n'),
    });

    expect(result.status).not.toBe(0);
    expect(fs.readFileSync(configPath, "utf8")).toBe('{"state":"current"}\n');
    expect(fs.readFileSync(lastGoodPath, "utf8")).toBe('{"state":"last-good"}\n');
    expect(fs.readFileSync(redirectedHashPath, "utf8")).toBe("outside remains unchanged\n");
  });
});
