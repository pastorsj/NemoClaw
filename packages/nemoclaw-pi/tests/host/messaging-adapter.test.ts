// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type { HarnessMessagingAdapterModule } from "@nvidia/nemoclaw-harness-contract";
import { loadPackageHostModule } from "../helpers/host-module";

const adapter = loadPackageHostModule<HarnessMessagingAdapterModule>("messaging-adapter.cts");

describe("Pi messaging adapter", () => {
  it("explicitly disables messaging for the terminal-only harness", () => {
    expect(adapter.describeMessagingIntegration({ packageId: "pi" })).toEqual({
      kind: "disabled",
      packageId: "pi",
      reason: "Pi does not provide a long-running messaging bridge.",
    });
  });
});
