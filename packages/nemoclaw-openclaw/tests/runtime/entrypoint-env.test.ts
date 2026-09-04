// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { readOpenClawEntrypointBlock } from "../helpers/startup";

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, "..", "..", "..", "..");
const ENTRYPOINT_ENV_WRAPPER = path.join(
  REPOSITORY_ROOT,
  "scripts",
  "lib",
  "entrypoint-env-wrapper.sh",
);

describe("OCI entrypoint env-wrapper normalization", () => {
  it("unwraps the sandbox-create env self-wrapper and applies dashboard port defaults", () => {
    const normalizer = fs.readFileSync(ENTRYPOINT_ENV_WRAPPER, "utf-8");
    const openClawPortBlock = readOpenClawEntrypointBlock(
      'NEMOCLAW_CMD=("$@")',
      "# startup-modules begin",
    );
    const snippet = [
      normalizer,
      'nemoclaw_normalize_entrypoint_env_wrapper "$@"',
      'if [ "$NEMOCLAW_ENTRYPOINT_NORMALIZED_ARGC" -eq 0 ]; then set --; ' +
        'else set -- "${NEMOCLAW_ENTRYPOINT_NORMALIZED_ARGV[@]}"; fi',
      openClawPortBlock,
    ].join("\n");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-env-wrapper-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "run.sh");
    function runScenario(setArgs: string, extraEnv: Record<string, string> = {}) {
      const baseEnv = { ...process.env };
      delete baseEnv.NEMOCLAW_DASHBOARD_PORT;
      delete baseEnv.CHAT_UI_URL;
      const script = [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        setArgs,
        snippet,
        'printf "CHAT_UI_URL=%s\\n" "$CHAT_UI_URL"',
        'printf "PUBLIC_PORT=%s\\n" "$PUBLIC_PORT"',
        'printf "OPENCLAW_GATEWAY_PORT=%s\\n" "$OPENCLAW_GATEWAY_PORT"',
        'printf "OPENCLAW_GATEWAY_URL=%s\\n" "$OPENCLAW_GATEWAY_URL"',
        'printf "SANDBOX_HOME=%s\\n" "$_SANDBOX_HOME"',
        'printf "OPENCLAW_HOME=%s\\n" "$OPENCLAW_HOME"',
        'printf "OPENCLAW_STATE_DIR=%s\\n" "$OPENCLAW_STATE_DIR"',
        'printf "OPENCLAW_CONFIG_PATH=%s\\n" "$OPENCLAW_CONFIG_PATH"',
        'printf "OPENCLAW_OAUTH_DIR=%s\\n" "$OPENCLAW_OAUTH_DIR"',
        'printf "CMD=%s\\n" "${NEMOCLAW_CMD[*]}"',
      ].join("\n");
      fs.writeFileSync(scriptPath, script, { mode: 0o700 });
      return spawnSync("bash", [scriptPath], {
        encoding: "utf-8",
        timeout: 5000,
        env: { ...baseEnv, PATH: `${fakeBin}:${process.env.PATH || ""}`, ...extraEnv },
      });
    }

    vi.stubEnv("NEMOCLAW_DASHBOARD_PORT", "19999");
    vi.stubEnv("CHAT_UI_URL", "https://ambient.example.test/ui");

    try {
      fs.mkdirSync(fakeBin);
      fs.writeFileSync(path.join(fakeBin, "openclaw"), "#!/usr/bin/env bash\nexit 0\n", {
        mode: 0o755,
      });

      const injected = runScenario(
        "set -- env CHAT_UI_URL=https://chat.example.test NEMOCLAW_DASHBOARD_PORT=19000 nemoclaw-start openclaw agent --agent main",
      );
      expect(injected.status, injected.stderr).toBe(0);
      expect(injected.stdout).toContain("CHAT_UI_URL=http://127.0.0.1:19000");
      expect(injected.stdout).toContain("PUBLIC_PORT=19000");
      expect(injected.stdout).toContain("OPENCLAW_GATEWAY_PORT=19000");
      expect(injected.stdout).toContain("OPENCLAW_GATEWAY_URL=ws://127.0.0.1:19000");
      expect(injected.stdout).toContain("SANDBOX_HOME=/sandbox");
      expect(injected.stdout).toContain("OPENCLAW_HOME=/sandbox");
      expect(injected.stdout).toContain("OPENCLAW_STATE_DIR=/sandbox/.openclaw");
      expect(injected.stdout).toContain("OPENCLAW_CONFIG_PATH=/sandbox/.openclaw/openclaw.json");
      expect(injected.stdout).toContain("OPENCLAW_OAUTH_DIR=/sandbox/.openclaw/credentials");
      expect(injected.stdout).toContain("CMD=openclaw agent --agent main");

      const bakedCustomPort = runScenario("set -- nemoclaw-start openclaw agent", {
        CHAT_UI_URL: "http://127.0.0.1:18790",
      });
      expect(bakedCustomPort.status).toBe(0);
      expect(bakedCustomPort.stdout).toContain("CHAT_UI_URL=http://127.0.0.1:18790");
      expect(bakedCustomPort.stdout).toContain("PUBLIC_PORT=18790");
      expect(bakedCustomPort.stdout).toContain("OPENCLAW_GATEWAY_PORT=18790");
      expect(bakedCustomPort.stdout).toContain("OPENCLAW_GATEWAY_URL=ws://127.0.0.1:18790");
      expect(bakedCustomPort.stdout).toContain("OPENCLAW_STATE_DIR=/sandbox/.openclaw");
      expect(bakedCustomPort.stdout).toContain("OPENCLAW_OAUTH_DIR=/sandbox/.openclaw/credentials");
      expect(bakedCustomPort.stdout).toContain("CMD=openclaw agent");

      const baked = runScenario("set -- nemoclaw-start openclaw agent", {
        CHAT_UI_URL: "https://baked.example.test/ui",
      });
      expect(baked.status).toBe(0);
      expect(baked.stdout).toContain("CHAT_UI_URL=https://baked.example.test/ui");
      expect(baked.stdout).toContain("PUBLIC_PORT=18789");
      expect(baked.stdout).toContain("OPENCLAW_GATEWAY_PORT=18789");
      expect(baked.stdout).toContain("OPENCLAW_GATEWAY_URL=ws://127.0.0.1:18789");
      expect(baked.stdout).toContain("SANDBOX_HOME=/sandbox");
      expect(baked.stdout).toContain("OPENCLAW_STATE_DIR=/sandbox/.openclaw");
      expect(baked.stdout).toContain("CMD=openclaw agent");

      const defaults = runScenario("set -- nemoclaw-start openclaw agent");
      expect(defaults.status).toBe(0);
      expect(defaults.stdout).toContain("CHAT_UI_URL=http://127.0.0.1:18789");
      expect(defaults.stdout).toContain("PUBLIC_PORT=18789");

      const invalidHighPort = runScenario("set -- nemoclaw-start openclaw agent", {
        NEMOCLAW_DASHBOARD_PORT: "70000",
      });
      expect(invalidHighPort.status).toBe(1);
      expect(invalidHighPort.stderr).toContain("Invalid NEMOCLAW_DASHBOARD_PORT='70000'");
      expect(invalidHighPort.stderr).toContain("must be an integer between 1024 and 65535");
    } finally {
      vi.unstubAllEnvs();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
