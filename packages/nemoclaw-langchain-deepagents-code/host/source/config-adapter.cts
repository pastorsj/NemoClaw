// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { HarnessConfigAdapterModule } from "@nvidia/nemoclaw-harness-contract";

const configAdapter: HarnessConfigAdapterModule = {
  describeInferenceConfig() {
    return {
      kind: "unsupported",
      reason: "This configuration is materialized by the sandbox image. Re-onboard to change it.",
    };
  },

  prepareInferenceConfig() {
    return {
      kind: "unsupported",
      reason: "This configuration is materialized by the sandbox image. Re-onboard to change it.",
    };
  },

  prepareConfigUpdate() {
    return {
      kind: "immutable",
      reason: "This configuration is materialized by the sandbox image. Re-onboard to change it.",
    };
  },

  classifyConfigUrl() {
    return { allowPrivateUrls: false, allowOpenShellBridge: false };
  },

  describeMutableConfig() {
    return {
      kind: "not-required",
      reason: "The image owns this terminal runtime configuration.",
    };
  },
};

export = configAdapter;
