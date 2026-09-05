// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { listBundledAgentRuntimeSources } from "../../../../scripts/build-harnesses.mts";
import type { PublicFabricHarnessContract } from "../../../../test/e2e/live/public-fabric-turn.ts";
import liveContractFixture from "../fixtures/live-contract.json";

const liveContract: PublicFabricHarnessContract = liveContractFixture;

describe("Haystack Agent package discovery", () => {
  it("discovers the unknown package ID without a core catalogue branch", () => {
    const source = listBundledAgentRuntimeSources().find(({ id }) => id === "haystack-agent");
    expect(source).toMatchObject({
      id: "haystack-agent",
      displayName: "Haystack Agent (experimental)",
      manifestPath: "packages/nemoclaw-haystack-agent/manifest.yaml",
      packageVersion: "0.1.0",
    });
  });

  it("keeps the package fixture compatible with the generic live runner", () => {
    expect(liveContract.packageId).toBe("haystack-agent");
    expect(liveContract.descriptorRunnerModule).toBe("nemoclaw_haystack_fabric.adapter");
  });
});
