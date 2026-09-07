// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isLegacyAgentOwnedPreset } from "./legacy-policy";

export type PresetProvenance = { source: "agent"; agent: string } | { source: "user" };

export interface PresetProvenanceContext {
  agentName?: string | null;
  /** Present only when an exact package receipt supplied this declaration. */
  ownedPresetNames?: readonly string[];
}

export interface PresetVerificationState {
  active: boolean;
  observedInOpenShell: boolean | null;
}

/**
 * Infer display-only provenance from the agent baseline. All other live
 * entries are operator-added; NemoClaw does not persist policy history.
 */
export function classifyPresetProvenance(
  presetName: string,
  context: PresetProvenanceContext = {},
): PresetProvenance {
  const name = presetName.trim().toLowerCase();
  const agentName = context.agentName?.trim().toLowerCase() ?? null;
  const agentOwned = context.ownedPresetNames
    ? context.ownedPresetNames.includes(name)
    : isLegacyAgentOwnedPreset(agentName, name);
  if (agentName && agentOwned) {
    return { source: "agent", agent: agentName };
  }
  return { source: "user" };
}

export function formatPresetProvenanceTag(provenance: PresetProvenance): string {
  switch (provenance.source) {
    case "agent":
      return `from ${provenance.agent} agent`;
    case "user":
      return "user-added";
  }
}

/** Format the display suffix without claiming provenance for unverified state. */
export function formatPresetProvenanceSuffix(
  presetName: string,
  context: PresetProvenanceContext,
  state: PresetVerificationState,
): string {
  if (!state.active) return "";
  if (state.observedInOpenShell === true) {
    return ` [${formatPresetProvenanceTag(classifyPresetProvenance(presetName, context))}]`;
  }
  return " [source unverified (gateway unreachable)]";
}
