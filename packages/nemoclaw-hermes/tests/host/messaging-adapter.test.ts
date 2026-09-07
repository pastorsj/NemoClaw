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

describe("Hermes messaging adapter", () => {
  it("describes every package-supported channel without host capabilities", () => {
    expect(adapter.describeMessagingIntegration({ packageId: "hermes" })).toEqual({
      kind: "channels",
      packageId: "hermes",
      channelIds: ["discord", "googlechat", "slack", "teams", "telegram", "wechat", "whatsapp"],
      profilePath: "messaging/profile.json",
      build: {
        configRoot: "~/.hermes",
        packageManagers: ["python-package"],
        packageInstallers: {
          "python-package": {
            kind: "batched-command",
            command: [
              "uv",
              "pip",
              "install",
              "--python",
              "/opt/hermes/.venv/bin/python",
              "--no-cache",
              "--",
              "{{packages}}",
            ],
            environment: {
              UV_SYSTEM_CERTS: "1",
              SSL_CERT_FILE: "/etc/ssl/certs/ca-certificates.crt",
            },
          },
        },
        renderFinalizers: ["inherit-api-server-toolsets"],
        postCreateCredentialReconciliation: "restart-runtime",
        degradedDiagnostics: "gateway-log-tail",
      },
    });
  });

  it("rejects a request for another package", () => {
    expect(() => adapter.describeMessagingIntegration({ packageId: "another-package" })).toThrow(
      "does not match this package",
    );
  });

  it("owns Hermes config, policy, and lifecycle differences as package data", () => {
    const telegram = profiles.find(({ channelId }) => channelId === "telegram");
    expect(telegram?.config.renders.map(({ target }) => target)).toEqual([
      "~/.hermes/.env",
      "~/.hermes/config.yaml",
      "~/.hermes/config.yaml",
    ]);
    expect(telegram?.config.visibility).toEqual([
      expect.objectContaining({ inputId: "allowedIds", envKey: "TELEGRAM_ALLOWED_USERS" }),
      expect.objectContaining({ inputId: "requireMention", path: ["telegram", "require_mention"] }),
    ]);
    expect(telegram?.policy).toEqual([
      { presetName: "telegram", policyKeys: ["telegram"], requiredAtCreate: true },
    ]);
    expect(telegram?.lifecycle.runtime).toBeUndefined();
    expect(
      profiles
        .flatMap(({ lifecycle }) => lifecycle.packageInstalls ?? [])
        .every(({ manager }) => manager === "python-package"),
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
    expect(
      profiles.find(({ channelId }) => channelId === "whatsapp")?.lifecycle.statusProbe,
    ).toEqual({
      kind: "session-files",
      primaryCredentialPath: "platforms/whatsapp/session/creds.json",
      alternateCredentialPath: "profiles/dashboard-home/platforms/whatsapp/session/creds.json",
      primaryLabel: "Hermes gateway",
      alternateLabel: "dashboard-home",
      pairingCommand: { argv: ["hermes", "whatsapp"] },
      configuredSessionPath: {
        configPath: "config.yaml",
        valuePath: ["platforms", "whatsapp", "extra", "session_path"],
      },
    });
  });

  it("declares Hermes Google Chat prompt fields on the generic core prompt", () => {
    const googleChat = profiles.find(({ channelId }) => channelId === "googlechat");
    expect(googleChat?.lifecycle.hookIds).not.toContain("googlechat-hermes-config-prompt");
    expect(googleChat?.lifecycle.hookOperations).toEqual([
      {
        hookId: "googlechat-config-prompt",
        kind: "config-prompt",
        outputIds: ["allowFrom", "projectId", "subscriptionName"],
      },
    ]);
  });

  it("declares static and gateway-minted provider projections beside the package profile", () => {
    expect(profiles.find(({ channelId }) => channelId === "discord")?.credentialProvider).toEqual({
      profilePath: "provider-profiles/discord.yaml",
      profileId: "discord-hermes-static-v1",
      credentialEnv: "DISCORD_BOT_TOKEN",
      sourceInputId: "botToken",
    });
    expect(
      profiles.find(({ channelId }) => channelId === "googlechat")?.credentialProvider,
    ).toEqual({
      profilePath: "provider-profiles/googlechat.yaml",
      profileId: "google-chat-hermes-bridge",
      credentialEnv: "GOOGLE_CHAT_ACCESS_TOKEN",
      sourceInputId: "serviceAccount",
      refresh: {
        strategy: "google_service_account_jwt",
        scopes: [
          "https://www.googleapis.com/auth/chat.bot",
          "https://www.googleapis.com/auth/pubsub",
        ],
        secretMaterialKeys: ["private_key"],
      },
    });
    expect(fs.existsSync(path.resolve("provider-profiles/discord.yaml"))).toBe(true);
    expect(fs.existsSync(path.resolve("provider-profiles/googlechat.yaml"))).toBe(true);
  });
});
