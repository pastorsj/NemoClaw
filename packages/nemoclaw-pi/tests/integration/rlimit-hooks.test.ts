// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  dockerRunCommandBetween,
  runLoggedDockerShell,
} from "../../../../test/helpers/dockerfile-run-shell";

const PACKAGE_ROOT = path.resolve(import.meta.dirname, "../..");
const REPOSITORY_ROOT = path.resolve(PACKAGE_ROOT, "../..");
const DOCKERFILE_BASE = path.join(PACKAGE_ROOT, "Dockerfile.base");
const SANDBOX_RLIMITS = path.join(REPOSITORY_ROOT, "scripts", "lib", "sandbox-rlimits.sh");

function copyRlimitFixture(target: string): void {
  // TEST-ONLY OVERRIDE: production remains 512 in scripts/lib/sandbox-rlimits.sh.
  // RLIMIT_NPROC is shared by the real user, so that default can starve this
  // test's shell when Vitest runs subprocesses concurrently.
  fs.writeFileSync(
    target,
    fs
      .readFileSync(SANDBOX_RLIMITS, "utf-8")
      .replace(/^NEMOCLAW_SANDBOX_NPROC_LIMIT=512$/m, "NEMOCLAW_SANDBOX_NPROC_LIMIT=4096"),
  );
}

function expectShellStartupRejection(
  hooks: ReadonlyArray<{ readonly mode: "interactive" | "login"; readonly path: string }>,
  failure: string,
): void {
  for (const hook of hooks) {
    const args =
      hook.mode === "login"
        ? [
            "--noprofile",
            "--norc",
            "-lc",
            'source "$1"; printf "UNREACHABLE\\n"',
            "pi-login",
            hook.path,
          ]
        : ["--noprofile", "--rcfile", hook.path, "-ic", 'printf "UNREACHABLE\\n"'];
    const result = spawnSync("bash", args, {
      encoding: "utf-8",
      timeout: 5000,
    });

    expect(result.status, `${hook.mode}: ${failure}\n${result.stderr}`).not.toBe(0);
    expect(result.stdout).not.toContain("UNREACHABLE");
    expect(result.stderr).toContain(
      "[SECURITY] Sandbox resource limits were NOT hardened for this shell; refusing shell startup.",
    );
  }
}

describe("Pi sandbox resource-limit hooks", () => {
  it("rejects login and interactive shells when exact limit enforcement fails", () => {
    const dockerfile = fs.readFileSync(DOCKERFILE_BASE, "utf-8");
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-pi-rlimit-hooks-"));
    const rlimitHook = path.join(temporaryRoot, "profile.d", "nemoclaw-rlimits.sh");
    const rlimitLib = path.join(temporaryRoot, "sandbox-rlimits.sh");
    const bashrc = path.join(temporaryRoot, "bash.bashrc");

    try {
      fs.mkdirSync(path.dirname(rlimitHook), { recursive: true });
      copyRlimitFixture(rlimitLib);
      fs.writeFileSync(bashrc, "# existing Pi bashrc\n");
      const command = dockerRunCommandBetween(
        dockerfile,
        "# System-wide RLIMIT hooks for Pi connect and login shells",
        "COPY packages/nemoclaw-pi/runtime/pi/package.json",
      )
        .replaceAll("/usr/local/lib/nemoclaw/sandbox-rlimits.sh", rlimitLib)
        .replaceAll("/etc/profile.d/nemoclaw-rlimits.sh", rlimitHook)
        .replaceAll("/etc/bash.bashrc", bashrc);

      const { result } = runLoggedDockerShell(command, temporaryRoot);
      expect(result.status, result.stderr).toBe(0);
      expect(fs.readFileSync(bashrc, "utf-8")).toContain("# existing Pi bashrc");
      const hooks = [
        { mode: "login" as const, path: rlimitHook },
        { mode: "interactive" as const, path: bashrc },
      ];

      fs.rmSync(rlimitLib, { force: true });
      expectShellStartupRejection(hooks, "missing helper");

      fs.writeFileSync(
        rlimitLib,
        [
          "harden_resource_limits() { return 1; }",
          "verify_resource_limits() { :; }",
          "verify_resource_limits_exact() { :; }",
        ].join("\n"),
        { mode: 0o644 },
      );
      expectShellStartupRejection(hooks, "failed hardening");

      fs.writeFileSync(
        rlimitLib,
        [
          "harden_resource_limits() { :; }",
          "verify_resource_limits() { :; }",
          "verify_resource_limits_exact() { return 1; }",
        ].join("\n"),
        { mode: 0o644 },
      );
      expectShellStartupRejection(hooks, "failed exact verification");
    } finally {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });
});
