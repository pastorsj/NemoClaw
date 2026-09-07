// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  HarnessPolicyCapability,
  HarnessToolGatewayCapability,
} from "@nvidia/nemoclaw-harness-contract";

import { type WebSearchConfig, webSearchProviderForConfig } from "../inference/web-search";
import {
  filterSetupPolicyPresetNamesForAgent,
  filterSetupPolicyPresetsForAgent,
} from "./agent-policy-presets";
import {
  hasDisabledMessagingPolicyPreset,
  mergeAppliedPolicyPresetsForDisabledMessagingCleanup,
  pruneDisabledMessagingPolicyPresets,
} from "./messaging-policy-presets";
import {
  isInactiveObservabilityPolicyPreset,
  OBSERVABILITY_OTLP_LOCAL_POLICY_PRESET,
} from "./observability-policy-presets";
import {
  isStaleBuiltinWebSearchPolicyPreset,
  mergeRequiredSetupPolicyPresets,
} from "./policy-preset-reconciliation";
import {
  ensureRequiredTierPolicyPresets,
  suppressedAgentRequiredPresets,
} from "./policy-tier-suppression";
import { evaluatePackagePolicyPresets } from "./policy-authority/package-activation";

type Preset = { name: string; access?: string };

type PoliciesApi = {
  setupPolicyPresetSupported(
    name: string,
    options?: { webSearchSupported?: boolean | null; agent?: string | null },
  ): boolean;
  listSetupPolicyPresets(
    sandboxName: string,
    options?: { webSearchSupported?: boolean | null; agent?: string | null },
  ): Preset[];
  listCustomPresets(sandboxName: string): Preset[];
  getAppliedPresets(sandboxName: string): string[];
  customPresetOwnsNetworkPolicyKey?(sandboxName: string, policyKey: string): boolean;
  clampSetupPolicyPresetNames(
    names: string[],
    selectablePresets: Preset[],
    options?: { webSearchSupported?: boolean | null },
    customPresetNames?: Set<string>,
  ): string[];
};

export type PreparedPolicyResumeSelection = {
  policyPresets: string[];
  livePolicyPresetsNeedUpdate: boolean;
  disabledMessagingPolicyPresetApplied: boolean;
  suppressedAgentRequiredPresetsLive: boolean;
};

export function preparePolicyPresetResumeSelection(
  deps: { policies: PoliciesApi },
  sandboxName: string,
  options: {
    disabledChannels?: string[] | null;
    enabledChannels?: string[] | null;
    hermesToolGateways?: string[] | null;
    toolGatewaySelections?: readonly string[] | null;
    toolGatewayCapability?: Extract<
      HarnessToolGatewayCapability,
      { readonly support: "managed" }
    > | null;
    agent?: string | null;
    observabilityEnabled?: boolean | null;
    webSearchConfig?: WebSearchConfig | null;
    webSearchConfigChanged?: boolean;
    webSearchSupported?: boolean | null;
    env?: NodeJS.ProcessEnv;
    tierName?: string | null;
    packagePolicyCapability?: HarnessPolicyCapability | null;
  },
): PreparedPolicyResumeSelection {
  const supportOptions = { webSearchSupported: options.webSearchSupported, agent: options.agent };
  const customPolicyPresetNames = new Set(
    deps.policies.listCustomPresets(sandboxName).map((preset) => preset.name),
  );
  const customOwnsObservability =
    deps.policies.customPresetOwnsNetworkPolicyKey?.(
      sandboxName,
      OBSERVABILITY_OTLP_LOCAL_POLICY_PRESET,
    ) === true;
  const packagePolicyCapability = options.packagePolicyCapability ?? null;
  const overriddenPackagePolicyNames = new Set(
    (packagePolicyCapability?.automatic_presets ?? [])
      .map((rule) => rule.name)
      .filter(
        (name) => deps.policies.customPresetOwnsNetworkPolicyKey?.(sandboxName, name) === true,
      ),
  );
  const rawAppliedPolicyPresets = deps.policies.getAppliedPresets(sandboxName);
  const appliedPolicyPresets = packagePolicyCapability
    ? [...new Set(rawAppliedPolicyPresets)].filter(
        (name) => !overriddenPackagePolicyNames.has(name) || customPolicyPresetNames.has(name),
      )
    : customOwnsObservability
      ? [...new Set(rawAppliedPolicyPresets)].filter(
          (name) =>
            name !== OBSERVABILITY_OTLP_LOCAL_POLICY_PRESET ||
            customPolicyPresetNames.has(OBSERVABILITY_OTLP_LOCAL_POLICY_PRESET),
        )
      : rawAppliedPolicyPresets;
  const selectablePolicyPresets = [
    ...filterSetupPolicyPresetsForAgent(
      deps.policies.listSetupPolicyPresets(sandboxName, supportOptions),
      options.agent,
      packagePolicyCapability,
    ),
    ...filterSetupPolicyPresetNamesForAgent(
      appliedPolicyPresets,
      options.agent,
      packagePolicyCapability,
    ).map((name) => ({ name })),
  ];
  const clampedLivePolicyPresets = deps.policies.clampSetupPolicyPresetNames(
    appliedPolicyPresets,
    selectablePolicyPresets,
    supportOptions,
    customPolicyPresetNames,
  );
  // Defaults of the requested tier (e.g. `brave` on Balanced) are tier
  // egress presets, not stale web-search leftovers — pass the requested tier +
  // agent so the shared predicate exempts them via provenance and re-onboard
  // reuse preserves them. (#6844)
  const isStaleBuiltinWebSearch = (name: string) =>
    isStaleBuiltinWebSearchPolicyPreset(name, {
      webSearchConfig: options.webSearchConfig,
      customPresetNames: customPolicyPresetNames,
      tierName: options.tierName,
      agentName: options.agent,
      packagePolicyCapability,
    });
  const packageEvaluation = evaluatePackagePolicyPresets(packagePolicyCapability, {
    observabilityEnabled: options.observabilityEnabled,
    tierName: options.tierName,
    env: options.env,
    overriddenPolicyNames: overriddenPackagePolicyNames,
  });
  const isInactiveAutomaticPreset = (name: string) =>
    packagePolicyCapability
      ? packageEvaluation.inactivePresets.has(name) || packageEvaluation.suppressedPresets.has(name)
      : isInactiveObservabilityPolicyPreset(name, {
          agent: options.agent,
          observabilityEnabled: options.observabilityEnabled,
          customPresetNames: customPolicyPresetNames,
          customOwnsObservability,
        });
  const liveBuiltinWebSearchProviderChanged = clampedLivePolicyPresets.some(
    (name) => (name === "brave" || name === "tavily") && isStaleBuiltinWebSearch(name),
  );
  let policyPresets = pruneDisabledMessagingPolicyPresets(
    clampedLivePolicyPresets.filter(
      (name) => !isStaleBuiltinWebSearch(name) && !isInactiveAutomaticPreset(name),
    ),
    options.disabledChannels,
  );
  const appliedPolicyPresetsForSupport = deps.policies
    .clampSetupPolicyPresetNames(
      appliedPolicyPresets,
      selectablePolicyPresets,
      supportOptions,
      customPolicyPresetNames,
    )
    .filter((name) => !isStaleBuiltinWebSearch(name) && !isInactiveAutomaticPreset(name));
  const disabledMessagingPolicyPresetApplied = hasDisabledMessagingPolicyPreset(
    appliedPolicyPresetsForSupport,
    options.disabledChannels,
  );
  policyPresets = mergeAppliedPolicyPresetsForDisabledMessagingCleanup(
    policyPresets,
    appliedPolicyPresetsForSupport,
    options.disabledChannels,
  );
  policyPresets = mergeRequiredSetupPolicyPresets(policyPresets, {
    enabledChannels: options.enabledChannels,
    hermesToolGateways: options.hermesToolGateways,
    toolGatewaySelections: options.toolGatewaySelections,
    toolGatewayCapability: options.toolGatewayCapability,
    agent: options.agent,
    observabilityEnabled: options.observabilityEnabled,
    knownPresetNames: selectablePolicyPresets.map((preset) => preset.name),
    env: options.env,
    tierName: options.tierName,
    webSearchConfig: options.webSearchConfig,
    customPresetNames: customPolicyPresetNames,
    customOwnsObservability,
    packagePolicyCapability,
    overriddenPackagePolicyNames,
  });

  // Provider switches are build-time changes, but their matching egress
  // preset is runtime state. Resume must add the newly active provider after
  // pruning the stale one or the replacement sandbox cannot reach search.
  const activeWebSearchPreset = options.webSearchConfig
    ? webSearchProviderForConfig(options.webSearchConfig)
    : null;
  const selectablePolicyPresetNames = new Set(selectablePolicyPresets.map((preset) => preset.name));
  if (
    activeWebSearchPreset &&
    options.webSearchSupported !== false &&
    (options.webSearchConfigChanged === true || liveBuiltinWebSearchProviderChanged) &&
    selectablePolicyPresetNames.has(activeWebSearchPreset) &&
    !policyPresets.includes(activeWebSearchPreset)
  ) {
    policyPresets.push(activeWebSearchPreset);
  }
  policyPresets = ensureRequiredTierPolicyPresets(options.tierName, policyPresets);
  const livePolicyPresetsNeedUpdate =
    policyPresets.length !== appliedPolicyPresets.length ||
    policyPresets.some((name) => !appliedPolicyPresets.includes(name)) ||
    appliedPolicyPresets.some((name) => !policyPresets.includes(name));
  const suppressedForTier = options.tierName
    ? packagePolicyCapability
      ? packageEvaluation.suppressedPresets
      : new Set(suppressedAgentRequiredPresets(options.tierName, options.agent))
    : null;
  const suppressedAgentRequiredPresetsLive =
    suppressedForTier !== null &&
    suppressedForTier.size > 0 &&
    appliedPolicyPresets.some((name) => suppressedForTier.has(name));

  return {
    policyPresets,
    livePolicyPresetsNeedUpdate,
    disabledMessagingPolicyPresetApplied,
    suppressedAgentRequiredPresetsLive,
  };
}
