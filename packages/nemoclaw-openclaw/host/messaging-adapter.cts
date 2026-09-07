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
        return {
            kind: "channels",
            packageId: PACKAGE_ID,
            channelIds: CHANNEL_IDS,
            profilePath: "messaging/profile.json",
            build: {
                configRoot: "~/.openclaw",
                packageManagers: ["node-package"],
                packageInstallers: {
                    "node-package": {
                        kind: "verified-archive-command",
                        command: ["openclaw", "plugins", "install", "{{archive}}"],
                        archiveArgumentPrefix: "npm-pack:",
                        packageVersionEnvironment: "OPENCLAW_VERSION",
                    },
                },
                renderFinalizers: ["allow-rendered-plugins"],
                postRenderRepair: {
                    command: ["openclaw", "doctor", "--fix", "--non-interactive"],
                },
                nodeArchiveRemediation: "package-helper",
                credentialPolicyReconciliation: "teams-outlook-shared-login",
            },
        };
    },
};
module.exports = messagingAdapter;
