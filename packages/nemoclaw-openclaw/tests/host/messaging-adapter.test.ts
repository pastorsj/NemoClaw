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
        packageInstallers: {
          "node-package": {
            kind: "verified-archive-command",
            command: ["openclaw", "plugins", "install", "{{archive}}"],
            archiveArgumentPrefix: "npm-pack:",
            packageVersionEnvironment: "OPENCLAW_VERSION",
          },
        },
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
    expect(telegram?.config.visibility.map(({ inputId }) => inputId)).toEqual([
      "allowedIds",
      "groupPolicy",
      "requireMention",
    ]);
    expect(profiles.find(({ channelId }) => channelId === "wechat")?.config.visibility).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ inputId: "baseUrl", targetInputId: "accountId" }),
      ]),
    );
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

  it("owns channel policy assets and the finite WhatsApp status operation", () => {
    const presetNames = profiles.flatMap(({ policy }) =>
      policy.map(({ presetName }) => presetName),
    );
    expect(
      presetNames.every((presetName) =>
        fs.existsSync(path.resolve("policies", "presets", `${presetName}.yaml`)),
      ),
    ).toBe(true);
    const whatsapp = profiles.find(({ channelId }) => channelId === "whatsapp");
    expect(whatsapp?.config.statePaths).toEqual(["whatsapp"]);
    expect(whatsapp?.lifecycle.statusProbe).toEqual({
      kind: "channel-status-json",
      command: {
        argv: ["openclaw", "channels", "status", "--channel", "whatsapp", "--json"],
      },
      timeoutOption: "--timeout",
      pairingCommand: {
        argv: ["openclaw", "channels", "login", "--channel", "whatsapp"],
      },
    });
  });

  it("owns native prompt, probe, and build-file behavior through finite operations", () => {
    const telegram = profiles.find(({ channelId }) => channelId === "telegram");
    expect(telegram?.lifecycle.hookIds).not.toContain("telegram-openclaw-config-prompt");
    expect(telegram?.lifecycle.hookOperations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          hookId: "telegram-config-prompt",
          kind: "config-prompt",
          outputIds: ["requireMention", "allowedIds", "groupPolicy"],
        }),
        expect.objectContaining({
          hookId: "telegram-openclaw-bridge-health",
          kind: "sandbox-command",
          output: "bridge-health",
        }),
        expect.objectContaining({
          hookId: "telegram-status-health",
          kind: "sandbox-command",
          output: "channel-health",
          context: "channel-health",
        }),
      ]),
    );
    const wechat = profiles.find(({ channelId }) => channelId === "wechat");
    expect(wechat?.lifecycle.hookOperations).toEqual([
      expect.objectContaining({
        hookId: "wechat-seed-openclaw-account",
        kind: "build-files",
        outputs: expect.arrayContaining([
          expect.objectContaining({ id: "openclawWeixinAccountFile" }),
          expect.objectContaining({ id: "openclawConfigPatch" }),
        ]),
      }),
    ]);
    const googleChat = profiles.find(({ channelId }) => channelId === "googlechat");
    expect(googleChat?.lifecycle.hookIds).not.toContain("googlechat-openclaw-config-prompt");
    expect(googleChat?.lifecycle.hookOperations).toEqual([
      {
        hookId: "googlechat-config-prompt",
        kind: "config-prompt",
        outputIds: ["allowFrom", "appPrincipal"],
      },
    ]);
    expect(fs.existsSync(path.resolve("messaging/probes/probe.mts"))).toBe(true);
    expect(fs.readFileSync(path.resolve("Dockerfile"), "utf8")).toContain(
      "messaging/probes/probe.mts /usr/local/lib/nemoclaw/messaging-probe.mts",
    );
  });

  it("declares its gateway-minted provider projection beside the package profile", () => {
    expect(
      profiles.find(({ channelId }) => channelId === "googlechat")?.credentialProvider,
    ).toEqual({
      profilePath: "provider-profiles/googlechat.yaml",
      profileId: "google-chat-bridge",
      credentialEnv: "GOOGLE_CHAT_ACCESS_TOKEN",
      sourceInputId: "serviceAccount",
      refresh: {
        strategy: "google_service_account_jwt",
        scopes: ["https://www.googleapis.com/auth/chat.bot"],
        secretMaterialKeys: ["private_key"],
      },
    });
    expect(fs.existsSync(path.resolve("provider-profiles/googlechat.yaml"))).toBe(true);
  });
});
