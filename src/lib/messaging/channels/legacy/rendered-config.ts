// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  envConfigKey,
  structuredConfigKey,
  type RenderedChannelConfigParserContext,
  type RenderedConfigVisibilityKey,
} from "../rendered-config-parser-utils";

/** Exact pre-receipt mappings. Receipt-backed manifests never enter this module. */
export function listLegacyRenderedConfigKeys(
  channelId: string,
  context: RenderedChannelConfigParserContext,
): readonly RenderedConfigVisibilityKey[] {
  if (context.agentId === "openclaw") return openClawKeys(channelId, context);
  if (context.agentId === "hermes") return hermesKeys(channelId);
  return [];
}

function openClawKeys(
  channelId: string,
  context: RenderedChannelConfigParserContext,
): readonly RenderedConfigVisibilityKey[] {
  switch (channelId) {
    case "discord":
      return [
        structuredConfigKey(
          "serverId",
          "openclaw.json",
          ["channels", "discord", "guilds"],
          "guildIds",
        ),
        structuredConfigKey(
          "requireMention",
          "openclaw.json",
          ["channels", "discord", "guilds"],
          "guildRequireMention",
        ),
        structuredConfigKey(
          "userId",
          "openclaw.json",
          ["channels", "discord", "guilds"],
          "guildUsers",
        ),
      ];
    case "telegram": {
      const keys: RenderedConfigVisibilityKey[] = [
        structuredConfigKey("allowedIds", "openclaw.json", [
          "channels",
          "telegram",
          "accounts",
          "default",
          "allowFrom",
        ]),
        structuredConfigKey("groupPolicy", "openclaw.json", [
          "channels",
          "telegram",
          "accounts",
          "default",
          "groupPolicy",
        ]),
      ];
      if (effectiveInput(context, "groupPolicy", "open") === "open") {
        keys.push(
          structuredConfigKey(
            "requireMention",
            "openclaw.json",
            ["channels", "telegram", "groups"],
            "groupRequireMention",
          ),
        );
      }
      return keys;
    }
    case "slack":
      return [
        structuredConfigKey("allowedUsers", "openclaw.json", [
          "channels",
          "slack",
          "accounts",
          "default",
          "allowFrom",
        ]),
        structuredConfigKey(
          "allowedChannels",
          "openclaw.json",
          ["channels", "slack", "accounts", "default", "channels"],
          "allowedChannelIds",
        ),
      ];
    case "teams":
      return [
        structuredConfigKey("appId", "openclaw.json", ["channels", "msteams", "appId"]),
        structuredConfigKey("tenantId", "openclaw.json", ["channels", "msteams", "tenantId"]),
        structuredConfigKey("allowedUsers", "openclaw.json", ["channels", "msteams", "allowFrom"]),
        structuredConfigKey("webhookPort", "openclaw.json", [
          "channels",
          "msteams",
          "webhook",
          "port",
        ]),
        structuredConfigKey("requireMention", "openclaw.json", [
          "channels",
          "msteams",
          "requireMention",
        ]),
      ];
    case "wechat": {
      const keys: RenderedConfigVisibilityKey[] = [
        structuredConfigKey(
          "accountId",
          "openclaw.json",
          ["channels", "openclaw-weixin", "accounts"],
          "accountIds",
        ),
      ];
      const accountId = effectiveInput(context, "accountId");
      if (safeSegment(accountId)) {
        const target = `~/.openclaw/openclaw-weixin/accounts/${accountId}.json`;
        keys.push(structuredConfigKey("baseUrl", target, ["baseUrl"]));
        keys.push(structuredConfigKey("userId", target, ["userId"]));
      }
      return keys;
    }
    case "googlechat":
      return [
        structuredConfigKey("audienceType", "openclaw.json", [
          "channels",
          "googlechat",
          "audienceType",
        ]),
        structuredConfigKey("audience", "openclaw.json", ["channels", "googlechat", "audience"]),
        structuredConfigKey("appPrincipal", "openclaw.json", [
          "channels",
          "googlechat",
          "appPrincipal",
        ]),
        structuredConfigKey("allowFrom", "openclaw.json", [
          "channels",
          "googlechat",
          "dm",
          "allowFrom",
        ]),
      ];
    default:
      return [];
  }
}

function hermesKeys(channelId: string): readonly RenderedConfigVisibilityKey[] {
  switch (channelId) {
    case "discord":
      return [
        envConfigKey("serverId", "~/.hermes/.env", "NEMOCLAW_DISCORD_GUILD_IDS"),
        envConfigKey("userId", "~/.hermes/.env", "DISCORD_ALLOWED_USERS"),
        structuredConfigKey("requireMention", "~/.hermes/config.yaml", [
          "discord",
          "require_mention",
        ]),
      ];
    case "telegram":
      return [
        envConfigKey("allowedIds", "~/.hermes/.env", "TELEGRAM_ALLOWED_USERS"),
        structuredConfigKey("requireMention", "~/.hermes/config.yaml", [
          "telegram",
          "require_mention",
        ]),
      ];
    case "slack":
      return [
        envConfigKey("allowedUsers", "~/.hermes/.env", "SLACK_ALLOWED_USERS"),
        envConfigKey("allowedChannels", "~/.hermes/.env", "SLACK_ALLOWED_CHANNELS"),
      ];
    case "teams":
      return [
        envConfigKey("appId", "~/.hermes/.env", "TEAMS_CLIENT_ID"),
        envConfigKey("tenantId", "~/.hermes/.env", "TEAMS_TENANT_ID"),
        envConfigKey("allowedUsers", "~/.hermes/.env", "TEAMS_ALLOWED_USERS"),
        envConfigKey("webhookPort", "~/.hermes/.env", "TEAMS_PORT"),
      ];
    case "wechat":
      return [
        envConfigKey("accountId", "~/.hermes/.env", "WEIXIN_ACCOUNT_ID"),
        envConfigKey("baseUrl", "~/.hermes/.env", "WEIXIN_BASE_URL"),
        envConfigKey("allowedIds", "~/.hermes/.env", "WEIXIN_ALLOWED_USERS"),
      ];
    case "whatsapp":
      return [
        envConfigKey("mode", "~/.hermes/.env", "WHATSAPP_MODE"),
        envConfigKey("allowedIds", "~/.hermes/.env", "WHATSAPP_ALLOWED_USERS"),
      ];
    default:
      return [];
  }
}

function effectiveInput(
  context: RenderedChannelConfigParserContext,
  inputId: string,
  fallback?: string,
): string | undefined {
  const value = context.inputs.find((input) => input.inputId === inputId)?.value;
  if (typeof value === "string" && value.trim()) return value.trim();
  const declared = context.manifest.inputs.find((input) => input.id === inputId);
  return declared?.kind === "config" && declared.defaultValue ? declared.defaultValue : fallback;
}

function safeSegment(value: string | undefined): value is string {
  return Boolean(
    value &&
    value !== "." &&
    value !== ".." &&
    !value.includes("..") &&
    /^[A-Za-z0-9._-]+$/u.test(value),
  );
}
