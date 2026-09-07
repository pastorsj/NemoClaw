// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createCanonicalCliPairingFixture } from "../helpers/pair-settlement";

const NONCE = "a".repeat(64);
const SCRIPT = path.join(import.meta.dirname, "../../runtime/session-qualify.py");
const temporaryDirectories: string[] = [];

function runQualification(modify?: (document: Record<string, unknown>) => void) {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-session-qualify-"));
  temporaryDirectories.push(temporaryDirectory);
  const stateDirectory = path.join(temporaryDirectory, "state");
  const pairedDevice = createCanonicalCliPairingFixture(stateDirectory);
  const document: Record<string, unknown> = { paired: [pairedDevice], pending: [] };
  modify?.(document);
  const fakeOpenClaw = path.join(temporaryDirectory, "openclaw");
  fs.writeFileSync(
    fakeOpenClaw,
    `#!/bin/sh\nprintf '%s\\n' ${JSON.stringify(JSON.stringify(document))}\n`,
    { mode: 0o755 },
  );
  return spawnSync("python3", [SCRIPT, NONCE], {
    encoding: "utf8",
    env: {
      ...process.env,
      OPENCLAW_BIN: fakeOpenClaw,
      OPENCLAW_STATE_DIR: stateDirectory,
    },
  });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("OpenClaw package session qualification", () => {
  it("returns one stable credential-free digest for the canonical CLI session", () => {
    const result = runQualification();

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toMatch(
      new RegExp(`^__NEMOCLAW_SESSION_QUALIFIED__=${NONCE}:[a-f0-9]{64}$`, "u"),
    );
    expect(result.stdout).not.toContain("operator.read");
    expect(result.stdout).not.toContain("publicKey");
  });

  it("rejects a pending request for the canonical CLI identity", () => {
    const result = runQualification((document) => {
      const paired = document.paired as Array<Record<string, unknown>>;
      document.pending = [{ requestId: "still-pending", deviceId: paired[0]?.deviceId }];
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
  });

  it("rejects an under-scoped paired credential", () => {
    const result = runQualification((document) => {
      const paired = document.paired as Array<Record<string, unknown>>;
      paired[0] = { ...paired[0], approvedScopes: ["operator.pairing"] };
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
  });
});
