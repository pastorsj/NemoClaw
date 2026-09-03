// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const PROCESS_TOKEN = "a".repeat(32);

describe("Shields timer private-file authority", () => {
  let temporaryHome: string;

  beforeEach(() => {
    temporaryHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-timer-private-authority-"));
    vi.stubEnv("HOME", temporaryHome);
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(temporaryHome, { recursive: true, force: true });
  });

  it("rejects a mutable-private file change after timer authorization", async () => {
    const timer = await import("./timer");
    const stateDir = path.join(temporaryHome, ".nemoclaw", "state");
    fs.mkdirSync(stateDir, { recursive: true });
    const sandboxName = "private-authority";
    const snapshotPath = path.join(stateDir, "snapshot.yaml");
    const restoreAtIso = new Date(Date.now() + 60_000).toISOString();
    const markerPath = path.join(stateDir, `shields-timer-${sandboxName}.json`);
    const marker = {
      pid: process.pid,
      sandboxName,
      snapshotPath,
      restoreAt: restoreAtIso,
      processToken: PROCESS_TOKEN,
      configPath: "/sandbox/.hermes/config.yaml",
      configDir: "/sandbox/.hermes",
      protectedFiles: ["config.yaml", ".config-hash", ".env", "fabric.json"],
      mutablePrivateFiles: ["fabric.json"],
    };
    fs.writeFileSync(markerPath, JSON.stringify(marker));
    const args = timer.parseTimerArgs([
      sandboxName,
      snapshotPath,
      restoreAtIso,
      marker.configPath,
      marker.configDir,
      PROCESS_TOKEN,
    ]);
    expect(args).not.toBeNull();
    args!.authorizedProtectedFiles = marker.protectedFiles;
    args!.authorizedMutablePrivateFiles = marker.mutablePrivateFiles;
    expect(timer.markerMatchesCurrentTimer(args!)).toBe(true);

    fs.writeFileSync(
      markerPath,
      JSON.stringify({ ...marker, mutablePrivateFiles: [".config-hash", "fabric.json"] }),
    );

    expect(timer.markerMatchesCurrentTimer(args!)).toBe(false);
  });
});
