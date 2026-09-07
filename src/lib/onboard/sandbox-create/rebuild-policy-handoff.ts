// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { isDeepStrictEqual } from "node:util";
import YAML from "yaml";

import {
  parseOpenShellPolicy,
  stripProviderComposedPolicies,
} from "../../adapters/openshell/policy-boundary";
import type { AgentDefinition } from "../../agent/defs";
import type { HarnessPackageIdentity } from "../../agent-runtime/package/types";
import { isReviewedMessagingChannelPolicyUpgrade } from "../../messaging/channels/policy";
import type { SandboxMessagingNetworkPolicyEntryPlan } from "../../messaging/manifest";
import type { MessagingChannelConfig } from "../../messaging-channel-config";
import {
  loadReceiptBoundPackagePolicyPreset,
  resolvePackageMessagingPolicyEntries,
} from "../../policy/package-messaging";
import { reconcileTeamsOutlookLoginCredentialBinding } from "../../policy/microsoft-login-credential-binding";
import { getCredentialBindingProviders, type InitialSandboxPolicy } from "../initial-policy";
import { cleanupTempDir, createExactTempFileCleanup, secureTempFile } from "../temp-files";

const REBUILD_POLICY_HANDOFF_PREFIX = "nemoclaw-rebuild-policy-handoff";

type PolicyMapping = Record<string, unknown>;

export type RebuildCredentialPolicyReconciliation = {
  readonly mode: "teams-outlook-shared-login";
  readonly teamsChannelState: "active" | "removed";
};

export type RebuildNetworkPolicyRemovalExpectation = Readonly<{
  key: string;
  allowedValues: readonly unknown[];
}>;

function authorizedCredentialBindingProviders(
  source: string,
  replacementPolicy: InitialSandboxPolicy,
  additionalAuthorized: readonly string[],
): string[] {
  const observed = getCredentialBindingProviders(source);
  const authorized = new Set([
    ...(replacementPolicy.credentialBindingProviders ?? []),
    ...additionalAuthorized,
  ]);
  const unauthorized = observed.filter((provider) => !authorized.has(provider));
  if (unauthorized.length > 0) {
    throw new Error(
      "Cannot prepare rebuild policy handoff: live policy references a credential provider outside the verified replacement plan.",
    );
  }
  return observed;
}

function isPolicyMapping(value: unknown): value is PolicyMapping {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function policyMapping(value: unknown, label: string): PolicyMapping {
  if (!isPolicyMapping(value)) {
    throw new Error(`Cannot prepare rebuild policy handoff: ${label} must be a mapping.`);
  }
  return value;
}

/** Select rebuild policy bytes through the shared exact-package messaging boundary. */
export function resolveRebuildPackageMessagingPolicySources(input: {
  readonly agentDefinition: AgentDefinition;
  readonly entries: readonly SandboxMessagingNetworkPolicyEntryPlan[];
  readonly harnessPackageIdentity: HarnessPackageIdentity;
  readonly includeCredentialBindings?: boolean;
  readonly messagingConfig?: MessagingChannelConfig | null;
  readonly sandboxName: string;
}): string[] {
  return resolvePackageMessagingPolicyEntries({
    ...input,
    includeCredentialBindings: input.includeCredentialBindings ?? true,
  }).map(({ content }) => content);
}

function networkPolicyValuesFromSources(
  sources: readonly string[],
  selectedKeys: ReadonlySet<string>,
): ReadonlyMap<string, unknown> {
  const values = new Map<string, unknown>();
  for (const source of sources) {
    let parsed: unknown;
    try {
      parsed = YAML.parse(source);
    } catch {
      throw new Error(
        "Cannot prepare rebuild policy handoff: package network policy source is invalid YAML.",
      );
    }
    const policy = policyMapping(parsed, "package network policy source");
    const networkPolicies = policyMapping(
      policy.network_policies,
      "package network policy source network_policies",
    );
    for (const [key, value] of Object.entries(networkPolicies)) {
      if (!selectedKeys.has(key)) continue;
      const existing = values.get(key);
      if (existing !== undefined && !isDeepStrictEqual(existing, value)) {
        throw new Error(
          `Cannot prepare rebuild policy handoff: package network policy '${key}' has conflicting removal sources.`,
        );
      }
      values.set(key, structuredClone(value));
    }
  }
  return values;
}

/** Resolve exact package-owned values that are safe to remove during rebuild. */
export function resolveRebuildPackagePolicyRemovalExpectations(input: {
  readonly agentDefinition: AgentDefinition;
  readonly harnessPackageIdentity: HarnessPackageIdentity;
  readonly messagingConfig?: MessagingChannelConfig | null;
  readonly messagingEntries: readonly SandboxMessagingNetworkPolicyEntryPlan[];
  readonly policyKeys: readonly string[];
  readonly automaticPresetNames: readonly string[];
  readonly sandboxName: string;
}): readonly RebuildNetworkPolicyRemovalExpectation[] {
  const selectedKeys = new Set(input.policyKeys);
  const boundMessagingValues = networkPolicyValuesFromSources(
    resolveRebuildPackageMessagingPolicySources({
      agentDefinition: input.agentDefinition,
      entries: input.messagingEntries,
      harnessPackageIdentity: input.harnessPackageIdentity,
      includeCredentialBindings: true,
      messagingConfig: input.messagingConfig,
      sandboxName: input.sandboxName,
    }),
    selectedKeys,
  );
  const unboundMessagingValues = networkPolicyValuesFromSources(
    resolveRebuildPackageMessagingPolicySources({
      agentDefinition: input.agentDefinition,
      entries: input.messagingEntries,
      harnessPackageIdentity: input.harnessPackageIdentity,
      includeCredentialBindings: false,
      messagingConfig: input.messagingConfig,
      sandboxName: input.sandboxName,
    }),
    selectedKeys,
  );
  const automaticValues = new Map<string, unknown>();
  for (const presetName of input.automaticPresetNames) {
    const preset = loadReceiptBoundPackagePolicyPreset({
      agentDefinition: input.agentDefinition,
      harnessPackageIdentity: input.harnessPackageIdentity,
      presetName,
    });
    if (!preset) {
      throw new Error(
        `Cannot prepare rebuild policy handoff: package automatic policy preset '${presetName}' is unavailable.`,
      );
    }
    const values = networkPolicyValuesFromSources([preset.content], selectedKeys);
    if (!values.has(presetName)) {
      throw new Error(
        `Cannot prepare rebuild policy handoff: package automatic policy preset '${presetName}' does not own its network policy key.`,
      );
    }
    automaticValues.set(presetName, values.get(presetName));
  }

  return Object.freeze(
    input.policyKeys.flatMap((key) => {
      const allowedValues = [
        boundMessagingValues.get(key),
        unboundMessagingValues.get(key),
        automaticValues.get(key),
      ].filter((value): value is NonNullable<typeof value> => value !== undefined);
      const uniqueValues = allowedValues.filter(
        (value, index) =>
          allowedValues.findIndex((candidate) => isDeepStrictEqual(candidate, value)) === index,
      );
      return uniqueValues.length === 0
        ? []
        : [Object.freeze({ key, allowedValues: Object.freeze(uniqueValues) })];
    }),
  );
}

function policyPaths(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`Cannot prepare rebuild policy handoff: ${label} must be a string array.`);
  }
  return [...value];
}

function optionalPolicyPaths(mapping: PolicyMapping, field: string, label: string): string[] {
  return mapping[field] === undefined ? [] : policyPaths(mapping[field], `${label}.${field}`);
}

function mergeReplacementFilesystemAccess(
  live: PolicyMapping,
  replacement: PolicyMapping,
): boolean {
  const replacementFilesystemValue = replacement.filesystem_policy;
  if (replacementFilesystemValue === undefined) return false;
  const replacementFilesystem = policyMapping(
    replacementFilesystemValue,
    "replacement filesystem_policy",
  );
  const requiredReadOnly = optionalPolicyPaths(
    replacementFilesystem,
    "read_only",
    "replacement filesystem_policy",
  );
  const requiredReadWrite = optionalPolicyPaths(
    replacementFilesystem,
    "read_write",
    "replacement filesystem_policy",
  );
  if (requiredReadOnly.length === 0 && requiredReadWrite.length === 0) return false;

  const liveFilesystemValue = live.filesystem_policy;
  const liveFilesystem =
    liveFilesystemValue === undefined
      ? {}
      : structuredClone(policyMapping(liveFilesystemValue, "live filesystem_policy"));
  let readOnly = optionalPolicyPaths(liveFilesystem, "read_only", "live filesystem_policy");
  const readWrite = optionalPolicyPaths(liveFilesystem, "read_write", "live filesystem_policy");
  let changed = false;

  for (const requiredPath of requiredReadWrite) {
    if (readOnly.includes(requiredPath)) {
      readOnly = readOnly.filter((entry) => entry !== requiredPath);
      changed = true;
    }
    if (!readWrite.includes(requiredPath)) {
      readWrite.push(requiredPath);
      changed = true;
    }
  }
  for (const requiredPath of requiredReadOnly) {
    if (readOnly.includes(requiredPath) || readWrite.includes(requiredPath)) continue;
    readOnly.push(requiredPath);
    changed = true;
  }
  if (!changed) return false;

  liveFilesystem.read_only = readOnly;
  liveFilesystem.read_write = readWrite;
  live.filesystem_policy = liveFilesystem;
  return true;
}

function mergeMissingReplacementProcessIdentity(
  live: PolicyMapping,
  replacement: PolicyMapping,
): boolean {
  const replacementProcessValue = replacement.process;
  if (replacementProcessValue === undefined) return false;
  const replacementProcess = policyMapping(replacementProcessValue, "replacement process");
  const liveProcessValue = live.process;
  const liveProcess =
    liveProcessValue === undefined
      ? {}
      : structuredClone(policyMapping(liveProcessValue, "live process"));
  let changed = false;
  for (const field of ["run_as_user", "run_as_group"] as const) {
    if (liveProcess[field] !== undefined || typeof replacementProcess[field] !== "string") continue;
    liveProcess[field] = replacementProcess[field];
    changed = true;
  }
  if (changed) live.process = liveProcess;
  return changed;
}

function mergeRequestedReplacementNetworkPolicies(
  live: PolicyMapping,
  replacement: PolicyMapping,
  requiredKeys: readonly string[],
  removedKeys: readonly string[],
  requiredPolicySources: readonly string[],
  reviewedMessagingUpgradeKeys?: readonly string[],
  removalExpectations: readonly RebuildNetworkPolicyRemovalExpectation[] = [],
): boolean {
  if (requiredKeys.length === 0 && removedKeys.length === 0) return false;

  const required = new Set(requiredKeys);
  const removed = new Set(removedKeys);
  for (const key of required) {
    if (removed.has(key)) {
      throw new Error(
        `Cannot prepare rebuild policy handoff: network policy '${key}' is both required and removed.`,
      );
    }
  }
  const replacementPolicies =
    replacement.network_policies === undefined
      ? {}
      : structuredClone(
          policyMapping(replacement.network_policies, "replacement network_policies"),
        );
  if (required.size > 0) {
    const requiredPolicies: PolicyMapping = {};
    for (const source of requiredPolicySources) {
      let parsed: unknown;
      try {
        parsed = YAML.parse(source);
      } catch {
        throw new Error(
          "Cannot prepare rebuild policy handoff: required network policy source is invalid YAML.",
        );
      }
      const policy = policyMapping(parsed, "required network policy source");
      const policies = policyMapping(
        policy.network_policies,
        "required network policy source network_policies",
      );
      for (const [key, value] of Object.entries(policies)) {
        if (!required.has(key)) continue;
        const existing = requiredPolicies[key];
        if (existing !== undefined && !isDeepStrictEqual(existing, value)) {
          throw new Error(
            `Cannot prepare rebuild policy handoff: required network policy '${key}' has conflicting replacement sources.`,
          );
        }
        requiredPolicies[key] = structuredClone(value);
      }
    }
    Object.assign(replacementPolicies, requiredPolicies);
  }
  const livePolicies =
    live.network_policies === undefined
      ? {}
      : structuredClone(policyMapping(live.network_policies, "live network_policies"));
  let changed = false;

  const removalExpectationsByKey = new Map<string, readonly unknown[]>();
  for (const expectation of removalExpectations) {
    if (
      !removed.has(expectation.key) ||
      expectation.allowedValues.length === 0 ||
      removalExpectationsByKey.has(expectation.key)
    ) {
      throw new Error(
        "Cannot prepare rebuild policy handoff: network policy removal authority is invalid.",
      );
    }
    removalExpectationsByKey.set(expectation.key, expectation.allowedValues);
  }

  for (const key of removed) {
    if (!Object.hasOwn(livePolicies, key)) continue;
    const allowedValues = removalExpectationsByKey.get(key);
    if (
      allowedValues &&
      !allowedValues.some((expectedValue) => isDeepStrictEqual(livePolicies[key], expectedValue))
    ) {
      throw new Error(
        `Cannot prepare rebuild policy handoff: live network policy '${key}' does not match package removal authority.`,
      );
    }
    delete livePolicies[key];
    changed = true;
  }
  for (const key of required) {
    if (!Object.hasOwn(replacementPolicies, key)) {
      throw new Error(
        `Cannot prepare rebuild policy handoff: required network policy '${key}' is absent from the replacement policy.`,
      );
    }
    if (Object.hasOwn(livePolicies, key)) {
      if (!isDeepStrictEqual(livePolicies[key], replacementPolicies[key])) {
        if (
          isReviewedMessagingChannelPolicyUpgrade(
            key,
            livePolicies[key],
            replacementPolicies[key],
            reviewedMessagingUpgradeKeys,
          )
        ) {
          livePolicies[key] = structuredClone(replacementPolicies[key]);
          changed = true;
          continue;
        }
        throw new Error(
          `Cannot prepare rebuild policy handoff: live network policy '${key}' does not match the enabled channel requirement.`,
        );
      }
      continue;
    }
    livePolicies[key] = structuredClone(replacementPolicies[key]);
    changed = true;
  }

  if (changed) live.network_policies = livePolicies;
  return changed;
}

/**
 * Build one replacement-create input from OpenShell's live policy. Host edits
 * win completely outside missing non-root process identity, filesystem access,
 * and network keys required by an explicit active messaging command. A live
 * collision on an enabled channel key must already match the selected channel
 * policy or rebuild stops before deletion. Those bounded image/command
 * requirements are added only to the replacement create input; they are never
 * persisted as a NemoClaw-owned policy shadow.
 */
export function mergeReplacementPolicyAccess(
  livePolicySource: string,
  replacementPolicySource: string,
  requiredNetworkPolicyKeys: readonly string[] = [],
  removedNetworkPolicyKeys: readonly string[] = [],
  requiredNetworkPolicySources: readonly string[] = [],
  sandboxName?: string,
  reviewedMessagingUpgradeKeys?: readonly string[],
  credentialPolicyReconciliation?: RebuildCredentialPolicyReconciliation | null,
  removalExpectations: readonly RebuildNetworkPolicyRemovalExpectation[] = [],
): { readonly changed: boolean; readonly source: string } {
  const providerNormalizedLivePolicySource = stripProviderComposedPolicies(livePolicySource);
  const teamsActive =
    credentialPolicyReconciliation === undefined
      ? requiredNetworkPolicyKeys.includes("teams")
        ? true
        : removedNetworkPolicyKeys.includes("teams")
          ? false
          : null
      : credentialPolicyReconciliation?.mode === "teams-outlook-shared-login"
        ? credentialPolicyReconciliation.teamsChannelState === "active"
        : null;
  const normalizedLivePolicySource =
    teamsActive !== null
      ? reconcileTeamsOutlookLoginCredentialBinding(
          providerNormalizedLivePolicySource,
          sandboxName,
          teamsActive,
        )
      : providerNormalizedLivePolicySource;
  const live = structuredClone(
    parseOpenShellPolicy(normalizedLivePolicySource).policy,
  ) as PolicyMapping;
  const replacement = parseOpenShellPolicy(replacementPolicySource).policy as PolicyMapping;
  const processChanged = mergeMissingReplacementProcessIdentity(live, replacement);
  const filesystemChanged = mergeReplacementFilesystemAccess(live, replacement);
  const networkChanged = mergeRequestedReplacementNetworkPolicies(
    live,
    replacement,
    requiredNetworkPolicyKeys,
    removedNetworkPolicyKeys,
    requiredNetworkPolicySources,
    reviewedMessagingUpgradeKeys,
    removalExpectations,
  );
  const changed =
    normalizedLivePolicySource !== livePolicySource ||
    processChanged ||
    filesystemChanged ||
    networkChanged;
  return changed
    ? { changed: true, source: YAML.stringify(live) }
    : { changed: false, source: normalizedLivePolicySource };
}

/** Materialize the single ephemeral policy input consumed by an explicit rebuild. */
export function materializeRebuildPolicyHandoff(input: {
  readonly sandboxName?: string;
  readonly livePolicyPath: string;
  readonly replacementPolicy: InitialSandboxPolicy;
  readonly requiredNetworkPolicyKeys?: readonly string[];
  readonly removedNetworkPolicyKeys?: readonly string[];
  readonly requiredNetworkPolicySources?: readonly string[];
  readonly removalExpectations?: readonly RebuildNetworkPolicyRemovalExpectation[];
  readonly authorizedCredentialBindingProviders?: readonly string[];
  readonly reviewedMessagingUpgradeKeys?: readonly string[];
  readonly credentialPolicyReconciliation?: RebuildCredentialPolicyReconciliation | null;
}): InitialSandboxPolicy {
  const liveSource = fs.readFileSync(input.livePolicyPath, "utf8");
  const replacementSource =
    input.replacementPolicy.sourceBytes?.toString("utf8") ??
    fs.readFileSync(input.replacementPolicy.policyPath, "utf8");
  const merged = mergeReplacementPolicyAccess(
    liveSource,
    replacementSource,
    input.requiredNetworkPolicyKeys,
    input.removedNetworkPolicyKeys,
    input.requiredNetworkPolicySources,
    input.sandboxName,
    input.reviewedMessagingUpgradeKeys,
    input.credentialPolicyReconciliation,
    input.removalExpectations,
  );
  if (!merged.changed) {
    return {
      ...input.replacementPolicy,
      policyPath: input.livePolicyPath,
      appliedPresets: [],
      credentialBindingProviders: authorizedCredentialBindingProviders(
        liveSource,
        input.replacementPolicy,
        input.authorizedCredentialBindingProviders ?? [],
      ),
      sourceBytes: Buffer.from(liveSource),
    };
  }

  const policyPath = secureTempFile(REBUILD_POLICY_HANDOFF_PREFIX, ".yaml");
  try {
    fs.writeFileSync(policyPath, merged.source, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    const cleanupHandoff = createExactTempFileCleanup(policyPath, REBUILD_POLICY_HANDOFF_PREFIX);
    const cleanup = (): boolean => {
      const handoffRemoved = cleanupHandoff();
      const replacementRemoved = input.replacementPolicy.cleanup?.() ?? true;
      return handoffRemoved && replacementRemoved;
    };
    return {
      ...input.replacementPolicy,
      policyPath,
      appliedPresets: [],
      credentialBindingProviders: authorizedCredentialBindingProviders(
        merged.source,
        input.replacementPolicy,
        input.authorizedCredentialBindingProviders ?? [],
      ),
      sourceBytes: Buffer.from(merged.source),
      cleanup,
      cleanupExact: cleanup,
    };
  } catch (error) {
    cleanupTempDir(policyPath, REBUILD_POLICY_HANDOFF_PREFIX);
    throw error;
  }
}
