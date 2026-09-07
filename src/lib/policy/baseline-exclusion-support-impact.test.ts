// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

import { describe, expect, it } from "vitest";

import {
  getBaselineExclusionFeatureImpact,
  isProtectedBaselineExclusionKey,
  listBaselineEntryKeys,
} from "./baseline-exclusion";

const BASELINES = [
  {
    agent: "openclaw",
    path: "nemoclaw-blueprint/policies/openclaw-sandbox.yaml",
  },
  {
    agent: "hermes",
    path: "packages/nemoclaw-hermes/policy-additions.yaml",
  },
  {
    agent: "langchain-deepagents-code",
    path: "packages/nemoclaw-langchain-deepagents-code/policy-additions.yaml",
  },
] as const;

describe("baseline exclusion supported-feature disclosure (#7178)", () => {
  it("names the affected Hermes feature for nous_research", () => {
    expect(getBaselineExclusionFeatureImpact({ agent: "hermes" }, "nous_research")).toBe(
      "Hermes public metadata lookup and agent updates may stop working.",
    );
  });

  it("names a different affected feature for another baseline entry", () => {
    expect(getBaselineExclusionFeatureImpact({ agent: "openclaw" }, "npm_registry")).toBe(
      "OpenClaw plugin installation from npm may stop working.",
    );
  });

  it.each(BASELINES)(
    "defines an impact for every excludable $agent baseline entry",
    ({ agent, path }) => {
      const content = fs.readFileSync(path, "utf8");
      const excludableKeys = listBaselineEntryKeys(content).filter(
        (key) => !isProtectedBaselineExclusionKey(key),
      );

      expect(excludableKeys).not.toHaveLength(0);
      expect(
        excludableKeys.every((key) => getBaselineExclusionFeatureImpact({ agent }, key) !== null),
      ).toBe(true);
    },
  );

  it("returns no disclosure for an unreviewed baseline entry", () => {
    expect(getBaselineExclusionFeatureImpact({ agent: "hermes" }, "future_entry")).toBeNull();
  });

  it("uses receipt policy metadata without recognizing the harness identifier", () => {
    expect(
      getBaselineExclusionFeatureImpact(
        {
          agent: "future-harness",
          policyCapability: {
            owned_presets: [],
            automatic_presets: [],
            baseline_exclusion_impacts: {
              future_entry: "A future harness feature may stop working.",
            },
          },
        },
        "future_entry",
      ),
    ).toBe("A future harness feature may stop working.");
  });

  it("does not fall back to legacy metadata for a receipt-backed package", () => {
    expect(
      getBaselineExclusionFeatureImpact(
        {
          agent: "openclaw",
          policyCapability: {
            owned_presets: [],
            automatic_presets: [],
            baseline_exclusion_impacts: {},
          },
        },
        "npm_registry",
      ),
    ).toBeNull();
  });
});
