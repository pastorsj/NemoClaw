// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { readOpenClawStartupSource } from "../helpers/startup";

// The connect-session NODE_OPTIONS wiring (and the openclaw() guard injection)
// is exercised behaviorally rather than by asserting on source text: the guard
// describe-block below executes the extracted openclaw() function and checks the
// --require injection, and the end-to-end renderer E2E
// (test/e2e/live/whatsapp-qr-compact.test.ts) plus the
// messaging-providers Vitest coverage prove the wired preload actually shrinks
// the QR.

// Extract the sandbox-side `openclaw()` guard function from the single-quoted
// heredoc so we can exercise the WhatsApp login branch without a live sandbox.
function extractGuardFunction(src: string): string {
  const begin = src.indexOf("# nemoclaw-configure-guard begin");
  const end = src.indexOf("# nemoclaw-configure-guard end");
  if (begin === -1 || end === -1 || end <= begin) {
    throw new Error(
      "Expected nemoclaw-configure-guard markers in packages/nemoclaw-openclaw/start.sh",
    );
  }
  return src.slice(begin, end);
}

describe("WhatsApp pairing guard (channels login --channel whatsapp)", () => {
  const src = readOpenClawStartupSource();
  const guard = extractGuardFunction(src);

  function runGuard(
    args: string[],
    opts: {
      gatewayUrl?: string;
      gatewayToken?: string;
      insecurePublicWs?: string;
      privateGatewayUrl?: string;
      insecurePrivateWs?: string;
      preloadPresent?: boolean;
      fakeExit?: number;
      runPrivateGatewayControl?: boolean;
      shell?: "bash" | "/bin/sh";
      poisonShellFunctions?: readonly ("[" | "command" | "echo" | "exit" | "return")[];
    },
  ): { status: number; stdout: string; stderr: string; preloadPath: string } {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-wa-guard-"));
    try {
      // Fake `openclaw` binary on PATH so the absolute env dispatch resolves to it.
      const binDir = path.join(tempDir, "bin");
      fs.mkdirSync(binDir);
      const fakeOpenclaw = path.join(binDir, "openclaw");
      fs.writeFileSync(
        fakeOpenclaw,
        [
          "#!/usr/bin/env bash",
          'echo "FAKE_OPENCLAW_ARGS=$*"',
          'echo "FAKE_OPENCLAW_NODE_OPTIONS=${NODE_OPTIONS:-}"',
          'echo "FAKE_OPENCLAW_GATEWAY_URL=${OPENCLAW_GATEWAY_URL:-unset}"',
          'echo "FAKE_OPENCLAW_INSECURE_WS=${OPENCLAW_ALLOW_INSECURE_PRIVATE_WS:-unset}"',
          'echo "FAKE_OPENCLAW_TOKEN=${OPENCLAW_GATEWAY_TOKEN:-unset}"',
          'case "$*" in',
          '  "channels login --channel whatsapp" | "channels login --channel=whatsapp")',
          '    echo "POSTPAIR_RPC=channels.start"',
          '    case "${OPENCLAW_GATEWAY_URL:-}" in',
          "      ws://10.200.0.2:*)",
          '        echo "POSTPAIR_ERROR=missing scope: operator.admin" >&2',
          '        echo "CHANNEL_STATE=stopped"',
          "        exit 13",
          "        ;;",
          '      *) echo "CHANNEL_STATE=running" ;;',
          "    esac",
          "    ;;",
          "esac",
          `exit ${opts.fakeExit ?? 0}`,
        ].join("\n"),
        { mode: 0o755 },
      );

      const preloadPath = path.join(tempDir, "nemoclaw-whatsapp-qr-compact.js");
      if (opts.preloadPresent) fs.writeFileSync(preloadPath, "// stub preload\n");
      const connectPreloadsPath = path.join(tempDir, "nemoclaw-messaging-connect-preloads.list");
      if (opts.preloadPresent) fs.writeFileSync(connectPreloadsPath, `${preloadPath}\n`);

      // The guard body hardcodes literal /tmp paths (single-quoted heredoc);
      // redirect them to temp files for the test.
      const guardBody = guard
        .replaceAll("/tmp/nemoclaw-whatsapp-qr-compact.js", preloadPath)
        .replaceAll("/tmp/nemoclaw-messaging-connect-preloads.list", connectPreloadsPath);

      const wrapperLines = [
        "#!/usr/bin/env bash",
        `export PATH=${JSON.stringify(binDir)}:\"$PATH\"`,
      ];
      if (opts.gatewayUrl !== undefined) {
        wrapperLines.push(`export OPENCLAW_GATEWAY_URL=${JSON.stringify(opts.gatewayUrl)}`);
      } else {
        wrapperLines.push("unset OPENCLAW_GATEWAY_URL");
      }
      wrapperLines.push(
        opts.gatewayToken !== undefined
          ? `export OPENCLAW_GATEWAY_TOKEN=${JSON.stringify(opts.gatewayToken)}`
          : "unset OPENCLAW_GATEWAY_TOKEN",
      );
      wrapperLines.push(
        opts.insecurePublicWs !== undefined
          ? `export OPENCLAW_ALLOW_INSECURE_PRIVATE_WS=${JSON.stringify(opts.insecurePublicWs)}`
          : "unset OPENCLAW_ALLOW_INSECURE_PRIVATE_WS",
        opts.privateGatewayUrl !== undefined
          ? `export NEMOCLAW_OPENCLAW_GATEWAY_URL=${JSON.stringify(opts.privateGatewayUrl)}`
          : "unset NEMOCLAW_OPENCLAW_GATEWAY_URL",
        opts.insecurePrivateWs !== undefined
          ? `export NEMOCLAW_OPENCLAW_ALLOW_INSECURE_PRIVATE_WS=${JSON.stringify(opts.insecurePrivateWs)}`
          : "unset NEMOCLAW_OPENCLAW_ALLOW_INSECURE_PRIVATE_WS",
      );
      wrapperLines.push(
        guardBody,
        `openclaw ${args.map((a) => JSON.stringify(a)).join(" ")}`,
        'echo "GUARD_EXIT=$?"',
        ...(opts.runPrivateGatewayControl
          ? [
              'echo "PRIVATE_CONTROL_BEGIN"',
              'OPENCLAW_GATEWAY_URL="$NEMOCLAW_OPENCLAW_GATEWAY_URL" /usr/bin/env openclaw channels login --channel whatsapp',
              'echo "PRIVATE_CONTROL_EXIT=$?"',
            ]
          : []),
      );
      const wrapperPath = path.join(tempDir, "run.sh");
      fs.writeFileSync(wrapperPath, wrapperLines.join("\n"), { mode: 0o700 });

      const poisonedFunctions = new Set(opts.poisonShellFunctions ?? []);
      const poisonEnv = {
        ...(poisonedFunctions.has("[") ? { "BASH_FUNC_[%%": "() { /usr/bin/false; }" } : {}),
        ...(poisonedFunctions.has("command")
          ? { "BASH_FUNC_command%%": "() { printf 'POISON_COMMAND_USED\\n'; }" }
          : {}),
        ...(poisonedFunctions.has("echo")
          ? {
              "BASH_FUNC_echo%%":
                '() { _nemoclaw_whatsapp_gateway_url="ws://127.0.0.1:1@evil.example.test"; builtin echo "$@"; }',
            }
          : {}),
        ...(poisonedFunctions.has("exit")
          ? { "BASH_FUNC_exit%%": "() { printf 'POISON_EXIT_USED\\n'; }" }
          : {}),
        ...(poisonedFunctions.has("return") ? { "BASH_FUNC_return%%": "() { :; }" } : {}),
      };
      const r = spawnSync(opts.shell ?? "bash", [wrapperPath], {
        encoding: "utf-8",
        env: { ...process.env, ...poisonEnv },
        timeout: 10000,
      });
      return {
        status: r.status ?? -1,
        stdout: r.stdout ?? "",
        stderr: r.stderr ?? "",
        preloadPath,
      };
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }

  it("blocks login for non-WhatsApp channels", () => {
    const r = runGuard(["channels", "login", "--channel", "telegram"], {
      gatewayUrl: "ws://127.0.0.1:8080",
    });
    expect(r.stderr).toContain("only supported inside the sandbox for WhatsApp");
    expect(r.stdout).toContain("GUARD_EXIT=1");
    expect(r.stdout).not.toContain("FAKE_OPENCLAW_ARGS");
  });

  it("keeps the native post-pair channel running via loopback config resolution (#6413)", () => {
    const r = runGuard(["channels", "login", "--channel", "whatsapp"], {
      privateGatewayUrl: "ws://10.200.0.2:18790",
      preloadPresent: true,
      runPrivateGatewayControl: true,
    });
    expect(r.stderr).toContain("Pairing via the in-sandbox gateway (loopback)");
    expect(r.stdout).toContain("FAKE_OPENCLAW_ARGS=channels login --channel whatsapp");
    // No URL in the environment: OpenClaw resolves ws://127.0.0.1:<port> from
    // its own config, keeping the pairing origin local so operator scopes
    // survive the post-pair channels.start restart.
    expect(r.stdout).toContain("FAKE_OPENCLAW_GATEWAY_URL=unset");
    expect(r.stdout).toContain("FAKE_OPENCLAW_INSECURE_WS=unset");
    expect(r.stdout).toContain("POSTPAIR_RPC=channels.start");
    expect(r.stdout).toContain("CHANNEL_STATE=running");
    expect(r.stdout).toContain("GUARD_EXIT=0");
    // Control: the same fake upstream boundary models OpenClaw's known
    // private-veth locality behavior. Re-injecting NemoClaw's stashed URL
    // strips operator.admin from the native post-pair channels.start call and
    // leaves the channel stopped.
    expect(r.stdout).toMatch(
      /PRIVATE_CONTROL_BEGIN[\s\S]*FAKE_OPENCLAW_GATEWAY_URL=ws:\/\/10\.200\.0\.2:18790[\s\S]*POSTPAIR_RPC=channels\.start[\s\S]*CHANNEL_STATE=stopped[\s\S]*PRIVATE_CONTROL_EXIT=13/,
    );
    expect(r.stderr).toContain("POSTPAIR_ERROR=missing scope: operator.admin");
  });

  it("preserves handled WhatsApp statuses when sourced by POSIX sh (#6413)", () => {
    const failedLogin = runGuard(["channels", "login", "--channel", "whatsapp"], {
      fakeExit: 7,
      preloadPresent: true,
      shell: "/bin/sh",
    });
    expect(failedLogin.stdout).toContain("FAKE_OPENCLAW_ARGS=channels login --channel whatsapp");
    expect(failedLogin.stdout).toContain("GUARD_EXIT=7");
    expect(failedLogin.stderr).not.toContain("builtin");

    const rejectedUrl = runGuard(["channels", "login", "--channel", "whatsapp"], {
      gatewayUrl: "wss://attacker.example.test:443",
      gatewayToken: "guard-secret-token",
      preloadPresent: true,
      shell: "/bin/sh",
    });
    expect(rejectedUrl.stdout).toContain("GUARD_EXIT=1");
    expect(rejectedUrl.stdout).not.toContain("FAKE_OPENCLAW_ARGS");
    expect(`${rejectedUrl.stdout}\n${rejectedUrl.stderr}`).not.toContain("guard-secret-token");
    expect(rejectedUrl.stderr).not.toContain("builtin");
  });

  it.each(["foo", "http://127.0.0.1:18789", "127.0.0.1:18789"])(
    "refuses to pair when OPENCLAW_GATEWAY_URL is not a ws:// URL (%s)",
    (badUrl) => {
      const r = runGuard(["channels", "login", "--channel", "whatsapp"], {
        gatewayUrl: badUrl,
        preloadPresent: true,
      });
      expect(r.stderr).toContain("is not a ws:// gateway URL");
      expect(r.stdout).toContain("GUARD_EXIT=1");
      expect(r.stdout).not.toContain("FAKE_OPENCLAW_ARGS");
      expect(`${r.stdout}\n${r.stderr}`).not.toContain(badUrl);
    },
  );

  it.each([
    "ws://127.0.0.1:18789",
    "wss://localhost:443",
    "ws://[::1]:18789",
    "ws://127.0.0.1:18789/path?token=loopback-secret#fragment",
  ])("accepts loopback ws:// and wss:// gateway URL overrides (%s)", (goodUrl) => {
    const r = runGuard(["channels", "login", "--channel", "whatsapp"], {
      gatewayUrl: goodUrl,
      preloadPresent: true,
    });
    expect(r.stdout).toContain("FAKE_OPENCLAW_ARGS=channels login --channel whatsapp");
    expect(r.stdout).toContain(`FAKE_OPENCLAW_GATEWAY_URL=${goodUrl}`);
    expect(r.stdout).toContain("GUARD_EXIT=0");
    expect(r.stderr).not.toContain(goodUrl);
    expect(r.stderr).not.toContain("loopback-secret");
  });

  it.each([
    "wss://attacker.example.test:443",
    "ws://10.200.0.2:18790",
    "ws://gateway.internal:18789",
    "ws://127.0.0.1.evil.example:18789",
    "ws://localhost.evil.example:18789",
  ])(
    "fails closed on a non-loopback gateway URL override without invoking openclaw (%s)",
    (badUrl) => {
      const r = runGuard(["channels", "login", "--channel", "whatsapp"], {
        gatewayUrl: badUrl,
        gatewayToken: "guard-secret-token",
        preloadPresent: true,
      });
      expect(r.stderr).toContain("is not a loopback gateway URL");
      expect(r.stdout).toContain("GUARD_EXIT=1");
      // The child never runs, so the connect-shell gateway token is never
      // presented to the caller-selected endpoint.
      expect(r.stdout).not.toContain("FAKE_OPENCLAW_ARGS");
      expect(r.stdout).not.toContain("FAKE_OPENCLAW_TOKEN");
      expect(`${r.stdout}\n${r.stderr}`).not.toContain("guard-secret-token");
      expect(`${r.stdout}\n${r.stderr}`).not.toContain(badUrl);
    },
  );

  it("fails closed on a non-loopback URL when an imported function shadows the bracket builtin", () => {
    const r = runGuard(["channels", "login", "--channel=whatsapp"], {
      gatewayUrl: "wss://attacker.example.test:443",
      gatewayToken: "guard-secret-token",
      poisonShellFunctions: ["["],
      preloadPresent: true,
    });
    expect(r.stderr).toContain("is not a loopback gateway URL");
    expect(r.stdout).toContain("GUARD_EXIT=1");
    expect(r.stdout).not.toContain("FAKE_OPENCLAW_ARGS");
    expect(r.stdout).not.toContain("FAKE_OPENCLAW_TOKEN");
    expect(r.stdout).not.toContain("POISON_COMMAND_USED");
    expect(`${r.stdout}\n${r.stderr}`).not.toContain("guard-secret-token");
  });

  it("cannot continue into token-bearing dispatch when an imported function shadows return", () => {
    const r = runGuard(["channels", "login", "--channel", "whatsapp"], {
      gatewayUrl: "wss://attacker.example.test:443",
      gatewayToken: "guard-secret-token",
      poisonShellFunctions: ["exit", "return"],
      preloadPresent: true,
    });
    expect(r.stderr).toContain("is not a loopback gateway URL");
    expect(r.stdout).toContain("GUARD_EXIT=1");
    expect(r.stdout).not.toContain("FAKE_OPENCLAW_ARGS");
    expect(r.stdout).not.toContain("FAKE_OPENCLAW_TOKEN");
    expect(`${r.stdout}\n${r.stderr}`).not.toContain("guard-secret-token");
  });

  it("revalidates the loopback destination after an imported echo mutates it (#6413)", () => {
    const r = runGuard(["channels", "login", "--channel", "whatsapp"], {
      gatewayToken: "guard-secret-token",
      poisonShellFunctions: ["echo"],
      preloadPresent: true,
    });
    expect(r.stderr).toContain("gateway URL changed after validation");
    expect(r.stdout).toContain("GUARD_EXIT=1");
    expect(r.stdout).not.toContain("FAKE_OPENCLAW_ARGS");
    expect(r.stdout).not.toContain("FAKE_OPENCLAW_TOKEN");
    expect(`${r.stdout}\n${r.stderr}`).not.toContain("guard-secret-token");
  });

  it("bypasses a shadowed command function for a validated loopback URL", () => {
    const r = runGuard(["channels", "login", "--channel=whatsapp"], {
      gatewayUrl: "ws://127.0.0.1:18789",
      gatewayToken: "guard-secret-token",
      poisonShellFunctions: ["command"],
      preloadPresent: true,
    });
    expect(r.stdout).toContain("FAKE_OPENCLAW_ARGS=channels login --channel=whatsapp");
    expect(r.stdout).toContain("FAKE_OPENCLAW_GATEWAY_URL=ws://127.0.0.1:18789");
    expect(r.stdout).toContain("FAKE_OPENCLAW_TOKEN=guard-secret-token");
    expect(r.stdout).not.toContain("POISON_COMMAND_USED");
  });

  it.each([
    "ws://127.0.0.1:1@evil.example",
    "wss://127.0.0.1:1@evil.example",
    "ws://localhost:1@evil.example",
    "ws://[::1]:1@evil.example",
  ])(
    "fails closed on a loopback-prefixed userinfo gateway URL without invoking openclaw (%s)",
    (badUrl) => {
      // The loopback host is userinfo, not the real host: the WHATWG URL
      // parser reads `127.0.0.1:1` as user:password and connects to
      // `evil.example`, so a raw ws://127.0.0.1:* prefix match would leak the
      // gateway token to a non-loopback host.
      const r = runGuard(["channels", "login", "--channel", "whatsapp"], {
        gatewayUrl: badUrl,
        gatewayToken: "guard-secret-token",
        preloadPresent: true,
      });
      expect(r.stderr).toContain("must not contain '@' (userinfo)");
      expect(r.stdout).toContain("GUARD_EXIT=1");
      expect(r.stdout).not.toContain("FAKE_OPENCLAW_ARGS");
      expect(r.stdout).not.toContain("FAKE_OPENCLAW_TOKEN");
      expect(`${r.stdout}\n${r.stderr}`).not.toContain("guard-secret-token");
      expect(`${r.stdout}\n${r.stderr}`).not.toContain(badUrl);
    },
  );

  it("does not re-inject the stashed private gateway URL for WhatsApp (#6413)", () => {
    const r = runGuard(["channels", "login", "--channel", "whatsapp"], {
      privateGatewayUrl: "ws://10.200.0.2:18790",
      insecurePrivateWs: "1",
      preloadPresent: true,
    });
    expect(r.stdout).toContain("FAKE_OPENCLAW_ARGS=channels login --channel whatsapp");
    // The stashed private veth URL must stay out of the login environment: a
    // private-IP origin makes the gateway's locality check strip operator
    // scopes and the post-pair restart fails with "missing scope:
    // operator.admin".
    expect(r.stdout).toContain("FAKE_OPENCLAW_GATEWAY_URL=unset");
    expect(r.stdout).toContain("FAKE_OPENCLAW_INSECURE_WS=unset");
    expect(r.stdout).toContain("GUARD_EXIT=0");
  });

  it("preserves an explicit loopback override without borrowing the private opt-in (#4504)", () => {
    const r = runGuard(["channels", "login", "--channel", "whatsapp"], {
      gatewayUrl: "wss://127.0.0.1:443",
      privateGatewayUrl: "ws://10.200.0.2:18790",
      insecurePrivateWs: "1",
      preloadPresent: true,
    });
    expect(r.stdout).toContain("FAKE_OPENCLAW_GATEWAY_URL=wss://127.0.0.1:443");
    expect(r.stdout).toContain("FAKE_OPENCLAW_INSECURE_WS=unset");
  });

  it("preserves the insecure-WS marker explicitly coupled to a loopback override (#4504)", () => {
    const r = runGuard(["channels", "login", "--channel", "whatsapp"], {
      gatewayUrl: "ws://localhost:18790",
      insecurePublicWs: "explicit-marker",
      privateGatewayUrl: "ws://10.200.0.2:18790",
      insecurePrivateWs: "1",
      preloadPresent: true,
    });
    expect(r.stdout).toContain("FAKE_OPENCLAW_GATEWAY_URL=ws://localhost:18790");
    expect(r.stdout).toContain("FAKE_OPENCLAW_INSECURE_WS=explicit-marker");
  });

  it("injects the compact-QR preload into NODE_OPTIONS for the login", () => {
    const r = runGuard(["channels", "login", "--channel", "whatsapp"], {
      gatewayUrl: "ws://127.0.0.1:8080",
      preloadPresent: true,
    });
    expect(r.stdout).toContain("FAKE_OPENCLAW_ARGS=channels login --channel whatsapp");
    expect(r.stdout).toContain(`--require ${r.preloadPath}`);
    expect(r.stdout).toContain("GUARD_EXIT=0");
    // Clean exit: no gateway-close diagnostics.
    expect(r.stderr).not.toContain("abnormal closure");
  });

  it("runs login even if the preload file is absent (older base image)", () => {
    const r = runGuard(["channels", "login", "--channel", "whatsapp"], {
      gatewayUrl: "ws://127.0.0.1:8080",
      preloadPresent: false,
    });
    expect(r.stdout).toContain("FAKE_OPENCLAW_ARGS=channels login --channel whatsapp");
    expect(r.stdout).not.toContain(r.preloadPath);
    expect(r.stdout).toContain("GUARD_EXIT=0");
  });

  it("surfaces gateway-close diagnostics and preserves exit status when return is shadowed", () => {
    const r = runGuard(["channels", "login", "--channel", "whatsapp"], {
      gatewayUrl: "ws://127.0.0.1:8080",
      poisonShellFunctions: ["return"],
      preloadPresent: true,
      fakeExit: 7,
    });
    expect(r.stderr).toContain("1008 abnormal closure");
    expect(r.stderr).toContain("not a QR-size issue");
    // Guard preserves the underlying exit code.
    expect(r.stdout).toContain("GUARD_EXIT=7");
    expect(r.stdout).not.toContain("POISON_EXIT_USED");
  });
});
