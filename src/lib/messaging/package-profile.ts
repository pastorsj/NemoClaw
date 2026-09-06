// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  HarnessMessagingBuildProfile,
  HarnessMessagingChannelProfile,
} from "@nvidia/nemoclaw-harness-contract";

import type { ChannelManifest, MessagingAgentId } from "./manifest";

/**
 * Bind a core-owned channel service to package-owned harness behavior.
 * The result uses the existing compiler inputs, so credentials, policy application,
 * tunnels, hooks, and lifecycle execution remain NemoClaw responsibilities.
 */
export function applyHarnessMessagingProfile(
  service: ChannelManifest,
  packageId: MessagingAgentId,
  profile: HarnessMessagingChannelProfile,
  build: HarnessMessagingBuildProfile,
): ChannelManifest {
  const agent = packageId;
  const hookIds = new Set(profile.lifecycle.hookIds);
  const hooksById = new Map(service.hooks.map((hook) => [hook.id, hook]));
  for (const hookId of hookIds) {
    if (!hooksById.has(hookId)) {
      throw new Error(
        `Harness messaging profile '${packageId}' references unknown ${service.id} hook '${hookId}'`,
      );
    }
  }

  return {
    ...service,
    packageBuild: build,
    supportedAgents: [agent],
    ...(profile.config.statePaths
      ? { state: { [agent]: profile.config.statePaths } }
      : { state: undefined }),
    policyPresets: profile.policy.map((entry) => ({
      name: entry.presetName,
      policyKeys: entry.policyKeys,
      ...(entry.requiredAtCreate === undefined ? {} : { requiredAtCreate: entry.requiredAtCreate }),
      ...(entry.validationWarningLines
        ? { validationWarningLines: entry.validationWarningLines }
        : {}),
    })),
    render: profile.config.renders.map((entry) =>
      entry.kind === "json-fragment"
        ? {
            id: entry.id,
            kind: entry.kind,
            agent,
            target: entry.target,
            ...(entry.when ? { when: entry.when } : {}),
            fragment: { path: entry.path, value: entry.value },
          }
        : {
            id: entry.id,
            kind: entry.kind,
            agent,
            target: entry.target,
            ...(entry.when ? { when: entry.when } : {}),
            lines: entry.lines,
          },
    ),
    ...(profile.lifecycle.runtime
      ? { runtime: { [agent]: profile.lifecycle.runtime } }
      : { runtime: undefined }),
    agentPackages: (profile.lifecycle.packageInstalls ?? []).map((entry) => ({
      ...entry,
      agent,
    })),
    hooks: service.hooks
      .filter((hook) => hookIds.has(hook.id))
      .map((hook) => ({ ...hook, agents: [agent] })),
  };
}
