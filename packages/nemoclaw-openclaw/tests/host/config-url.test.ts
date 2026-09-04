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

const urlCases = [
  {
    name: "allows the exact provider base URL through a relative path",
    key: "models",
    relativePath: ["providers", "nvidia", "baseUrl"],
    allowOpenShellBridge: true,
  },
  {
    name: "allows the exact provider base URL when the root key contains path segments",
    key: "models.providers",
    relativePath: ["nvidia", "baseUrl"],
    allowOpenShellBridge: true,
  },
  {
    name: "denies a sibling provider field",
    key: "models",
    relativePath: ["providers", "nvidia", "apiKey"],
    allowOpenShellBridge: false,
  },
  {
    name: "denies a provider URL at the wrong depth",
    key: "models",
    relativePath: ["providers", "nvidia", "endpoint", "baseUrl"],
    allowOpenShellBridge: false,
  },
  {
    name: "denies a nested object path",
    key: "models",
    relativePath: ["providers", "nvidia", "endpoints", "primary", "baseUrl"],
    allowOpenShellBridge: false,
  },
  {
    name: "denies an array index as a provider identifier",
    key: "models",
    relativePath: ["providers", "0", "baseUrl"],
    allowOpenShellBridge: false,
  },
] as const;

describe("OpenClaw configuration URL policy", () => {
  it.each(urlCases)("$name", ({ key, relativePath, allowOpenShellBridge }) => {
    expect(adapter.classifyConfigUrl({ config: {}, key, relativePath })).toEqual({
      allowPrivateUrls: false,
      allowOpenShellBridge,
    });
  });

  it.each(["__proto__", "constructor", "prototype", "toString", "hasOwnProperty"])(
    "denies the reserved provider segment %s",
    (provider) => {
      expect(
        adapter.classifyConfigUrl({
          config: {},
          key: "models",
          relativePath: ["providers", provider, "baseUrl"],
        }),
      ).toEqual({ allowPrivateUrls: false, allowOpenShellBridge: false });
    },
  );
});
