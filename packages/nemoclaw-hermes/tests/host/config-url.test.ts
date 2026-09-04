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
    name: "allows the exact model base URL through a relative path",
    key: "model",
    relativePath: ["base_url"],
    allowOpenShellBridge: true,
  },
  {
    name: "allows the exact model base URL when the root key contains path segments",
    key: "model.base_url",
    relativePath: [],
    allowOpenShellBridge: true,
  },
  {
    name: "denies a sibling model field",
    key: "model",
    relativePath: ["api_base"],
    allowOpenShellBridge: false,
  },
  {
    name: "denies a model URL at the wrong depth",
    key: "model",
    relativePath: ["endpoint", "base_url"],
    allowOpenShellBridge: false,
  },
  {
    name: "denies a nested object path",
    key: "model",
    relativePath: ["endpoints", "primary", "base_url"],
    allowOpenShellBridge: false,
  },
  {
    name: "denies a nested array path",
    key: "model",
    relativePath: ["endpoints", "0", "base_url"],
    allowOpenShellBridge: false,
  },
] as const;

describe("Hermes configuration URL policy", () => {
  it.each(urlCases)("$name", ({ key, relativePath, allowOpenShellBridge }) => {
    expect(adapter.classifyConfigUrl({ config: {}, key, relativePath })).toEqual({
      allowPrivateUrls: false,
      allowOpenShellBridge,
    });
  });

  it("allows private URLs only when the package configuration opts in", () => {
    expect(
      adapter.classifyConfigUrl({
        config: { security: { allow_private_urls: true } },
        key: "unrelated",
        relativePath: ["url"],
      }),
    ).toEqual({ allowPrivateUrls: true, allowOpenShellBridge: false });
  });

  it.each(["__proto__", "constructor", "prototype", "toString", "hasOwnProperty"])(
    "denies the reserved segment %s",
    (segment) => {
      expect(
        adapter.classifyConfigUrl({
          config: {},
          key: "model",
          relativePath: [segment, "base_url"],
        }),
      ).toEqual({ allowPrivateUrls: false, allowOpenShellBridge: false });
    },
  );
});
