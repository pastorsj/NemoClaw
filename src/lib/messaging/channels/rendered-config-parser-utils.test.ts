// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type { ChannelManifest } from "../manifest";
import { listPackageConfigVisibilityKeys } from "./rendered-config-parser-utils";

describe("package rendered config visibility", () => {
  it("projects a synthetic unknown package without a core package dispatch", () => {
    const manifest = {
      configVisibility: [
        {
          inputId: "workspace",
          target: "~/.future-harness/accounts/{{input}}.json",
          targetInputId: "accountId",
          kind: "structured",
          path: ["workspace"],
          whenInput: { inputId: "mode", equals: "managed", defaultValue: "managed" },
        },
      ],
    } as unknown as ChannelManifest;

    expect(
      listPackageConfigVisibilityKeys({
        manifest,
        agentId: "future-harness",
        inputs: [
          {
            channelId: "future-chat",
            inputId: "accountId",
            kind: "config",
            required: true,
            value: "team-7",
          },
        ],
      }),
    ).toEqual([
      {
        key: "workspace",
        inputId: "workspace",
        target: "~/.future-harness/accounts/team-7.json",
        kind: "structured",
        path: ["workspace"],
      },
    ]);
  });

  it("fails closed on unsafe dynamic targets and distinguishes package-owned empty metadata", () => {
    const manifest = {
      configVisibility: [
        {
          inputId: "workspace",
          target: "~/.future-harness/accounts/{{input}}.json",
          targetInputId: "accountId",
          kind: "structured",
          path: ["workspace"],
        },
      ],
    } as unknown as ChannelManifest;
    const context = {
      manifest,
      agentId: "future-harness",
      inputs: [
        {
          channelId: "future-chat",
          inputId: "accountId",
          kind: "config" as const,
          required: true,
          value: "../escape",
        },
      ],
    };

    expect(listPackageConfigVisibilityKeys(context)).toEqual([]);
    expect(
      listPackageConfigVisibilityKeys({
        ...context,
        manifest: { configVisibility: [] } as unknown as ChannelManifest,
      }),
    ).toEqual([]);
    expect(
      listPackageConfigVisibilityKeys({ ...context, manifest: {} as ChannelManifest }),
    ).toBeNull();
  });
});
