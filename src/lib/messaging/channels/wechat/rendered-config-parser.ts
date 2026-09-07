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

const ACCOUNT_IDS_KEY = "accountIds";

export const wechatRenderedConfigParser: RenderedChannelConfigParser = {
  listConfigVisibilityKeys(context) {
    return (
      listPackageConfigVisibilityKeys(context) ?? listLegacyRenderedConfigKeys("wechat", context)
    );
  },

  getValue(key, source) {
    if (key.key === ACCOUNT_IDS_KEY) return accountIds(source, key);
    return key.kind === "env"
      ? getEnvConfigValue(source, key.envKey)
      : getStructuredConfigValue(source, key.path);
  },
};

function accountIds(
  source: RenderedConfigSource,
  key: RenderedConfigVisibilityKey,
): string[] | undefined {
  const value = getStructuredConfigValue(source, key.path);
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const accountIds = Object.keys(value);
  return accountIds.length > 0 ? accountIds : undefined;
}
