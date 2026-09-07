// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type { HarnessMessagingChannelProfile } from "@nvidia/nemoclaw-harness-contract";

import { telegramManifest } from "./channels/telegram/manifest";
import { applyHarnessMessagingProfile } from "./package-profile";

const BUILD = { configRoot: "~/.synthetic", packageManagers: [] } as const;

function telegramProfile(
  hookIds: readonly string[],
  hookOperations?: HarnessMessagingChannelProfile["lifecycle"]["hookOperations"],
): HarnessMessagingChannelProfile {
  return {
    channelId: "telegram",
    config: { renders: [], visibility: [] },
    policy: [],
    lifecycle: { hookIds, ...(hookOperations ? { hookOperations } : {}) },
  };
}

describe("receipt-backed messaging hook operations", () => {
  it("does not fall back to a native hook for a synthetic package with the same ID", () => {
    expect(() =>
      applyHarnessMessagingProfile(
        telegramManifest,
        "openclaw",
        telegramProfile(["telegram-openclaw-bridge-health"]),
        BUILD,
      ),
    ).toThrow("requires a typed package operation");
  });

  it("replaces a legacy-native hook slot with the generic finite command executor", () => {
    const command = { argv: ["futurectl", "bridge", "telegram"] } as const;
    const manifest = applyHarnessMessagingProfile(
      telegramManifest,
      "synthetic-harness",
      telegramProfile(
        ["telegram-openclaw-bridge-health"],
        [
          {
            hookId: "telegram-openclaw-bridge-health",
            kind: "sandbox-command",
            command,
            output: "bridge-health",
          },
        ],
      ),
      BUILD,
    );

    expect(manifest.hooks).toEqual([
      expect.objectContaining({
        id: "telegram-openclaw-bridge-health",
        handler: "common.packageCommand",
        packageOperation: expect.objectContaining({ command }),
      }),
    ]);
    expect(manifest.hooks[0]?.handler).not.toBe("telegram.openclawBridgeHealth");
  });

  it("lets a package extend one core prompt without selecting a package-specific prompt hook", () => {
    const manifest = applyHarnessMessagingProfile(
      telegramManifest,
      "synthetic-harness",
      telegramProfile(
        ["telegram-config-prompt"],
        [
          {
            hookId: "telegram-config-prompt",
            kind: "config-prompt",
            outputIds: ["allowedIds", "requireMention", "groupPolicy"],
          },
        ],
      ),
      BUILD,
    );

    expect(manifest.hooks).toEqual([
      expect.objectContaining({
        id: "telegram-config-prompt",
        handler: "common.configPrompt",
        outputs: [
          { id: "allowedIds", kind: "config" },
          { id: "requireMention", kind: "config" },
          { id: "groupPolicy", kind: "config" },
        ],
      }),
    ]);
  });

  it("leaves the built-in manifest unchanged for explicit no-receipt callers", () => {
    expect(
      telegramManifest.hooks.find(({ id }) => id === "telegram-openclaw-bridge-health"),
    ).toMatchObject({ handler: "telegram.openclawBridgeHealth" });
  });
});
