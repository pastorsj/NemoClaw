// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

function prepareConfigUpdate() {
  return {
    kind: "immutable",
    reason: "This configuration is materialized by the sandbox image. Re-onboard to change it.",
  };
}

function classifyConfigUrl() {
  return { allowPrivateUrls: false, allowOpenShellBridge: false };
}

function describeMutableConfig() {
  return {
    kind: "not-required",
    reason: "The image owns this terminal runtime configuration.",
  };
}

module.exports = {
  classifyConfigUrl,
  describeMutableConfig,
  prepareConfigUpdate,
};
