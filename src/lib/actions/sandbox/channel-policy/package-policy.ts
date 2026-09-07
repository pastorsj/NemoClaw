// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isDeepStrictEqual } from "node:util";
import YAML from "yaml";

import {
  type ChannelManifest,
  type SandboxMessagingNetworkPolicyEntryPlan,
  type SandboxMessagingPlan,
} from "../../../messaging";
import { filterEnabledPlanEntries } from "../../../messaging/applier/plan-filter";
import { planNetworkPolicy } from "../../../messaging/compiler/engines/policy-resolver";
import { getMessagingChannelConfigFromPlan } from "../../../messaging/plan-validation";
import type { MessagingChannelConfig } from "../../../messaging-channel-config";
import * as policies from "../../../policy";
import {
  requireAuthorizedPackageMessagingPolicyProviders,
  resolvePackageMessagingPolicyEntries,
  type ResolvedPackageMessagingPolicyEntry,
} from "../../../policy/package-messaging";
import {
  requireCurrentSandboxCommandAgentAuthority,
  type SandboxCommandAgentAuthority,
} from "../../../sandbox/command-agent";
import { getHydratedMessagingPlanFromEntry } from "../../../state/registry-messaging";
import { getSandbox } from "../../../state/registry/read";

export type PreparedPackageChannelPolicy = Readonly<{
  authority: SandboxCommandAgentAuthority;
  channelId: string;
  context: policies.PolicyMutationContext;
  credentialPolicyReconciliation?: "teams-outlook-shared-login";
  includeCredentialBindings: boolean;
  retainedEntries: readonly SandboxMessagingNetworkPolicyEntryPlan[];
  resolvedEntries: readonly ResolvedPackageMessagingPolicyEntry[];
}>;

export type PackagePolicyMutationReceipt = Readonly<{
  authority: SandboxCommandAgentAuthority;
  channelId: string;
  expectedPolicyDocument: string;
  ownedPolicyKeys?: readonly string[];
  previousPolicyDocument: string;
  submissionContext: policies.PolicyMutationContext;
}>;

export type PackagePolicyMutationResult = Readonly<{
  accepted: boolean;
  receipt: PackagePolicyMutationReceipt;
}>;

function readRetainedPackageChannelPolicyEntries(
  sandboxName: string,
  channelId: string,
  manifests: readonly ChannelManifest[],
): Readonly<{
  entries: readonly SandboxMessagingNetworkPolicyEntryPlan[];
  ownedPolicyKeys: ReadonlySet<string>;
  plan: SandboxMessagingPlan | null;
}> {
  const plan = getHydratedMessagingPlanFromEntry(getSandbox(sandboxName), {
    manifests,
  });
  const activeEntries = plan ? filterEnabledPlanEntries(plan, plan.networkPolicy.entries) : [];
  const entries = activeEntries.filter((candidate) => candidate.channelId !== channelId);
  return Object.freeze({
    entries,
    ownedPolicyKeys: new Set(activeEntries.flatMap((entry) => entry.policyKeys)),
    plan,
  });
}

function resolvedPolicyValues(
  entries: readonly ResolvedPackageMessagingPolicyEntry[],
): ReadonlyMap<string, unknown> {
  const values = new Map<string, unknown>();
  for (const resolved of entries) {
    const parsed = YAML.parse(resolved.content) as { network_policies?: unknown } | null;
    const networkPolicies = parsed?.network_policies;
    if (!networkPolicies || typeof networkPolicies !== "object" || Array.isArray(networkPolicies)) {
      throw new Error(
        `Resolved package policy '${resolved.entry.presetName}' has invalid network_policies`,
      );
    }
    for (const [key, value] of Object.entries(networkPolicies)) values.set(key, value);
  }
  return values;
}

function requireCompatibleSharedPolicyKeys(
  channelId: string,
  target: readonly ResolvedPackageMessagingPolicyEntry[],
  retained: readonly ResolvedPackageMessagingPolicyEntry[],
): void {
  const targetValues = resolvedPolicyValues(target);
  const retainedValues = resolvedPolicyValues(retained);
  for (const [key, targetValue] of targetValues) {
    if (retainedValues.has(key) && !isDeepStrictEqual(targetValue, retainedValues.get(key))) {
      throw new Error(
        `Messaging channel '${channelId}' policy key '${key}' conflicts with another active channel`,
      );
    }
  }
}

function requireCompatibleLivePolicyKeys(
  channelId: string,
  policyDocument: string,
  target: readonly ResolvedPackageMessagingPolicyEntry[],
  unboundTarget: readonly ResolvedPackageMessagingPolicyEntry[],
  ownedPolicyKeys: ReadonlySet<string>,
): void {
  let parsed: unknown;
  try {
    parsed = YAML.parse(policyDocument);
  } catch {
    throw new Error("Live messaging policy is invalid YAML");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Live messaging policy must be a YAML mapping");
  }
  const networkPolicies = (parsed as { network_policies?: unknown }).network_policies;
  if (networkPolicies === undefined) return;
  if (!networkPolicies || typeof networkPolicies !== "object" || Array.isArray(networkPolicies)) {
    throw new Error("Live messaging network_policies must be a mapping");
  }

  const targetValues = resolvedPolicyValues(target);
  const unboundValues = resolvedPolicyValues(unboundTarget);
  for (const [key, targetValue] of targetValues) {
    if (!Object.hasOwn(networkPolicies, key)) continue;
    const liveValue = (networkPolicies as Record<string, unknown>)[key];
    if (
      !isDeepStrictEqual(liveValue, targetValue) &&
      !isDeepStrictEqual(liveValue, unboundValues.get(key))
    ) {
      throw new Error(
        `Messaging channel '${channelId}' policy key '${key}' conflicts with live policy state`,
      );
    }
    if (!ownedPolicyKeys.has(key)) {
      throw new Error(
        `Messaging channel '${channelId}' policy key '${key}' exists without active package plan authority`,
      );
    }
  }
}

function compileChannelNetworkPolicyEntries(input: {
  readonly authority: SandboxCommandAgentAuthority;
  readonly availableChannels: readonly ChannelManifest[];
  readonly channelId: string;
  readonly sandboxName: string;
  readonly workflow: SandboxMessagingPlan["workflow"];
}): readonly SandboxMessagingNetworkPolicyEntryPlan[] {
  const manifest = input.availableChannels.find((candidate) => candidate.id === input.channelId);
  if (!manifest) {
    throw new Error(
      `Messaging channel '${input.channelId}' is unavailable to this harness package`,
    );
  }
  return planNetworkPolicy([manifest], {
    sandboxName: input.sandboxName,
    agent: input.authority.definition.name,
    workflow: input.workflow,
    isInteractive: false,
    configuredChannels: [input.channelId],
    disabledChannels: [],
    supportedChannelIds: [input.channelId],
  }).entries;
}

function requireMatchingPackagePolicyAuthority(
  sandboxName: string,
  expected: SandboxCommandAgentAuthority,
  context: policies.PolicyMutationContext,
): void {
  requireCurrentSandboxCommandAgentAuthority(expected, getSandbox(sandboxName));
  if (!context.agentAuthority || !isDeepStrictEqual(context.agentAuthority, expected)) {
    throw new Error(
      `Sandbox '${sandboxName}' policy authority does not match its messaging package receipt`,
    );
  }
}

/**
 * Compile and disclose the exact receipt-owned policy entries for one channel.
 * This package-backed path never consults a legacy channel-named preset.
 */
export function preparePackageChannelPolicy(input: {
  readonly allowedCredentialProviderNames: ReadonlySet<string>;
  readonly authority: SandboxCommandAgentAuthority;
  readonly availableChannels: readonly ChannelManifest[];
  readonly channelId: string;
  readonly disclose: boolean;
  readonly includeCredentialBindings: boolean;
  readonly messagingConfig?: MessagingChannelConfig | null;
  readonly priorPolicyMutationReceipts?: readonly PackagePolicyMutationReceipt[];
  readonly sandboxName: string;
  readonly workflow: SandboxMessagingPlan["workflow"];
}): PreparedPackageChannelPolicy {
  const manifest = input.availableChannels.find((candidate) => candidate.id === input.channelId);
  if (!manifest) {
    throw new Error(
      `Messaging channel '${input.channelId}' is unavailable to this harness package`,
    );
  }
  const entries = compileChannelNetworkPolicyEntries(input);
  const context = policies.inspectPolicyMutationContext(
    input.sandboxName,
    `${input.workflow} messaging policy for '${input.channelId}'`,
  );
  requireMatchingPackagePolicyAuthority(input.sandboxName, input.authority, context);
  const harnessPackageIdentity = input.authority.harnessPackage;
  if (!harnessPackageIdentity) {
    throw new Error("Receipt-backed messaging policy requires harness package authority");
  }
  const resolvedEntries = resolvePackageMessagingPolicyEntries({
    agentDefinition: input.authority.definition,
    entries,
    harnessPackageIdentity,
    includeCredentialBindings: input.includeCredentialBindings,
    messagingConfig: input.messagingConfig,
    sandboxName: input.sandboxName,
  });
  const unboundResolvedEntries = input.includeCredentialBindings
    ? resolvePackageMessagingPolicyEntries({
        agentDefinition: input.authority.definition,
        entries,
        harnessPackageIdentity,
        includeCredentialBindings: false,
        messagingConfig: input.messagingConfig,
        sandboxName: input.sandboxName,
      })
    : resolvedEntries;
  requireAuthorizedPackageMessagingPolicyProviders(
    resolvedEntries.map((entry) => entry.content),
    input.allowedCredentialProviderNames,
  );
  const retained = readRetainedPackageChannelPolicyEntries(
    input.sandboxName,
    input.channelId,
    input.availableChannels,
  );
  const ownedPolicyKeys = new Set(retained.ownedPolicyKeys);
  const targetPolicyKeys = new Set(resolvedEntries.flatMap(({ entry }) => entry.policyKeys));
  if (input.workflow === "start-channel" || input.workflow === "stop-channel") {
    const storedTarget = retained.plan?.channels.find(
      (channel) => channel.channelId === input.channelId && channel.configured,
    );
    if (storedTarget) {
      for (const entry of retained.plan?.networkPolicy.entries ?? []) {
        if (entry.channelId !== input.channelId) continue;
        for (const key of entry.policyKeys) {
          if (targetPolicyKeys.has(key)) ownedPolicyKeys.add(key);
        }
      }
    }
  }
  for (const receipt of input.priorPolicyMutationReceipts ?? []) {
    if (
      receipt.channelId === input.channelId &&
      isDeepStrictEqual(receipt.authority, input.authority) &&
      receipt.submissionContext.gatewayName === context.gatewayName &&
      packagePolicyDocumentsMatch(receipt.expectedPolicyDocument, context.basePolicyDocument)
    ) {
      for (const key of receipt.ownedPolicyKeys ?? []) {
        if (targetPolicyKeys.has(key)) ownedPolicyKeys.add(key);
      }
    }
  }
  requireCompatibleLivePolicyKeys(
    input.channelId,
    context.basePolicyDocument,
    resolvedEntries,
    unboundResolvedEntries,
    ownedPolicyKeys,
  );
  if (retained.entries.length > 0) {
    const resolvedRetainedEntries = resolvePackageMessagingPolicyEntries({
      agentDefinition: input.authority.definition,
      entries: retained.entries,
      harnessPackageIdentity,
      includeCredentialBindings: input.includeCredentialBindings,
      messagingConfig: getMessagingChannelConfigFromPlan(retained.plan),
      sandboxName: input.sandboxName,
    });
    requireCompatibleSharedPolicyKeys(input.channelId, resolvedEntries, resolvedRetainedEntries);
  }
  if (input.disclose) {
    for (const resolved of resolvedEntries) {
      const state = policies.getPresetContentGatewayState(input.sandboxName, resolved.content);
      policies.logPresetScopeForState(resolved.entry.presetName, resolved.content, state);
    }
  }
  return Object.freeze({
    authority: input.authority,
    channelId: input.channelId,
    context,
    credentialPolicyReconciliation: manifest.packageBuild?.credentialPolicyReconciliation,
    includeCredentialBindings: input.includeCredentialBindings,
    retainedEntries: retained.entries,
    resolvedEntries,
  });
}

function reconcilePreparedCredentialPolicy(
  sandboxName: string,
  prepared: PreparedPackageChannelPolicy,
  policy: string,
  targetRemainsActive: boolean,
  retainedEntries = prepared.retainedEntries,
): string {
  if (prepared.credentialPolicyReconciliation !== "teams-outlook-shared-login") return policy;
  const teamsActive =
    (targetRemainsActive && prepared.channelId === "teams") ||
    retainedEntries.some((entry) => entry.channelId === "teams");
  return policies.reconcileTeamsOutlookLoginCredentialBinding(
    policy,
    sandboxName,
    teamsActive && prepared.includeCredentialBindings,
  );
}

/** Revalidate the package receipt and live policy captured during preparation. */
export function recheckPreparedPackageChannelPolicy(
  sandboxName: string,
  prepared: PreparedPackageChannelPolicy,
): void {
  requireMatchingPackagePolicyAuthority(sandboxName, prepared.authority, prepared.context);
  policies.recheckPolicyMutationContext(
    sandboxName,
    `change receipt-backed messaging policy for '${prepared.resolvedEntries[0]?.entry.channelId ?? "channel"}'`,
    prepared.context,
  );
}

function packagePolicyKeysPresent(
  policyDocument: string,
  policyKeys: ReadonlySet<string>,
): boolean {
  if (policyKeys.size === 0) return false;
  let parsed: unknown;
  try {
    parsed = YAML.parse(policyDocument);
  } catch {
    throw new Error("Cannot remove receipt-backed messaging policy: live policy is invalid YAML");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      "Cannot remove receipt-backed messaging policy: live policy must be a YAML mapping",
    );
  }
  const networkPolicies = (parsed as { network_policies?: unknown }).network_policies;
  if (networkPolicies === undefined) return false;
  if (!networkPolicies || typeof networkPolicies !== "object" || Array.isArray(networkPolicies)) {
    throw new Error(
      "Cannot remove receipt-backed messaging policy: network_policies must be a mapping",
    );
  }
  return [...policyKeys].some((key) => Object.hasOwn(networkPolicies, key));
}

function packagePolicyDocumentsMatch(left: string, right: string): boolean {
  try {
    return isDeepStrictEqual(YAML.parse(left), YAML.parse(right));
  } catch {
    return false;
  }
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function preparedPolicyOwnedKeys(prepared: PreparedPackageChannelPolicy): readonly string[] {
  return Object.freeze([
    ...new Set(prepared.resolvedEntries.flatMap(({ entry }) => entry.policyKeys)),
  ]);
}

/** Apply all compiled entries with one policy-set mutation. */
export function applyPreparedPackageChannelPolicy(
  sandboxName: string,
  prepared: PreparedPackageChannelPolicy,
): boolean {
  return applyPreparedPackageChannelPolicyWithReceipt(sandboxName, prepared).accepted;
}

/** Apply one prepared policy and retain enough authority for safe compensation. */
export function applyPreparedPackageChannelPolicyWithReceipt(
  sandboxName: string,
  prepared: PreparedPackageChannelPolicy,
  receiptSink?: PackagePolicyMutationReceipt[],
  options: { readonly revalidateTarget?: (operation: string) => void } = {},
): PackagePolicyMutationResult {
  let desiredPolicy = prepared.context.basePolicyDocument;
  if (prepared.resolvedEntries.length === 0) {
    recheckPreparedPackageChannelPolicy(sandboxName, prepared);
    const result: PackagePolicyMutationResult = {
      accepted: true,
      receipt: {
        authority: prepared.authority,
        channelId: prepared.channelId,
        expectedPolicyDocument: desiredPolicy,
        ownedPolicyKeys: preparedPolicyOwnedKeys(prepared),
        previousPolicyDocument: prepared.context.basePolicyDocument,
        submissionContext: prepared.context,
      } satisfies PackagePolicyMutationReceipt,
    };
    receiptSink?.push(result.receipt);
    return result;
  }
  try {
    for (const resolved of prepared.resolvedEntries) {
      const entries = policies.extractPresetEntries(resolved.content);
      if (!entries) throw new Error(`Preset '${resolved.entry.presetName}' has no policy entries`);
      desiredPolicy = policies.mergePresetIntoPolicy(desiredPolicy, entries);
    }
    desiredPolicy = reconcilePreparedCredentialPolicy(sandboxName, prepared, desiredPolicy, true);
  } catch (error) {
    console.error(`  ${formatErrorMessage(error)}`);
    const result: PackagePolicyMutationResult = {
      accepted: false,
      receipt: {
        authority: prepared.authority,
        channelId: prepared.channelId,
        expectedPolicyDocument: desiredPolicy,
        ownedPolicyKeys: preparedPolicyOwnedKeys(prepared),
        previousPolicyDocument: prepared.context.basePolicyDocument,
        submissionContext: prepared.context,
      } satisfies PackagePolicyMutationReceipt,
    };
    receiptSink?.push(result.receipt);
    return result;
  }
  const receipt: PackagePolicyMutationReceipt = Object.freeze({
    authority: prepared.authority,
    channelId: prepared.channelId,
    expectedPolicyDocument: desiredPolicy,
    ownedPolicyKeys: preparedPolicyOwnedKeys(prepared),
    previousPolicyDocument: prepared.context.basePolicyDocument,
    submissionContext: prepared.context,
  });
  if (packagePolicyDocumentsMatch(prepared.context.basePolicyDocument, desiredPolicy)) {
    recheckPreparedPackageChannelPolicy(sandboxName, prepared);
    receiptSink?.push(receipt);
    return { accepted: true, receipt };
  }
  recheckPreparedPackageChannelPolicy(sandboxName, prepared);
  options.revalidateTarget?.(
    `apply policy for receipt-backed messaging channel '${prepared.channelId}'`,
  );
  // Register compensation authority before the setter can mutate, fail, or throw.
  receiptSink?.push(receipt);
  return {
    accepted: policies.setPolicyDocument(sandboxName, desiredPolicy, {
      context: prepared.context,
      nonFatal: true,
      operation: "apply receipt-backed messaging policy",
    }),
    receipt,
  };
}

/** Restore accepted or ambiguous package policy submissions in reverse order. */
export function rollbackPackagePolicyMutations(
  sandboxName: string,
  receipts: readonly PackagePolicyMutationReceipt[],
  options: { readonly revalidateTarget?: (operation: string) => void } = {},
): boolean {
  for (const receipt of [...receipts].reverse()) {
    let current: policies.PolicyMutationContext;
    try {
      options.revalidateTarget?.(
        `inspect policy compensation target for messaging channel '${receipt.channelId}'`,
      );
      current = policies.inspectPolicyMutationContext(
        sandboxName,
        `roll back receipt-backed messaging policy for '${receipt.channelId}'`,
      );
      requireMatchingPackagePolicyAuthority(sandboxName, receipt.authority, current);
      if (current.gatewayName !== receipt.submissionContext.gatewayName) {
        throw new Error(
          `Sandbox '${sandboxName}' gateway changed before messaging policy compensation`,
        );
      }
    } catch (error) {
      console.error(`  ${formatErrorMessage(error)}`);
      return false;
    }
    if (packagePolicyDocumentsMatch(current.basePolicyDocument, receipt.previousPolicyDocument)) {
      continue;
    }
    if (!packagePolicyDocumentsMatch(current.basePolicyDocument, receipt.expectedPolicyDocument)) {
      console.error(
        `  Refusing to roll back '${receipt.channelId}' policy because live policy changed after submission.`,
      );
      return false;
    }
    try {
      options.revalidateTarget?.(`restore policy for messaging channel '${receipt.channelId}'`);
    } catch (error) {
      console.error(`  ${formatErrorMessage(error)}`);
      return false;
    }
    if (
      !policies.setPolicyDocument(sandboxName, receipt.previousPolicyDocument, {
        context: current,
        nonFatal: true,
        operation: "roll back receipt-backed messaging policy",
      })
    ) {
      return false;
    }
  }
  return true;
}

/** Remove only keys not required by another active channel, in one mutation. */
export function removePreparedPackageChannelPolicy(
  sandboxName: string,
  prepared: PreparedPackageChannelPolicy,
  retainedEntries: readonly SandboxMessagingNetworkPolicyEntryPlan[],
): boolean {
  const retainedKeys = new Set(retainedEntries.flatMap((entry) => entry.policyKeys));
  const removableKeys = new Set(
    prepared.resolvedEntries.flatMap(({ entry }) =>
      entry.policyKeys.filter((key) => !retainedKeys.has(key)),
    ),
  );
  if (!packagePolicyKeysPresent(prepared.context.basePolicyDocument, removableKeys)) {
    recheckPreparedPackageChannelPolicy(sandboxName, prepared);
    return true;
  }

  const removalContent = YAML.stringify({
    network_policies: Object.fromEntries([...removableKeys].map((key) => [key, {}])),
  });
  const entries = policies.extractPresetEntries(removalContent);
  if (!entries) return false;
  let desiredPolicy: string;
  try {
    desiredPolicy = policies.removePresetFromPolicy(prepared.context.basePolicyDocument, entries);
    desiredPolicy = reconcilePreparedCredentialPolicy(
      sandboxName,
      prepared,
      desiredPolicy,
      false,
      retainedEntries,
    );
  } catch (error) {
    console.error(`  ${formatErrorMessage(error)}`);
    return false;
  }
  if (packagePolicyDocumentsMatch(prepared.context.basePolicyDocument, desiredPolicy)) {
    recheckPreparedPackageChannelPolicy(sandboxName, prepared);
    return true;
  }
  recheckPreparedPackageChannelPolicy(sandboxName, prepared);
  return policies.setPolicyDocument(sandboxName, desiredPolicy, {
    context: prepared.context,
    nonFatal: true,
    operation: "remove receipt-backed messaging policy",
  });
}

/** Return active entries whose keys must survive removal of one channel. */
export function retainedPackageChannelPolicyEntries(
  sandboxName: string,
  channelId: string,
  manifests: readonly ChannelManifest[],
): readonly SandboxMessagingNetworkPolicyEntryPlan[] {
  return readRetainedPackageChannelPolicyEntries(sandboxName, channelId, manifests).entries;
}
