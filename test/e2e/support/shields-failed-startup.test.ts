// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  failedStartupProcessControlCommands,
  resumeSupervisorIfPaused,
} from "../fixtures/shields-failed-startup.ts";
import {
  bindChildlessBoundaryRuntime,
  createPolicySetChildlessBoundaryShim,
} from "../live/shields-shim.ts";

describe("Shields failed-startup process control", () => {
  it("builds host-side PID 1 signals and an in-sandbox child termination signal", () => {
    expect(failedStartupProcessControlCommands("abc123def456", 44)).toEqual({
      pauseSupervisor: ["kill", "--signal", "SIGSTOP", "abc123def456"],
      resumeSupervisor: ["kill", "--signal", "SIGCONT", "abc123def456"],
      terminateStartupChild: ["exec", "--user", "0", "abc123def456", "kill", "-TERM", "44"],
    });
  });

  it("runs the resume callback only when the supervisor was paused", async () => {
    const events: string[] = [];
    const resume = async () => {
      events.push("resume");
    };

    await resumeSupervisorIfPaused(false, resume);
    await resumeSupervisorIfPaused(true, resume);

    expect(events).toEqual(["resume"]);
  });

  it("passes the selected runtime endpoint to every childless-boundary operation", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-shields-boundary-"));
    const callsPath = path.join(directory, "calls.jsonl");
    const fakeExecutable = (name: string) => {
      const executable = path.join(directory, `${name}.cjs`);
      fs.writeFileSync(
        executable,
        `#!${process.execPath}\nrequire("node:fs").appendFileSync(process.env.CALLS_PATH, JSON.stringify({ name: ${JSON.stringify(name)}, args: process.argv.slice(2) }) + "\\n");\n`,
        { mode: 0o700 },
      );
      return executable;
    };

    try {
      const runtime = bindChildlessBoundaryRuntime(
        { command: "docker", args: [] },
        "unix:///private/colima.sock",
      );
      const boundary = createPolicySetChildlessBoundaryShim({
        configGuardPath: "/opt/nemoclaw/config-guard.py",
        containerId: "abc123def456",
        realOpenshellPath: fakeExecutable("openshell"),
        runtimeCommand: fakeExecutable(runtime.command),
        runtimePrefix: runtime.args,
        sandboxName: "e2e-shields",
        startupPid: 44,
        tempRoot: directory,
      });
      const result = spawnSync(
        boundary.executable,
        ["policy", "set", "--wait", "policy.yaml", "e2e-shields"],
        { env: { ...process.env, CALLS_PATH: callsPath } },
      );

      expect(result.status, result.stderr.toString()).toBe(0);
      const calls = fs
        .readFileSync(callsPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { name: string; args: string[] });
      expect(calls[0]).toEqual({
        name: "openshell",
        args: ["policy", "set", "--wait", "policy.yaml", "e2e-shields"],
      });
      expect(calls.slice(1)).toHaveLength(3);
      expect(calls[1]?.name).toBe("docker");
      expect(calls[1]?.args.slice(0, 2)).toEqual(["--host", "unix:///private/colima.sock"]);
      expect(calls[2]?.name).toBe("docker");
      expect(calls[2]?.args.slice(0, 2)).toEqual(["--host", "unix:///private/colima.sock"]);
      expect(calls[3]?.name).toBe("docker");
      expect(calls[3]?.args.slice(0, 2)).toEqual(["--host", "unix:///private/colima.sock"]);
      expect(JSON.parse(fs.readFileSync(boundary.receipt, "utf8"))).toEqual({
        status: "childless",
      });
    } finally {
      fs.rmSync(directory, { force: true, recursive: true });
    }
  });

  it.each([0, 1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects unsafe startup child pid %s",
    (pid) => {
      expect(() => failedStartupProcessControlCommands("abc123def456", pid)).toThrow(
        "startup child pid must be a safe integer greater than 1",
      );
    },
  );

  it.each(["", "-latest", "container id", "container/id"])(
    "rejects unsafe Docker container id %s",
    (containerId) => {
      expect(() => failedStartupProcessControlCommands(containerId, 44)).toThrow(
        "container id must be a safe Docker identifier",
      );
    },
  );
});
