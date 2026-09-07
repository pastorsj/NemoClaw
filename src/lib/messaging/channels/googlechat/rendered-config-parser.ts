// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  getStructuredConfigValue,
  listPackageConfigVisibilityKeys,
  type RenderedChannelConfigParser,
} from "../rendered-config-parser-utils";
import { listLegacyRenderedConfigKeys } from "../legacy/rendered-config";

export const googlechatRenderedConfigParser: RenderedChannelConfigParser = {
  listConfigVisibilityKeys(context) {
    return (
      listPackageConfigVisibilityKeys(context) ??
      listLegacyRenderedConfigKeys("googlechat", context)
    );
  },

  getValue(key, source) {
    return getStructuredConfigValue(source, key.path);
  },
};
