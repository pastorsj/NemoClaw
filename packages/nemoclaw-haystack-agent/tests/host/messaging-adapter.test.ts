// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type { HarnessMessagingAdapterModule } from "@nvidia/nemoclaw-harness-contract";
import { loadPackageHostModule } from "../helpers/host-module";

const adapter = loadPackageHostModule<HarnessMessagingAdapterModule>("messaging-adapter.cts");

describe("Haystack Agent messaging adapter", () => {
  it("explicitly disables messaging until the harness owns a bridge", () => {
    expect(adapter.describeMessagingIntegration({ packageId: "haystack-agent" })).toEqual({
      kind: "disabled",
      packageId: "haystack-agent",
      reason: "Haystack Agent does not provide a long-running messaging bridge.",
    });
  });
});
