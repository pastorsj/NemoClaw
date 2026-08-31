// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { readOpenClawStartupSource } from "../helpers/startup";

const packageRoot = path.resolve(import.meta.dirname, "../..");

describe("OpenClaw runtime hardening", () => {
  it("disables jiti filesystem cache in base, runtime, and connect shells", () => {
    const baseSource = fs.readFileSync(path.join(packageRoot, "Dockerfile.base"), "utf-8");
    const runtimeSource = fs.readFileSync(path.join(packageRoot, "Dockerfile"), "utf-8");
    const startSource = readOpenClawStartupSource();

    expect(baseSource).toContain("ENV JITI_FS_CACHE=false");
    expect(runtimeSource).toContain("ENV JITI_FS_CACHE=false");
    expect(startSource).toContain('export JITI_FS_CACHE="false"');
  });

  it.each([{ scenario: "base image" }, { scenario: "runtime image" }])(
    "disables EC2 metadata credential discovery across image, startup, and shell boundaries [$scenario]",
    ({ scenario }) => {
      const baseSource = fs.readFileSync(path.join(packageRoot, "Dockerfile.base"), "utf-8");
      const runtimeSource = fs.readFileSync(path.join(packageRoot, "Dockerfile"), "utf-8");
      const startSource = readOpenClawStartupSource();

      expect(baseSource).toContain("ENV AWS_EC2_METADATA_DISABLED=true");
      expect(runtimeSource).toContain("ENV AWS_EC2_METADATA_DISABLED=true");
      const baseRuntimeStageStart = baseSource.lastIndexOf("\nFROM ");
      expect(baseRuntimeStageStart).toBeGreaterThan(-1);
      const runtimeStageStart = runtimeSource.indexOf("# Stage 3: Runtime image");
      expect(runtimeStageStart).toBeGreaterThan(-1);
      const [source, stageStart] = (
        {
          "base image": [baseSource, baseRuntimeStageStart],
          "runtime image": [runtimeSource, runtimeStageStart],
        } as const
      )[scenario]!;
      const fromIndex = source.indexOf("\nFROM ", stageStart);
      expect(fromIndex).toBeGreaterThan(-1);
      const firstRunIndex = source.indexOf("\nRUN ", fromIndex);
      expect(firstRunIndex).toBeGreaterThan(-1);
      const metadataEnvIndex = source.indexOf("ENV AWS_EC2_METADATA_DISABLED=true", fromIndex);
      expect(metadataEnvIndex).toBeGreaterThan(fromIndex);
      expect(metadataEnvIndex).toBeLessThan(firstRunIndex);

      expect(startSource).toContain("export AWS_EC2_METADATA_DISABLED=true");
      expect(startSource).toContain('export AWS_EC2_METADATA_DISABLED="true"');
    },
  );
});
