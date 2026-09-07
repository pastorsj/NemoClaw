// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { SandboxEntry } from "../state/registry/types";
import { createBuiltInChannelManifestRegistry } from "./channels/built-ins";
import type {
  ChannelManifest,
  SandboxMessagingHostForwardPlan,
  SandboxMessagingPlan,
} from "./manifest";
import { listMessagingChannelsForSandboxAuthority } from "./profile-authority";

export function listSandboxMessagingHostForwardManifests(
  entry: Pick<SandboxEntry, "agent" | "harnessPackage" | "harnessPackageMigration">,
): ChannelManifest[] {
  return listMessagingChannelsForSandboxAuthority(entry, createBuiltInChannelManifestRegistry());
}

export function getActiveMessagingHostForward(
  plan: SandboxMessagingPlan | null | undefined,
): SandboxMessagingHostForwardPlan | null {
  if (!plan) return null;
  const disabled = new Set(plan.disabledChannels);
  for (const channel of plan.channels) {
    if (!channel.active || channel.disabled || disabled.has(channel.channelId)) continue;
    if (channel.hostForward) return channel.hostForward;
  }
  return null;
}
