// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  type OpenClawProbeIo,
  probeBridgeHealth,
  probeSlackStatus,
  probeTelegramStatus,
} from "../../messaging/probes/probe.mts";

const CONTEXT = {
  agent: "openclaw",
  probedAt: "2026-09-06T00:00:00.000Z",
  channelEnabledInRegistry: true,
  presetApplied: true,
  presetOnGateway: true,
} as const;

function probeIo(options: {
  readonly config?: unknown;
  readonly log?: string;
  readonly command?: { readonly status: number | null; readonly stdout: string };
}): OpenClawProbeIo {
  return {
    readTextFile(path) {
      if (path.endsWith("openclaw.json")) return JSON.stringify(options.config ?? {});
      return options.log ?? "";
    },
    runCommand() {
      return options.command ?? { status: 1, stdout: "" };
    },
  };
}

describe("OpenClaw package messaging probe", () => {
  it("owns OpenClaw config and log grammar for bridge health", () => {
    const result = probeBridgeHealth(
      "telegram",
      probeIo({
        config: {
          channels: {
            telegram: {
              enabled: true,
              accounts: { default: { dmPolicy: "allowlist", allowFrom: [] } },
            },
          },
        },
        log: "[telegram] [default] provider ready",
      }),
    );

    expect(result.lines).toEqual([
      "  ✓ 'telegram' bridge startup detected in sandbox runtime log.",
      "  ⚠ Telegram direct-message allowlist is empty in baked openclaw.json.",
      "    Set TELEGRAM_ALLOWED_IDS before rebuild, or complete OpenClaw pairing before expecting DM replies.",
    ]);
  });

  it("lets the latest Telegram provider evidence supersede a stale network failure", () => {
    const report = probeTelegramStatus(
      CONTEXT,
      probeIo({
        log: [
          "[telegram] Network request for getMe failed",
          "[telegram] [default] provider ready (Bot API reachable)",
        ].join("\n"),
        command: { status: 0, stdout: "123 openclaw-gateway\n" },
      }),
    );

    expect(report.verdict).toBe("healthy");
    expect(report.signals).toContainEqual(
      expect.objectContaining({ label: "Bot API reachability", severity: "ok" }),
    );
  });

  it("classifies a rejected Telegram credential without returning raw log text", () => {
    const report = probeTelegramStatus(
      CONTEXT,
      probeIo({
        log: "[telegram] Bot API rejected startup probe with HTTP 401; token invalid",
        command: { status: 0, stdout: "123 openclaw-gateway\n" },
      }),
    );

    expect(report.verdict).toBe("token_rejected");
    expect(JSON.stringify(report)).not.toContain("token invalid");
  });

  it("maps OpenClaw Slack status JSON into a generic ready report", () => {
    const report = probeSlackStatus(
      CONTEXT,
      probeIo({
        command: {
          status: 0,
          stdout: JSON.stringify({
            gatewayReachable: true,
            channels: { slack: { configured: true } },
            channelAccounts: {
              slack: [
                {
                  accountId: "default",
                  enabled: true,
                  configured: true,
                  running: true,
                  connected: true,
                  probe: { ok: true },
                },
              ],
            },
          }),
        },
      }),
    );

    expect(report).toMatchObject({
      verdict: "healthy",
      readiness: { state: "ready", category: null, reason: "operational" },
    });
  });

  it("does not run native probes when generic policy facts make the channel ineligible", () => {
    let commandRuns = 0;
    const report = probeSlackStatus(
      { ...CONTEXT, presetOnGateway: false },
      {
        readTextFile: () => null,
        runCommand: () => {
          commandRuns += 1;
          return { status: 0, stdout: "{}" };
        },
      },
    );

    expect(commandRuns).toBe(0);
    expect(report.readiness).toMatchObject({ state: "terminal", category: "policy" });
  });
});
