// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const PACKAGE_ROOT = path.resolve(import.meta.dirname, "../..");

describe("Pi live contract fixture", () => {
  it("supplies the generic public Fabric journey without a core harness switch", () => {
    const contract = JSON.parse(
      fs.readFileSync(path.join(PACKAGE_ROOT, "tests", "fixtures", "live-contract.json"), "utf8"),
    ) as Record<string, unknown>;

    expect(contract).toEqual(
      expect.objectContaining({
        packageId: "pi",
        adapterId: "nvidia.nemoclaw.pi",
        artifactRoot: "/sandbox/.pi/agent/fabric-artifacts",
        configPath: "/sandbox/.pi/agent/fabric.json",
        descriptorRunnerModule: "nemoclaw_pi_fabric.adapter",
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
