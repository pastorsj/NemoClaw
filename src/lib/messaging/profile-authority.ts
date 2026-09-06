// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { AgentDefinition } from "../agent/defs";
import {
  loadHarnessMessagingIntegration,
  type HarnessMessagingIntegration,
} from "../agent-runtime/messaging-module";
import type { HarnessPackageStoreOptions } from "../agent-runtime/package/store";
import { resolveRecordedSandboxAgentAuthority } from "../onboard/package/package-authority";
import type { ResolvedSandboxAgent } from "../onboard/sandbox-agent";
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

/** Bind messaging support to the exact package receipt recorded for one sandbox. */
export function resolveSandboxMessagingProfileAuthority(
  entry: Pick<SandboxEntry, "agent" | "harnessPackage" | "harnessPackageMigration">,
  options: HarnessPackageStoreOptions = {},
): SandboxMessagingProfileAuthority {
  const packageAuthority = resolveRecordedSandboxAgentAuthority(entry, options);
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

  const agentId: MessagingAgentId = authority.agent.name;
  if (authority.integration === null) {
    return listLegacyMessagingChannels(agentId, registry);
  }

  const integration = authority.integration;
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
      );
    } catch (error) {
      throw new HarnessMessagingSupportError(
        `Installed harness package has an invalid '${profile.channelId}' messaging profile`,
        { cause: error },
      );
    }
  });
}
