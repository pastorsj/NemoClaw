// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, "../../..");

const LEGACY_RUNTIME_ASSET_PAIRS = [
  {
    name: "Google Chat outbound authentication",
    legacy: "src/lib/messaging/channels/googlechat/runtime/googlechat-outbound-auth.ts",
    canonical:
      "packages/nemoclaw-openclaw/messaging/runtime/googlechat/runtime/googlechat-outbound-auth.ts",
  },
  {
    name: "Google Chat trusted proxy fetch",
    legacy: "src/lib/messaging/channels/googlechat/runtime/googlechat-trusted-proxy-fetch.ts",
    canonical:
      "packages/nemoclaw-openclaw/messaging/runtime/googlechat/runtime/googlechat-trusted-proxy-fetch.ts",
  },
  {
    name: "Slack channel guard",
    legacy: "src/lib/messaging/channels/slack/runtime/slack-channel-guard.ts",
    canonical: "packages/nemoclaw-openclaw/messaging/runtime/slack/runtime/slack-channel-guard.ts",
  },
  {
    name: "Microsoft Teams message hints",
    legacy: "src/lib/messaging/channels/teams/runtime/msteams-message-hints.ts",
    canonical:
      "packages/nemoclaw-openclaw/messaging/runtime/teams/runtime/msteams-message-hints.ts",
  },
  {
    name: "Telegram diagnostics",
    legacy: "src/lib/messaging/channels/telegram/runtime/telegram-diagnostics.ts",
    canonical:
      "packages/nemoclaw-openclaw/messaging/runtime/telegram/runtime/telegram-diagnostics.ts",
  },
  {
    name: "WeChat account placeholder",
    legacy: "src/lib/messaging/channels/wechat/runtime/wechat-account-placeholder.ts",
    canonical:
      "packages/nemoclaw-openclaw/messaging/runtime/wechat/runtime/wechat-account-placeholder.ts",
  },
  {
    name: "WeChat diagnostics",
    legacy: "src/lib/messaging/channels/wechat/runtime/wechat-diagnostics.ts",
    canonical: "packages/nemoclaw-openclaw/messaging/runtime/wechat/runtime/wechat-diagnostics.ts",
  },
  {
    name: "WhatsApp compact QR renderer",
    legacy: "src/lib/messaging/channels/whatsapp/runtime/whatsapp-qr-compact.ts",
    canonical:
      "packages/nemoclaw-openclaw/messaging/runtime/whatsapp/runtime/whatsapp-qr-compact.ts",
  },
  {
    name: "Hermes Google Chat adapter",
    legacy: "src/lib/messaging/channels/googlechat/runtime/hermes-adapter.py",
    canonical: "packages/nemoclaw-hermes/messaging/runtime/googlechat/hermes-adapter.py",
  },
] as const;

describe("legacy core messaging runtime assets", () => {
  // source-shape-contract: compatibility -- Exact byte parity prevents the no-receipt compatibility lane from drifting away from package-owned runtime behavior
  it("keeps every legacy runtime copy byte-identical to its canonical package asset", () => {
    const mismatches = LEGACY_RUNTIME_ASSET_PAIRS.flatMap(({ name, legacy, canonical }) => {
      const legacyBytes = readFileSync(path.join(REPOSITORY_ROOT, legacy));
      const canonicalBytes = readFileSync(path.join(REPOSITORY_ROOT, canonical));
      return legacyBytes.equals(canonicalBytes) ? [] : [name];
    });

    expect(mismatches).toEqual([]);
  });
});
