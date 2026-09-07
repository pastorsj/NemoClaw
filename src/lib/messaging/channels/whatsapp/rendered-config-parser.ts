// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { listLegacyRenderedConfigKeys } from "../legacy/rendered-config";
import {
  getEnvConfigValue,
  listPackageConfigVisibilityKeys,
  type RenderedChannelConfigParser,
} from "../rendered-config-parser-utils";

export const whatsappRenderedConfigParser: RenderedChannelConfigParser = {
  listConfigVisibilityKeys(context) {
    return (
      listPackageConfigVisibilityKeys(context) ?? listLegacyRenderedConfigKeys("whatsapp", context)
    );
  },

  getValue(key, source) {
    return getEnvConfigValue(source, key.envKey);
  },
};
