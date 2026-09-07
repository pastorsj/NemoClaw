// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { HarnessPolicyCapability } from "@nvidia/nemoclaw-harness-contract";

import { isLegacyHarnessPolicyPreset } from "../policy/legacy-policy";
import { HERMES_TOOL_GATEWAY_PRESET_NAMES } from "./hermes-managed-tools";
import { DCODE_ONLY_POLICY_PRESETS, isDcodeAgent } from "./observability-policy-presets";
import { isOpenclawAgent, OPENCLAW_ONLY_POLICY_PRESETS } from "./openclaw-otel-policy-presets";

export { OPENCLAW_ONLY_POLICY_PRESETS };

function isHermesAgent(agent: string | null | undefined): boolean {
  return typeof agent === "string" && agent.trim().toLowerCase() === "hermes";
}

export function setupPolicyPresetAppliesToAgent(
  presetName: string,
  agent: string | null | undefined,
  packagePolicyCapability?: HarnessPolicyCapability | null,
): boolean {
  const name = presetName.trim().toLowerCase();
  if (packagePolicyCapability) {
    return (
      !isLegacyHarnessPolicyPreset(name) || packagePolicyCapability.owned_presets.includes(name)
    );
  }
  if (HERMES_TOOL_GATEWAY_PRESET_NAMES.has(name)) return isHermesAgent(agent);
  if (DCODE_ONLY_POLICY_PRESETS.has(name)) return isDcodeAgent(agent);
  if (OPENCLAW_ONLY_POLICY_PRESETS.has(name)) return isOpenclawAgent(agent);
  return true;
}

export function filterSetupPolicyPresetsForAgent<T extends { name: string }>(
  presets: T[],
  agent: string | null | undefined,
  packagePolicyCapability?: HarnessPolicyCapability | null,
): T[] {
  return presets.filter((preset) =>
    setupPolicyPresetAppliesToAgent(preset.name, agent, packagePolicyCapability),
  );
}

export function filterSetupPolicyPresetNamesForAgent(
  presetNames: string[],
  agent: string | null | undefined,
  packagePolicyCapability?: HarnessPolicyCapability | null,
): string[] {
  return presetNames.filter((name) =>
    setupPolicyPresetAppliesToAgent(name, agent, packagePolicyCapability),
  );
}
