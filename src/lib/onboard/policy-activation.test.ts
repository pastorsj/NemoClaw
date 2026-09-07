// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { HarnessPolicyCapability } from "@nvidia/nemoclaw-harness-contract";
import { describe, expect, it } from "vitest";

import {
  evaluatePackagePolicyPresets,
  mergeAutomaticPackagePolicyPresets,
} from "./policy-authority/package-activation";
import { createUnavailablePolicyPresetPruner } from "./policy-preset-reconciliation";

const capability: HarnessPolicyCapability = {
  owned_presets: ["future-required", "future-traces", "future-metrics"],
  automatic_presets: [
    {
      name: "future-required",
      activation: { kind: "always" },
      apply_during_create: false,
      suppress_in_tiers: ["personal"],
    },
    {
      name: "future-traces",
      activation: { kind: "observability-enabled" },
      apply_during_create: true,
      suppress_in_tiers: ["restricted"],
    },
    {
      name: "future-metrics",
      activation: {
        kind: "local-endpoint-enabled",
        enabled_environment: "FUTURE_METRICS_ENABLED",
        endpoint_environment: "FUTURE_METRICS_ENDPOINT",
        default_endpoint: "http://host.openshell.internal:4318",
        local_origin: "http://host.openshell.internal:4318",
      },
      apply_during_create: true,
      suppress_in_tiers: ["restricted"],
    },
  ],
  baseline_exclusion_impacts: {},
};

describe("receipt-declared policy activation", () => {
  it("evaluates an unknown package without a harness-name branch", () => {
    const result = evaluatePackagePolicyPresets(capability, {
      observabilityEnabled: true,
      tierName: "balanced",
      env: {
        FUTURE_METRICS_ENABLED: "yes",
        FUTURE_METRICS_ENDPOINT: "host.openshell.internal:4318/v1/traces",
      },
    });

    expect(result.activePresets).toEqual(["future-required", "future-traces", "future-metrics"]);
    expect([...result.inactivePresets]).toEqual([]);
    expect([...result.suppressedPresets]).toEqual([]);
  });

  it("applies only create-enabled rules during sandbox creation", () => {
    expect(
      evaluatePackagePolicyPresets(capability, {
        phase: "sandbox-create",
        observabilityEnabled: true,
        tierName: "balanced",
        env: {},
      }).activePresets,
    ).toEqual(["future-traces"]);
  });

  it("suppresses stale rules by tier even after their activation turns off", () => {
    const result = evaluatePackagePolicyPresets(capability, {
      observabilityEnabled: false,
      tierName: "restricted",
      env: {},
    });

    expect(result.activePresets).toEqual(["future-required"]);
    expect([...result.inactivePresets].sort()).toEqual(["future-metrics", "future-traces"]);
    expect([...result.suppressedPresets].sort()).toEqual(["future-metrics", "future-traces"]);
  });

  it("honors package asset availability and custom policy ownership", () => {
    expect(
      evaluatePackagePolicyPresets(capability, {
        observabilityEnabled: true,
        knownPresetNames: ["future-required", "future-traces"],
        overriddenPolicyNames: new Set(["future-traces"]),
      }),
    ).toMatchObject({ activePresets: ["future-required"] });
  });

  it("merges active rules once and removes inactive package rules", () => {
    expect(
      mergeAutomaticPackagePolicyPresets(["npm", "future-traces", "npm"], capability, {
        observabilityEnabled: false,
      }),
    ).toEqual(["npm", "npm", "future-required"]);
  });

  it("prunes inactive messaging presets for any receipt-backed package", () => {
    const prune = createUnavailablePolicyPresetPruner({
      agent: "future-harness",
      enabledChannels: ["discord"],
      packagePolicyCapability: capability,
      observabilityEnabled: false,
      env: {},
    });

    expect(prune(["telegram", "discord", "future-traces", "npm"])).toEqual(["discord", "npm"]);
  });
});
