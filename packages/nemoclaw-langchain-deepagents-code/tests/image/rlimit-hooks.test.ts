// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  copyRlimitFixture,
  dcodeRlimitShim,
  dockerRunCommandBetween,
  expectDcodeRlimitHookWarnsWhenHelperIsMissing,
  expectDcodeRlimitHookWarnsWhenVerificationFails,
  expectSystemRlimitHookBypassesShadowedUlimit,
  expectSystemRlimitHookEnforcesLimits,
  runLoggedDockerShell,
} from "../helpers/rlimit-hooks";

const PACKAGE_ROOT = path.resolve(import.meta.dirname, "../..");
const DCODE_DOCKERFILE_BASE = path.join(PACKAGE_ROOT, "Dockerfile.base");

describe("sandbox rlimit system hooks (#2173)", () => {
  it("Deep Agents Code base image selects exact verification for connect and login shells", () => {
    const dockerfile = fs.readFileSync(DCODE_DOCKERFILE_BASE, "utf-8");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-rlimit-hooks-"));
    const rlimitHook = path.join(tmp, "profile.d", "nemoclaw-rlimits.sh");
    const rlimitLib = path.join(tmp, "sandbox-rlimits.sh");
    const bashrc = path.join(tmp, "bash.bashrc");
    const expectedRlimitShim = dcodeRlimitShim(rlimitLib);

    try {
      fs.mkdirSync(path.dirname(rlimitHook), { recursive: true });
      copyRlimitFixture(rlimitLib);
      fs.writeFileSync(bashrc, "# existing dcode bashrc\n");
      const command = dockerRunCommandBetween(
        dockerfile,
        "# System-wide RLIMIT hooks for Deep Agents Code",
        "COPY packages/nemoclaw-langchain-deepagents-code/runtime/requirements.lock",
      )
        .replaceAll("/usr/local/lib/nemoclaw/sandbox-rlimits.sh", rlimitLib)
        .replaceAll("/etc/profile.d/nemoclaw-rlimits.sh", rlimitHook)
        .replaceAll("/etc/bash.bashrc", bashrc);

      const { result } = runLoggedDockerShell(command, tmp);
      expect(result.status, result.stderr).toBe(0);
      expect(fs.readFileSync(rlimitHook, "utf-8")).toContain(expectedRlimitShim);
      expect(fs.readFileSync(bashrc, "utf-8")).toContain(expectedRlimitShim);
      expect(fs.readFileSync(bashrc, "utf-8")).toContain("# existing dcode bashrc");
      expectSystemRlimitHookEnforcesLimits(rlimitHook);
      expectSystemRlimitHookEnforcesLimits(bashrc);
      expectSystemRlimitHookBypassesShadowedUlimit(rlimitHook);
      expectDcodeRlimitHookWarnsWhenVerificationFails(rlimitHook, rlimitLib);
      expectDcodeRlimitHookWarnsWhenHelperIsMissing(rlimitHook, rlimitLib);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
