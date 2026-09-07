// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  envConfigKey,
  getEnvConfigValue,
  getStructuredConfigValue,
  getStructuredPath,
  listPackageConfigVisibilityKeys,
  type RenderedConfigSource,
  type RenderedConfigVisibilityKey,
  type RenderedChannelConfigParser,
} from "../rendered-config-parser-utils";
import { listLegacyRenderedConfigKeys } from "../legacy/rendered-config";

const ACCOUNT_PATH = ["channels", "telegram", "accounts", "default"] as const;

export const telegramRenderedConfigParser: RenderedChannelConfigParser = {
  listConfigVisibilityKeys(context) {
    return (
      listPackageConfigVisibilityKeys(context) ?? listLegacyRenderedConfigKeys("telegram", context)
    );
  },

  getValue(key, source) {
    if (key.key === "groupRequireMention") {
      return getGroupRequireMention(key, source);
    }
    return key.kind === "env"
      ? getEnvConfigValue(source, key.envKey)
      : getStructuredConfigValue(source, key.path);
  },
};

function getGroupRequireMention(
  key: RenderedConfigVisibilityKey,
  source: RenderedConfigSource,
): boolean | boolean[] | undefined {
  const accountGroupPolicy =
    source.kind === "structured"
      ? getStructuredPath(source.value, [...ACCOUNT_PATH, "groupPolicy"])
      : undefined;
  if (accountGroupPolicy !== "open") {
    return undefined;
  }

  const groups = getStructuredConfigValue(source, key.path);
  if (!groups || typeof groups !== "object" || Array.isArray(groups)) return false;

  const values = Object.values(groups)
    .map((group) =>
      group && typeof group === "object" && !Array.isArray(group)
        ? getStructuredPath(group, ["requireMention"])
        : undefined,
    )
    .filter((value): value is boolean => typeof value === "boolean");
  if (values.length === 0) return false;
  return [...new Set(values)].sort().length === 1 ? values[0] : [...new Set(values)].sort();
}
