// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  CHANNEL_RUNTIME_SCRIPTS,
  encodeRuntimeSetupPlan,
  extractShellFunctionFromSource,
  messagingRuntimeSetupSection,
  OPENCLAW_PACKAGE,
  readOpenClawStartupSource,
  startScriptHeredoc,
} from "../helpers/startup-suite";

describe("Slack channel guard — unhandled-rejection safety net (#2340)", () => {
  const src = readOpenClawStartupSource();
  const extractGuardScript = () => startScriptHeredoc(src, "SLACK_GUARD_EOF");

  function runSlackGuardHarness(body: string): ReturnType<typeof spawnSync> {
    return spawnSync(
      process.execPath,
      [
        "-e",
        `process.env.OPENSHELL_SANDBOX = '1';
${extractGuardScript()}
${body}`,
      ],
      { encoding: "utf-8" },
    );
  }

  it("installs the guard only when Slack is configured", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-slack-guard-"));
    const sourcePrefix = path.join(tmpDir, "preloads") + path.sep;
    const guardSource = path.join(sourcePrefix, "slack-channel-guard.js");
    const guardPath = path.join(tmpDir, "slack-channel-guard.js");
    const planPath = path.join(tmpDir, "runtime-plan.json");
    const connectPreloadsPath = path.join(tmpDir, "connect-preloads.list");
    const scriptPath = path.join(tmpDir, "run.sh");
    fs.mkdirSync(sourcePrefix, { recursive: true });
    fs.copyFileSync(
      path.join(CHANNEL_RUNTIME_SCRIPTS, "slack", "runtime", "slack-channel-guard.ts"),
      guardSource,
    );
    const runtimeValue = {
      nodePreloads: [
        {
          source: guardSource,
          target: guardPath,
          injectInto: ["boot", "connect"],
          optional: false,
          installMessage:
            "[channels] Installing Slack channel guard (unhandled-rejection safety net)",
          installedMessage: "[channels] Slack channel guard installed (NODE_OPTIONS updated)",
        },
      ],
    };
    const run = (active: boolean) => {
      fs.rmSync(guardPath, { force: true });
      fs.rmSync(planPath, { force: true });
      fs.rmSync(connectPreloadsPath, { force: true });
      fs.writeFileSync(
        scriptPath,
        [
          "#!/usr/bin/env bash",
          "set -euo pipefail",
          'id() { if [ "${1:-}" = "-u" ]; then printf "1000"; else command id "$@"; fi; }',
          'emit_sandbox_sourced_file() { local target="$1"; cat > "$target"; chmod 444 "$target"; }',
          "NODE_OPTIONS='--require /already-loaded.js'",
          `export NEMOCLAW_MESSAGING_PLAN_B64=${JSON.stringify(encodeRuntimeSetupPlan("slack", runtimeValue, { active }))}`,
          messagingRuntimeSetupSection(src, {
            planPath,
            connectPreloadsPath,
            sourcePrefix,
            targetPrefix: tmpDir + path.sep,
          }),
          "write_messaging_runtime_setup_plan",
          "install_messaging_runtime_preloads",
          'printf "NODE_OPTIONS=%s\\n" "$NODE_OPTIONS"',
        ].join("\n"),
        { mode: 0o700 },
      );
      return spawnSync("bash", [scriptPath], { encoding: "utf-8", timeout: 5000 });
    };

    try {
      const noSlack = run(false);
      expect(noSlack.status).toBe(0);
      expect(fs.existsSync(guardPath)).toBe(false);
      expect(noSlack.stdout).not.toContain(guardPath);

      const withSlack = run(true);
      expect(withSlack.status).toBe(0);
      expect(fs.existsSync(guardPath)).toBe(true);
      expect((fs.statSync(guardPath).mode & 0o777).toString(8)).toBe("444");
      expect(withSlack.stdout).toContain("--require /already-loaded.js");
      expect(withSlack.stdout).toContain(`--require ${guardPath}`);
      expect(fs.readFileSync(connectPreloadsPath, "utf-8")).toContain(guardPath);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("catches uncaught exceptions from Slack (sync throws)", () => {
    const result = runSlackGuardHarness(`
process.emit('uncaughtException', new Error('An API error occurred: invalid_auth'));
setImmediate(function () { console.log('still-running'); });
`);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("still-running");
    expect(result.stderr).toContain("provider failed to start");
  });

  it("passes non-Slack failures through to later process handlers", () => {
    const result = runSlackGuardHarness(`
process.on('unhandledRejection', function () {
  console.log('downstream');
  process.exit(42);
});
process.emit('unhandledRejection', new Error('plain failure'), {});
`);
    expect(result.status).toBe(42);
    expect(result.stdout).toContain("downstream");
  });

  it("consumes Slack auth rejections before later fatal handlers see them", () => {
    const result = runSlackGuardHarness(`
let downstreamCalled = false;
process.on('unhandledRejection', function () {
  downstreamCalled = true;
  process.exit(42);
});
process.emit('unhandledRejection', new Error('An API error occurred: invalid_auth'), {});
setImmediate(function () {
  console.log('downstream=' + downstreamCalled);
});
`);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("downstream=false");
    expect(result.stderr).toContain("provider failed to start");
  });

  it("detects Slack errors by error code, message, stack trace, and domain", () => {
    const result = runSlackGuardHarness(`
const cases = [
  Object.assign(new Error('code path'), { code: 'slack_webapi_platform_error' }),
  new Error('token_revoked'),
  Object.assign(new Error('stack path'), { stack: 'at @slack/web-api' }),
  new Error('CONNECT failed for slack.com'),
  new Error('CONNECT failed for https://hooks.slack.com/services/T/B/C'),
];
for (const err of cases) process.emit('unhandledRejection', err, {});
setImmediate(function () { console.log('cases=' + cases.length); });
`);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("cases=5");
    expect((result.stderr.match(/provider failed to start/g) || []).length).toBe(5);
    expect(result.stderr).toContain("caught by safety net, gateway continues");
  });

  it("does not classify arbitrary hosts containing slack.com as Slack errors", () => {
    const result = runSlackGuardHarness(`
let downstreamCalled = false;
process.on('unhandledRejection', function () {
  downstreamCalled = true;
});
process.emit('unhandledRejection', new Error('CONNECT failed for https://slack.com.evil.example'), {});
setImmediate(function () {
  console.log('downstream=' + downstreamCalled);
});
`);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("downstream=true");
    expect(result.stderr).not.toContain("provider failed to start");
  });
});

describe("Slack secrets-on-disk tripwire (#2085)", () => {
  const src = readOpenClawStartupSource();

  it("refuses to serve when real Slack tokens leak to disk", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-slack-secret-"));
    const configPath = path.join(tmpDir, "openclaw.json");
    const planPath = path.join(tmpDir, "runtime-plan.json");
    const runtimeValue = {
      secretScans: [
        {
          path: configPath,
          pattern: "(?:xoxb|xapp)-(?!OPENSHELL-RESOLVE-ENV-)",
          message: "[SECURITY] Slack token leaked into {path} - refusing to serve",
          exitCode: 78,
        },
      ],
    };
    const scriptPath = path.join(tmpDir, "run.sh");
    const run = (config: string) => {
      fs.writeFileSync(configPath, config);
      fs.rmSync(planPath, { force: true });
      fs.writeFileSync(
        scriptPath,
        [
          "#!/usr/bin/env bash",
          "set -euo pipefail",
          'id() { if [ "${1:-}" = "-u" ]; then printf "1000"; else command id "$@"; fi; }',
          'emit_sandbox_sourced_file() { local target="$1"; cat > "$target"; chmod 444 "$target"; }',
          `export NEMOCLAW_MESSAGING_PLAN_B64=${JSON.stringify(encodeRuntimeSetupPlan("slack", runtimeValue))}`,
          messagingRuntimeSetupSection(src, {
            planPath,
            secretScanPrefix: tmpDir + path.sep,
          }),
          "write_messaging_runtime_setup_plan",
          "verify_messaging_runtime_secret_scans",
        ].join("\n"),
        { mode: 0o700 },
      );
      return spawnSync("bash", [scriptPath], { encoding: "utf-8", timeout: 5000 });
    };

    try {
      expect(run('{"botToken":"xoxb-real-token"}\n').status).toBe(78);
      expect(run('{"appToken":"xapp-real-token"}\n').status).toBe(78);
      expect(run('{"botToken":"xoxb-OPENSHELL-RESOLVE-ENV-SLACK_BOT_TOKEN"}\n').status).toBe(0);
      expect(run('{"token":"openshell:resolve:env:SLACK_BOT_TOKEN"}\n').status).toBe(0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("provider placeholder refresh (#4251)", () => {
  const src = readOpenClawStartupSource();

  function runRefresh(
    config: unknown,
    env: Record<string, string> = {},
  ): { config: any; hash: string; result: ReturnType<typeof spawnSync> } {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-provider-placeholders-"));
    const openclawDir = path.join(tmpDir, ".openclaw");
    const configPath = path.join(openclawDir, "openclaw.json");
    const fabricPath = path.join(openclawDir, "fabric.json");
    const hashPath = path.join(openclawDir, ".config-hash");
    const scriptPath = path.join(tmpDir, "run.sh");
    fs.mkdirSync(openclawDir, { recursive: true });
    fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
    fs.writeFileSync(fabricPath, "{}\n", { mode: 0o600 });
    const fn = extractShellFunctionFromSource(
      src,
      "refresh_openclaw_provider_placeholders",
    ).replaceAll("/sandbox/.openclaw", openclawDir);
    fs.writeFileSync(
      scriptPath,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail\nrefresh_openclaw_wechat_account_placeholder() { :; }",
        "openclaw_config_dir_owner() { echo sandbox; }",
        "prepare_openclaw_config_for_write() { :; }",
        "restore_openclaw_config_after_write() { :; }",
        fn,
        "refresh_openclaw_provider_placeholders",
      ].join("\n"),
      { mode: 0o700 },
    );
    const result = spawnSync("bash", [scriptPath], {
      encoding: "utf-8",
      env: { PATH: process.env.PATH || "", ...env },
      timeout: 5000,
    });
    const updatedConfig = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    const hash = fs.existsSync(hashPath) ? fs.readFileSync(hashPath, "utf-8") : "";
    fs.rmSync(tmpDir, { recursive: true, force: true });
    return { config: updatedConfig, hash, result };
  }

  function placeholderPlan(envKeys: string[]): string {
    return Buffer.from(
      JSON.stringify({
        credentialBindings: envKeys.map((envKey) => ({ providerEnvKey: envKey })),
      }),
    ).toString("base64");
  }

  it("rewrites Telegram canonical placeholders to OpenShell runtime-scoped placeholders", () => {
    const scoped = "openshell:resolve:env:v42_TELEGRAM_BOT_TOKEN";
    const run = runRefresh(
      {
        channels: {
          telegram: {
            accounts: {
              default: {
                botToken: "openshell:resolve:env:TELEGRAM_BOT_TOKEN",
              },
            },
          },
        },
      },
      { TELEGRAM_BOT_TOKEN: scoped },
    );

    expect(run.result.status, run.result.stderr).toBe(0);
    expect(run.config.channels.telegram.accounts.default.botToken).toBe(scoped);
    expect(run.hash).toContain("openclaw.json");
    expect(run.hash).toContain("fabric.json");
    expect(run.result.stderr).toContain(
      "Refreshed provider placeholders from OpenShell runtime env: TELEGRAM_BOT_TOKEN",
    );
    expect(run.result.stderr).not.toContain("v42_TELEGRAM_BOT_TOKEN");
  });

  it("does not write raw provider credentials into openclaw.json", () => {
    const run = runRefresh(
      {
        channels: {
          telegram: {
            accounts: {
              default: {
                botToken: "openshell:resolve:env:TELEGRAM_BOT_TOKEN",
              },
            },
          },
        },
      },
      { TELEGRAM_BOT_TOKEN: "123456:SECRET" },
    );

    expect(run.result.status, run.result.stderr).toBe(0);
    expect(run.config.channels.telegram.accounts.default.botToken).toBe(
      "openshell:resolve:env:TELEGRAM_BOT_TOKEN",
    );
    expect(JSON.stringify(run.config)).not.toContain("123456:SECRET");
    expect(run.result.stderr).toContain("refusing to write raw credentials");
  });

  it("warns when Telegram is configured but the runtime placeholder env is missing", () => {
    const run = runRefresh({
      channels: {
        telegram: {
          accounts: {
            default: {
              botToken: "openshell:resolve:env:TELEGRAM_BOT_TOKEN",
            },
          },
        },
      },
    });

    expect(run.result.status, run.result.stderr).toBe(0);
    expect(run.result.stderr).toContain(
      "telegram.default.botToken is an OpenShell placeholder but TELEGRAM_BOT_TOKEN is missing",
    );
  });

  it("warns when the Slack config alias is present but SLACK_BOT_TOKEN is missing", () => {
    const run = runRefresh({
      channels: {
        slack: {
          accounts: {
            default: {
              botToken: "xoxb-OPENSHELL-RESOLVE-ENV-SLACK_BOT_TOKEN",
              appToken: "xapp-OPENSHELL-RESOLVE-ENV-SLACK_APP_TOKEN",
            },
          },
        },
      },
    });

    expect(run.result.status, run.result.stderr).toBe(0);
    expect(run.result.stderr).toContain(
      "slack.default.botToken expects the SLACK_BOT_TOKEN provider placeholder but it is missing",
    );
    expect(run.result.stderr).toContain(
      "slack.default.appToken expects the SLACK_APP_TOKEN provider placeholder but it is missing",
    );
  });

  it("does not warn when the Slack config alias matches an OpenShell runtime placeholder", () => {
    const run = runRefresh(
      {
        channels: {
          slack: {
            accounts: {
              default: {
                botToken: "xoxb-OPENSHELL-RESOLVE-ENV-SLACK_BOT_TOKEN",
                appToken: "xapp-OPENSHELL-RESOLVE-ENV-SLACK_APP_TOKEN",
              },
            },
          },
        },
      },
      {
        SLACK_BOT_TOKEN: "openshell:resolve:env:v42_SLACK_BOT_TOKEN",
        SLACK_APP_TOKEN: "openshell:resolve:env:v42_SLACK_APP_TOKEN",
      },
    );

    expect(run.result.status, run.result.stderr).toBe(0);
    expect(run.result.stderr).not.toContain("slack.default");
    // The Bolt-compatible alias is never rewritten on disk; it does not match
    // the canonical "openshell:resolve:env:SLACK_BOT_TOKEN" placeholder key.
    expect(run.config.channels.slack.accounts.default.botToken).toBe(
      "xoxb-OPENSHELL-RESOLVE-ENV-SLACK_BOT_TOKEN",
    );
    expect(run.config.channels.slack.accounts.default.appToken).toBe(
      "xapp-OPENSHELL-RESOLVE-ENV-SLACK_APP_TOKEN",
    );
  });

  it("does not warn when the Slack runtime env holds a genuine xoxb-/xapp- token", () => {
    const run = runRefresh(
      {
        channels: {
          slack: {
            accounts: {
              default: {
                botToken: "xoxb-OPENSHELL-RESOLVE-ENV-SLACK_BOT_TOKEN",
                appToken: "xapp-OPENSHELL-RESOLVE-ENV-SLACK_APP_TOKEN",
              },
            },
          },
        },
      },
      {
        SLACK_BOT_TOKEN: "xoxb-1-real-bot-token",
        SLACK_APP_TOKEN: "xapp-1-real-app-token",
      },
    );

    expect(run.result.status, run.result.stderr).toBe(0);
    expect(run.result.stderr).not.toContain("slack.default");
    expect(JSON.stringify(run.config)).not.toContain("xoxb-1-real-bot-token");
  });

  it("warns when the Slack runtime env holds neither a placeholder nor a Slack token", () => {
    const run = runRefresh(
      {
        channels: {
          slack: {
            accounts: {
              default: {
                botToken: "xoxb-OPENSHELL-RESOLVE-ENV-SLACK_BOT_TOKEN",
              },
            },
          },
        },
      },
      { SLACK_BOT_TOKEN: "garbage-not-a-token" },
    );

    expect(run.result.status, run.result.stderr).toBe(0);
    expect(run.result.stderr).toContain(
      "slack.default.botToken runtime SLACK_BOT_TOKEN is neither the SLACK_BOT_TOKEN OpenShell placeholder nor a xoxb- token",
    );
  });

  it("warns when the Slack runtime env resolves a different key than expected", () => {
    // A placeholder for the wrong key must not look healthy — Bolt would still
    // inherit a non-Slack placeholder and fail at startup.
    const run = runRefresh(
      {
        channels: {
          slack: {
            accounts: {
              default: {
                botToken: "xoxb-OPENSHELL-RESOLVE-ENV-SLACK_BOT_TOKEN",
              },
            },
          },
        },
      },
      { SLACK_BOT_TOKEN: "openshell:resolve:env:v51_OTHER_KEY" },
    );

    expect(run.result.status, run.result.stderr).toBe(0);
    expect(run.result.stderr).toContain(
      "slack.default.botToken runtime SLACK_BOT_TOKEN is neither the SLACK_BOT_TOKEN OpenShell placeholder nor a xoxb- token",
    );
  });

  it("emits the deterministic accepted-extras breadcrumb so e2e harnesses can prove env-arg propagation", () => {
    const run = runRefresh(
      {
        channels: {
          telegram: {
            accounts: {
              default: { botToken: "openshell:resolve:env:TELEGRAM_BOT_TOKEN" },
            },
          },
        },
      },
      {
        NEMOCLAW_MESSAGING_PLAN_B64: placeholderPlan(["TELEGRAM_BOT_TOKEN", "SLACK_BOT_TOKEN"]),
        NEMOCLAW_EXTRA_PLACEHOLDER_KEYS: "TELEGRAM_BOT_TOKEN_AGENT_A SLACK_BOT_TOKEN_AGENT_B",
      },
    );

    expect(run.result.status, run.result.stderr).toBe(0);
    expect(run.result.stderr).toMatch(
      /\[config\] NEMOCLAW_EXTRA_PLACEHOLDER_KEYS accepted 2 entry\(ies\): TELEGRAM_BOT_TOKEN_AGENT_A SLACK_BOT_TOKEN_AGENT_B/,
    );
  });

  it("does not emit the accepted-extras breadcrumb when NEMOCLAW_EXTRA_PLACEHOLDER_KEYS is unset", () => {
    const run = runRefresh(
      {
        channels: {
          telegram: {
            accounts: {
              default: { botToken: "openshell:resolve:env:TELEGRAM_BOT_TOKEN" },
            },
          },
        },
      },
      {},
    );

    expect(run.result.status, run.result.stderr).toBe(0);
    expect(run.result.stderr).not.toContain("[config] NEMOCLAW_EXTRA_PLACEHOLDER_KEYS accepted");
  });

  it("splits NEMOCLAW_EXTRA_PLACEHOLDER_KEYS on commas the same way as whitespace", () => {
    const scopedA = "openshell:resolve:env:v42_TELEGRAM_BOT_TOKEN_AGENT_A";
    const scopedB = "openshell:resolve:env:v42_TELEGRAM_BOT_TOKEN_AGENT_B";
    const run = runRefresh(
      {
        channels: {
          telegram: {
            accounts: {
              a: { botToken: "openshell:resolve:env:TELEGRAM_BOT_TOKEN_AGENT_A" },
              b: { botToken: "openshell:resolve:env:TELEGRAM_BOT_TOKEN_AGENT_B" },
            },
          },
        },
      },
      {
        // Comma- and whitespace-mixed input — the bash for-loop only splits on
        // default IFS (whitespace), so without the comma->space normalization
        // both keys would arrive concatenated as a single token and fail the
        // regex check.
        NEMOCLAW_EXTRA_PLACEHOLDER_KEYS: "TELEGRAM_BOT_TOKEN_AGENT_A,TELEGRAM_BOT_TOKEN_AGENT_B",
        TELEGRAM_BOT_TOKEN_AGENT_A: scopedA,
        TELEGRAM_BOT_TOKEN_AGENT_B: scopedB,
      },
    );

    expect(run.result.status, run.result.stderr).toBe(0);
    expect(run.config.channels.telegram.accounts.a.botToken).toBe(scopedA);
    expect(run.config.channels.telegram.accounts.b.botToken).toBe(scopedB);
    expect(run.result.stderr).toContain(
      "Refreshed provider placeholders from OpenShell runtime env: TELEGRAM_BOT_TOKEN_AGENT_A,TELEGRAM_BOT_TOKEN_AGENT_B",
    );
  });

  it("revision-collapses NEMOCLAW_EXTRA_PLACEHOLDER_KEYS entries the same way as canonical keys", () => {
    const scoped = "openshell:resolve:env:v42_TELEGRAM_BOT_TOKEN_AGENT_A";
    const run = runRefresh(
      {
        channels: {
          telegram: {
            accounts: {
              default: {
                botToken: "openshell:resolve:env:TELEGRAM_BOT_TOKEN_AGENT_A",
              },
            },
          },
        },
      },
      {
        NEMOCLAW_EXTRA_PLACEHOLDER_KEYS: "TELEGRAM_BOT_TOKEN_AGENT_A",
        TELEGRAM_BOT_TOKEN_AGENT_A: scoped,
      },
    );

    expect(run.result.status, run.result.stderr).toBe(0);
    expect(run.config.channels.telegram.accounts.default.botToken).toBe(scoped);
    expect(run.result.stderr).toContain(
      "Refreshed provider placeholders from OpenShell runtime env: TELEGRAM_BOT_TOKEN_AGENT_A",
    );
  });

  it("does not let canonical TELEGRAM_BOT_TOKEN rewrite the suffixed extra placeholder", () => {
    // Pre-fix bug: the python rewrite did `if old in value: value.replace(old, new)`,
    // so the canonical replacement for `openshell:resolve:env:TELEGRAM_BOT_TOKEN`
    // greedily rewrote the prefix of `openshell:resolve:env:TELEGRAM_BOT_TOKEN_AGENT_A`,
    // routing the per-profile placeholder to the wrong canonical revision and
    // making rotation of an extra key unsafe. The grammar-aware regex now
    // matches each placeholder as an exact token only.
    const canonicalScoped = "openshell:resolve:env:v42_TELEGRAM_BOT_TOKEN";
    const extraScoped = "openshell:resolve:env:v51_TELEGRAM_BOT_TOKEN_AGENT_A";
    const run = runRefresh(
      {
        channels: {
          telegram: {
            accounts: {
              default: { botToken: "openshell:resolve:env:TELEGRAM_BOT_TOKEN" },
              agentA: { botToken: "openshell:resolve:env:TELEGRAM_BOT_TOKEN_AGENT_A" },
            },
          },
        },
      },
      {
        TELEGRAM_BOT_TOKEN: canonicalScoped,
        NEMOCLAW_EXTRA_PLACEHOLDER_KEYS: "TELEGRAM_BOT_TOKEN_AGENT_A",
        TELEGRAM_BOT_TOKEN_AGENT_A: extraScoped,
      },
    );

    expect(run.result.status, run.result.stderr).toBe(0);
    expect(run.config.channels.telegram.accounts.default.botToken).toBe(canonicalScoped);
    expect(run.config.channels.telegram.accounts.agentA.botToken).toBe(extraScoped);
  });

  it("leaves the suffixed extra placeholder unchanged when only the canonical revision is set", () => {
    // Companion to the canonical-vs-extra collision test: when the operator
    // staged a revision for TELEGRAM_BOT_TOKEN but not for the extra key,
    // the extra placeholder must stay on its canonical form rather than be
    // partially rewritten by the prefix replacement.
    const canonicalScoped = "openshell:resolve:env:v42_TELEGRAM_BOT_TOKEN";
    const run = runRefresh(
      {
        channels: {
          telegram: {
            accounts: {
              default: { botToken: "openshell:resolve:env:TELEGRAM_BOT_TOKEN" },
              agentA: { botToken: "openshell:resolve:env:TELEGRAM_BOT_TOKEN_AGENT_A" },
            },
          },
        },
      },
      {
        TELEGRAM_BOT_TOKEN: canonicalScoped,
        NEMOCLAW_EXTRA_PLACEHOLDER_KEYS: "TELEGRAM_BOT_TOKEN_AGENT_A",
      },
    );

    expect(run.result.status, run.result.stderr).toBe(0);
    expect(run.config.channels.telegram.accounts.default.botToken).toBe(canonicalScoped);
    expect(run.config.channels.telegram.accounts.agentA.botToken).toBe(
      "openshell:resolve:env:TELEGRAM_BOT_TOKEN_AGENT_A",
    );
  });

  it("rejects malformed and canonical-collision NEMOCLAW_EXTRA_PLACEHOLDER_KEYS entries without faulting", () => {
    const run = runRefresh(
      {
        channels: {
          telegram: {
            accounts: {
              default: {
                botToken: "openshell:resolve:env:TELEGRAM_BOT_TOKEN",
              },
            },
          },
        },
      },
      {
        TELEGRAM_BOT_TOKEN: "openshell:resolve:env:v42_TELEGRAM_BOT_TOKEN",
        NEMOCLAW_EXTRA_PLACEHOLDER_KEYS:
          "telegram_bot_token 9NUM_START Path$Bad TELEGRAM_BOT_TOKEN TELEGRAM_BOT_TOKEN_VALID",
      },
    );

    expect(run.result.status, run.result.stderr).toBe(0);
    expect(run.result.stderr).toContain(
      "[config] Ignoring NEMOCLAW_EXTRA_PLACEHOLDER_KEYS entry 'telegram_bot_token'",
    );
    expect(run.result.stderr).toContain(
      "[config] Ignoring NEMOCLAW_EXTRA_PLACEHOLDER_KEYS entry '9NUM_START'",
    );
    expect(run.result.stderr).toContain(
      "[config] Ignoring NEMOCLAW_EXTRA_PLACEHOLDER_KEYS entry 'Path$Bad'",
    );
    // Canonical-collision tokens are filtered silently by the case statement.
    expect(run.result.stderr).not.toContain(
      "[config] Ignoring NEMOCLAW_EXTRA_PLACEHOLDER_KEYS entry 'TELEGRAM_BOT_TOKEN'",
    );
    // The canonical-key revision-collapse still runs end-to-end.
    expect(run.config.channels.telegram.accounts.default.botToken).toBe(
      "openshell:resolve:env:v42_TELEGRAM_BOT_TOKEN",
    );
  });

  it.each([
    "GITHUB_TOKEN",
    "AWS_SECRET_ACCESS_KEY",
    "NPM_TOKEN",
    "KUBECONFIG",
    "NEMOCLAW_EXTRA_PLACEHOLDER_KEYS",
  ])(
    "refuses arbitrary host secret names that do not extend a discovered provider envKey inside the sandbox [%s]",
    (blocked) => {
      // Defence-in-depth: even if an operator clobbers NEMOCLAW_EXTRA_PLACEHOLDER_KEYS
      // inside a running sandbox after the host-side parser already filtered it,
      // the container-side refresh helper must mirror the host's canonical-prefix
      // restriction so a noncanonical name such as GITHUB_TOKEN never reaches the
      // python placeholder walker.
      const run = runRefresh(
        {
          channels: {
            telegram: {
              accounts: {
                default: {
                  botToken: "openshell:resolve:env:TELEGRAM_BOT_TOKEN",
                },
              },
            },
          },
        },
        {
          TELEGRAM_BOT_TOKEN: "openshell:resolve:env:v42_TELEGRAM_BOT_TOKEN",
          NEMOCLAW_EXTRA_PLACEHOLDER_KEYS:
            "GITHUB_TOKEN AWS_SECRET_ACCESS_KEY NPM_TOKEN KUBECONFIG NEMOCLAW_EXTRA_PLACEHOLDER_KEYS TELEGRAM_BOT_TOKEN_KEPT",
          // Stage host secrets that would leak if the bash refresh ever
          // accepted their names. The assertion below confirms none of these
          // values appear in any output produced by the python heredoc.
          GITHUB_TOKEN: "ghp-host-secret-would-leak",
          AWS_SECRET_ACCESS_KEY: "aws-host-secret-would-leak",
          NPM_TOKEN: "npm-host-secret-would-leak",
          KUBECONFIG: "/host/path/would-leak",
        },
      );

      expect(run.result.status, run.result.stderr).toBe(0);

      expect(run.result.stderr).toContain(
        `[config] Ignoring NEMOCLAW_EXTRA_PLACEHOLDER_KEYS entry '${blocked}' — must extend a discovered provider envKey such as TELEGRAM_BOT_TOKEN_<suffix>`,
      );

      expect(run.result.stderr).not.toContain(
        "[config] Ignoring NEMOCLAW_EXTRA_PLACEHOLDER_KEYS entry 'TELEGRAM_BOT_TOKEN_KEPT'",
      );
      // None of the staged host secret values should reach any stdout/stderr
      // line the python heredoc emits, because their names were rejected before
      // the heredoc ran.
      expect(run.result.stderr).not.toContain("ghp-host-secret-would-leak");
      expect(run.result.stderr).not.toContain("aws-host-secret-would-leak");
      expect(run.result.stderr).not.toContain("npm-host-secret-would-leak");
      expect(run.result.stdout).not.toContain("ghp-host-secret-would-leak");
      expect(run.result.stdout).not.toContain("aws-host-secret-would-leak");
      expect(run.result.stdout).not.toContain("npm-host-secret-would-leak");
      expect(JSON.stringify(run.config)).not.toContain("ghp-host-secret-would-leak");
      expect(JSON.stringify(run.config)).not.toContain("aws-host-secret-would-leak");
    },
  );

  it("accepts every manifest credential envKey from the messaging plan as an extension prefix", () => {
    // Behavioural parity guard: the in-container parser should not hardcode
    // channel env keys. It consumes the messaging plan's credentialBindings,
    // then accepts per-profile extensions for those discovered keys.
    // For each TypeScript-derived canonical envKey, plant a `<KEY>_PARITY`
    // extension and assert that the bash refresh accepts and revision-
    // collapses it. Drift in either direction (new channel added but bash
    // not updated, or bash list shrunk) breaks one of the two assertions.
    const distPath = path.join(
      OPENCLAW_PACKAGE,
      "..",
      "..",
      "src",
      "lib",
      "onboard",
      "extra-placeholder-keys.ts",
    );
    const { canonicalPlaceholderKeys } = require(distPath);
    const canonicalKeys: string[] = Array.from(canonicalPlaceholderKeys()).sort();
    expect(canonicalKeys.length).toBeGreaterThan(0);

    canonicalKeys.forEach((canonical) => {
      const extension = `${canonical}_PARITY`;
      const scoped = `openshell:resolve:env:v77_${extension}`;
      const run = runRefresh(
        {
          channels: {
            telegram: {
              accounts: {
                parity: { botToken: `openshell:resolve:env:${extension}` },
              },
            },
          },
        },
        {
          NEMOCLAW_MESSAGING_PLAN_B64: placeholderPlan([canonical]),
          NEMOCLAW_EXTRA_PLACEHOLDER_KEYS: extension,
          [extension]: scoped,
        },
      );

      expect(run.result.status, run.result.stderr).toBe(0);
      expect(
        run.result.stderr,
        `bash refresh refused manifest credential extension '${extension}'`,
      ).not.toContain(`[config] Ignoring NEMOCLAW_EXTRA_PLACEHOLDER_KEYS entry '${extension}'`);
      expect(run.config.channels.telegram.accounts.parity.botToken).toBe(scoped);
    });
  });

  it("caps NEMOCLAW_EXTRA_PLACEHOLDER_KEYS at 32 entries inside the sandbox", () => {
    // 33 fillers in the list, all extending TELEGRAM_BOT_TOKEN_, all valid
    // canonical extensions. The cap should accept the first 32 (indices
    // 0..31) and reject the 33rd entry (index 32, named ..._FILLER_32),
    // which is also the beyondCap placeholder we plant in openclaw.json.
    const tokens = Array.from({ length: 33 }, (_, i) => `TELEGRAM_BOT_TOKEN_FILLER_${i}`);
    const beyondCap = tokens[32];
    const beyondCapScoped = `openshell:resolve:env:v42_${beyondCap}`;
    const env: Record<string, string> = {
      NEMOCLAW_EXTRA_PLACEHOLDER_KEYS: tokens.join(" "),
      // Stage a revision-scoped placeholder ONLY for the beyondCap entry.
      // If the cap is a no-op, the python heredoc would iterate beyondCap
      // and collapse the canonical placeholder in openclaw.json to the
      // v42_-scoped form. With the cap working, beyondCap stays out of
      // the keys list, so the rewrite never runs.
      [beyondCap]: beyondCapScoped,
      // Deliberately leave TELEGRAM_BOT_TOKEN / DISCORD_BOT_TOKEN / etc.
      // unset so no canonical replacement is added; that sidesteps the
      // python heredoc's substring-match path which would otherwise let a
      // shorter canonical replacement bleed into beyondCap regardless of
      // the cap state.
    };
    const run = runRefresh(
      {
        channels: {
          telegram: {
            accounts: {
              default: {
                botToken: "openshell:resolve:env:TELEGRAM_BOT_TOKEN",
              },
              beyondCap: {
                botToken: `openshell:resolve:env:${beyondCap}`,
              },
            },
          },
        },
      },
      env,
    );

    expect(run.result.status, run.result.stderr).toBe(0);
    expect(run.result.stderr).toContain(
      "[config] NEMOCLAW_EXTRA_PLACEHOLDER_KEYS: capped at 32 entries; ignoring remainder",
    );
    // The beyondCap key must not be processed by the python heredoc, so the
    // beyondCap canonical placeholder must stay unchanged on disk.
    expect(run.config.channels.telegram.accounts.beyondCap.botToken).toBe(
      `openshell:resolve:env:${beyondCap}`,
    );
    expect(run.result.stderr).not.toContain(
      `Refreshed provider placeholders from OpenShell runtime env: ${beyondCap}`,
    );
    expect(run.result.stdout).not.toContain(beyondCapScoped);
  });
});
