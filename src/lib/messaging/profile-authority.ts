// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { AgentDefinition } from "../agent/defs";
import {
  loadHarnessMessagingIntegration,
  type HarnessMessagingIntegration,
} from "../agent-runtime/messaging-module";
import type { HarnessPackageStoreOptions } from "../agent-runtime/package/store";
import { resolveSandboxAgent, type ResolvedSandboxAgent } from "../onboard/sandbox-agent";
import type { SandboxEntry } from "../state/registry";
import type { ChannelManifest, MessagingAgentId } from "./manifest";
import type { ChannelManifestRegistry } from "./manifest/registry";

export type SandboxMessagingProfileAuthority = Readonly<{
  agent: AgentDefinition;
  packageAuthority: ResolvedSandboxAgent;
  integration: HarnessMessagingIntegration | null;
}>;

export class HarnessMessagingSupportError extends Error {
  override readonly name = "HarnessMessagingSupportError";
}

/** Bind messaging support to the exact package receipt recorded for one sandbox. */
export function resolveSandboxMessagingProfileAuthority(
  entry: Pick<SandboxEntry, "agent" | "harnessPackage" | "harnessPackageMigration">,
  options: HarnessPackageStoreOptions = {},
): SandboxMessagingProfileAuthority {
  const packageAuthority = resolveSandboxAgent(entry, options);
  const integration = packageAuthority.harnessPackage
    ? loadHarnessMessagingIntegration(packageAuthority.harnessPackage, options)
    : null;
  return Object.freeze({
    agent: packageAuthority.definition,
    packageAuthority,
    integration,
  });
}

/**
 * Resolve the intersection between a package's static profile and core-owned channel services.
 * Every package-declared channel must have a current core implementation for that package.
 */
export function listMessagingChannelsForProfile(
  authority: SandboxMessagingProfileAuthority,
  registry: ChannelManifestRegistry,
): ChannelManifest[] {
  if (authority.integration?.kind === "disabled") return [];

  const agentId = authority.agent.name as MessagingAgentId;
  if (authority.integration === null) {
    return registry.listAvailable({ agent: agentId });
  }

  const serviceById = new Map(registry.list().map((manifest) => [manifest.id, manifest]));
  for (const channelId of authority.integration.channelIds) {
    const service = serviceById.get(channelId);
    if (!service || !(service.supportedAgents as readonly string[]).includes(agentId)) {
      throw new HarnessMessagingSupportError(
        `Installed harness package declares messaging channel '${channelId}' without a compatible core service`,
      );
    }
  }
  return registry.listAvailable({
    agent: agentId,
    supportedChannelIds: authority.integration.channelIds,
  });
}
