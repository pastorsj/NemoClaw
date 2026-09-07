// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isDeepStrictEqual } from "node:util";
import { listMessagingCredentialMetadata } from "../messaging/channels/metadata";
import type { SandboxMessagingPlan } from "../messaging/manifest";
import { harnessPackageIdentitiesEqual } from "../agent-runtime/package/identity-validation";
import type {
  HarnessPackageIdentity,
  HarnessPackageMigration,
} from "../agent-runtime/package/types";
import { MESSAGING_CREDENTIAL_PROVIDER_TYPE } from "../messaging/provider-profile";
import { getActiveChannelIdsFromPlan } from "../messaging/plan-validation";
import { isDecisionSelected } from "../state/onboard-checkpoint-decision";
import type {
  CheckpointEffectGroupName,
  CheckpointProviderBinding,
  CheckpointSandboxIdentity,
  OnboardCheckpoint,
} from "../state/onboard-checkpoint-types";
import type { SandboxEntry } from "../state/registry/types";
import type { HarnessWebSearchCapability } from "../agent-runtime/manifest-types";
import { packageWebSearchProviderBinding } from "../agent-runtime/web-search";
import { HERMES_TAVILY_PROVIDER_PROFILE_ID } from "../messaging/applier/web-search-provider-profile";
import type { OnboardMachineState } from "./machine/types";
import { ONBOARD_MACHINE_STATES } from "./machine/types";
import {
  listMessagingBridgeProfiles,
  messagingBridgeProfilesForAgent,
  staticMessagingProviderTypeForChannel,
} from "./messaging-bridge-provider";

export interface CheckpointedMachineSession {
  readonly checkpoint: OnboardCheckpoint | null;
  readonly machine: { readonly state: OnboardMachineState };
}

interface CheckpointPackageOwner extends CheckpointedMachineSession {
  readonly harnessPackage: HarnessPackageIdentity | null;
  readonly harnessPackageMigration: HarnessPackageMigration | null;
}

function nullableHarnessPackagesEqual(
  left: HarnessPackageIdentity | null,
  right: HarnessPackageIdentity | null,
): boolean {
  return left === null
    ? right === null
    : right !== null && harnessPackageIdentitiesEqual(left, right);
}

export function checkpointPackageOwnerAuthorityMatches(
  left: Pick<CheckpointPackageOwner, "harnessPackage" | "harnessPackageMigration">,
  right: Pick<CheckpointPackageOwner, "harnessPackage" | "harnessPackageMigration">,
): boolean {
  return (
    nullableHarnessPackagesEqual(left.harnessPackage, right.harnessPackage) &&
    isDeepStrictEqual(left.harnessPackageMigration, right.harnessPackageMigration)
  );
}

/** Fail closed before replay when any durable owner changed package authority. */
export function assertCheckpointPackageAuthorityChain(
  session: CheckpointPackageOwner,
  registryEntry: SandboxEntry | null,
): void {
  const checkpoint = session.checkpoint;
  if (checkpoint) {
    if (!nullableHarnessPackagesEqual(session.harnessPackage, checkpoint.harnessPackage)) {
      throw new Error("Checkpoint package authority does not match its Session");
    }
    const transaction = checkpoint.sandboxRecreate;
    if (transaction?.version === 1) {
      throw new Error("Recreate transaction requires package authority migration before replay");
    }
    if (
      transaction &&
      !nullableHarnessPackagesEqual(session.harnessPackage, transaction.harnessPackage)
    ) {
      throw new Error("Recreate transaction package authority does not match its Session");
    }
  }
  if (
    registryEntry &&
    (!nullableHarnessPackagesEqual(session.harnessPackage, registryEntry.harnessPackage ?? null) ||
      !isDeepStrictEqual(
        session.harnessPackageMigration,
        registryEntry.harnessPackageMigration ?? null,
      ))
  ) {
    throw new Error("Registry package authority does not match its onboarding Session");
  }
}

export function checkpointSandboxIdentityMatches(
  session:
    | (CheckpointedMachineSession & {
        readonly sandboxName?: string | null;
        readonly sandboxPromptProgress?: { readonly sandboxName?: boolean };
      })
    | null
    | undefined,
  sandboxName: string,
): boolean {
  if (session?.checkpoint) {
    return (
      isDecisionSelected(session.checkpoint.sandboxIdentity) &&
      session.checkpoint.sandboxIdentity.value.name === sandboxName
    );
  }
  return (
    session?.sandboxPromptProgress?.sandboxName === true && session.sandboxName === sandboxName
  );
}

export function checkpointProvesSandboxStepComplete(
  session: CheckpointedMachineSession | null | undefined,
): boolean {
  if (!session?.checkpoint) return false;
  const sandboxIndex = ONBOARD_MACHINE_STATES.indexOf("sandbox");
  const stateIndex = ONBOARD_MACHINE_STATES.indexOf(session.machine.state);
  return stateIndex > sandboxIndex;
}

export type EffectGroupReplayReason =
  | "not_recorded"
  | "postcondition_failed"
  | "fingerprint_mismatch"
  | "already_complete_revalidated";

export interface EffectGroupReplayDecision {
  readonly group: CheckpointEffectGroupName;
  readonly action: "skip" | "run";
  readonly reason: EffectGroupReplayReason;
}

export function planEffectGroupReplay(
  checkpoint: OnboardCheckpoint,
  group: CheckpointEffectGroupName,
  observedFingerprint: string | null,
): EffectGroupReplayDecision {
  const record = checkpoint.effectGroups[group];
  if (!record) return { group, action: "run", reason: "not_recorded" };
  if (!observedFingerprint) return { group, action: "run", reason: "postcondition_failed" };
  if (observedFingerprint !== record.fingerprint) {
    return { group, action: "run", reason: "fingerprint_mismatch" };
  }
  return { group, action: "skip", reason: "already_complete_revalidated" };
}

export function observeProviderEffectFingerprint(
  checkpoint: OnboardCheckpoint,
  group: CheckpointEffectGroupName,
  requiredBindings: readonly CheckpointProviderBinding[],
  bindingMatches: (
    binding: OnboardCheckpoint["bindings"]["registeredProviders"][number],
  ) => boolean,
): string | null {
  const fingerprint = checkpoint.effectGroups[group]?.fingerprint;
  const providerNames = fingerprint?.split(",").filter(Boolean) ?? [];
  if (
    !fingerprint ||
    providerNames.length === 0 ||
    providerNames.join(",") !== fingerprint ||
    providerNames.length !== requiredBindings.length
  ) {
    return null;
  }
  const receiptNames = new Set(providerNames);
  const requiredBindingsByName = new Map(
    requiredBindings.map((binding) => [binding.name, binding]),
  );
  if (
    receiptNames.size !== providerNames.length ||
    requiredBindingsByName.size !== requiredBindings.length
  ) {
    return null;
  }
  const receiptBindings = checkpoint.bindings.registeredProviders.filter((binding) =>
    receiptNames.has(binding.name),
  );
  if (receiptBindings.length !== providerNames.length) return null;
  const bindingsByName = new Map(receiptBindings.map((binding) => [binding.name, binding]));
  for (const name of providerNames) {
    const binding = bindingsByName.get(name);
    const required = requiredBindingsByName.get(name);
    if (
      !binding ||
      !required ||
      binding.type !== required.type ||
      binding.credentialEnv !== required.credentialEnv ||
      !bindingMatches(binding)
    ) {
      return null;
    }
  }
  return fingerprint;
}

export function requiredWebSearchProviderType(
  provider: "brave" | "tavily",
  agent: { name?: string; web_search?: HarnessWebSearchCapability } | null,
  receiptBackedPackage = false,
): string {
  if (receiptBackedPackage) {
    const binding = packageWebSearchProviderBinding(agent, provider);
    if (!binding) {
      throw new Error(`The selected harness package does not declare ${provider} web search.`);
    }
    return binding.profile_type;
  }
  // Explicit compatibility for receiptless Hermes sessions. Receipt-backed
  // packages select their profile only from the declaration above.
  return provider === "tavily" && agent?.name?.trim().toLowerCase() === "hermes"
    ? HERMES_TAVILY_PROVIDER_PROFILE_ID
    : provider;
}

/** Collect every active credential binding, including multiple keys owned by one provider. */
export function collectRequiredMessagingProviderBindings(
  sandboxName: string,
  plan: SandboxMessagingPlan | null,
  channelIds?: ReadonlySet<string>,
): CheckpointProviderBinding[] {
  if (!plan) return [];
  const activeChannels = new Set(
    getActiveChannelIdsFromPlan(plan).filter(
      (channelId) => channelIds === undefined || channelIds.has(channelId),
    ),
  );
  // Receipt-backed plans carry their package's bounded provider projection.
  // Only old plans without packageBuild may consult the compatibility profile map.
  const legacyProfiles = plan.packageBuild
    ? null
    : messagingBridgeProfilesForAgent(plan.agent, listMessagingBridgeProfiles());
  const bindings: CheckpointProviderBinding[] = [];
  for (const binding of plan.credentialBindings) {
    if (!activeChannels.has(binding.channelId)) continue;
    const projectedProvider = plan.packageBuild
      ? plan.channels.find((channel) => channel.channelId === binding.channelId)?.credentialProvider
      : undefined;
    const declaredProvider =
      projectedProvider?.credentialEnv === binding.providerEnvKey ? projectedProvider : undefined;
    bindings.push({
      name: binding.providerName,
      type:
        declaredProvider?.profileId ??
        staticMessagingProviderTypeForChannel(
          binding.channelId,
          plan.agent,
          legacyProfiles ?? [],
          binding.providerEnvKey,
        ) ??
        MESSAGING_CREDENTIAL_PROVIDER_TYPE,
      credentialEnv: binding.providerEnvKey,
    });
  }
  const refreshingProviders = plan.packageBuild
    ? plan.channels.flatMap((channel) =>
        channel.credentialProvider?.refresh
          ? [{ channelId: channel.channelId, ...channel.credentialProvider }]
          : [],
      )
    : (legacyProfiles ?? []).filter((profile) => profile.strategy !== null);
  for (const profile of refreshingProviders) {
    if (!activeChannels.has(profile.channelId)) continue;
    const name = `${sandboxName}-${profile.channelId}-bridge`;
    if (bindings.some((binding) => binding.name === name)) continue;
    bindings.push({
      name,
      type: profile.profileId,
      credentialEnv: "credentialKey" in profile ? profile.credentialKey : profile.credentialEnv,
    });
  }
  return bindings;
}

/** Replace proven legacy provider names with the current manifest-owned names. */
export function normalizeMessagingProviderBindings(
  sandboxName: string,
  plan: SandboxMessagingPlan,
): SandboxMessagingPlan {
  const providerNamesByCredential = new Map(
    listMessagingCredentialMetadata({ agent: plan.agent }).map((credential) => [
      `${credential.channelId}\0${credential.providerEnvKey}`,
      credential.providerNameTemplate.replaceAll("{sandboxName}", sandboxName),
    ]),
  );
  const currentProviderCredentialEnvs = new Map<string, Set<string>>();
  for (const binding of plan.credentialBindings) {
    const providerName = providerNamesByCredential.get(
      `${binding.channelId}\0${binding.providerEnvKey}`,
    );
    if (providerName !== binding.providerName) continue;
    const key = `${binding.channelId}\0${binding.providerName}`;
    const credentialEnvs = currentProviderCredentialEnvs.get(key) ?? new Set<string>();
    credentialEnvs.add(binding.providerEnvKey);
    currentProviderCredentialEnvs.set(key, credentialEnvs);
  }
  let changed = false;
  const credentialBindings = plan.credentialBindings.map((binding) => {
    const currentProviderName = providerNamesByCredential.get(
      `${binding.channelId}\0${binding.providerEnvKey}`,
    );
    if (!currentProviderName || currentProviderName === binding.providerName) return binding;
    const siblingCredentialEnvs = currentProviderCredentialEnvs.get(
      `${binding.channelId}\0${binding.providerName}`,
    );
    const hasCurrentSibling = [...(siblingCredentialEnvs ?? [])].some(
      (providerEnvKey) => providerEnvKey !== binding.providerEnvKey,
    );
    if (!hasCurrentSibling) return binding;
    changed = true;
    return { ...binding, providerName: currentProviderName };
  });
  return changed ? { ...plan, credentialBindings } : plan;
}

export function requiredMessagingProviderBindings(
  sandboxName: string,
  plan: SandboxMessagingPlan | null,
  channelIds?: ReadonlySet<string>,
): CheckpointProviderBinding[] {
  if (!plan) return [];
  const registrationPlan = normalizeMessagingProviderBindings(sandboxName, plan);
  const bindings = new Map<string, CheckpointProviderBinding>();
  for (const binding of collectRequiredMessagingProviderBindings(
    sandboxName,
    registrationPlan,
    channelIds,
  )) {
    bindings.set(binding.name, binding);
  }
  return [...bindings.values()];
}

export interface SandboxCreateObservation {
  readonly liveSandboxExists: boolean;
}

export type SandboxCreateReplayDecision =
  | { readonly action: "reuse"; readonly identity: CheckpointSandboxIdentity }
  | { readonly action: "create"; readonly identity: CheckpointSandboxIdentity }
  | { readonly action: "capture_identity_first" };

export function planSandboxCreateReplay(
  checkpoint: OnboardCheckpoint,
  observed: SandboxCreateObservation,
): SandboxCreateReplayDecision {
  if (!isDecisionSelected(checkpoint.sandboxIdentity)) {
    return { action: "capture_identity_first" };
  }
  const identity = checkpoint.sandboxIdentity.value;
  if (observed.liveSandboxExists) {
    return { action: "reuse", identity };
  }
  return { action: "create", identity };
}
