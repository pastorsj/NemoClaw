// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  extractShellFunctionFromSource,
  nonRootFallbackBlock,
  nonRootIntegrityGateBlock,
  readOpenClawStartupSource,
  rootIntegrityGateBlock,
  startScriptLine,
} from "../helpers/startup-suite";

describe("nemoclaw-start non-root fallback", () => {
  it("exits before startup work when locked config integrity fails in non-root mode", () => {
    const src = readOpenClawStartupSource();
    const script = [
      "set -euo pipefail",
      'id() { if [ "${1:-}" = "-u" ]; then printf "1000"; else command id "$@"; fi; }',
      "recover_openclaw_config_if_empty() { :; }",
      'verify_config_integrity_if_locked() { printf "verify:%s\\n" "$*"; return 1; }',
      'apply_model_override() { echo "SHOULD_NOT_RUN"; exit 70; }',
      nonRootIntegrityGateBlock(src),
      'echo "SHOULD_NOT_CONTINUE"',
    ].join("\n");

    const result = spawnSync("bash", ["-c", script], { encoding: "utf-8", timeout: 5000 });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("verify:/sandbox/.openclaw");
    expect(result.stdout).not.toContain("SHOULD_NOT");
    expect(result.stderr).toContain("Config integrity check failed");
    expect(result.stderr).not.toMatch(/proceeding anyway/i);
  });

  it("verifies config integrity in both non-root and root startup paths", () => {
    const src = readOpenClawStartupSource();
    const nonRootScript = [
      "set -euo pipefail",
      'id() { if [ "${1:-}" = "-u" ]; then printf "1000"; else command id "$@"; fi; }',
      "recover_openclaw_config_if_empty() { :; }",
      'verify_config_integrity_if_locked() { printf "nonroot:%s\\n" "$*"; }',
      "normalize_mutable_config_perms() { :; }",
      nonRootIntegrityGateBlock(src),
      'echo "NONROOT_CONTINUED"',
    ].join("\n");
    const rootScript = [
      "set -euo pipefail",
      "recover_openclaw_config_if_empty() { :; }",
      'verify_config_integrity_if_locked() { printf "root:%s\\n" "$*"; }',
      rootIntegrityGateBlock(src),
      'echo "ROOT_CONTINUED"',
    ].join("\n");

    const nonRoot = spawnSync("bash", ["-c", nonRootScript], {
      encoding: "utf-8",
      timeout: 5000,
    });
    const root = spawnSync("bash", ["-c", rootScript], { encoding: "utf-8", timeout: 5000 });

    expect(nonRoot.status).toBe(0);
    expect(nonRoot.stdout).toContain("nonroot:/sandbox/.openclaw");
    expect(nonRoot.stdout).toContain("NONROOT_CONTINUED");
    expect(root.status).toBe(0);
    expect(root.stdout).toContain("root:/sandbox/.openclaw");
    expect(root.stdout).toContain("ROOT_CONTINUED");
  });

  it("sends startup diagnostics to stderr so they do not leak into bridge output (#1064)", () => {
    const src = readOpenClawStartupSource();
    const token = "a".repeat(64);
    const script = [
      "set -euo pipefail",
      `_read_gateway_token() { printf "${token}\\n"; }`,
      'PUBLIC_PORT="19000"',
      `CHAT_UI_URL="https://remote.example.test/ui/#token=${token}"`,
      startScriptLine(src, "echo 'Setting up NemoClaw...'"),
      extractShellFunctionFromSource(src, "print_dashboard_urls"),
      "print_dashboard_urls",
    ].join("\n");

    const result = spawnSync("bash", ["-c", script], { encoding: "utf-8", timeout: 5000 });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Setting up NemoClaw");
    expect(result.stderr).toContain("[gateway] Local UI: http://127.0.0.1:19000/");
    expect(result.stderr).toContain("[gateway] Remote UI: https://remote.example.test/ui/");
    expect(result.stderr).toContain("Dashboard auth token redacted from startup logs.");
    expect(result.stderr).not.toContain("#token=");
    expect(result.stderr).not.toContain(token);
  });

  it("runs runtime preloads and scans before explicit non-root commands", () => {
    const src = readOpenClawStartupSource();
    const script = [
      "set -euo pipefail",
      'id() { if [ "${1:-}" = "-u" ]; then printf "1000"; else command id "$@"; fi; }',
      "recover_openclaw_config_if_empty() { :; }",
      "verify_config_integrity_if_locked() { :; }",
      "normalize_mutable_config_perms() { :; }",
      "apply_model_override() { :; }",
      "reconcile_agent_model_with_provider() { :; }",
      "apply_cors_override() { :; }",
      "refresh_openclaw_provider_placeholders() { :; }",
      "ensure_mutable_openclaw_config_hash() { :; }",
      extractShellFunctionFromSource(src, "needs_gateway_token_for_current_command"),
      extractShellFunctionFromSource(src, "prepare_gateway_token_for_current_command"),
      'ensure_gateway_token() { echo "SHOULD_NOT_ENSURE"; exit 75; }',
      'ensure_gateway_token_if_missing() { echo "SHOULD_NOT_ENSURE"; exit 76; }',
      "write_openclaw_config_baseline() { :; }",
      "export_gateway_token() { :; }",
      "write_messaging_runtime_setup_plan() { :; }",
      "write_runtime_shell_env() { :; }",
      "ensure_runtime_shell_env_shim() { :; }",
      "lock_rc_files() { :; }",
      "apply_messaging_runtime_env_aliases() { :; }",
      'configure_messaging_channels() { echo "SHOULD_NOT_CONFIGURE"; exit 70; }',
      'install_messaging_runtime_preloads() { echo "ORDER:install"; }',
      'verify_messaging_runtime_secret_scans() { echo "ORDER:verify"; }',
      "seed_default_workspace_templates() { :; }",
      extractShellFunctionFromSource(src, "run_oneshot_command"),
      "_SANDBOX_HOME=/sandbox",
      "NEMOCLAW_CMD=(bash -c 'echo EXPLICIT_COMMAND; exit 23')",
      nonRootFallbackBlock(src),
      'echo "SHOULD_NOT_REACH"',
    ].join("\n");
    const result = spawnSync("bash", ["-c", script], { encoding: "utf-8", timeout: 5000 });
    expect(result.status).toBe(23);
    expect(result.stdout).toContain("EXPLICIT_COMMAND");
    expect(result.stdout).toMatch(/ORDER:install[\s\S]*ORDER:verify[\s\S]*EXPLICIT_COMMAND/);
    expect(result.stdout).not.toContain("SHOULD_NOT_CONFIGURE");
  });

  it("only requires early gateway token generation for gateway and OpenClaw commands (#3256)", () => {
    const src = readOpenClawStartupSource();
    const script = [
      "set -euo pipefail",
      extractShellFunctionFromSource(src, "needs_gateway_token_for_current_command"),
      'check() { NEMOCLAW_CMD=("$@"); if needs_gateway_token_for_current_command; then printf "yes:%s\\n" "${1:-<none>}"; else printf "no:%s\\n" "${1:-<none>}"; fi; }',
      "check",
      "check openclaw agent --agent main",
      "check /usr/local/bin/openclaw agent --agent main",
      "check true",
      "check bash -lc 'openclaw agent --agent main'",
    ].join("\n");

    const result = spawnSync("bash", ["-c", script], { encoding: "utf-8", timeout: 5000 });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("yes:<none>");
    expect(result.stdout).toContain("yes:openclaw");
    expect(result.stdout).toContain("yes:/usr/local/bin/openclaw");
    expect(result.stdout).toContain("no:true");
    expect(result.stdout).toContain("no:bash");
  });

  it("refreshes startup tokens but only ensures direct OpenClaw command tokens (#4517)", () => {
    const src = readOpenClawStartupSource();
    const script = [
      "set -euo pipefail",
      extractShellFunctionFromSource(src, "needs_gateway_token_for_current_command"),
      extractShellFunctionFromSource(src, "prepare_gateway_token_for_current_command"),
      'ensure_gateway_token() { printf "rotate:%s\\n" "${NEMOCLAW_CMD[*]:-<none>}"; }',
      'ensure_gateway_token_if_missing() { printf "ensure-missing:%s\\n" "${NEMOCLAW_CMD[*]}"; }',
      'check() { NEMOCLAW_CMD=("$@"); prepare_gateway_token_for_current_command; }',
      "check",
      "check openclaw agent --agent main",
      "check true",
    ].join("\n");

    const result = spawnSync("bash", ["-c", script], { encoding: "utf-8", timeout: 5000 });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("rotate:<none>");
    expect(result.stdout).toContain("ensure-missing:openclaw agent --agent main");
    expect(result.stdout).not.toContain("true");
  });

  it.each(["workspace", "memory", "credentials", "flows", "telegram", "media"])(
    "repairs writable OpenClaw state directories in non-root mode [%s]",
    (dir) => {
      const src = readOpenClawStartupSource();
      const match = src.match(/fix_openclaw_ownership\(\) \{([\s\S]*?)^\s*\}/m);
      if (!match) {
        throw new Error("Expected fix_openclaw_ownership in packages/nemoclaw-openclaw/start.sh");
      }
      const fn = `fix_openclaw_ownership() {${match[1]}\n}`;
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-ownership-"));
      const openclawDir = path.join(tmpDir, ".openclaw");
      const scriptPath = path.join(tmpDir, "run.sh");
      fs.mkdirSync(openclawDir, { recursive: true });
      fs.writeFileSync(path.join(openclawDir, "openclaw.json"), "{}\n", { mode: 0o644 });
      fs.writeFileSync(path.join(openclawDir, ".config-hash"), "hash\n", { mode: 0o644 });
      fs.writeFileSync(path.join(openclawDir, "fabric.json"), "{}\n", { mode: 0o644 });
      fs.writeFileSync(
        scriptPath,
        ["#!/usr/bin/env bash", "set -euo pipefail", fn, "fix_openclaw_ownership"].join("\n"),
        { mode: 0o700 },
      );
      try {
        const result = spawnSync("bash", [scriptPath], {
          encoding: "utf-8",
          timeout: 5000,
          env: { ...process.env, HOME: tmpDir },
        });
        expect(result.status).toBe(0);
        expect(fs.statSync(path.join(openclawDir, dir)).isDirectory()).toBe(true);
        expect((fs.statSync(openclawDir).mode & 0o777).toString(8)).toBe("770");
        expect(fs.statSync(openclawDir).mode & 0o2000).toBe(0o2000);
        expect(
          (fs.statSync(path.join(openclawDir, "openclaw.json")).mode & 0o777).toString(8),
        ).toBe("660");
        expect((fs.statSync(path.join(openclawDir, ".config-hash")).mode & 0o777).toString(8)).toBe(
          "660",
        );
        expect((fs.statSync(path.join(openclawDir, "fabric.json")).mode & 0o777).toString(8)).toBe(
          "600",
        );
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    },
  );
});
