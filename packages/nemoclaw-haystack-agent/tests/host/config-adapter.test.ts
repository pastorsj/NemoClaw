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
  directory: "/sandbox/.haystack-agent",
  file: "fabric.json",
  format: "json",
  sensitiveFiles: [],
};

describe("Haystack Agent configuration adapter", () => {
  it("keeps the generated config immutable and denies URL exceptions", () => {
    expect(adapter.prepareConfigUpdate({ target })).toMatchObject({
      kind: "immutable",
      reason: expect.stringContaining("Re-onboard"),
    });
    expect(adapter.describeMutableConfig({ target })).toMatchObject({ kind: "not-required" });
    expect(
      adapter.classifyConfigUrl({ config: {}, key: "models", relativePath: ["base_url"] }),
    ).toEqual({ allowPrivateUrls: false, allowOpenShellBridge: false });
  });

  it("rejects a receipt target that does not match the manifest", () => {
    expect(() =>
      adapter.prepareConfigUpdate({ target: { ...target, directory: "/tmp/redirected" } }),
    ).toThrow("does not match its package manifest");
    expect(() =>
      adapter.describeMutableConfig({ target: { ...target, file: "other.json" } }),
    ).toThrow("does not match its package manifest");
  });
});
