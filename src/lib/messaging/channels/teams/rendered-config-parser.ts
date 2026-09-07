// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  getEnvConfigValue,
  getStructuredConfigValue,
  listPackageConfigVisibilityKeys,
  type RenderedChannelConfigParser,
} from "../rendered-config-parser-utils";
import { listLegacyRenderedConfigKeys } from "../legacy/rendered-config";

export const teamsRenderedConfigParser: RenderedChannelConfigParser = {
  listConfigVisibilityKeys(context) {
    return (
      listPackageConfigVisibilityKeys(context) ?? listLegacyRenderedConfigKeys("teams", context)
    );
  },

  getValue(key, source) {
    return key.kind === "env"
      ? getEnvConfigValue(source, key.envKey)
      : getStructuredConfigValue(source, key.path);
  },
};
