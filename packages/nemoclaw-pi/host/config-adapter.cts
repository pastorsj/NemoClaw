// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
"use strict";
const CONFIG_DIRECTORY = "/sandbox/.pi/agent";
const CONFIG_FILE = "models.json";
function requireTarget(target) {
    if (target.directory !== CONFIG_DIRECTORY ||
        target.file !== CONFIG_FILE ||
        target.format !== "json") {
        throw new Error("Pi configuration target does not match its package manifest");
    }
}
const configAdapter = {
    describeInferenceConfig(request) {
        requireTarget(request.target);
        return {
            kind: "unsupported",
            reason: "The sandbox image generates the Pi model catalog. Re-onboard to change it.",
        };
    },
    prepareInferenceConfig(request) {
        requireTarget(request.target);
        return {
            kind: "unsupported",
            reason: "The sandbox image generates the Pi model catalog. Re-onboard to change it.",
        };
    },
    prepareConfigUpdate(request) {
        requireTarget(request.target);
        return {
            kind: "immutable",
            reason: "The sandbox image generates the Pi model catalog. Re-onboard to change it.",
        };
    },
    classifyConfigUrl() {
        return { allowPrivateUrls: false, allowOpenShellBridge: false };
    },
    describeMutableConfig(request) {
        requireTarget(request.target);
        return {
            kind: "not-required",
            reason: "The sandbox image owns the private Pi model catalog.",
        };
    },
};
module.exports = configAdapter;
