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
  readOpenClawStartupSource,
  runtimeShellEnvBlock,
  startScriptHeredoc,
} from "../helpers/startup-suite";

describe("Telegram diagnostics (#2766)", () => {
  const src = readOpenClawStartupSource();
  const telegramDiagnosticsScript = startScriptHeredoc(src, "TELEGRAM_DIAGNOSTICS_EOF");
  type EntryKind = "non-root" | "root";

  function preGatewaySetupBlock(kind: EntryKind, gatewayLog: string, autoPairLog: string) {
    const nonRootMarker = src.indexOf("# ── Non-root fallback");
    const start =
      kind === "non-root"
        ? src.indexOf('if [ "$(id -u)" -ne 0 ]; then', nonRootMarker)
        : src.indexOf("# ── Root path");
    const endMarker =
      kind === "non-root"
        ? "  # Start gateway in background, auto-pair, then wait"
        : "# Start the gateway as the 'gateway' user.";
    const end = src.indexOf(endMarker, start);
    if (start === -1 || end === -1 || end <= start) {
      throw new Error(`Expected ${kind} pre-gateway setup block in OpenClaw start.sh`);
    }
    const block = src
      .slice(start, end)
      .replaceAll("/tmp/gateway.log", gatewayLog)
      .replaceAll("/tmp/auto-pair.log", autoPairLog)
      .replaceAll("/tmp/nemoclaw-auto-pair-status.json", `${autoPairLog}.status`);
    return kind === "non-root"
      ? `${extractShellFunctionFromSource(src, "_nemoclaw_capture_epoch_realtime")}\n${block}fi\n`
      : block;
  }

  function runPreGatewaySetup(kind: EntryKind) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `nemoclaw-telegram-${kind}-`));
    const configPath = path.join(tmpDir, "openclaw.json");
    const preloadPath = path.join(tmpDir, "telegram-diagnostics.js");
    const gatewayLog = path.join(tmpDir, "gateway.log");
    const autoPairLog = path.join(tmpDir, "auto-pair.log");
    const pluginRefreshLog = path.join(tmpDir, "nemoclaw-plugin-refresh.log");
    const scriptPath = path.join(tmpDir, "run.sh");
    fs.writeFileSync(configPath, '{"channels":{"telegram":{}}}\n');
    fs.writeFileSync(
      scriptPath,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        kind === "non-root"
          ? 'id() { if [ "${1:-}" = "-u" ]; then printf "1000"; elif [ "${1:-}" = "-g" ]; then printf "1000"; else command id "$@"; fi; }'
          : 'id() { if [ "${1:-}" = "-u" ]; then printf "0"; elif [ "${1:-}" = "-g" ]; then printf "0"; else command id "$@"; fi; }',
        'emit_sandbox_sourced_file() { local target="$1"; cat > "$target"; chmod 444 "$target"; }',
        "recover_openclaw_config_if_empty() { :; }",
        'verify_config_integrity_if_locked() { echo "ORDER:verify"; }',
        'normalize_mutable_config_perms() { echo "ORDER:normalize"; }',
        "apply_model_override() { :; }",
        "reconcile_agent_model_with_provider() { :; }",
        "apply_cors_override() { :; }",
        "refresh_openclaw_provider_placeholders() { :; }",
        "ensure_mutable_openclaw_config_hash() { :; }",
        "needs_gateway_token_for_current_command() { :; }",
        extractShellFunctionFromSource(src, "prepare_gateway_token_for_current_command"),
        "ensure_gateway_token() { :; }",
        "ensure_gateway_token_if_missing() { :; }",
        "write_openclaw_config_baseline() { :; }",
        "export_gateway_token() { :; }",
        "write_messaging_runtime_setup_plan() { :; }",
        "write_runtime_shell_env() { :; }",
        "ensure_runtime_shell_env_shim() { :; }",
        "lock_rc_files() { :; }",
        "apply_messaging_runtime_env_aliases() { :; }",
        'configure_messaging_channels() { echo "ORDER:configure"; }',
        `install_messaging_runtime_preloads() { : > ${JSON.stringify(preloadPath)}; chmod 444 ${JSON.stringify(preloadPath)}; }`,
        "verify_messaging_runtime_secret_scans() { :; }",
        "seed_default_workspace_templates() { :; }",
        "seed_default_workspace_templates_as_sandbox() { seed_default_workspace_templates; }",
        "write_auth_profile() { :; }",
        "harden_auth_profiles() { :; }",
        "run_step_down_as_sandbox() { :; }",
        "setup_auth_profile_as_sandbox() { :; }",
        `PLUGIN_REFRESH_LOG=${JSON.stringify(pluginRefreshLog)}`,
        extractShellFunctionFromSource(src, "prepare_plugin_refresh_log"),
        "chown() { :; }",
        "chown_tree_no_symlink_follow() { :; }",
        "start_persistent_gateway_log_mirror() { :; }",
        'setpriv() { while [ "$1" != "--" ]; do shift; done; shift; "$@"; }',
        // STEP_DOWN_PREFIX_* are normally populated by init_step_down_prefixes
        // in sandbox-init.sh; the test scaffolding doesn't source that, so
        // initialize them here because this scaffolding does not source the
        // shared privilege-transition helper.
        "STEP_DOWN_PREFIX_SANDBOX=(setpriv --reuid=sandbox --regid=sandbox --init-groups --)",
        "STEP_DOWN_PREFIX_GATEWAY=(setpriv --reuid=gateway --regid=gateway --init-groups --)",
        'validate_tmp_permissions() { printf "VALIDATE:%s\\n" "$*"; }',
        "_SANDBOX_HOME=/sandbox",
        `_SANDBOX_SAFETY_NET=${JSON.stringify(path.join(tmpDir, "safety.js"))}`,
        `_PROXY_FIX_SCRIPT=${JSON.stringify(path.join(tmpDir, "proxy-fix.js"))}`,
        `_NEMOTRON_FIX_SCRIPT=${JSON.stringify(path.join(tmpDir, "nemotron-fix.js"))}`,
        `_CIAO_GUARD_SCRIPT=${JSON.stringify(path.join(tmpDir, "ciao-guard.js"))}`,
        `validate_nemoclaw_tmp_permissions() { validate_tmp_permissions ${JSON.stringify(preloadPath)}; }`,
        "NEMOCLAW_CMD=()",
        '_nemoclaw_safe_create_tmp_file() { if [ "$1" = /tmp/auto-pair.log ]; then return 97; fi; : > "$1"; chmod "$2" "$1"; }',
        `${extractShellFunctionFromSource(src, "prepare_auto_pair_log").replaceAll(
          "/tmp/auto-pair.log",
          autoPairLog,
        )}\n${preGatewaySetupBlock(kind, gatewayLog, autoPairLog)}`,
      ].join("\n"),
      { mode: 0o700 },
    );

    const result = spawnSync("bash", [scriptPath], { encoding: "utf-8", timeout: 5000 });
    const preloadExists = fs.existsSync(preloadPath);
    const preloadMode = preloadExists ? (fs.statSync(preloadPath).mode & 0o777).toString(8) : "";
    const pluginRefreshLogExists = fs.existsSync(pluginRefreshLog);
    const pluginRefreshLogMode = pluginRefreshLogExists
      ? (fs.statSync(pluginRefreshLog).mode & 0o777).toString(8)
      : "";
    fs.rmSync(tmpDir, { recursive: true, force: true });
    return {
      result,
      preloadExists,
      preloadMode,
      preloadPath,
      pluginRefreshLogExists,
      pluginRefreshLogMode,
    };
  }

  it("emits provider readiness for successful Telegram Bot API startup probes", () => {
    const run = spawnSync(
      process.execPath,
      [
        "-e",
        `
const { EventEmitter } = require('node:events');
const https = require('node:https');
https.request = function () {
  const req = new EventEmitter();
  process.nextTick(() => req.emit('response', { statusCode: 200 }));
  return req;
};
${telegramDiagnosticsScript}
https.request('https://api.telegram.org/bot123456:SECRET/getMe');
https.request('https://api.telegram.org/bot123456:SECRET/getUpdates?offset=1');
setTimeout(() => {}, 5);
`,
      ],
      { encoding: "utf-8" },
    );

    expect(run.status).toBe(0);
    const readinessLines = run.stderr
      .split(/\r?\n/)
      .filter((line) => line.includes("provider ready"));
    expect(readinessLines).toHaveLength(1);
    expect(readinessLines[0]).toContain("inference.local");
    expect(readinessLines[0]).not.toContain("SECRET");
  });

  it("classifies Telegram Bot API auth rejections during startup probes", () => {
    const run = spawnSync(
      process.execPath,
      [
        "-e",
        `
const { EventEmitter } = require('node:events');
const https = require('node:https');
https.request = function () {
  const req = new EventEmitter();
  process.nextTick(() => req.emit('response', { statusCode: 401 }));
  return req;
};
${telegramDiagnosticsScript}
https.request('https://api.telegram.org/bot123456:SECRET/getMe');
https.request('https://api.telegram.org/bot123456:SECRET/getWebhookInfo');
setTimeout(() => {}, 5);
`,
      ],
      { encoding: "utf-8" },
    );

    expect(run.status).toBe(0);
    const rejectionLines = run.stderr
      .split(/\r?\n/)
      .filter((line) => line.includes("Bot API rejected startup probe"));
    expect(rejectionLines).toHaveLength(1);
    expect(rejectionLines[0]).toContain("HTTP 401");
    expect(rejectionLines[0]).not.toContain("SECRET");
  });

  it("classifies Telegram Bot API startup probe network failures and redacts token paths", () => {
    const run = spawnSync(
      process.execPath,
      [
        "-e",
        `
const { EventEmitter } = require('node:events');
const https = require('node:https');
https.request = function () {
  const req = new EventEmitter();
  process.nextTick(() => {
    const err = new Error('connect failed for /bot123456:SECRET/getMe');
    err.code = 'ECONNRESET';
    req.emit('error', err);
  });
  return req;
};
${telegramDiagnosticsScript}
https.request('https://api.telegram.org/bot123456:SECRET/getMe');
setTimeout(() => {}, 5);
`,
      ],
      { encoding: "utf-8" },
    );

    expect(run.status).toBe(0);
    expect(run.stderr).toContain("Bot API startup probe failed: ECONNRESET");
    expect(run.stderr).not.toContain("SECRET");
  });

  it("emits a Telegram credential-placeholder mismatch diagnostic without leaking token values", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-telegram-credential-"));
    const configPath = path.join(tmpDir, "openclaw.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        channels: {
          telegram: {
            accounts: {
              default: {
                botToken: "openshell:resolve:env:TELEGRAM_BOT_TOKEN",
              },
            },
          },
        },
      }),
    );
    try {
      const run = spawnSync(
        process.execPath,
        [
          "-e",
          `
${telegramDiagnosticsScript}
setTimeout(() => {}, 5);
`,
        ],
        {
          encoding: "utf-8",
          env: {
            ...process.env,
            OPENCLAW_CONFIG_PATH: configPath,
            TELEGRAM_BOT_TOKEN: "openshell:resolve:env:v42_TELEGRAM_BOT_TOKEN",
          },
        },
      );

      expect(run.status).toBe(0);
      expect(run.stderr).toContain("credential placeholder mismatch");
      expect(run.stderr).not.toContain("v42_TELEGRAM_BOT_TOKEN");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("emits inference diagnostics only after provider startup and redacts token values", () => {
    const run = spawnSync(
      process.execPath,
      [
        "-e",
        `
${telegramDiagnosticsScript}
process.stderr.write('LLM request failed: token=123456:BEFORE\\n');
process.stderr.write('[telegram] [default] starting provider\\n');
process.stderr.write('Embedded agent failed before reply: token=123456:AFTER\\n');
process.stderr.write('FailoverError: token=123456:LATER\\n');
`,
      ],
      { encoding: "utf-8" },
    );

    expect(run.status).toBe(0);
    const diagnosticLines = run.stderr
      .split(/\r?\n/)
      .filter((line) => line.includes("agent turn failed after provider startup"));
    expect(diagnosticLines).toHaveLength(1);
    expect(diagnosticLines[0]).toContain("Embedded agent failed before reply");
    expect(diagnosticLines[0]).toContain("token=<redacted>");
    expect(diagnosticLines[0]).not.toContain("AFTER");
    expect(diagnosticLines[0]).not.toContain("LATER");
  });

  it.each(["non-root", "root"] as const)(
    "installs and validates the diagnostics preload in both entrypoint paths before gateway launch [case %#]",
    (kind) => {
      const setup = runPreGatewaySetup(kind);
      expect(setup.result.status).toBe(0);
      expect(setup.preloadExists).toBe(true);
      expect(setup.preloadMode).toBe("444");
      expect(setup.result.stdout).toContain("ORDER:configure");
      expect(setup.result.stdout).toContain("VALIDATE:");
      expect(setup.result.stdout).toContain(setup.preloadPath);
      expect(setup.pluginRefreshLogExists).toBe(true);
      expect(setup.pluginRefreshLogMode).toBe("600");
    },
  );

  it("connect-shell rc sources the diagnostics preload when present", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-telegram-rc-"));
    const proxyEnv = path.join(tmpDir, "proxy-env.sh");
    const preloadPath = path.join(tmpDir, "telegram-diagnostics.js");
    const connectPreloadsPath = path.join(tmpDir, "connect-preloads.list");
    const scriptPath = path.join(tmpDir, "write-env.sh");
    const runtimeBlock = `${runtimeShellEnvBlock(src)}\nwrite_runtime_shell_env`.replaceAll(
      "/tmp/nemoclaw-proxy-env.sh",
      proxyEnv,
    );
    fs.writeFileSync(preloadPath, "// diagnostics\n");
    fs.writeFileSync(connectPreloadsPath, `${preloadPath}\n`);
    fs.writeFileSync(
      scriptPath,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        'emit_sandbox_sourced_file() { local target="$1"; cat > "$target"; chmod 444 "$target"; }',
        'PROXY_HOST="10.200.0.1"',
        'PROXY_PORT="3128"',
        '_PROXY_URL="http://${PROXY_HOST}:${PROXY_PORT}"',
        '_NO_PROXY_VAL="localhost,127.0.0.1,::1,${PROXY_HOST}"',
        `_SANDBOX_SAFETY_NET=${JSON.stringify(path.join(tmpDir, "safety.js"))}`,
        `_PROXY_FIX_SCRIPT=${JSON.stringify(path.join(tmpDir, "proxy-fix.js"))}`,
        `_NEMOTRON_FIX_SCRIPT=${JSON.stringify(path.join(tmpDir, "nemotron-fix.js"))}`,
        `_CIAO_GUARD_SCRIPT=${JSON.stringify(path.join(tmpDir, "ciao-guard.js"))}`,
        `_MESSAGING_CONNECT_PRELOADS_FILE=${JSON.stringify(connectPreloadsPath)}`,
        extractShellFunctionFromSource(src, "emit_messaging_connect_runtime_preload_exports"),
        "_TOOL_REDIRECTS=()",
        "set +u",
        runtimeBlock,
      ].join("\n"),
      { mode: 0o700 },
    );

    const sourceRuntimeEnv = () =>
      spawnSync(
        "bash",
        [
          "--noprofile",
          "--norc",
          "-c",
          `source ${JSON.stringify(proxyEnv)}; printf 'NODE_OPTIONS=%s\\n' "$NODE_OPTIONS"`,
        ],
        {
          encoding: "utf-8",
          env: { PATH: process.env.PATH || "", NODE_OPTIONS: "" },
          timeout: 5000,
        },
      );

    try {
      const write = spawnSync("bash", [scriptPath], { encoding: "utf-8", timeout: 5000 });
      expect(write.status).toBe(0);

      const withPreload = sourceRuntimeEnv();
      expect(withPreload.status).toBe(0);
      expect(withPreload.stdout).toContain(preloadPath);

      fs.rmSync(preloadPath, { force: true });
      const withoutPreload = sourceRuntimeEnv();
      expect(withoutPreload.status).toBe(0);
      expect(withoutPreload.stdout).not.toContain(preloadPath);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
