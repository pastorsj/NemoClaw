// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { HarnessMessagingAdapterModule } from "@nvidia/nemoclaw-harness-contract";

const PACKAGE_ID = "pi";

const messagingAdapter: HarnessMessagingAdapterModule = {
  describeMessagingIntegration(request) {
    if (request.packageId !== PACKAGE_ID) {
      throw new Error("Pi messaging request does not match this package");
    }
    return {
      kind: "disabled",
      packageId: PACKAGE_ID,
      reason: "Pi does not provide a long-running messaging bridge.",
    };
  },
};

export = messagingAdapter;
