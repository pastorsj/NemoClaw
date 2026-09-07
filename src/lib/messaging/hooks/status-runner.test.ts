// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { whatsappManifest } from "../channels/whatsapp/manifest";
import type { MessagingHookContext } from "./types";
import { MessagingHookRegistry } from "./registry";
import {
  type MessagingStatusHookRunResult,
  readChannelHealthOutputs,
  runMessagingStatusHooks,
} from "./status-runner";

function runResult(
  outputs: Record<string, { kind: string; value: unknown }>,
): MessagingStatusHookRunResult {
  return {
    channelId: "telegram",
    hookId: "telegram-status-health",
    outputs,
  } as unknown as MessagingStatusHookRunResult;
}

const VALID_REPORT = {
  schemaVersion: 1,
  channel: "telegram",
  agent: "openclaw",
  verdict: "healthy",
  probedAt: "2026-07-15T00:00:00.000Z",
  signals: [],
  hints: [],
};

describe("readChannelHealthOutputs (#6888)", () => {
  it("returns a well-formed messaging-channel-health report", () => {
    const out = readChannelHealthOutputs(
      runResult({
        channelHealth: {
          kind: "status",
          value: { type: "messaging-channel-health", report: VALID_REPORT },
        },
      }),
    );
    expect(out).toEqual([VALID_REPORT]);
  });

  it("threads a receipt-backed unknown package's finite status declaration", () => {
    let captured: MessagingHookContext | undefined;
    const statusHook = whatsappManifest.hooks.find(({ phase }) => phase === "status");
    expect(statusHook).toBeDefined();
    const statusProbe = {
      kind: "channel-status-json",
      command: { argv: ["futurectl", "status", "--json"] },
      pairingCommand: { argv: ["futurectl", "pair"] },
    } as const;
    const manifest = {
      ...whatsappManifest,
      supportedAgents: ["future-harness"],
      packageBuild: { configRoot: "~/.future-harness", packageManagers: [] },
      hooks: [{ ...statusHook!, agents: ["future-harness"], statusProbe }],
    };
    const hookRegistry = new MessagingHookRegistry([
      {
        id: "whatsapp.statusHealth",
        handler: (context) => {
          captured = context;
          return {};
        },
      },
    ]);

    runMessagingStatusHooks({
      agent: "future-harness",
      currentSandbox: "future-sandbox",
      manifests: [manifest],
      hookRegistry,
    });

    expect(captured?.inputs).toMatchObject({
      agent: "future-harness",
      currentSandbox: "future-sandbox",
      packageConfigRoot: "~/.future-harness",
      receiptBackedProfile: true,
      statusProbe,
    });
  });

  it("drops a malformed report (missing signals) instead of passing it through", () => {
    const out = readChannelHealthOutputs(
      runResult({
        channelHealth: {
          kind: "status",
          value: {
            type: "messaging-channel-health",
            report: { ...VALID_REPORT, signals: undefined },
          },
        },
      }),
    );
    expect(out).toEqual([]);
  });

  it("ignores non-health status outputs (e.g. bridge conflicts)", () => {
    const out = readChannelHealthOutputs(
      runResult({
        bridgeHealth: {
          kind: "status",
          value: { type: "messaging-bridge-health", channel: "telegram", conflicts: 1 },
        },
      }),
    );
    expect(out).toEqual([]);
  });
});
