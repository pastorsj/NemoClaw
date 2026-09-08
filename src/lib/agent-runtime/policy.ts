// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { HarnessPolicyCapability } from "@nvidia/nemoclaw-harness-contract";

import { readObject } from "./manifest-readers";
import type { ManifestRecord } from "./manifest-types";

const EMPTY_POLICY_CAPABILITY: HarnessPolicyCapability = Object.freeze({
  owned_presets: Object.freeze([]),
  automatic_presets: Object.freeze([]),
  baseline_exclusion_impacts: Object.freeze({}),
});

const POLICY_PRESET_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const BASELINE_KEY_PATTERN = /^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/u;
const DISPLAY_CONTROL_PATTERN = /[\p{Cc}\p{Cf}\p{Cs}]/u;
const SAFE_CONTEXT_TARGET_PATTERN = /^\/sandbox\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/u;

/** Read the already contract-validated package policy declaration. */
export function readPolicyCapability(manifest: ManifestRecord): HarnessPolicyCapability {
  const policy = readObject(manifest, "policy");
  if (!policy) return EMPTY_POLICY_CAPABILITY;
  const fields = new Set([
    "automatic_presets",
    "baseline_exclusion_impacts",
    "context_target",
    "owned_presets",
  ]);
  if (Object.keys(policy).length < 3 || Object.keys(policy).some((key) => !fields.has(key))) {
    throw new Error(
      "Agent manifest field 'policy' must contain automatic_presets, baseline_exclusion_impacts, and owned_presets, with optional context_target",
    );
  }
  for (const requiredField of [
    "automatic_presets",
    "baseline_exclusion_impacts",
    "owned_presets",
  ]) {
    if (!Object.hasOwn(policy, requiredField)) {
      throw new Error(`Agent manifest field 'policy.${requiredField}' is required`);
    }
  }
  const contextTarget = policy.context_target;
  if (
    contextTarget !== undefined &&
    (typeof contextTarget !== "string" ||
      contextTarget.length > 512 ||
      !SAFE_CONTEXT_TARGET_PATTERN.test(contextTarget))
  ) {
    throw new Error(
      "Agent manifest field 'policy.context_target' must be a canonical /sandbox path",
    );
  }
  const validatedContextTarget =
    typeof contextTarget === "string" ? (contextTarget as `/sandbox/${string}`) : undefined;
  const ownedPresets = policy.owned_presets;
  const automaticPresets = policy.automatic_presets;
  const impacts = readObject(policy, "baseline_exclusion_impacts");
  if (
    !Array.isArray(ownedPresets) ||
    ownedPresets.length > 64 ||
    new Set(ownedPresets).size !== ownedPresets.length ||
    ownedPresets.some((entry) => typeof entry !== "string" || !POLICY_PRESET_PATTERN.test(entry))
  ) {
    throw new Error("Agent manifest field 'policy.owned_presets' must be a string array");
  }
  if (!Array.isArray(automaticPresets)) {
    throw new Error("Agent manifest field 'policy.automatic_presets' must be an array");
  }
  if (!impacts || Object.keys(impacts).length > 64) {
    throw new Error("Agent manifest field 'policy.baseline_exclusion_impacts' must be an object");
  }
  const impactEntries = Object.entries(impacts);
  if (
    impactEntries.some(
      ([key, value]) =>
        !BASELINE_KEY_PATTERN.test(key) ||
        typeof value !== "string" ||
        value !== value.trim() ||
        value.length === 0 ||
        Buffer.byteLength(value, "utf8") > 512 ||
        DISPLAY_CONTROL_PATTERN.test(value),
    )
  ) {
    throw new Error(
      "Agent manifest field 'policy.baseline_exclusion_impacts' must contain bounded policy impact text",
    );
  }
  return Object.freeze({
    owned_presets: Object.freeze([...(ownedPresets as string[])]),
    automatic_presets: Object.freeze(
      structuredClone(automaticPresets) as unknown as HarnessPolicyCapability["automatic_presets"],
    ),
    baseline_exclusion_impacts: Object.freeze(
      Object.fromEntries(impactEntries) as Record<string, string>,
    ),
    ...(validatedContextTarget ? { context_target: validatedContextTarget } : {}),
  });
}
