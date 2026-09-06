// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type {
  HarnessMessagingAdapterModule,
  HarnessMessagingChannelProfile,
} from "@nvidia/nemoclaw-harness-contract";
import { loadPackageHostModule } from "../helpers/host-module";

const adapter = loadPackageHostModule<HarnessMessagingAdapterModule>("messaging-adapter.cts");
const profiles = JSON.parse(
  fs.readFileSync(path.resolve("messaging/profile.json"), "utf8"),
) as HarnessMessagingChannelProfile[];

describe("Hermes messaging adapter", () => {
  it("describes every package-supported channel without host capabilities", () => {
    expect(adapter.describeMessagingIntegration({ packageId: "hermes" })).toEqual({
      kind: "channels",
      packageId: "hermes",
      channelIds: ["discord", "googlechat", "slack", "teams", "telegram", "wechat", "whatsapp"],
      profilePath: "messaging/profile.json",
      build: {
        configRoot: "~/.hermes",
        packageManagers: ["python-package"],
        renderFinalizers: ["inherit-api-server-toolsets"],
        postCreateCredentialReconciliation: "restart-runtime",
        degradedDiagnostics: "gateway-log-tail",
      },
    });
  });

  it("rejects a request for another package", () => {
    expect(() => adapter.describeMessagingIntegration({ packageId: "another-package" })).toThrow(
      "does not match this package",
    );
  });

  it("owns Hermes config, policy, and lifecycle differences as package data", () => {
    const telegram = profiles.find(({ channelId }) => channelId === "telegram");
    expect(telegram?.config.renders.map(({ target }) => target)).toEqual([
      "~/.hermes/.env",
      "~/.hermes/config.yaml",
      "~/.hermes/config.yaml",
    ]);
    expect(telegram?.policy).toEqual([
      { presetName: "telegram", policyKeys: ["telegram"], requiredAtCreate: true },
    ]);
    expect(telegram?.lifecycle.runtime).toBeUndefined();
    expect(
      profiles
        .flatMap(({ lifecycle }) => lifecycle.packageInstalls ?? [])
        .every(({ manager }) => manager === "python-package"),
    ).toBe(true);
  });
});
