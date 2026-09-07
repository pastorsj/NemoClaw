// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from "node:module";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { listBundledAgentRuntimeSources } from "../../../../scripts/build-harnesses.mts";

const PACKAGE_ROOT = path.resolve(import.meta.dirname, "../..");
const requireModule = createRequire(import.meta.url);

describe("Pi package discovery", () => {
  it("exposes the package through NemoClaw's bundled package inventory", () => {
    const source = listBundledAgentRuntimeSources().find(({ id }) => id === "pi");
    expect(source).toMatchObject({
      id: "pi",
      displayName: "Pi",
      manifestPath: "manifest.yaml",
      packageVersion: "0.1.0",
    });
  });

  it("ships an immutable typed configuration adapter", () => {
    const adapter = requireModule(path.join(PACKAGE_ROOT, "host/config-adapter.cts")) as {
      prepareConfigUpdate(request: Record<string, unknown>): { kind: string; reason: string };
      classifyConfigUrl(request: Record<string, unknown>): {
        allowPrivateUrls: boolean;
        allowOpenShellBridge: boolean;
      };
      describeMutableConfig(request: Record<string, unknown>): { kind: string; reason: string };
    };
    const target = {
      directory: "/sandbox/.pi/agent",
      file: "models.json",
      format: "json",
      sensitiveFiles: ["/sandbox/.pi/agent/.config-hash"],
    };

    expect(adapter.prepareConfigUpdate({ target })).toMatchObject({
      kind: "immutable",
      reason: expect.stringContaining("Re-onboard"),
    });
    expect(adapter.classifyConfigUrl({})).toEqual({
      allowPrivateUrls: false,
      allowOpenShellBridge: false,
    });
    expect(adapter.describeMutableConfig({ target })).toMatchObject({
      kind: "not-required",
    });
  });
});
