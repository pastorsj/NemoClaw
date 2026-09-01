// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { listBundledAgentRuntimeSources } from "../../../../scripts/build-harnesses.mts";

describe("Pi package discovery", () => {
  it("exposes the package through NemoClaw's bundled package inventory", () => {
    const source = listBundledAgentRuntimeSources().find(({ id }) => id === "pi");
    expect(source).toMatchObject({
      id: "pi",
      displayName: "Pi",
      manifestPath: "packages/nemoclaw-pi/manifest.yaml",
      packageVersion: "0.1.0",
    });
  });
});
