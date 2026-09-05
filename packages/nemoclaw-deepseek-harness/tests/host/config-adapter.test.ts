// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { loadPackageHostModule } from "../helpers/host-module";

interface ConfigAdapter {
  prepareConfigUpdate(request: Record<string, unknown>): { kind: string; reason: string };
  classifyConfigUrl(request: Record<string, unknown>): {
    allowPrivateUrls: boolean;
    allowOpenShellBridge: boolean;
  };
  describeMutableConfig(request: Record<string, unknown>): { kind: string; reason: string };
}

const adapter = loadPackageHostModule<ConfigAdapter>("config-adapter.cts");
const target = {
  directory: "/sandbox/.deepseek-harness",
  file: "fabric.json",
  format: "json",
  sensitiveFiles: ["/sandbox/.deepseek-harness/.config-hash"],
};

describe("DeepSeek Harness configuration ownership", () => {
  it("refuses generic mutation of the image-generated Fabric route", () => {
    expect(adapter.prepareConfigUpdate({ target })).toMatchObject({ kind: "immutable" });
    expect(adapter.describeMutableConfig({ target })).toMatchObject({ kind: "not-required" });
  });

  it("does not widen URL access for any nested setting", () => {
    expect(
      adapter.classifyConfigUrl({ config: {}, key: "models", relativePath: ["base_url"] }),
    ).toEqual({ allowPrivateUrls: false, allowOpenShellBridge: false });
  });

  it("rejects a receipt target that does not match the manifest", () => {
    expect(() =>
      adapter.prepareConfigUpdate({ target: { ...target, file: "other.json" } }),
    ).toThrow(/does not match/u);
  });
});
