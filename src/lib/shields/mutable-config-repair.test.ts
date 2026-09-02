// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createShieldsFlowHarness } from "../../../test/helpers/shields-flow-harness";
import type { AgentConfigTarget } from "../sandbox/agent-config";

const NORMALIZER = "/usr/local/lib/nemoclaw/normalize_mutable_config_perms.py";
const NORMALIZER_WATCHDOG = ["/usr/bin/timeout", "--signal=TERM", "--kill-after=5s", "15s"];
const OPENCLAW_TARGET: AgentConfigTarget = {
  agentName: "openclaw",
  configDir: "/sandbox/.openclaw",
  configPath: "/sandbox/.openclaw/openclaw.json",
  configFile: "openclaw.json",
  format: "json",
  sensitiveFiles: ["/sandbox/.openclaw/.config-hash", "/sandbox/.openclaw/fabric.json"],
  stateLockPlanInImage: true,
};
const requireSource = createRequire(import.meta.url);

type MutableConfigRepairModule = typeof import("./mutable-config-repair");
type PrivilegedExecModule = typeof import("../sandbox/privileged-exec");

let normalizeMutableOpenClawConfig: MutableConfigRepairModule["normalizeMutableOpenClawConfig"];
let privilegedExec: PrivilegedExecModule;

function mockPrivilegedLease() {
  return vi
    .spyOn(privilegedExec, "withPrivilegedSandboxExecutionLease")
    .mockImplementation(<T>(_sandboxName: string, _operation: string, fn: () => T): T => fn());
}

describe("mutable OpenClaw config repair", () => {
  beforeEach(() => {
    delete require.cache[requireSource.resolve("./mutable-config-repair.js")];
    privilegedExec = requireSource("../sandbox/privileged-exec.js");
    ({ normalizeMutableOpenClawConfig } = requireSource("./mutable-config-repair.js"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete require.cache[requireSource.resolve("./mutable-config-repair.js")];
  });

  it("sanitizes identity probes and watchdogs the privileged normalizer", () => {
    const lease = mockPrivilegedLease();
    const capture = vi
      .spyOn(privilegedExec, "capturePrivilegedSandboxCommand")
      .mockReturnValueOnce(Buffer.from("1000\n"))
      .mockReturnValueOnce(Buffer.from("1001\n"))
      .mockReturnValue(Buffer.alloc(0));

    normalizeMutableOpenClawConfig("alpha", OPENCLAW_TARGET);

    expect(capture.mock.calls).toEqual([
      ["alpha", ["/usr/bin/id", "-u", "sandbox"], { sanitizeEnvironment: true, timeout: 15000 }],
      ["alpha", ["/usr/bin/id", "-g", "sandbox"], { sanitizeEnvironment: true, timeout: 15000 }],
      [
        "alpha",
        [
          ...NORMALIZER_WATCHDOG,
          "/usr/bin/python3",
          "-I",
          NORMALIZER,
          "/sandbox/.openclaw",
          "1000",
          "1001",
          "normalize-protected",
          "openclaw.json",
          "660",
          ".config-hash",
          "660",
          "fabric.json",
          "600",
        ],
        { sanitizeEnvironment: true, timeout: 25000 },
      ],
    ]);
    expect(lease.mock.calls.map(([sandboxName, operation]) => [sandboxName, operation])).toEqual([
      ["alpha", "mutable config identity lookup"],
      ["alpha", "mutable config identity lookup"],
      ["alpha", "mutable config permission repair"],
    ]);
  });

  it("rejects an invalid sandbox UID before the GID or normalizer runs", () => {
    mockPrivilegedLease();
    const capture = vi
      .spyOn(privilegedExec, "capturePrivilegedSandboxCommand")
      .mockReturnValue(Buffer.from("0\n"));

    expect(() => normalizeMutableOpenClawConfig("alpha", OPENCLAW_TARGET)).toThrow(
      "sandbox identity lookup returned an invalid UID",
    );
    expect(capture).toHaveBeenCalledOnce();
    expect(capture).toHaveBeenCalledWith("alpha", ["/usr/bin/id", "-u", "sandbox"], {
      sanitizeEnvironment: true,
      timeout: 15000,
    });
  });

  it("rejects an invalid sandbox GID before the normalizer runs", () => {
    mockPrivilegedLease();
    const capture = vi
      .spyOn(privilegedExec, "capturePrivilegedSandboxCommand")
      .mockReturnValueOnce(Buffer.from("1000\n"))
      .mockReturnValueOnce(Buffer.from("not-a-gid\n"));

    expect(() => normalizeMutableOpenClawConfig("alpha", OPENCLAW_TARGET)).toThrow(
      "sandbox identity lookup returned an invalid GID",
    );
    expect(capture).toHaveBeenCalledTimes(2);
    expect(capture.mock.calls.flatMap(([, command]) => command)).not.toContain(NORMALIZER);
  });

  it("propagates a trusted normalizer execution failure", () => {
    mockPrivilegedLease();
    const failure = new Error("provider exec failed");
    const capture = vi
      .spyOn(privilegedExec, "capturePrivilegedSandboxCommand")
      .mockReturnValueOnce(Buffer.from("1000\n"))
      .mockReturnValueOnce(Buffer.from("1001\n"))
      .mockImplementationOnce(() => {
        throw failure;
      });

    expect(() => normalizeMutableOpenClawConfig("alpha", OPENCLAW_TARGET)).toThrow(failure);
    expect(capture).toHaveBeenLastCalledWith(
      "alpha",
      [
        ...NORMALIZER_WATCHDOG,
        "/usr/bin/python3",
        "-I",
        NORMALIZER,
        "/sandbox/.openclaw",
        "1000",
        "1001",
        "normalize-protected",
        "openclaw.json",
        "660",
        ".config-hash",
        "660",
        "fabric.json",
        "600",
      ],
      { sanitizeEnvironment: true, timeout: 25000 },
    );
    expect(capture).toHaveBeenCalledTimes(3);
  });

  it("rejects a nested protected path before privileged execution", () => {
    const lease = mockPrivilegedLease();
    const capture = vi.spyOn(privilegedExec, "capturePrivilegedSandboxCommand");

    expect(() =>
      normalizeMutableOpenClawConfig("alpha", {
        ...OPENCLAW_TARGET,
        sensitiveFiles: [
          "/sandbox/.openclaw/.config-hash",
          "/sandbox/.openclaw/nested/fabric.json",
        ],
      }),
    ).toThrow("must be a direct canonical file");
    expect(lease).not.toHaveBeenCalled();
    expect(capture).not.toHaveBeenCalled();
  });
});

describe("locked Shields policy recovery status", () => {
  let homeDir: string;

  beforeEach(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-locked-policy-recovery-"));
    vi.stubEnv("HOME", homeDir);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  it("verifies Hermes locked recovery status without mutating provider state (#9833)", () => {
    const sandboxName = "hermes";
    const target = {
      agentName: "hermes",
      configDir: "/sandbox/.hermes",
      configFile: "config.yaml",
      configPath: "/sandbox/.hermes/config.yaml",
      format: "yaml",
      sensitiveFiles: ["/sandbox/.hermes/.env"],
      stateLockPlanInImage: true,
    };
    const harness = createShieldsFlowHarness(requireSource, homeDir, {
      agentConfigTarget: target,
      sandboxName,
    });
    const stateDir = path.join(homeDir, ".nemoclaw", "state");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, `shields-${sandboxName}.json`),
      JSON.stringify({
        shieldsDown: true,
        policyRecoveryConfigLocked: true,
        chattrApplied: true,
        fileHashes: { [target.configPath]: "a".repeat(64) },
      }),
    );
    const mutationCount = harness.dockerSpawnCalls.length;
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process exit ${String(code)}`);
    }) as typeof process.exit);

    expect(() =>
      harness.shieldsStatus(sandboxName, false, {
        resolveConfig: () => target,
        verifyLockState: () => ({ ok: true, issues: [] }),
        verifyStateLockPlan: () => [],
      }),
    ).toThrow("process exit 2");

    expect(harness.dockerSpawnCalls).toHaveLength(mutationCount);
    expect(harness.errorSpy.mock.calls.flat().join("\n")).toContain(
      "DOWN (CONFIG LOCKED — POLICY RECOVERY REQUIRED)",
    );
  });
});
