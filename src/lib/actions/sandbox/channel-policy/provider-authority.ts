// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isDeepStrictEqual } from "node:util";

export { OPENSHELL_OPERATION_TIMEOUT_MS } from "../../../adapters/openshell/provider-command";
export { reportsExactProviderNotFound } from "../../../adapters/openshell/provider-diagnostic-cli";
import {
  matchesGatewayCredentialFamilyProviderBinding,
  matchesGatewayCredentialOnlyProviderBinding,
} from "../../../onboard/gateway-provider-metadata";
import type { AgentDefinition } from "../../../agent/defs";
import type {
  ChannelManifest,
  SandboxMessagingPlan,
  SandboxMessagingProviderReceipt,
} from "../../../messaging/manifest";
import { MESSAGING_CREDENTIAL_PROVIDER_TYPE } from "../../../messaging/provider-profile";
export {
  bindMessagingProviderReceipts,
  findMessagingProviderReceipt,
} from "../../../messaging/provider-receipts";
import { findMessagingProviderReceipt } from "../../../messaging/provider-receipts";
import {
  staticMessagingProviderTypeForChannel,
  type MessagingBridgeProfile,
} from "../../../onboard/messaging-bridge-provider";
import type { MessagingProviderMutationReceipt } from "../../../onboard/messaging-prep";
import type { SandboxCommandAgentAuthority } from "../../../sandbox/command-agent";
import { policyChannelDependencies } from "../policy-channel-dependencies";

export const PROVIDER_COMMAND_MAX_BUFFER = 64 * 1024;

export type SandboxMessagingProfile = Readonly<{
  agent: AgentDefinition;
  availableChannels: readonly ChannelManifest[];
  providerProfiles: readonly MessagingBridgeProfile[];
  receiptAuthority?: SandboxCommandAgentAuthority;
}>;

/** Provider registration already reconciled its own gateway-side effects. */
export class ChannelProviderRegistrationFailure extends Error {
  override readonly name = "ChannelProviderRegistrationFailure";

  constructor(error: unknown) {
    super(error instanceof Error ? error.message : String(error), { cause: error });
  }
}

export type MessagingProviderTargetAuthority = Readonly<{
  gatewayName: string;
  lifecycleGeneration: string;
  liveIdentityFingerprint: string;
  sandboxName: string;
}>;

export type PreparedMessagingProviderTarget = Readonly<{
  gatewayName: string;
  targetAuthority: MessagingProviderTargetAuthority;
}>;

export type ChannelProviderBinding = Readonly<{
  credentialKey: string;
  credentialShape: "family" | "only";
  name: string;
  type: string;
}>;

export type PreparedChannelProviderTeardown = Readonly<{
  bindings: ReadonlyMap<string, ChannelProviderBinding>;
  providerReceipts: ReadonlyMap<string, SandboxMessagingProviderReceipt>;
  deleteProviderNames: readonly string[];
  detachProviderNames: readonly string[];
  gatewayName: string;
  targetAuthority?: MessagingProviderTargetAuthority;
  updatedProviderNames: readonly string[];
}>;

export type ChannelProviderAddResult = Readonly<{
  preparedTeardown?: PreparedChannelProviderTeardown;
  providerReceipts?: readonly SandboxMessagingProviderReceipt[];
  registeredBridge: boolean;
}>;

export function requiredChannelProviderBindings(
  sandboxName: string,
  channelId: string,
  profile: SandboxMessagingProfile,
): readonly ChannelProviderBinding[] {
  const manifest = profile.availableChannels.find((candidate) => candidate.id === channelId);
  if (!manifest) {
    throw new Error(`Messaging channel '${channelId}' is unavailable to this harness package`);
  }
  const credentialBindings = manifest.credentials.map((credential) => ({
    name: credential.providerName.replaceAll("{sandboxName}", sandboxName),
    type:
      staticMessagingProviderTypeForChannel(
        channelId,
        profile.agent.name,
        profile.providerProfiles,
        credential.providerEnvKey,
      ) ?? MESSAGING_CREDENTIAL_PROVIDER_TYPE,
    credentialKey: credential.providerEnvKey,
    credentialShape: "only" as const,
  }));
  const refreshingBindings = profile.providerProfiles
    .filter((provider) => provider.channelId === channelId && provider.strategy !== null)
    .map((provider) => ({
      name: `${sandboxName}-${channelId}-bridge`,
      type: provider.profileId,
      credentialKey: provider.credentialKey,
      credentialShape: "family" as const,
    }));
  const bindings = new Map<string, ChannelProviderBinding>();
  for (const binding of [...credentialBindings, ...refreshingBindings]) {
    const existing = bindings.get(binding.name);
    if (existing && !isDeepStrictEqual(existing, binding)) {
      throw new Error(`Messaging channel '${channelId}' declares conflicting provider bindings`);
    }
    bindings.set(binding.name, Object.freeze(binding));
  }
  return Object.freeze([...bindings.values()]);
}

export function requireSafeProviderIdentity(
  channelId: string,
  binding: ChannelProviderBinding,
  gatewayName: string,
  expectedProviderId?: string,
): Readonly<{ kind: "exact"; providerId: string }> | Readonly<{ kind: "missing" }> {
  const inspection = policyChannelDependencies.inspectMessagingProviderBinding(
    binding,
    gatewayName,
  );
  if (inspection.kind === "collision") {
    throw new Error(
      `Messaging channel '${channelId}' provider does not match its typed package binding`,
    );
  }
  if (inspection.kind === "indeterminate") {
    throw new Error(`Messaging channel '${channelId}' provider could not be inspected`);
  }
  if (inspection.kind === "missing") return { kind: "missing" };
  const metadata = policyChannelDependencies.inspectMessagingProviderMetadata(
    binding.name,
    gatewayName,
  );
  const shapeMatches =
    binding.credentialShape === "family"
      ? matchesGatewayCredentialFamilyProviderBinding(metadata, binding)
      : matchesGatewayCredentialOnlyProviderBinding(metadata, binding);
  if (!shapeMatches || !metadata?.id) {
    throw new Error(`Messaging channel '${channelId}' provider identity could not be confirmed`);
  }
  if (expectedProviderId && metadata.id !== expectedProviderId) {
    throw new Error(
      `Messaging channel '${channelId}' provider changed from its recorded stable identity`,
    );
  }
  return { kind: "exact", providerId: metadata.id };
}

export function requireProviderAttachmentState(
  sandboxName: string,
  channelId: string,
  providerName: string,
  providerId: string,
  gatewayName: string,
): "attached" | "missing" {
  const attachments = policyChannelDependencies.inspectMessagingProviderAttachments(
    sandboxName,
    gatewayName,
  );
  if (!attachments) {
    throw new Error(`Messaging channel '${channelId}' provider attachments could not be inspected`);
  }
  const attachment = attachments.find((candidate) => candidate.name === providerName);
  if (!attachment) return "missing";
  if (attachment.providerId !== providerId) {
    throw new Error(
      `Messaging channel '${channelId}' provider attachment changed from its recorded stable identity`,
    );
  }
  return "attached";
}

/** Preserve only provider mutations made by this add for a later rollback. */
export function prepareAddedChannelProviderTeardown(
  sandboxName: string,
  channelId: string,
  profile: SandboxMessagingProfile,
  gatewayName: string,
  targetAuthority: MessagingProviderTargetAuthority,
  receipt: MessagingProviderMutationReceipt,
  attachedProviderNames: readonly string[],
  existingPlan: SandboxMessagingPlan | null,
): PreparedChannelProviderTeardown {
  const bindings = new Map(
    requiredChannelProviderBindings(sandboxName, channelId, profile).map((binding) => [
      binding.name,
      binding,
    ]),
  );
  const receiptProviderNames = new Set(receipt.providerNames);
  const createdProviderNames = new Set(receipt.createdProviderNames);
  const updatedProviderNames = receipt.mutatedProviderNames.filter(
    (name) => !createdProviderNames.has(name),
  );
  const providerNames = new Set(receipt.providerNames);
  const invalidSelection = [
    ...attachedProviderNames,
    ...receipt.createdProviderNames,
    ...updatedProviderNames,
  ].find((name) => !receiptProviderNames.has(name) || !bindings.has(name));
  const invalidCreatedProvider = receipt.createdProviderNames.find(
    (name) => !receipt.mutatedProviderNames.includes(name),
  );
  if (invalidSelection || invalidCreatedProvider) {
    throw new Error(
      `Messaging channel '${channelId}' returned an invalid provider mutation receipt`,
    );
  }
  const providerReceipts = new Map<string, SandboxMessagingProviderReceipt>();
  for (const providerName of providerNames) {
    const binding = bindings.get(providerName)!;
    const prior = findMessagingProviderReceipt(existingPlan, channelId, providerName);
    const operationProviderId = receipt.providerIds[providerName];
    if (!operationProviderId || (!prior && !createdProviderNames.has(providerName))) {
      throw new Error(
        `Messaging channel '${channelId}' returned incomplete provider ownership authority`,
      );
    }
    const identity = requireSafeProviderIdentity(
      channelId,
      binding,
      gatewayName,
      operationProviderId,
    );
    if (identity.kind === "missing") continue;
    providerReceipts.set(providerName, {
      channelId,
      providerName,
      providerId: identity.providerId,
      createdByNemoClaw:
        prior?.createdByNemoClaw === true || createdProviderNames.has(providerName),
      attachmentAddedByNemoClaw:
        prior?.attachmentAddedByNemoClaw === true || attachedProviderNames.includes(providerName),
    });
  }
  return Object.freeze({
    bindings,
    providerReceipts,
    deleteProviderNames: Object.freeze(
      [...receipt.createdProviderNames].filter((name) => providerReceipts.has(name)),
    ),
    detachProviderNames: Object.freeze(
      [...attachedProviderNames].filter((name) => providerReceipts.has(name)),
    ),
    gatewayName,
    targetAuthority,
    updatedProviderNames: Object.freeze(updatedProviderNames),
  });
}

export function messagingProviderTargetAuthoritiesEqual(
  left: MessagingProviderTargetAuthority,
  right: MessagingProviderTargetAuthority,
): boolean {
  return isDeepStrictEqual(left, right);
}

export function preparedMessagingProviderTargetsEqual(
  left: PreparedMessagingProviderTarget,
  right: PreparedMessagingProviderTarget,
): boolean {
  return isDeepStrictEqual(left, right);
}
