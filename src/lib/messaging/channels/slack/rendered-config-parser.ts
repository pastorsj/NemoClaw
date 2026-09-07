// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  getEnvConfigValue,
  getStructuredConfigValue,
  listPackageConfigVisibilityKeys,
  type RenderedChannelConfigParser,
  type RenderedConfigSource,
  type RenderedConfigVisibilityKey,
} from "../rendered-config-parser-utils";
import { listLegacyRenderedConfigKeys } from "../legacy/rendered-config";

const ALLOWED_CHANNEL_IDS_KEY = "allowedChannelIds";

export const slackRenderedConfigParser: RenderedChannelConfigParser = {
  listConfigVisibilityKeys(context) {
    return (
      listPackageConfigVisibilityKeys(context) ?? listLegacyRenderedConfigKeys("slack", context)
    );
  },

  getValue(key, source) {
    if (key.key === ALLOWED_CHANNEL_IDS_KEY) return slackAllowedChannelIds(source, key);
    return key.kind === "env"
      ? getEnvConfigValue(source, key.envKey)
      : getStructuredConfigValue(source, key.path);
  },
};

function slackAllowedChannelIds(
  source: RenderedConfigSource,
  key: RenderedConfigVisibilityKey,
): string[] | undefined {
  const value = getStructuredConfigValue(source, key.path);
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const channelIds = Object.keys(value).filter((channelId) => channelId !== "*");
  return channelIds.length > 0 ? channelIds : undefined;
}
