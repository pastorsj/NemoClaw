// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ChannelManifest } from "../../messaging/manifest/index.js";
import { createBuiltInChannelManifestRegistry } from "../../messaging/channels/built-ins.js";
import {
  listMessagingChannelsForProfile,
  resolveSandboxMessagingProfileAuthority,
} from "../../messaging/profile-authority.js";
import type { SandboxEntry } from "../registry/types.js";

export function listPackageConfigRestoreManagedChannelNames(entry: SandboxEntry): string[] {
  const authority = resolveSandboxMessagingProfileAuthority(entry);
  return listManagedChannelNames(
    authority.agent.name,
    listMessagingChannelsForProfile(authority, createBuiltInChannelManifestRegistry()),
  );
}

/** Resolve agent-native channel keys for package-owned configuration restore. */
export function listManagedChannelNames(
  agentName: string,
  manifests: readonly ChannelManifest[],
): string[] {
  const normalizedAgentName = agentName.trim();
  if (!normalizedAgentName) return [];

  return [
    ...new Set(
      manifests.flatMap((manifest) => {
        if (!(manifest.supportedAgents as readonly string[]).includes(normalizedAgentName)) {
          return [];
        }
        const runtime = (
          manifest.runtime as
            | Readonly<Record<string, { readonly channelName?: unknown } | undefined>>
            | undefined
        )?.[normalizedAgentName];
        const channelName = runtime?.channelName;
        return [
          typeof channelName === "string" && channelName.trim() !== "" ? channelName : manifest.id,
        ];
      }),
    ),
  ];
}
