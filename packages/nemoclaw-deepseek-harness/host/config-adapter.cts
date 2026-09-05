// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
"use strict";
const CONFIG_DIRECTORY = "/sandbox/.deepseek-harness";
const CONFIG_FILE = "fabric.json";
function requireConfigTarget(target) {
    if (target.directory !== CONFIG_DIRECTORY ||
        target.file !== CONFIG_FILE ||
        target.format !== "json") {
        throw new Error("DeepSeek Harness configuration target does not match its manifest");
    }
}
const configAdapter = {
    describeInferenceConfig(request) {
        requireConfigTarget(request.target);
        return {
            kind: "immutable",
            reason: "The sandbox image owns its Fabric route. Re-onboard to change it.",
        };
    },
    prepareConfigUpdate(request) {
        requireConfigTarget(request.target);
        return {
            kind: "immutable",
            reason: "The sandbox image owns its Fabric route. Re-onboard to change it.",
        };
    },
    classifyConfigUrl() {
        return { allowPrivateUrls: false, allowOpenShellBridge: false };
    },
    describeMutableConfig(request) {
        requireConfigTarget(request.target);
        return {
            kind: "not-required",
            reason: "The package generates its private Fabric configuration.",
        };
    },
};
module.exports = configAdapter;
