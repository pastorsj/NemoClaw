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
    return { kind: "channels", packageId: PACKAGE_ID, channelIds: CHANNEL_IDS };
  },
};

export = messagingAdapter;
