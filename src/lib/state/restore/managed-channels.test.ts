// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type { ChannelManifest } from "../../messaging/manifest";
import { listManagedChannelNames } from "./managed-channels";

describe("managed configuration channel names", () => {
  it("derives built-in channel names from the selected agent runtime", () => {
    expect(listManagedChannelNames("hermes")).toEqual([
      "telegram",
      "discord",
      "wechat",
      "slack",
      "whatsapp",
      "teams",
      "googlechat",
    ]);
  });

  it("uses native channel names without adding a known-agent branch", () => {
    const manifests = [
      {
        id: "matrix",
        supportedAgents: ["future-agent"],
        runtime: { "future-agent": { channelName: "matrix-runtime" } },
      },
    ] as unknown as readonly ChannelManifest[];

    expect(listManagedChannelNames("future-agent", manifests)).toEqual(["matrix-runtime"]);
    expect(listManagedChannelNames("another-agent", manifests)).toEqual([]);
  });
});
