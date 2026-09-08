// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const NONCE = "a".repeat(64);
const SCRIPT = path.join(import.meta.dirname, "../../runtime/device-pairing-settle.sh");
const temporaryDirectories: string[] = [];

function runSettlement(watcherExitCode = 0) {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-pair-settle-"));
  temporaryDirectories.push(temporaryDirectory);
  const invocationLog = path.join(temporaryDirectory, "invocation.json");
  const fakeOpenClaw = path.join(temporaryDirectory, "openclaw");
  const fakeWatcher = path.join(temporaryDirectory, "auto-pair.py");
  const settlementScript = path.join(temporaryDirectory, "device-pairing-settle.sh");

  fs.writeFileSync(fakeOpenClaw, "#!/bin/sh\nexit 99\n", { mode: 0o755 });
  fs.writeFileSync(
    fakeWatcher,
    `import json
import os
import pathlib
import sys

projection = {
    "argv": sys.argv[1:],
    "openclawBin": os.environ.get("OPENCLAW_BIN"),
    "deadlineSeconds": os.environ.get("NEMOCLAW_AUTO_PAIR_DEADLINE_SECS"),
    "runTimeoutSeconds": os.environ.get("NEMOCLAW_AUTO_PAIR_RUN_TIMEOUT_SECS"),
    "inheritedMarkers": sorted(
        name
        for name in (
            "OPENCLAW_GATEWAY_URL",
            "OPENCLAW_GATEWAY_PORT",
            "OPENCLAW_GATEWAY_TOKEN",
            "OPENCLAW_GATEWAY_PASSWORD",
            "NEMOCLAW_OPENCLAW_FORCE_DEVICE_PAIRING",
            "NEMOCLAW_OPENCLAW_RESTORED_CLONE_PAIRING",
            "NEMOCLAW_OPENCLAW_PAIRING_SETTLEMENT",
            "NEMOCLAW_OPENCLAW_BOUNDED_DEVICE_APPROVAL",
        )
        if name in os.environ
    ),
}
pathlib.Path(${JSON.stringify(invocationLog)}).write_text(
    json.dumps(projection), encoding="utf-8"
)
raise SystemExit(${watcherExitCode})
`,
  );
  const source = fs
    .readFileSync(SCRIPT, "utf8")
    .replace("/usr/local/lib/nemoclaw/openclaw-startup/auto-pair.py", fakeWatcher);
  fs.writeFileSync(settlementScript, source, { mode: 0o755 });

  const result = spawnSync("/bin/sh", [settlementScript, NONCE], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${temporaryDirectory}:/usr/bin:/bin`,
      NEMOCLAW_DISABLE_DEVICE_AUTH: "1",
      OPENCLAW_GATEWAY_URL: "ws://untrusted.invalid",
      OPENCLAW_GATEWAY_PORT: "1",
      OPENCLAW_GATEWAY_TOKEN: "untrusted-token",
      OPENCLAW_GATEWAY_PASSWORD: "untrusted-password",
      NEMOCLAW_OPENCLAW_FORCE_DEVICE_PAIRING: "1",
      NEMOCLAW_OPENCLAW_RESTORED_CLONE_PAIRING: "1",
      NEMOCLAW_OPENCLAW_PAIRING_SETTLEMENT: "1",
      NEMOCLAW_OPENCLAW_BOUNDED_DEVICE_APPROVAL: "1",
    },
    timeout: 15_000,
  });
  return {
    result,
    fakeOpenClaw,
    invocation: fs.existsSync(invocationLog)
      ? (JSON.parse(fs.readFileSync(invocationLog, "utf8")) as Record<string, unknown>)
      : undefined,
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("OpenClaw package device-pairing settlement", () => {
  it("delegates the complete bounded transition to the package pairing state machine", () => {
    const { result, fakeOpenClaw, invocation } = runSettlement();

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(`__NEMOCLAW_DEVICE_PAIRING_SETTLED__=${NONCE}\n`);
    expect(invocation).toEqual({
      argv: ["--once"],
      openclawBin: fakeOpenClaw,
      deadlineSeconds: "90",
      runTimeoutSeconds: "10",
      inheritedMarkers: [],
    });
  });

  it("does not emit settlement when the exact pairing watcher fails", () => {
    const { result } = runSettlement(7);

    expect(result.status).toBe(7);
    expect(result.stdout).not.toContain("__NEMOCLAW_DEVICE_PAIRING_SETTLED__=");
  });

  it("rejects an invalid core nonce before starting native pairing", () => {
    const result = spawnSync("/bin/sh", [SCRIPT, "not-a-core-nonce"], {
      encoding: "utf8",
      env: {
        PATH: "/usr/bin:/bin",
        NEMOCLAW_DISABLE_DEVICE_AUTH: "1",
      },
    });

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
  });
});
