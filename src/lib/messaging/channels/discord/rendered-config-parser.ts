// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { MessagingSerializableValue } from "../../manifest";
import {
  getEnvConfigValue,
  getStructuredConfigValue,
  getStructuredPath,
  listPackageConfigVisibilityKeys,
  type RenderedChannelConfigParser,
  type RenderedConfigSource,
  type RenderedConfigVisibilityKey,
} from "../rendered-config-parser-utils";
import { listLegacyRenderedConfigKeys } from "../legacy/rendered-config";

export const discordRenderedConfigParser: RenderedChannelConfigParser = {
  listConfigVisibilityKeys(context) {
    return (
      listPackageConfigVisibilityKeys(context) ?? listLegacyRenderedConfigKeys("discord", context)
    );
  },

  getValue(key, source) {
    switch (key.key) {
      case "guildIds":
        return Object.keys(discordGuilds(source, key));
      case "guildRequireMention":
        return discordRequireMention(discordGuilds(source, key));
      case "guildUsers":
        return discordGuildUsers(discordGuilds(source, key));
      default:
        return key.kind === "env"
          ? getEnvConfigValue(source, key.envKey)
          : getStructuredConfigValue(source, key.path);
    }
  },
};

function discordGuilds(
  source: RenderedConfigSource,
  key: RenderedConfigVisibilityKey,
): Record<string, MessagingSerializableValue> {
  const value = getStructuredConfigValue(source, key.path);
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, MessagingSerializableValue>)
    : {};
}

function discordRequireMention(
  guilds: Readonly<Record<string, MessagingSerializableValue>>,
): MessagingSerializableValue | undefined {
  const values = Object.values(guilds)
    .map((guild) =>
      guild && typeof guild === "object" && !Array.isArray(guild)
        ? getStructuredPath(guild, ["requireMention"])
        : undefined,
    )
    .filter((entry): entry is MessagingSerializableValue => entry !== undefined);
  if (values.length === 0) return undefined;
  const uniqueValues = new Map<string, MessagingSerializableValue>();
  for (const value of values) {
    uniqueValues.set(formatProjectionValue(value), value);
  }
  const dedupedValues = Array.from(uniqueValues.values());
  return dedupedValues.length === 1 ? dedupedValues[0] : dedupedValues;
}

function discordGuildUsers(
  guilds: Readonly<Record<string, MessagingSerializableValue>>,
): MessagingSerializableValue | undefined {
  const users = Object.values(guilds).flatMap((guild) => {
    if (!guild || typeof guild !== "object" || Array.isArray(guild)) return [];
    const rawUsers = getStructuredPath(guild, ["users"]);
    return Array.isArray(rawUsers) ? rawUsers.map(String) : [];
  });
  return users.length > 0 ? users : undefined;
}

function formatProjectionValue(value: MessagingSerializableValue): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}
