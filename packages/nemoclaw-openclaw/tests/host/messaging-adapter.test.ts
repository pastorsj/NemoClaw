// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type {
  HarnessMessagingAdapterModule,
  HarnessMessagingChannelProfile,
} from "@nvidia/nemoclaw-harness-contract";
import { loadPackageHostModule } from "../helpers/host-module";

const adapter = loadPackageHostModule<HarnessMessagingAdapterModule>("messaging-adapter.cts");
const profiles = JSON.parse(
  fs.readFileSync(path.resolve("messaging/profile.json"), "utf8"),
) as HarnessMessagingChannelProfile[];

describe("OpenClaw messaging adapter", () => {
  it("describes every package-supported channel without host capabilities", () => {
    expect(adapter.describeMessagingIntegration({ packageId: "openclaw" })).toEqual({
      kind: "channels",
      packageId: "openclaw",
      channelIds: ["discord", "googlechat", "slack", "teams", "telegram", "wechat", "whatsapp"],
      profilePath: "messaging/profile.json",
      build: {
        configRoot: "~/.openclaw",
        packageManagers: ["node-package"],
        renderFinalizers: ["allow-rendered-plugins"],
        postRenderRepair: {
          command: ["openclaw", "doctor", "--fix", "--non-interactive"],
        },
        nodeArchiveRemediation: "package-helper",
        credentialPolicyReconciliation: "teams-outlook-shared-login",
      },
    });
  });

  it("rejects a request for another package", () => {
    expect(() => adapter.describeMessagingIntegration({ packageId: "another-package" })).toThrow(
      "does not match this package",
    );
  });

  it("owns OpenClaw config, policy, and lifecycle differences as package data", () => {
    const telegram = profiles.find(({ channelId }) => channelId === "telegram");
    expect(telegram?.config.renders.map(({ target }) => target)).toEqual([
      "~/.openclaw/openclaw.json",
      "~/.openclaw/openclaw.json",
      "~/.openclaw/openclaw.json",
    ]);
    expect(telegram?.policy).toEqual([
      { presetName: "telegram", policyKeys: ["telegram_bot"], requiredAtCreate: true },
    ]);
    expect(telegram?.lifecycle.runtime?.nodePreloads?.[0]?.module).toBe("telegram-diagnostics");
    expect(
      profiles
        .flatMap(({ lifecycle }) => lifecycle.packageInstalls ?? [])
        .every(({ manager }) => manager === "node-package"),
    ).toBe(true);
  });
});
