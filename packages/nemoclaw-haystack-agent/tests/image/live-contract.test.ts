// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const PACKAGE_ROOT = path.resolve(import.meta.dirname, "../..");

describe("Haystack Agent live contract fixture", () => {
  it("supplies the generic public Fabric turn without a core agent switch", () => {
    const contract = JSON.parse(
      fs.readFileSync(path.join(PACKAGE_ROOT, "tests", "fixtures", "live-contract.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(contract).toEqual(
      expect.objectContaining({
        packageId: "haystack-agent",
        adapterId: "nvidia.nemoclaw.haystack-agent",
        configPath: "/sandbox/.haystack-agent/fabric.json",
        descriptorRunnerModule: "nemoclaw_haystack_fabric.adapter",
      }),
    );
    expect(Object.keys(contract).sort()).toEqual(
      [
        "$comment",
        "adapterId",
        "artifactRoot",
        "configPath",
        "descriptorGlob",
        "descriptorPathPrefix",
        "descriptorRunnerModule",
        "packageId",
        "processMarkers",
      ].sort(),
    );
  });
});
