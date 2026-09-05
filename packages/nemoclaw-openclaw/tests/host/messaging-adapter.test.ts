// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type { HarnessMessagingAdapterModule } from "@nvidia/nemoclaw-harness-contract";
import { loadPackageHostModule } from "../helpers/host-module";

const adapter = loadPackageHostModule<HarnessMessagingAdapterModule>("messaging-adapter.cts");

describe("OpenClaw messaging adapter", () => {
  it("describes every package-supported channel without host capabilities", () => {
    expect(adapter.describeMessagingIntegration({ packageId: "openclaw" })).toEqual({
      kind: "channels",
      packageId: "openclaw",
      channelIds: ["discord", "googlechat", "slack", "teams", "telegram", "wechat", "whatsapp"],
    });
  });

  it("rejects a request for another package", () => {
    expect(() => adapter.describeMessagingIntegration({ packageId: "another-package" })).toThrow(
      "does not match this package",
    );
  });
});
