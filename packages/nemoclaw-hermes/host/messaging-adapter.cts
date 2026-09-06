// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
"use strict";
const PACKAGE_ID = "hermes";
const CHANNEL_IDS = [
    "discord",
    "googlechat",
    "slack",
    "teams",
    "telegram",
    "wechat",
    "whatsapp",
];
const messagingAdapter = {
    describeMessagingIntegration(request) {
        if (request.packageId !== PACKAGE_ID) {
            throw new Error("Hermes messaging request does not match this package");
        }
        return {
            kind: "channels",
            packageId: PACKAGE_ID,
            channelIds: CHANNEL_IDS,
            profilePath: "messaging/profile.json",
            build: {
                configRoot: "~/.hermes",
                packageManagers: ["python-package"],
                renderFinalizers: ["inherit-api-server-toolsets"],
                postCreateCredentialReconciliation: "restart-runtime",
                degradedDiagnostics: "gateway-log-tail",
            },
        };
    },
};
module.exports = messagingAdapter;
