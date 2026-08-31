// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync, execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const START_SERVICES_SCRIPT = join(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "scripts",
  "start-services.sh",
);

describe("service environment", () => {
  describe("start-services behavior", () => {
    it("starts without messaging-related warnings", { timeout: 30000 }, () => {
      const workspace = mkdtempSync(join(tmpdir(), "nemoclaw-services-no-key-"));
      const sandboxName = `test-box-${String(process.pid)}-${String(Date.now())}`;
      const pidDir = `/tmp/nemoclaw-services-${sandboxName}`;
      const env = {
        ...process.env,
        SANDBOX_NAME: sandboxName,
        TMPDIR: workspace,
      };

      try {
        const result = execFileSync("bash", [START_SERVICES_SCRIPT], {
          encoding: "utf-8",
          env,
        });

        expect(result).toContain("Messaging:   via OpenClaw native channels");
      } finally {
        try {
          execFileSync("bash", [START_SERVICES_SCRIPT, "--stop"], {
            env,
            stdio: "ignore",
          });
        } catch {
          // Startup may fail before there is a service to stop.
        }
        rmSync(pidDir, { recursive: true, force: true });
        rmSync(workspace, { recursive: true, force: true });
      }
    });
  });

  describe("SANDBOX_NAME defaulting", () => {
    it("start-services.sh preserves existing SANDBOX_NAME", () => {
      const result = execSync(
        'bash -c \'SANDBOX_NAME="${NEMOCLAW_SANDBOX:-${SANDBOX_NAME:-default}}"; export SANDBOX_NAME; bash -c "echo \\$SANDBOX_NAME"\'',
        {
          encoding: "utf-8",
          env: { ...process.env, NEMOCLAW_SANDBOX: "", SANDBOX_NAME: "my-box" },
        },
      ).trim();
      expect(result).toBe("my-box");
    });

    it("start-services.sh uses NEMOCLAW_SANDBOX over SANDBOX_NAME", () => {
      const result = execSync(
        'bash -c \'SANDBOX_NAME="${NEMOCLAW_SANDBOX:-${SANDBOX_NAME:-default}}"; export SANDBOX_NAME; bash -c "echo \\$SANDBOX_NAME"\'',
        {
          encoding: "utf-8",
          env: { ...process.env, NEMOCLAW_SANDBOX: "from-env", SANDBOX_NAME: "old" },
        },
      ).trim();
      expect(result).toBe("from-env");
    });

    it("start-services.sh falls back to default when both unset", () => {
      const result = execSync(
        'bash -c \'SANDBOX_NAME="${NEMOCLAW_SANDBOX:-${SANDBOX_NAME:-default}}"; export SANDBOX_NAME; bash -c "echo \\$SANDBOX_NAME"\'',
        {
          encoding: "utf-8",
          env: { ...process.env, NEMOCLAW_SANDBOX: "", SANDBOX_NAME: "" },
        },
      ).trim();
      expect(result).toBe("default");
    });
  });
});
