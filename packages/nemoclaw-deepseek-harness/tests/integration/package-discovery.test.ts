// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from "node:module";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { listBundledAgentRuntimeSources } from "../../../../scripts/build-harnesses.mts";
import type { PublicFabricHarnessContract } from "../../../../test/e2e/live/public-fabric-turn.ts";
import deepSeekFabricE2eContract from "../fixtures/live-contract.json";

const PACKAGE_ROOT = path.resolve(import.meta.dirname, "../..");
const requireModule = createRequire(import.meta.url);

describe("DeepSeek Harness package discovery", () => {
  it("is discovered through the same manifest marker as existing harnesses", () => {
    const source = listBundledAgentRuntimeSources().find(({ id }) => id === "deepseek-harness");
    expect(source).toMatchObject({
      id: "deepseek-harness",
      displayName: "DeepSeek Harness (local POC)",
      manifestPath: "packages/nemoclaw-deepseek-harness/manifest.yaml",
      packageVersion: "0.1.0",
    });
  });

  it("provides the typed immutable adapter required by core config operations", () => {
    const adapter = requireModule(path.join(PACKAGE_ROOT, "host/config-adapter.cts")) as {
      prepareConfigUpdate(request: Record<string, unknown>): { kind: string };
    };
    expect(
      adapter.prepareConfigUpdate({
        target: {
          directory: "/sandbox/.deepseek-harness",
          file: "fabric.json",
          format: "json",
        },
      }),
    ).toMatchObject({ kind: "immutable" });
  });

  it("fits the existing generic live proof through its explicit contract path", () => {
    const contract: PublicFabricHarnessContract = deepSeekFabricE2eContract;
    expect(contract).toMatchObject({
      packageId: "deepseek-harness",
      adapterId: "nvidia.nemoclaw.deepseek-harness",
      descriptorRunnerModule: "nemoclaw_deepseek_fabric.adapter",
    });
  });
});
