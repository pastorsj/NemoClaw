// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isDeepStrictEqual } from "node:util";

import type { AgentDefinition } from "../../agent/defs";
import { MessagingSetupApplier } from "../../messaging/applier/setup-applier";
import { createBuiltInChannelManifestRegistry } from "../../messaging/channels/built-ins";
import { createBuiltInRenderTemplateResolver } from "../../messaging/channels/template-resolver";
import { MessagingWorkflowPlanner } from "../../messaging/compiler/workflow-planner";
import type { SandboxMessagingPlan } from "../../messaging/manifest";
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
import type { SandboxEntry } from "../../state/registry";
import {
  checkPinnedAgentAuthority,
  rebuildAgentAuthoritiesMatch,
} from "./rebuild/authority";

export interface RebuildMessagingStageOptions {
  /** Exact authority captured at rebuild preflight for receipt-backed sandboxes. */
  readonly agentAuthority?: ResolvedSandboxAgent;
  readonly resolveMessagingProfileAuthority?: (
    authority: ResolvedSandboxAgent,
  ) => SandboxMessagingProfileAuthority;
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
    (profile.integration !== null &&
      profile.integration.packageId !== authority.harnessPackage?.id)
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
  const plan = await planner.buildRebuildPlanFromSandboxEntry({
    sandboxName,
    agent: agentId,
    sandboxEntry,
    supportedChannelIds,
  });
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
