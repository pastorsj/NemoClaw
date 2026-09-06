// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
"use strict";
const PACKAGE_ID = "haystack-agent";
const messagingAdapter = {
  describeMessagingIntegration(request) {
    if (request.packageId !== PACKAGE_ID) {
      throw new Error("Haystack Agent messaging request does not match this package");
    }
    return {
      kind: "disabled",
      packageId: PACKAGE_ID,
      reason: "Haystack Agent does not provide a long-running messaging bridge.",
    };
  },
};
module.exports = messagingAdapter;
