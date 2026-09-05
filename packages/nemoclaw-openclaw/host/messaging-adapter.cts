// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
"use strict";
const PACKAGE_ID = "openclaw";
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
            throw new Error("OpenClaw messaging request does not match this package");
        }
        return { kind: "channels", packageId: PACKAGE_ID, channelIds: CHANNEL_IDS };
    },
};
module.exports = messagingAdapter;
