// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  HarnessPolicyCapability,
  HarnessToolGatewayCapability,
} from "@nvidia/nemoclaw-harness-contract";

import { type WebSearchConfig, webSearchProviderForConfig } from "../inference/web-search";
import {
  filterSetupPolicyPresetNamesForAgent,
  setupPolicyPresetAppliesToAgent,
} from "./agent-policy-presets";
import { mergeRequiredHermesToolGatewayPolicyPresets } from "./hermes-managed-tools";
import { resolveHarnessToolGatewayPolicyPresets } from "../agent-runtime/tool-gateway";
import {
  mergeEnabledMessagingChannelPolicyPresets,
  pruneDisabledMessagingPolicyPresets,
  pruneInactiveMessagingPolicyPresets,
} from "./messaging-policy-presets";
import {
  isInactiveObservabilityPolicyPreset,
  mergeRequiredObservabilityPolicyPresets,
} from "./observability-policy-presets";
import { mergeRequiredOpenclawOtelPolicyPresets } from "./openclaw-otel-policy-presets";
import {
  evaluatePackagePolicyPresets,
  mergeAutomaticPackagePolicyPresets,
} from "./policy-authority/package-activation";
import { getTier } from "../policy/tiers";
import {
  ensureRequiredTierPolicyPresets,
  filterSuppressedAgentRequiredPresets,
} from "./policy-tier-suppression";

export type RequiredSetupPolicyPresetOptions = {
  enabledChannels?: string[] | null;
  hermesToolGateways?: string[] | null;
  toolGatewaySelections?: readonly string[] | null;
  toolGatewayCapability?: Extract<
    HarnessToolGatewayCapability,
    { readonly support: "managed" }
  > | null;
  agent?: string | null;
  observabilityEnabled?: boolean | null;
  knownPresetNames?: string[] | Set<string> | null;
  env?: NodeJS.ProcessEnv;
  tierName?: string | null;
  webSearchConfig?: WebSearchConfig | null;
  customPresetNames?: ReadonlySet<string> | null;
  customOwnsObservability?: boolean;
  packagePolicyCapability?: HarnessPolicyCapability | null;
  overriddenPackagePolicyNames?: ReadonlySet<string> | null;
};

export function mergeRequiredSetupPolicyPresets(
  policyPresets: string[],
  options: RequiredSetupPolicyPresetOptions = {},
): string[] {
  const agentFilteredPresets = filterSetupPolicyPresetNamesForAgent(
    policyPresets,
    options.agent,
    options.packagePolicyCapability,
  ).filter((name) => {
    if (options.packagePolicyCapability) {
      const packageEvaluation = evaluatePackagePolicyPresets(options.packagePolicyCapability, {
        observabilityEnabled: options.observabilityEnabled,
        tierName: options.tierName,
        env: options.env,
        overriddenPolicyNames: options.overriddenPackagePolicyNames,
      });
      return (
        !packageEvaluation.inactivePresets.has(name) &&
        !packageEvaluation.suppressedPresets.has(name)
      );
    }
    return !isInactiveObservabilityPolicyPreset(name, {
      agent: options.agent,
      observabilityEnabled: options.observabilityEnabled,
      customPresetNames: options.customPresetNames,
      customOwnsObservability: options.customOwnsObservability,
    });
  });
  const activeAgentPresets = pruneInactiveMessagingPolicyPresets(
    agentFilteredPresets,
    options.enabledChannels,
    options.customPresetNames,
  );
  const selectedToolGatewayPresets = options.toolGatewayCapability
    ? resolveHarnessToolGatewayPolicyPresets(
        options.toolGatewayCapability,
        options.toolGatewaySelections,
      )
    : (options.hermesToolGateways ?? []);
  const effectiveToolGatewayPresets = selectedToolGatewayPresets.filter(
    (name) =>
      !isStaleBuiltinWebSearchPolicyPreset(name, {
        webSearchConfig: options.webSearchConfig,
        customPresetNames: options.customPresetNames,
        packagePolicyCapability: options.packagePolicyCapability,
      }),
  );
  const capabilityNeutralPresets = mergeEnabledMessagingChannelPolicyPresets(
    options.toolGatewayCapability
      ? mergeDeclaredToolGatewayPolicyPresets(
          activeAgentPresets,
          effectiveToolGatewayPresets,
          options.knownPresetNames,
        )
      : mergeRequiredHermesToolGatewayPolicyPresets(
          activeAgentPresets,
          effectiveToolGatewayPresets,
          options.knownPresetNames,
        ),
    options.enabledChannels,
    options.knownPresetNames,
  );
  const mergedPresets = options.packagePolicyCapability
    ? mergeAutomaticPackagePolicyPresets(
        capabilityNeutralPresets,
        options.packagePolicyCapability,
        {
          observabilityEnabled: options.observabilityEnabled,
          tierName: options.tierName,
          env: options.env,
          knownPresetNames: options.knownPresetNames,
          overriddenPolicyNames: options.overriddenPackagePolicyNames,
        },
      )
    : mergeRequiredObservabilityPolicyPresets(
        mergeRequiredOpenclawOtelPolicyPresets(capabilityNeutralPresets, {
          agent: options.agent,
          knownPresetNames: options.knownPresetNames,
          env: options.env,
        }),
        {
          agent: options.agent,
          observabilityEnabled: options.observabilityEnabled,
          knownPresetNames: options.knownPresetNames,
          customOwnsObservability: options.customOwnsObservability,
        },
      );
  const agentScoped = filterSetupPolicyPresetNamesForAgent(
    mergedPresets,
    options.agent,
    options.packagePolicyCapability,
  );
  if (options.packagePolicyCapability) {
    return ensureRequiredTierPolicyPresets(options.tierName, agentScoped);
  }
  return ensureRequiredTierPolicyPresets(
    options.tierName,
    filterSuppressedAgentRequiredPresets(agentScoped, options.tierName, options.agent),
  );
}

function mergeDeclaredToolGatewayPolicyPresets(
  policyPresets: readonly string[],
  requiredPresets: readonly string[],
  knownPresetNames?: readonly string[] | Set<string> | null,
): string[] {
  const merged = [...policyPresets];
  const known = knownPresetNames ? new Set(knownPresetNames) : null;
  for (const preset of requiredPresets) {
    if (known && !known.has(preset)) continue;
    if (!merged.includes(preset)) merged.push(preset);
  }
  return merged;
}

export function isStaleBuiltinWebSearchPolicyPreset(
  name: string,
  options: {
    webSearchConfig?: WebSearchConfig | null;
    customPresetNames?: ReadonlySet<string> | null;
    tierName?: string | null;
    agentName?: string | null;
    packagePolicyCapability?: HarnessPolicyCapability | null;
  } = {},
): boolean {
  if (options.customPresetNames?.has(name)) return false;
  // brave/tavily double as a tier's default egress preset (e.g. Brave Search API
  // host access on the Balanced/Open tiers) AND the built-in web-search provider
  // preset. When the preset is a default of the applied tier it is a tier egress
  // default, not a stale web-search leftover — keep it regardless of the web-search
  // provider choice. A tier supplied by the active selection flow can exempt
  // its own default, but no tier is read from durable sandbox state.
  if (
    setupPolicyPresetAppliesToAgent(name, options.agentName, options.packagePolicyCapability) &&
    getTier(options.tierName ?? "")?.presets.some(
      (preset) => preset.name.trim().toLowerCase() === name.trim().toLowerCase(),
    )
  ) {
    return false;
  }
  if (name === "nous-web") {
    return Boolean(
      options.webSearchConfig && webSearchProviderForConfig(options.webSearchConfig) === "tavily",
    );
  }
  if (name !== "brave" && name !== "tavily") return false;
  if (!options.webSearchConfig) return true;
  return name !== webSearchProviderForConfig(options.webSearchConfig);
}

export function createUnavailablePolicyPresetPruner(options: {
  disabledChannels?: string[] | null;
  enabledChannels?: string[] | null;
  agent?: string | null;
  observabilityEnabled?: boolean | null;
  webSearchConfig?: WebSearchConfig | null;
  customPresetNames?: ReadonlySet<string> | null;
  customOwnsObservability?: boolean;
  packagePolicyCapability?: HarnessPolicyCapability | null;
  overriddenPackagePolicyNames?: ReadonlySet<string> | null;
  env?: NodeJS.ProcessEnv;
}): (
  presetNames: string[],
  pruning?: {
    preserveExplicitWebSearch?: boolean;
    tierName?: string | null;
  },
) => string[] {
  // Custom and interactive selections may explicitly opt into a built-in web-search
  // preset without storing provider config. Inactive observability remains ineligible.
  return (presetNames, pruning = {}) => {
    // OpenClaw keeps an already-applied channel preset until disabledChannels
    // explicitly retires it. Hermes recovery records the full enabled set, so
    // it can also prune repository defaults that are absent from that set.
    const enabledChannelPruned =
      options.packagePolicyCapability || options.agent?.trim().toLowerCase() === "hermes"
        ? pruneInactiveMessagingPolicyPresets(
            pruneDisabledMessagingPolicyPresets(presetNames, options.disabledChannels),
            options.enabledChannels,
            options.customPresetNames,
          )
        : pruneDisabledMessagingPolicyPresets(presetNames, options.disabledChannels);
    const packageEvaluation = evaluatePackagePolicyPresets(options.packagePolicyCapability, {
      observabilityEnabled: options.observabilityEnabled,
      tierName: pruning.tierName,
      env: options.env,
      overriddenPolicyNames: options.overriddenPackagePolicyNames,
    });
    return enabledChannelPruned.filter((name) => {
      const webSearchAvailable =
        pruning.preserveExplicitWebSearch ||
        !isStaleBuiltinWebSearchPolicyPreset(name, {
          webSearchConfig: options.webSearchConfig,
          customPresetNames: options.customPresetNames,
          tierName: pruning.tierName,
          agentName: options.agent,
          packagePolicyCapability: options.packagePolicyCapability,
        });
      if (!webSearchAvailable) return false;
      if (options.packagePolicyCapability) {
        return (
          !packageEvaluation.inactivePresets.has(name) &&
          !packageEvaluation.suppressedPresets.has(name)
        );
      }
      return !isInactiveObservabilityPolicyPreset(name, options);
    });
  };
}
