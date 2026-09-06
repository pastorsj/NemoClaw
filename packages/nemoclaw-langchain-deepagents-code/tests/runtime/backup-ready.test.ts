// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const PACKAGE_ROOT = path.resolve(import.meta.dirname, "../..");
const BACKUP_READY = path.join(PACKAGE_ROOT, "runtime/backup-ready.sh");

let fixtureRoot: string;
let fakeBin: string;

beforeEach(() => {
  fixtureRoot = mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-backup-ready-"));
  fakeBin = path.join(fixtureRoot, "bin");
  mkdirSync(fakeBin);
});

afterEach(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
});

function writeProcessFixture(output: string): void {
  const fakePs = path.join(fakeBin, "ps");
  writeFileSync(fakePs, `#!/bin/sh\nprintf '%s\\n' ${JSON.stringify(output)}\n`);
  chmodSync(fakePs, 0o755);
}

function inspectBackupReadiness() {
  return spawnSync(BACKUP_READY, [], {
    encoding: "utf8",
    env: {
      HOME: fixtureRoot,
      PATH: `${fakeBin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
    },
  });
}

describe("DCode state backup readiness", () => {
  it("reports ready when no DCode process is mutating package state", () => {
    writeProcessFixture("41 /usr/bin/sleep infinity");

    const result = inspectBackupReadiness();

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("NEMOCLAW_STATE_BACKUP=ready\n");
  });

  it.each([
    "42 dcode run --prompt hello",
    "43 /usr/bin/python3 -I -m deepagents_code --prompt hello",
    "44 /usr/local/bin/deepagents-code --prompt hello",
  ])("uses reserved status 75 for an active package process: %s", (processLine) => {
    writeProcessFixture(processLine);

    const result = inspectBackupReadiness();

    expect(result.status).toBe(75);
    expect(result.stdout).toBe("NEMOCLAW_STATE_BACKUP=busy\n");
  });
});
