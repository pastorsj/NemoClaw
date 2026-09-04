// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { loadPackageHostModule } from "../helpers/host-module";

interface ConfigUrlPolicy {
  readonly allowPrivateUrls: boolean;
  readonly allowOpenShellBridge: boolean;
}

interface ConfigUrlAdapter {
  classifyConfigUrl(request: {
    readonly config: Readonly<Record<string, unknown>>;
    readonly key: string;
    readonly relativePath: readonly string[];
  }): ConfigUrlPolicy;
}

const adapter = loadPackageHostModule<ConfigUrlAdapter>("config-adapter.cts");

describe("Deep Agents Code configuration URL policy", () => {
  it.each([
    ["model base URL", "model", ["base_url"]],
    ["OpenClaw provider base URL", "models", ["providers", "nvidia", "baseUrl"]],
    ["nested array URL", "providers", ["0", "base_url"]],
    ["reserved segment", "model", ["__proto__", "base_url"]],
  ] as const)("denies %s", (_name, key, relativePath) => {
    expect(adapter.classifyConfigUrl({ config: {}, key, relativePath })).toEqual({
      allowPrivateUrls: false,
      allowOpenShellBridge: false,
    });
  });
});
