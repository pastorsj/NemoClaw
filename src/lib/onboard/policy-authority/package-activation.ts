// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  HarnessPolicyCapability,
  HarnessPolicyPresetActivation,
} from "@nvidia/nemoclaw-harness-contract";

const FALSE_ENVIRONMENT_VALUES = new Set(["0", "false", "no", "off"]);

export type PackagePolicyActivationPhase = "reconcile" | "sandbox-create";

export interface PackagePolicyActivationOptions {
  readonly phase?: PackagePolicyActivationPhase;
  readonly observabilityEnabled?: boolean | null;
  readonly tierName?: string | null;
  readonly env?: NodeJS.ProcessEnv;
  readonly knownPresetNames?: Iterable<string> | null;
  readonly overriddenPolicyNames?: ReadonlySet<string> | null;
}

export interface PackagePolicyPresetEvaluation {
  /** Active, package-owned presets that core must merge for this operation. */
  readonly activePresets: readonly string[];
  /** Conditional presets that are currently inactive and must not be retained. */
  readonly inactivePresets: ReadonlySet<string>;
  /** Presets forbidden by the selected tier, even if they were previously active. */
  readonly suppressedPresets: ReadonlySet<string>;
}

function environmentFlagEnabled(value: string | undefined): boolean {
  if (typeof value !== "string") return false;
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 && !FALSE_ENVIRONMENT_VALUES.has(normalized);
}

function normalizeHttpOrigin(value: string): string | null {
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//iu.test(value) ? value : `http://${value}`;
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

function activationIsEnabled(
  activation: HarnessPolicyPresetActivation,
  options: PackagePolicyActivationOptions,
): boolean {
  if (activation.kind === "always") return true;
  if (activation.kind === "observability-enabled") {
    return options.observabilityEnabled === true;
  }

  const env = options.env ?? process.env;
  if (!environmentFlagEnabled(env[activation.enabled_environment])) return false;
  const configuredEndpoint = env[activation.endpoint_environment]?.trim();
  const endpoint = configuredEndpoint || activation.default_endpoint;
  return normalizeHttpOrigin(endpoint) === activation.local_origin;
}

/** Evaluate receipt-declared automatic policy rules without inspecting a harness identifier. */
export function evaluatePackagePolicyPresets(
  capability: HarnessPolicyCapability | null | undefined,
  options: PackagePolicyActivationOptions = {},
): PackagePolicyPresetEvaluation {
  if (!capability) {
    return {
      activePresets: Object.freeze([]),
      inactivePresets: new Set(),
      suppressedPresets: new Set(),
    };
  }

  const phase = options.phase ?? "reconcile";
  const tierName = options.tierName?.trim().toLowerCase() || null;
  const knownPresetNames = options.knownPresetNames ? new Set(options.knownPresetNames) : null;
  const overriddenPolicyNames = options.overriddenPolicyNames ?? new Set<string>();
  const activePresets: string[] = [];
  const inactivePresets = new Set<string>();
  const suppressedPresets = new Set<string>();

  for (const rule of capability.automatic_presets) {
    const suppressed = tierName !== null && rule.suppress_in_tiers.includes(tierName);
    if (suppressed) suppressedPresets.add(rule.name);

    const activationEnabled = activationIsEnabled(rule.activation, options);
    const overridden = overriddenPolicyNames.has(rule.name);
    if (!activationEnabled || overridden) inactivePresets.add(rule.name);

    const phaseEligible = phase === "reconcile" || rule.apply_during_create;
    if (
      activationEnabled &&
      phaseEligible &&
      !suppressed &&
      !overridden &&
      (!knownPresetNames || knownPresetNames.has(rule.name))
    ) {
      activePresets.push(rule.name);
    }
  }

  return {
    activePresets: Object.freeze(activePresets),
    inactivePresets,
    suppressedPresets,
  };
}

/** Merge active receipt-declared presets once while preserving caller order. */
export function mergeAutomaticPackagePolicyPresets(
  selectedPresets: readonly string[],
  capability: HarnessPolicyCapability | null | undefined,
  options: PackagePolicyActivationOptions = {},
): string[] {
  const evaluation = evaluatePackagePolicyPresets(capability, options);
  const merged = [...selectedPresets].filter(
    (name) => !evaluation.inactivePresets.has(name) && !evaluation.suppressedPresets.has(name),
  );
  const selected = new Set(merged);
  for (const name of evaluation.activePresets) {
    if (!selected.has(name)) {
      merged.push(name);
      selected.add(name);
    }
  }
  return merged;
}
