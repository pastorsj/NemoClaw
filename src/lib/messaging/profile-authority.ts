// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { AgentDefinition } from "../agent/defs";
import {
  loadHarnessMessagingIntegration,
  type HarnessMessagingIntegration,
} from "../agent-runtime/messaging-module";
import type { HarnessPackageStoreOptions } from "../agent-runtime/package/store";
import { resolveSandboxAgent, type ResolvedSandboxAgent } from "../onboard/sandbox-agent/authority";
import type { SandboxEntry } from "../state/registry";
import type { ChannelManifest, MessagingAgentId } from "./manifest";
import type { ChannelManifestRegistry } from "./manifest/registry";
import { listLegacyMessagingChannels } from "./legacy-profile";
import { applyHarnessMessagingProfile } from "./package-profile";

export type SandboxMessagingProfileAuthority = Readonly<{
  agent: AgentDefinition;
  packageAuthority: ResolvedSandboxAgent;
  integration: HarnessMessagingIntegration | null;
}>;

export class HarnessMessagingSupportError extends Error {
  override readonly name = "HarnessMessagingSupportError";
}

/** Bind messaging support to an agent definition already resolved from exact package authority. */
export function resolveAgentMessagingProfileAuthority(
  packageAuthority: ResolvedSandboxAgent,
  options: HarnessPackageStoreOptions = {},
): SandboxMessagingProfileAuthority {
  const integration = packageAuthority.harnessPackage
    ? loadHarnessMessagingIntegration(packageAuthority.harnessPackage, options)
    : null;
  return Object.freeze({
    agent: packageAuthority.definition,
    packageAuthority,
    integration,
  });
}

/** Bind messaging support to the exact package receipt recorded for one sandbox. */
export function resolveSandboxMessagingProfileAuthority(
  entry: Pick<SandboxEntry, "agent" | "harnessPackage" | "harnessPackageMigration">,
  options: HarnessPackageStoreOptions = {},
): SandboxMessagingProfileAuthority {
  const packageAuthority = resolveSandboxAgent(entry, options);
  return resolveAgentMessagingProfileAuthority(packageAuthority, options);
}

/**
 * Resolve the intersection between a package's static profile and core-owned channel services.
 * Every package-declared channel must have a current core implementation for that package.
 */
export function listMessagingChannelsForProfile(
  authority: SandboxMessagingProfileAuthority,
  registry: ChannelManifestRegistry,
): ChannelManifest[] {
  const agentId: MessagingAgentId = authority.agent.name;
  if (authority.integration === null) {
    return listLegacyMessagingChannels(agentId, registry);
  }

  return listMessagingChannelsForIntegration(agentId, authority.integration, registry);
}

/** Compose one already-loaded package declaration with core-owned channel services. */
export function listMessagingChannelsForIntegration(
  agentId: MessagingAgentId,
  integration: HarnessMessagingIntegration,
  registry: ChannelManifestRegistry,
): ChannelManifest[] {
  if (integration.packageId !== agentId) {
    throw new HarnessMessagingSupportError(
      `Installed harness package messaging profile belongs to '${integration.packageId}', not '${agentId}'`,
    );
  }
  if (integration.kind === "disabled") return [];

  const serviceById = new Map(registry.list().map((manifest) => [manifest.id, manifest]));
  return integration.channels.map((profile) => {
    const service = serviceById.get(profile.channelId);
    if (!service) {
      throw new HarnessMessagingSupportError(
        `Installed harness package declares messaging channel '${profile.channelId}' without a compatible core service`,
      );
    }
    try {
      return applyHarnessMessagingProfile(
        service,
        integration.packageId,
        profile,
        integration.build,
        profile.credentialProvider?.profileSha256,
      );
    } catch (error) {
      throw new HarnessMessagingSupportError(
        `Installed harness package has an invalid '${profile.channelId}' messaging profile`,
        { cause: error },
      );
    }
  });
}

/** Resolve exact package manifests, retaining the built-in registry only for no-receipt rows. */
export function listMessagingChannelsForSandboxAuthority(
  entry: Pick<SandboxEntry, "agent" | "harnessPackage" | "harnessPackageMigration">,
  registry: ChannelManifestRegistry,
  options: HarnessPackageStoreOptions = {},
): ChannelManifest[] {
  if (entry.harnessPackage == null && entry.harnessPackageMigration == null) {
    return registry.list();
  }
  return listMessagingChannelsForProfile(
    resolveSandboxMessagingProfileAuthority(entry, options),
    registry,
  );
}
