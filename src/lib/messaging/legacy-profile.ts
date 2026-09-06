// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { MessagingAgentId } from "./manifest";
import type { ChannelManifestRegistry } from "./manifest/registry";
import type { AgentDefinition } from "../agent/defs";

/** Preserve package-less sandboxes that still depend on the bundled agent projections. */
export function listLegacyMessagingChannels(agentId: string, registry: ChannelManifestRegistry) {
  return registry.listAvailable({ agent: agentId as MessagingAgentId });
}

/** Preserve channel-state cleanup for package-less OpenClaw and Hermes sandboxes. */
export function listLegacyChannelStatePaths(
  agent: AgentDefinition,
  channelName: string,
): readonly string[] {
  if (agent.name !== "openclaw" && agent.name !== "hermes") return [];
  const configDir = agent.configPaths.dir;
  const stateDirs = new Set(agent.stateDirs);
  const paths: string[] = [];
  const isHermesWhatsapp = agent.name === "hermes" && channelName === "whatsapp";
  if (stateDirs.has("platforms")) {
    paths.push(`${configDir}/platforms/${channelName}`);
  }
  if (isHermesWhatsapp && stateDirs.has("profiles")) {
    paths.push(`${configDir}/profiles/dashboard-home/platforms/whatsapp/session`);
  }
  // The old Dashboard home remains migration input for package-less Hermes sandboxes.
  if (isHermesWhatsapp && stateDirs.has("dashboard-home")) {
    paths.push(`${configDir}/dashboard-home/platforms/whatsapp/session`);
  }
  if (paths.length === 0 && stateDirs.has(channelName)) {
    paths.push(`${configDir}/${channelName}`);
  }
  return paths;
}
