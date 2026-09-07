// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  buildSelectedOpenShellSubprocessEnv,
  type OpenShellRuntimeSelection,
  runOpenshell,
} from "../../adapters/openshell/runtime";
import { RD as _RD, G, R } from "../../cli/terminal-style";
import { MessagingSetupApplier } from "../../messaging/applier/setup-applier";
import type {
  MessagingHookApplyRequest,
  MessagingOpenShellRunner,
} from "../../messaging/applier/types";
import type { MessagingHookOutputMap } from "../../messaging/hooks";
import type { SandboxMessagingPlan } from "../../messaging/manifest";
import { createBuiltInChannelManifestRegistry } from "../../messaging/channels/built-ins";
import {
  listMessagingChannelsForProfile,
  resolveAgentMessagingProfileAuthority,
} from "../../messaging/profile-authority";
import { retirePendingRemovalMessagingPlanChannels } from "../../messaging/compiler/workflow-planner";
import type { ResolvedSandboxAgent } from "../../onboard/sandbox-agent";
import {
  getLegacySessionMessagingChannelConfig,
  getMessagingChannelConfigFromPlan,
} from "../../onboard/messaging-config";
import {
  inspectGatewayCredentialFamilyProviderBinding,
  inspectGatewayCredentialOnlyProviderBinding,
  readGatewayProviderMetadata,
} from "../../onboard/gateway-provider-metadata";
import { findMessagingProviderReceipt } from "../../messaging/provider-receipts";
import { isMessagingBridgeSourceSecretValid } from "../../onboard/messaging-bridge-provider";
import { requiredMessagingProviderBindings } from "../../onboard/checkpoint-replay";
import { requireAuthorizedPackageMessagingPolicyProviders } from "../../policy/package-messaging";
import {
  getMessagingToken,
  getValidatedMessagingTokenByEnvKey,
} from "../../onboard/messaging-token";
import { listChannels } from "../../sandbox/channels";
import {
  resolveRebuildPackageMessagingPolicySources,
  resolveRebuildPackagePolicyRemovalExpectations,
} from "../../onboard/sandbox-create/rebuild-policy-handoff";
import type { Session } from "../../state/onboard-session";
import type { SandboxEntry } from "../../state/registry";
import { harnessPackageAuthoritiesEqual } from "../../agent-runtime/package/identity-read";
import type { RebuildBail } from "./rebuild-credential-preflight";
import { checkPinnedAgentAuthority } from "./rebuild/authority";
import { stageMessagingManifestPlanForRebuild } from "./rebuild-messaging-stage";
import { printRebuildPreflightFailure } from "./rebuild-preflight-error";

export { stageMessagingManifestPlanForRebuild };

function hasLegacyMessagingConfiguredState(config: Record<string, string> | null): boolean {
  return [
    "TELEGRAM_REQUIRE_MENTION",
    "WECHAT_ACCOUNT_ID",
    "WECHAT_BASE_URL",
    "WECHAT_USER_ID",
  ].some((key) => config?.[key]?.trim());
}

function hasLegacyMessagingSessionAuthority(session: Session): boolean {
  return (
    hasLegacyMessagingConfiguredState(getLegacySessionMessagingChannelConfig(session)) ||
    Object.keys(session.migratedLegacyValueHashes ?? {}).length > 0
  );
}

/**
 * Admit legacy messaging state only when the session belongs to this sandbox
 * and to the exact legacy agent/package migration being rebuilt.
 */
export function authorizeLegacyMessagingFallbackSession(
  sandboxName: string,
  session: Session | null,
  agentAuthority: ResolvedSandboxAgent,
): Session | null {
  if (
    !session ||
    session.sandboxName !== sandboxName ||
    !hasLegacyMessagingSessionAuthority(session)
  ) {
    return null;
  }
  const migration = agentAuthority.harnessPackageMigration;
  if (!migration) return session;
  const expectedLegacyAgent = migration.legacyAgent ?? "openclaw";
  const sessionLegacyAgent = session.agent ?? "openclaw";
  if (sessionLegacyAgent !== expectedLegacyAgent) {
    throw new Error(
      "Legacy messaging session agent does not match the pinned package migration authority.",
    );
  }
  const sessionHasPackageAuthority =
    session.harnessPackage !== null || session.harnessPackageMigration !== null;
  if (sessionHasPackageAuthority && !harnessPackageAuthoritiesEqual(session, agentAuthority)) {
    throw new Error(
      "Legacy messaging session package receipt does not match the pinned package migration authority.",
    );
  }
  return session;
}

/** Verify active receipt-owned provider bindings after gateway recovery and before mutation. */
export function preflightRebuildMessagingProviderAuthority(
  plan: SandboxMessagingPlan,
  agentAuthority: ResolvedSandboxAgent,
): void {
  const disabledChannels = new Set(plan.disabledChannels);
  const activeChannels = plan.channels.filter(
    (channel) => channel.active && !channel.disabled && !disabledChannels.has(channel.channelId),
  );
  const activeChannelIds = new Set(activeChannels.map((channel) => channel.channelId));
  for (const binding of plan.credentialBindings) {
    if (!activeChannelIds.has(binding.channelId)) continue;
    if (
      agentAuthority.harnessPackageMigration &&
      (!binding.credentialHash || !/^[0-9a-f]{64}$/i.test(binding.credentialHash))
    ) {
      throw new Error(
        `Migrated messaging credential '${binding.providerEnvKey}' lacks verified legacy credential provenance; restore the credential and rerun rebuild.`,
      );
    }
  }
  for (const provider of requiredMessagingProviderBindings(plan.sandboxName, plan)) {
    const credentialBinding = plan.credentialBindings.find(
      (binding) =>
        binding.providerName === provider.name &&
        binding.providerEnvKey === provider.credentialEnv &&
        !disabledChannels.has(binding.channelId),
    );
    const bridgeProvider = activeChannels.find(
      (channel) =>
        channel.credentialProvider?.refresh &&
        `${plan.sandboxName}-${channel.channelId}-bridge` === provider.name,
    )?.credentialProvider;
    const channelId =
      credentialBinding?.channelId ??
      activeChannels.find(
        (channel) => `${plan.sandboxName}-${channel.channelId}-bridge` === provider.name,
      )?.channelId;
    const recoverableCredential = credentialBinding
      ? getValidatedMessagingTokenByEnvKey(listChannels(), credentialBinding.providerEnvKey)
      : null;
    const recoverableBridgeSecret = bridgeProvider
      ? isMessagingBridgeSourceSecretValid(
          bridgeProvider,
          getMessagingToken(bridgeProvider.sourceSecretEnv),
        )
      : false;
    const expectedProvider = {
      name: provider.name,
      type: provider.type,
      credentialKey: provider.credentialEnv,
    };
    const providerState = bridgeProvider
      ? inspectGatewayCredentialFamilyProviderBinding(expectedProvider, runOpenshell)
      : inspectGatewayCredentialOnlyProviderBinding(expectedProvider, runOpenshell);
    if (providerState.kind === "exact") {
      const receipt = channelId
        ? findMessagingProviderReceipt(plan, channelId, provider.name)
        : undefined;
      const metadata = readGatewayProviderMetadata(provider.name, runOpenshell);
      if (!receipt || !metadata?.id || metadata.id !== receipt.providerId) {
        throw new Error(
          `Messaging provider '${provider.name}' does not match its recorded stable identity in the target gateway; restore the exact provider binding and rerun rebuild.`,
        );
      }
      continue;
    }
    if (providerState.kind === "missing" && (recoverableCredential || recoverableBridgeSecret)) {
      continue;
    }
    const reason =
      providerState.kind === "missing"
        ? "was not found"
        : providerState.kind === "collision"
          ? "does not match its exact credential binding"
          : "could not be inspected";
    const guidance =
      providerState.kind === "missing"
        ? "restore the provider or export its source credential"
        : providerState.kind === "collision"
          ? "restore the exact provider binding"
          : "restore target gateway availability";
    throw new Error(
      `Messaging provider '${provider.name}' ${reason} in the target gateway; ${guidance} and rerun rebuild.`,
    );
  }
}

/** Validate receipt-owned messaging policy assets before rebuild can reach backup or deletion. */
export function preflightRebuildMessagingPolicyAuthority(input: {
  readonly agentAuthority: ResolvedSandboxAgent;
  readonly fallbackMessagingSession: Session | null;
  readonly messagingPlan: SandboxMessagingPlan | null;
  readonly sandboxName: string;
}): void {
  const receipt = input.agentAuthority.harnessPackage;
  if (!receipt) return;
  const fallbackMessagingSession = input.agentAuthority.harnessPackageMigration
    ? authorizeLegacyMessagingFallbackSession(
        input.sandboxName,
        input.fallbackMessagingSession,
        input.agentAuthority,
      )
    : input.fallbackMessagingSession?.sandboxName === input.sandboxName
      ? input.fallbackMessagingSession
      : null;
  const agentDefinition = input.agentAuthority.definition;
  if (receipt.id !== agentDefinition.name) {
    throw new Error("Receipt-backed messaging policy does not match pinned package authority.");
  }
  const automaticPresetNames = (agentDefinition.policyCapability?.automatic_presets ?? []).map(
    ({ name }) => name,
  );
  const messagingEntries = input.messagingPlan?.networkPolicy.entries ?? [];
  const declaredPolicyKeys = [
    ...new Set([
      ...messagingEntries.flatMap(({ policyKeys }) => policyKeys),
      ...automaticPresetNames,
    ]),
  ];
  // Validate every policy asset that the exact receipt may add or remove before
  // rebuild can back up or delete the source sandbox. This includes inactive
  // automatic presets and disabled channels because they still own removal data.
  resolveRebuildPackagePolicyRemovalExpectations({
    agentDefinition,
    harnessPackageIdentity: receipt,
    messagingConfig: input.messagingPlan
      ? getMessagingChannelConfigFromPlan(input.messagingPlan)
      : null,
    messagingEntries,
    policyKeys: declaredPolicyKeys,
    automaticPresetNames,
    sandboxName: input.sandboxName,
  });
  if (!input.messagingPlan) {
    const fallbackConfig = getLegacySessionMessagingChannelConfig(fallbackMessagingSession);
    if (hasLegacyMessagingConfiguredState(fallbackConfig)) {
      throw new Error(
        "Receipt-backed rebuild cannot use legacy messaging state without a typed package messaging plan.",
      );
    }
    return;
  }
  if (input.messagingPlan.agent !== agentDefinition.name) {
    throw new Error("Receipt-backed messaging policy does not match pinned package authority.");
  }
  const disabledChannels = new Set(input.messagingPlan.disabledChannels);
  const requiredNetworkPolicySources = resolveRebuildPackageMessagingPolicySources({
    agentDefinition,
    entries: input.messagingPlan.networkPolicy.entries.filter(
      (entry) => !disabledChannels.has(entry.channelId),
    ),
    harnessPackageIdentity: receipt,
    messagingConfig: getMessagingChannelConfigFromPlan(input.messagingPlan),
    sandboxName: input.sandboxName,
  });
  const activeChannelIds = new Set(
    input.messagingPlan.channels
      .filter(
        (channel) =>
          channel.active && !channel.disabled && !disabledChannels.has(channel.channelId),
      )
      .map((channel) => channel.channelId),
  );
  const activeProviderNames = new Set(
    requiredMessagingProviderBindings(
      input.messagingPlan.sandboxName,
      input.messagingPlan,
      activeChannelIds,
    ).map((binding) => binding.name),
  );
  requireAuthorizedPackageMessagingPolicyProviders(
    requiredNetworkPolicySources,
    activeProviderNames,
  );
}

/** Report package policy authority failures through rebuild's standard preflight boundary. */
export function preflightRebuildMessagingPolicyAuthorityOrBail(
  input: Parameters<typeof preflightRebuildMessagingPolicyAuthority>[0],
  bail: RebuildBail,
): boolean {
  try {
    preflightRebuildMessagingPolicyAuthority(input);
    return true;
  } catch (error) {
    printRebuildPreflightFailure(
      "the receipt-backed messaging policy assets are unavailable or invalid.",
      error instanceof Error ? error.message : String(error),
      "Package messaging policy preflight failed",
      bail,
    );
    return false;
  }
}

/** Report live package provider failures through rebuild's standard preflight boundary. */
export function preflightRebuildMessagingProviderAuthorityOrBail(
  input: {
    readonly agentAuthority: ResolvedSandboxAgent;
    readonly messagingPlan: SandboxMessagingPlan | null;
  },
  bail: RebuildBail,
): boolean {
  if (
    (!input.agentAuthority.harnessPackage && !input.agentAuthority.harnessPackageMigration) ||
    !input.messagingPlan
  ) {
    return true;
  }
  try {
    preflightRebuildMessagingProviderAuthority(input.messagingPlan, input.agentAuthority);
    return true;
  } catch (error) {
    printRebuildPreflightFailure(
      "the receipt-backed messaging providers are unavailable or invalid.",
      error instanceof Error ? error.message : String(error),
      "Package messaging provider preflight failed",
      bail,
    );
    return false;
  }
}

export function listRebuildMessagingManifests(authority: ResolvedSandboxAgent) {
  return listMessagingChannelsForProfile(
    resolveAgentMessagingProfileAuthority(authority),
    createBuiltInChannelManifestRegistry(),
  );
}

function assertPinnedMessagingAgentAuthority(
  sandboxEntry: SandboxEntry,
  authority: ResolvedSandboxAgent,
): void {
  if (checkPinnedAgentAuthority(sandboxEntry, authority) !== null) {
    throw new Error("Pinned rebuild agent authority does not match messaging registry state.");
  }
}

/** Stage the manifest plan while preserving rebuild's fail-before-delete boundary. */
export async function stageRebuildMessagingPlanOrBail(
  sandboxName: string,
  sandboxEntry: SandboxEntry,
  agentAuthority: ResolvedSandboxAgent,
  log: (message: string) => void,
  bail: RebuildBail,
  fallbackMessagingSession: Session | null = null,
): Promise<SandboxMessagingPlan | null> {
  try {
    assertPinnedMessagingAgentAuthority(sandboxEntry, agentAuthority);
    const authorizedFallbackSession = authorizeLegacyMessagingFallbackSession(
      sandboxName,
      fallbackMessagingSession,
      agentAuthority,
    );
    return await stageMessagingManifestPlanForRebuild(
      sandboxName,
      sandboxEntry,
      agentAuthority.definition,
      log,
      {
        agentAuthority,
        legacyMessagingConfig: agentAuthority.harnessPackageMigration
          ? getLegacySessionMessagingChannelConfig(authorizedFallbackSession)
          : null,
        legacyCredentialHashes: agentAuthority.harnessPackageMigration
          ? authorizedFallbackSession?.migratedLegacyValueHashes
          : null,
      },
    );
  } catch (err) {
    // Source boundary: persisted registry messaging plans and current channel
    // manifests are host-side inputs. If they drift or become invalid, rebuild
    // must fail here before backup/delete; remove this boundary only if manifest
    // staging becomes total over all persisted registry states.
    const message = err instanceof Error ? err.message : String(err);
    console.error("");
    console.error(
      `  ${_RD}Rebuild preflight failed:${R} messaging manifest plan could not be staged.`,
    );
    console.error(`  ${message}`);
    console.error("");
    console.error("  Sandbox is untouched — no data was lost.");
    bail(message);
    return null;
  }
}

function createRunMessagingOpenshell(
  runtimeSelection?: OpenShellRuntimeSelection,
): MessagingOpenShellRunner {
  return (args, options = {}) =>
    runOpenshell([...args], {
      env: runtimeSelection
        ? buildSelectedOpenShellSubprocessEnv(
            runtimeSelection,
            options.env ? { ...options.env } : undefined,
          )
        : (options.env as NodeJS.ProcessEnv | undefined),
      replaceEnv: runtimeSelection ? true : undefined,
      ignoreError: options.ignoreError,
      input: options.input,
      stdio: options.stdio as never,
    });
}

export function finalizePendingMessagingRemovalsAfterRestore(
  plan: SandboxMessagingPlan | null,
  log: (message: string) => void,
  runtimeSelection?: OpenShellRuntimeSelection,
): SandboxMessagingPlan | null {
  if (!plan) return null;
  const runMessagingOpenshell = createRunMessagingOpenshell(runtimeSelection);
  const pendingRemovals = plan.channels.filter((channel) => channel.pendingRemoval === true);
  for (const channel of pendingRemovals) {
    const result = MessagingSetupApplier.removeDisabledChannelAgentConfigAtOpenShell(
      plan,
      channel.channelId,
      { runOpenshell: runMessagingOpenshell },
    );
    log(
      `Retired messaging config for '${channel.channelId}' after restore: ${result.appliedTargets.join(",") || "no config target"}`,
    );
  }
  return pendingRemovals.length > 0 ? retirePendingRemovalMessagingPlanChannels(plan) : plan;
}

function hookOutputsFromBuildSteps(
  plan: SandboxMessagingPlan,
  request: MessagingHookApplyRequest,
): { readonly outputs: MessagingHookOutputMap } {
  const outputs: Record<string, MessagingHookOutputMap[string]> = {};
  for (const step of plan.buildSteps) {
    if (
      step.channelId !== request.channelId ||
      step.hookId !== request.hookId ||
      step.value === undefined
    ) {
      continue;
    }
    outputs[step.outputId] = { kind: step.kind, value: step.value };
  }
  return { outputs };
}

/** Reapply package messaging files after a declared post-restore command may have rewritten them. */
export async function reapplyMessagingManifestAfterPackageRepair(
  sandboxName: string,
  plan: SandboxMessagingPlan | null,
  log: (message: string) => void,
  runtimeSelection?: OpenShellRuntimeSelection,
): Promise<void> {
  if (!plan) {
    log("Messaging manifest reapply skipped: no package messaging plan");
    return;
  }

  log("Reapplying package messaging manifest after post-restore repair");
  const runMessagingOpenshell = createRunMessagingOpenshell(runtimeSelection);
  const result = await MessagingSetupApplier.applyAgentConfigAtOpenShell(plan, {
    runOpenshell: runMessagingOpenshell,
    runHook: (request) => hookOutputsFromBuildSteps(plan, request),
  });
  log(
    `messaging manifest reapply: targets=${result.appliedTargets.join(",")}, hooks=${result.appliedHooks.join(",")}`,
  );
  if (result.appliedTargets.length > 0 || result.appliedHooks.length > 0) {
    console.log(`  ${G}\u2713${R} Messaging manifest config reapplied`);
  }
}

/** Pre-contract OpenClaw compatibility retained for old rebuild action lists. */
export async function reapplyMessagingManifestAfterOpenClawDoctor(
  sandboxName: string,
  plan: SandboxMessagingPlan | null,
  log: (message: string) => void,
  runtimeSelection?: OpenShellRuntimeSelection,
): Promise<void> {
  if (!plan || plan.agent !== "openclaw") {
    log("Messaging manifest reapply skipped: no OpenClaw messaging plan");
    return;
  }
  return reapplyMessagingManifestAfterPackageRepair(sandboxName, plan, log, runtimeSelection);
}
