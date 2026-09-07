// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  classifyPresetProvenance,
  formatPresetProvenanceSuffix,
  formatPresetProvenanceTag,
} from "./preset-provenance";

describe("live preset provenance", () => {
  it("labels agent baseline presets", () => {
    expect(classifyPresetProvenance("openclaw-pricing", { agentName: "openclaw" })).toEqual({
      source: "agent",
      agent: "openclaw",
    });
    expect(classifyPresetProvenance("nous-web", { agentName: "hermes" })).toEqual({
      source: "agent",
      agent: "hermes",
    });
  });

  it("labels every other live preset as operator-added", () => {
    expect(classifyPresetProvenance("npm", { agentName: "openclaw" })).toEqual({ source: "user" });
    expect(formatPresetProvenanceTag({ source: "user" })).toBe("user-added");
  });

  it("uses receipt-owned presets without recognizing the harness identifier", () => {
    expect(
      classifyPresetProvenance("future-tools", {
        agentName: "future-harness",
        ownedPresetNames: ["future-tools"],
      }),
    ).toEqual({ source: "agent", agent: "future-harness" });
  });

  it("does not use legacy ownership when a receipt declares no owned presets", () => {
    expect(
      classifyPresetProvenance("openclaw-pricing", {
        agentName: "openclaw",
        ownedPresetNames: [],
      }),
    ).toEqual({ source: "user" });
  });

  it("reports provenance only when OpenShell confirms the active entry", () => {
    expect(
      formatPresetProvenanceSuffix("npm", {}, { active: true, observedInOpenShell: true }),
    ).toBe(" [user-added]");
    expect(
      formatPresetProvenanceSuffix("npm", {}, { active: true, observedInOpenShell: null }),
    ).toBe(" [source unverified (gateway unreachable)]");
    expect(
      formatPresetProvenanceSuffix("npm", {}, { active: false, observedInOpenShell: false }),
    ).toBe("");
  });
});
