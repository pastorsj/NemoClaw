// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { HarnessMessagingAdapterModule } from "@nvidia/nemoclaw-harness-contract";

const PACKAGE_ID = "hermes";
const CHANNEL_IDS = [
  "discord",
  "googlechat",
  "slack",
  "teams",
  "telegram",
  "wechat",
  "whatsapp",
] as const;

const messagingAdapter: HarnessMessagingAdapterModule = {
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
        packageInstallers: {
          "python-package": {
            kind: "batched-command",
            command: [
              "uv",
              "pip",
              "install",
              "--python",
              "/opt/hermes/.venv/bin/python",
              "--no-cache",
              "--",
              "{{packages}}",
            ],
            environment: {
              UV_SYSTEM_CERTS: "1",
              SSL_CERT_FILE: "/etc/ssl/certs/ca-certificates.crt",
            },
          },
        },
        renderFinalizers: ["inherit-api-server-toolsets"],
        postCreateCredentialReconciliation: "restart-runtime",
        degradedDiagnostics: "gateway-log-tail",
      },
    };
  },
};

export = messagingAdapter;
