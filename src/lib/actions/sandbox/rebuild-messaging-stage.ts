// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isDeepStrictEqual } from "node:util";

import type { AgentDefinition } from "../../agent/defs";
import { MessagingSetupApplier } from "../../messaging/applier/setup-applier";
import { createBuiltInChannelManifestRegistry } from "../../messaging/channels/built-ins";
import { createBuiltInRenderTemplateResolver } from "../../messaging/channels/template-resolver";
import { MessagingWorkflowPlanner } from "../../messaging/compiler/workflow-planner";
import type {
  ChannelManifest,
  MessagingChannelId,
  SandboxMessagingPlan,
} from "../../messaging/manifest";
import { createChannelManifestRegistry } from "../../messaging/manifest/registry";
import {
  listMessagingChannelsForProfile,
  resolveAgentMessagingProfileAuthority,
  type SandboxMessagingProfileAuthority,
} from "../../messaging/profile-authority";
import {
  isMessagingSupportedAgent,
  listSupportedMessagingChannelIdsForAgent,
  tryGetMessagingAgentId,
} from "../../messaging/utils";
import type { ResolvedSandboxAgent } from "../../onboard/sandbox-agent";
import { getValidatedMessagingTokenByEnvKey } from "../../onboard/messaging-token";
import {
  hydrateMessagingChannelConfig,
  type MessagingChannelConfig,
} from "../../messaging-channel-config";
import { hashCredential } from "../../security/credential-hash";
import { listChannels } from "../../sandbox/channels";
import type { SandboxEntry } from "../../state/registry";
import { checkPinnedAgentAuthority, rebuildAgentAuthoritiesMatch } from "./rebuild/authority";

export interface RebuildMessagingStageOptions {
  /** Exact authority captured at rebuild preflight for receipt-backed sandboxes. */
  readonly agentAuthority?: ResolvedSandboxAgent;
  /** Legacy session configuration admitted only by explicit package-migration provenance. */
  readonly legacyMessagingConfig?: MessagingChannelConfig | null;
  /** Secret-free hashes proving the matching legacy session migrated each credential. */
  readonly legacyCredentialHashes?: Readonly<Record<string, string>> | null;
  readonly resolveMessagingProfileAuthority?: (
    authority: ResolvedSandboxAgent,
  ) => SandboxMessagingProfileAuthority;
}

async function buildMigratedLegacyMessagingPackagePlan(input: {
  readonly agent: AgentDefinition;
  readonly legacyCredentialHashes: Readonly<Record<string, string>> | null | undefined;
  readonly legacyMessagingConfig: MessagingChannelConfig | null | undefined;
  readonly manifests: readonly ChannelManifest[];
  readonly planner: MessagingWorkflowPlanner;
  readonly sandboxName: string;
  readonly supportedChannelIds: readonly MessagingChannelId[];
}): Promise<SandboxMessagingPlan | null> {
  const telegramRequireMention = input.legacyMessagingConfig?.TELEGRAM_REQUIRE_MENTION?.trim();
  const accountId = input.legacyMessagingConfig?.WECHAT_ACCOUNT_ID?.trim();
  const baseUrl = input.legacyMessagingConfig?.WECHAT_BASE_URL?.trim();
  const userId = input.legacyMessagingConfig?.WECHAT_USER_ID?.trim();
  if (!accountId) {
    if (baseUrl || userId) {
      throw new Error(
        `Migrated harness package '${input.agent.name}' cannot reconstruct incomplete legacy WeChat state without WECHAT_ACCOUNT_ID`,
      );
    }
  }
  const selectedChannelIds: MessagingChannelId[] = [];
  if (telegramRequireMention) selectedChannelIds.push("telegram");
  if (accountId) selectedChannelIds.push("wechat");
  if (selectedChannelIds.length === 0) return null;
  const selectedManifests = selectedChannelIds.map((channelId) => {
    const manifest = input.manifests.find((candidate) => candidate.id === channelId);
    if (manifest) return manifest;
    throw new Error(
      `Migrated harness package '${input.agent.name}' does not declare the legacy '${channelId}' channel`,
    );
  });
  hydrateMessagingChannelConfig(input.legacyMessagingConfig);
  const credentialHashesByEnv = new Map<string, string>();
  const credentialAvailability = Object.fromEntries(
    selectedManifests.flatMap((manifest) =>
      manifest.inputs
        .filter((entry) => entry.kind === "secret" && entry.required)
        .map((entry) => {
          const envKey = entry.envKey;
          const sessionHash = envKey ? input.legacyCredentialHashes?.[envKey] : undefined;
          const currentCredential = envKey
            ? getValidatedMessagingTokenByEnvKey(listChannels(), envKey)
            : null;
          const credentialHash =
            hashCredential(currentCredential) ??
            (typeof sessionHash === "string" && /^[0-9a-f]{64}$/i.test(sessionHash)
              ? sessionHash.toLowerCase()
              : null);
          if (!envKey || !credentialHash) {
            throw new Error(
              `Migrated harness package '${input.agent.name}' cannot prove its legacy '${manifest.id}' credential; restore the credential and rerun rebuild`,
            );
          }
          credentialHashesByEnv.set(envKey, credentialHash);
          return [`${manifest.id}.${entry.id}`, true] as const;
        }),
    ),
  );
  const plan = await input.planner.buildPlan({
    sandboxName: input.sandboxName,
    agent: input.agent.name,
    workflow: "rebuild",
    isInteractive: false,
    configuredChannels: selectedChannelIds,
    disabledChannels: [],
    supportedChannelIds: input.supportedChannelIds,
    credentialAvailability,
  });
  const inactiveChannelId = selectedChannelIds.find(
    (channelId) => !plan.channels.find((channel) => channel.channelId === channelId)?.active,
  );
  if (inactiveChannelId) {
    throw new Error(
      `Migrated harness package '${input.agent.name}' cannot reconstruct its legacy '${inactiveChannelId}' channel from stored configuration`,
    );
  }
  return {
    ...plan,
    credentialBindings: plan.credentialBindings.map((binding) => {
      const credentialHash = credentialHashesByEnv.get(binding.providerEnvKey);
      return credentialHash ? { ...binding, credentialHash } : binding;
    }),
  };
}

function receiptBackedMessagingProfile(
  sandboxEntry: SandboxEntry,
  options: RebuildMessagingStageOptions,
): SandboxMessagingProfileAuthority {
  const authority = options.agentAuthority;
  if (!authority || checkPinnedAgentAuthority(sandboxEntry, authority) !== null) {
    throw new Error("Receipt-backed messaging rebuild requires exact pinned package authority");
  }
  const profile = (
    options.resolveMessagingProfileAuthority ?? resolveAgentMessagingProfileAuthority
  )(authority);
  if (
    !rebuildAgentAuthoritiesMatch(profile.packageAuthority, authority) ||
    !isDeepStrictEqual(profile.agent, authority.definition) ||
    (profile.integration !== null && profile.integration.packageId !== authority.harnessPackage?.id)
  ) {
    throw new Error("Receipt-backed messaging profile does not match pinned package authority");
  }
  return profile;
}

/** Build and stage the manifest-derived messaging recreate contract. */
export async function stageMessagingManifestPlanForRebuild(
  sandboxName: string,
  sandboxEntry: SandboxEntry,
  agent: AgentDefinition,
  log: (message: string) => void,
  options: RebuildMessagingStageOptions = {},
): Promise<SandboxMessagingPlan | null> {
  const builtInRegistry = createBuiltInChannelManifestRegistry();
  const receiptBacked =
    sandboxEntry.harnessPackage != null || sandboxEntry.harnessPackageMigration != null;
  const profile = receiptBacked ? receiptBackedMessagingProfile(sandboxEntry, options) : null;
  const effectiveAgent = profile?.agent ?? agent;
  const manifests = profile
    ? listMessagingChannelsForProfile(profile, builtInRegistry)
    : builtInRegistry.list();
  const manifestRegistry = createChannelManifestRegistry(manifests);
  const agentId = tryGetMessagingAgentId(effectiveAgent, manifests);
  if (agentId === null) {
    MessagingSetupApplier.clearPlanEnv();
    log(
      `Messaging manifest rebuild plan skipped: agent '${effectiveAgent.name}' is not supported by any channel manifest`,
    );
    return null;
  }
  if (!isMessagingSupportedAgent(effectiveAgent, manifests)) {
    MessagingSetupApplier.clearPlanEnv();
    log(
      `Messaging manifest rebuild plan skipped: agent '${effectiveAgent.name}' has no supported messaging channels`,
    );
    return null;
  }
  const supportedChannelIds = listSupportedMessagingChannelIdsForAgent(manifests, agentId);
  const planner = new MessagingWorkflowPlanner(
    manifestRegistry,
    undefined,
    createBuiltInRenderTemplateResolver(),
  );
  let plan = await planner.buildRebuildPlanFromSandboxEntry({
    sandboxName,
    agent: agentId,
    sandboxEntry,
    supportedChannelIds,
  });
  if (!plan && sandboxEntry.harnessPackageMigration && sandboxEntry.messaging == null) {
    plan = await buildMigratedLegacyMessagingPackagePlan({
      agent: effectiveAgent,
      legacyCredentialHashes: options.legacyCredentialHashes,
      legacyMessagingConfig: options.legacyMessagingConfig,
      manifests,
      planner,
      sandboxName,
      supportedChannelIds,
    });
    if (plan) log("Messaging manifest rebuild plan restored from legacy session state");
  }
  if (!plan && receiptBacked && sandboxEntry.messaging != null) {
    throw new Error(
      "Receipt-backed messaging state could not be reconstructed from its exact package manifests",
    );
  }
  if (!plan) {
    MessagingSetupApplier.clearPlanEnv();
    log("Messaging manifest rebuild plan: no configured channels");
    return null;
  }
  MessagingSetupApplier.writePlanToEnv(plan);
  if (plan.channels.length === 0) {
    log("Messaging manifest rebuild plan staged: no configured channels");
    return plan;
  }
  log(
    `Messaging manifest rebuild plan staged: ${plan.channels
      .map((channel) => channel.channelId)
      .join(",")}`,
  );
  return plan;
}
