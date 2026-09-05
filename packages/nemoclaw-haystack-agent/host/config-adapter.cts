// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const CONFIG_DIRECTORY = "/sandbox/.haystack-agent";
const CONFIG_FILE = "fabric.json";

function requireTarget(target) {
  if (
    target.directory !== CONFIG_DIRECTORY ||
    target.file !== CONFIG_FILE ||
    target.format !== "json"
  ) {
    throw new Error("Haystack Agent configuration target does not match its package manifest");
  }
}

function prepareConfigUpdate(request) {
  requireTarget(request.target);
  return {
    kind: "immutable",
    reason: "The sandbox image generates the Haystack Agent config. Re-onboard to change it.",
  };
}

function classifyConfigUrl() {
  return { allowPrivateUrls: false, allowOpenShellBridge: false };
}

function describeMutableConfig(request) {
  requireTarget(request.target);
  return {
    kind: "not-required",
    reason: "The sandbox image owns the private Haystack Agent config.",
  };
}

module.exports = {
  classifyConfigUrl,
  describeMutableConfig,
  prepareConfigUpdate,
};
