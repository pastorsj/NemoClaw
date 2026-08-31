// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  copyRlimitFixture,
  dockerRunCommandBetween,
  expectSystemRlimitHookBypassesShadowedUlimit,
  expectSystemRlimitHookEnforcesLimits,
  expectSystemRlimitHookIsSilentWhenVerificationFails,
  occurrenceCount,
  rlimitShim,
  runLoggedDockerShell,
} from "../helpers/rlimit-hooks";

const PACKAGE_ROOT = path.resolve(import.meta.dirname, "../..");
const DOCKERFILE = path.join(PACKAGE_ROOT, "Dockerfile");
const DOCKERFILE_BASE = path.join(PACKAGE_ROOT, "Dockerfile.base");

describe("sandbox rlimit system hooks (#2173)", () => {
  it("connect shell reports numeric nproc <=4096 and nofile <=65536 and denies raising limits after system-wide rlimit hook startup", () => {
    const dockerfile = fs.readFileSync(DOCKERFILE_BASE, "utf-8");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-base-rlimit-hooks-"));
    const profileHook = path.join(tmp, "profile.d", "nemoclaw-proxy.sh");
    const rlimitHook = path.join(tmp, "profile.d", "nemoclaw-rlimits.sh");
    const rlimitLib = path.join(tmp, "sandbox-rlimits.sh");
    const bashrc = path.join(tmp, "bash.bashrc");
    const expectedRlimitShim = rlimitShim(rlimitLib);

    try {
      fs.mkdirSync(path.dirname(profileHook), { recursive: true });
      copyRlimitFixture(rlimitLib);
      fs.writeFileSync(bashrc, "# existing bashrc\n");
      const command = dockerRunCommandBetween(
        dockerfile,
        "# System-wide proxy hooks",
        "# Install OpenClaw CLI + PyYAML",
      )
        .replaceAll("/usr/local/lib/nemoclaw/sandbox-rlimits.sh", rlimitLib)
        .replaceAll("/etc/profile.d/nemoclaw-rlimits.sh", rlimitHook)
        .replaceAll("/etc/profile.d/nemoclaw-proxy.sh", profileHook)
        .replaceAll("/etc/bash.bashrc", bashrc);

      const { result } = runLoggedDockerShell(command, tmp);
      expect(result.status, result.stderr).toBe(0);
      expect(fs.readFileSync(rlimitHook, "utf-8")).toContain(expectedRlimitShim);
      expect(fs.readFileSync(bashrc, "utf-8")).toContain(expectedRlimitShim);
      expectSystemRlimitHookEnforcesLimits(rlimitHook);
      expectSystemRlimitHookEnforcesLimits(bashrc);
      expectSystemRlimitHookBypassesShadowedUlimit(rlimitHook);
      expectSystemRlimitHookIsSilentWhenVerificationFails(rlimitHook, rlimitLib);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("stale OpenClaw base replay preserves effective connect-shell rlimit hooks", () => {
    const dockerfile = fs.readFileSync(DOCKERFILE, "utf-8");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-rlimit-hooks-"));
    const profileHook = path.join(tmp, "profile.d", "nemoclaw-proxy.sh");
    const rlimitHook = path.join(tmp, "profile.d", "nemoclaw-rlimits.sh");
    const rlimitLib = path.join(tmp, "sandbox-rlimits.sh");
    const bashrc = path.join(tmp, "bash.bashrc");
    const expectedProxyShim = "[ -f /tmp/nemoclaw-proxy-env.sh ] && . /tmp/nemoclaw-proxy-env.sh";
    const expectedRlimitShim = rlimitShim(rlimitLib);

    try {
      fs.mkdirSync(path.dirname(profileHook), { recursive: true });
      copyRlimitFixture(rlimitLib);
      fs.writeFileSync(
        bashrc,
        [
          "# NemoClaw runtime proxy config — see /tmp/nemoclaw-proxy-env.sh (#2704)",
          "[ -f /tmp/nemoclaw-proxy-env.sh ] && . /tmp/nemoclaw-proxy-env.sh",
          "# NemoClaw sandbox resource limits — see sandbox-rlimits.sh (#2173)",
          "[ -f /usr/local/lib/nemoclaw/sandbox-rlimits.sh ] && . /usr/local/lib/nemoclaw/sandbox-rlimits.sh && harden_resource_limits --quiet && verify_resource_limits --quiet || true",
        ].join("\n"),
      );
      const command = dockerRunCommandBetween(
        dockerfile,
        "# System-wide shell hooks",
        "# Pin config hash at build time",
      )
        .replaceAll("/usr/local/lib/nemoclaw/sandbox-rlimits.sh", rlimitLib)
        .replaceAll("/etc/profile.d/nemoclaw-rlimits.sh", rlimitHook)
        .replaceAll("/etc/profile.d/nemoclaw-proxy.sh", profileHook)
        .replaceAll("/etc/bash.bashrc", bashrc);

      const { result } = runLoggedDockerShell(command, tmp);
      expect(result.status, result.stderr).toBe(0);
      const bashrcBody = fs.readFileSync(bashrc, "utf-8");
      expect(occurrenceCount(bashrcBody, expectedProxyShim)).toBe(1);
      expect(occurrenceCount(bashrcBody, expectedRlimitShim)).toBe(1);
      expectSystemRlimitHookEnforcesLimits(rlimitHook);
      expectSystemRlimitHookEnforcesLimits(bashrc);
      expectSystemRlimitHookIsSilentWhenVerificationFails(bashrc, rlimitLib);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
