// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  HarnessMessagingBuildProfile,
  HarnessMessagingChannelProfile,
  HarnessMessagingHookOperation,
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
  providerProfileSha256?: string,
): ChannelManifest {
  const agent = packageId;
  const credentialProvider = profile.credentialProvider;
  const sourceInput = credentialProvider
    ? service.inputs.find((input) => input.id === credentialProvider.sourceInputId)
    : undefined;
  const sourceCredential = credentialProvider
    ? service.credentials.find(
        (credential) => credential.sourceInput === credentialProvider.sourceInputId,
      )
    : undefined;
  if (
    credentialProvider &&
    (!sourceInput ||
      sourceInput.kind !== "secret" ||
      sourceInput.required !== true ||
      !sourceInput.envKey ||
      (credentialProvider.refresh === undefined &&
        (credentialProvider.credentialEnv !== sourceInput.envKey ||
          sourceCredential?.providerEnvKey !== credentialProvider.credentialEnv)))
  ) {
    throw new Error(
      `Harness messaging profile '${packageId}' has an invalid ${service.id} credential provider source`,
    );
  }
  const configInputIds = new Set(
    service.inputs.filter((input) => input.kind === "config").map((input) => input.id),
  );
  for (const entry of profile.config.visibility) {
    if (
      !configInputIds.has(entry.inputId) ||
      (entry.targetInputId !== undefined && !configInputIds.has(entry.targetInputId)) ||
      (entry.whenInput !== undefined && !configInputIds.has(entry.whenInput.inputId))
    ) {
      throw new Error(
        `Harness messaging profile '${packageId}' references an unknown ${service.id} config input`,
      );
    }
  }
  const hookIds = new Set(profile.lifecycle.hookIds);
  const hookOperations = new Map(
    (profile.lifecycle.hookOperations ?? []).map((operation) => [operation.hookId, operation]),
  );
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
    ...(credentialProvider && sourceInput?.envKey
      ? {
          credentialProvider: {
            ...credentialProvider,
            sourceSecretEnv: sourceInput.envKey,
            ...(providerProfileSha256 ? { profileSha256: providerProfileSha256 } : {}),
          },
        }
      : { credentialProvider: undefined }),
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
    configVisibility: profile.config.visibility.map((entry) => ({ ...entry })),
    ...(profile.lifecycle.runtime
      ? { runtime: { [agent]: profile.lifecycle.runtime } }
      : { runtime: undefined }),
    agentPackages: (profile.lifecycle.packageInstalls ?? []).map((entry) => ({
      ...entry,
      agent,
    })),
    hooks: service.hooks
      .filter((hook) => hookIds.has(hook.id))
      .map((hook) =>
        applyHarnessHookOperation(
          { ...hook, agents: [agent] },
          hookOperations.get(hook.id),
          configInputIds,
        ),
      )
      .map((hook) => ({
        ...hook,
        ...(hook.phase === "status" && profile.lifecycle.statusProbe
          ? { statusProbe: profile.lifecycle.statusProbe }
          : {}),
      })),
  };
}

function applyHarnessHookOperation(
  hook: ChannelManifest["hooks"][number],
  operation: HarnessMessagingHookOperation | undefined,
  configInputIds: ReadonlySet<string>,
): ChannelManifest["hooks"][number] {
  if (!operation) {
    if (hook.packageOperationRequired) {
      throw new Error(`Hook '${hook.id}' requires a typed package operation`);
    }
    return hook;
  }
  if (operation.kind === "config-prompt") {
    if (hook.phase !== "enroll" || hook.handler !== "common.configPrompt") {
      throw new Error(`Hook '${hook.id}' cannot accept a config-prompt operation`);
    }
    const unknown = operation.outputIds.filter((inputId) => !configInputIds.has(inputId));
    if (unknown.length > 0) {
      throw new Error(`Hook '${hook.id}' references unknown package config output '${unknown[0]}'`);
    }
    return {
      ...hook,
      outputs: operation.outputIds.map((id) => ({ id, kind: "config" as const })),
      packageOperation: operation,
    };
  }
  if (operation.kind === "sandbox-command") {
    if (
      (operation.output === "bridge-health" && hook.phase !== "health-check") ||
      (operation.output === "channel-health" && hook.phase !== "status")
    ) {
      throw new Error(`Hook '${hook.id}' has an incompatible package command output`);
    }
    return {
      ...hook,
      handler: "common.packageCommand",
      packageOperation: operation,
      ...(operation.output === "channel-health"
        ? { outputs: [{ id: "channelHealth", kind: "status" as const }] }
        : { outputs: undefined }),
    };
  }
  if (hook.phase !== "post-agent-install") {
    throw new Error(`Hook '${hook.id}' cannot accept a build-files operation`);
  }
  return {
    ...hook,
    handler: "common.packageBuildFiles",
    inputs: operation.inputIds,
    outputs: operation.outputs.map((output) => ({
      id: output.id,
      kind: "build-file" as const,
      required: output.required !== false,
    })),
    packageOperation: operation,
  };
}
