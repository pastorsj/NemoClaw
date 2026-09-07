// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isDeepStrictEqual } from "node:util";

import type {
  HarnessMessagingChannelProfile,
  HarnessWebSearchProviderBinding,
} from "@nvidia/nemoclaw-harness-contract";

import { isValidCliOpenShellProviderIdentifier } from "../../../adapters/openshell/provider-metadata-cli";
import {
  inspectGatewayCredentialFamilyProviderBinding,
  inspectGatewayCredentialOnlyProviderBinding,
  type GatewayCredentialOnlyProviderInspection,
} from "../../../onboard/gateway-provider-metadata";
import {
  loadHarnessMessagingIntegration,
  type HarnessMessagingIntegration,
} from "../../../agent-runtime/messaging-module";
import { resolvePinnedHarnessPackage } from "../../../agent-runtime/package/pinned";
import type { HarnessPackageStoreOptions } from "../../../agent-runtime/package/store";
import type { HarnessPackageIdentity } from "../../../agent-runtime/package/types";
import {
  packageWebSearchProviderBinding,
  readWebSearchCapability,
} from "../../../agent-runtime/web-search";
import { listMessagingCredentialMetadata } from "../../../messaging/channels/metadata";
import { createBuiltInChannelManifestRegistry } from "../../../messaging/channels/built-ins";
import type {
  ChannelCredentialProviderSpec,
  SandboxMessagingPlan,
} from "../../../messaging/manifest";
import { parseSandboxMessagingPlan } from "../../../messaging/plan-validation";
import { listMessagingChannelsForIntegration } from "../../../messaging/profile-authority";
import { MESSAGING_CREDENTIAL_PROVIDER_TYPE } from "../../../messaging/provider-profile";
import {
  deleteProviderWithRecovery,
  runNamedSandboxProviderPreDeleteCleanup,
  type DetachSandboxProvidersResult,
  type ProviderDeleteWithRecoveryResult,
  type SandboxProviderRunOpenshell,
} from "../../../onboard/sandbox-provider-cleanup";
import type { SandboxEntry } from "../../../state/registry";

type ProviderCredentialShape = "family" | "only";

export interface ReceiptOwnedProviderBinding {
  readonly credentialKey: string;
  readonly credentialShape: ProviderCredentialShape;
  readonly name: string;
  readonly type: string;
}

interface ReceiptProviderAuthoritySnapshot {
  readonly gatewayName: SandboxEntry["gatewayName"];
  readonly gatewayPort: SandboxEntry["gatewayPort"];
  readonly harnessPackage: HarnessPackageIdentity;
  readonly lifecycleGeneration: SandboxEntry["lifecycleGeneration"];
  readonly lifecycleLiveIdentityFingerprint: SandboxEntry["lifecycleLiveIdentityFingerprint"];
  readonly messaging: SandboxEntry["messaging"];
  readonly pendingCreateIdentity: SandboxEntry["pendingCreateIdentity"];
  readonly webSearchEnabled: SandboxEntry["webSearchEnabled"];
  readonly webSearchProvider: SandboxEntry["webSearchProvider"];
}

export interface PreparedReceiptProviderCleanup {
  readonly bindings: readonly ReceiptOwnedProviderBinding[];
  readonly sandboxName: string;
  readonly snapshot: ReceiptProviderAuthoritySnapshot;
}

type LoadWebSearchBinding = (
  identity: HarnessPackageIdentity,
  provider: "brave" | "tavily",
  options: HarnessPackageStoreOptions,
) => HarnessWebSearchProviderBinding | null;

export interface ReceiptProviderCleanupDeps extends HarnessPackageStoreOptions {
  readonly deleteProvider?: typeof deleteProviderWithRecovery;
  readonly getSandbox: (sandboxName: string) => SandboxEntry | null;
  readonly inspectCredentialFamily?: typeof inspectGatewayCredentialFamilyProviderBinding;
  readonly inspectCredentialOnly?: typeof inspectGatewayCredentialOnlyProviderBinding;
  readonly loadMessagingIntegration?: typeof loadHarnessMessagingIntegration;
  readonly loadWebSearchBinding?: LoadWebSearchBinding;
  readonly runOpenshell: SandboxProviderRunOpenshell;
}

const CREDENTIAL_KEY_PATTERN = /^[A-Z_][A-Z0-9_]{0,127}$/u;

function authorityError(detail: string): Error {
  return new Error(`Receipt-backed provider cleanup authority is invalid: ${detail}`);
}

function requireProviderName(sandboxName: string, providerName: string): string {
  if (
    !isValidCliOpenShellProviderIdentifier(providerName) ||
    !providerName.startsWith(`${sandboxName}-`)
  ) {
    throw authorityError(`provider '${providerName}' is not owned by sandbox '${sandboxName}'.`);
  }
  return providerName;
}

function requireCredentialKey(value: string): string {
  if (!CREDENTIAL_KEY_PATTERN.test(value)) {
    throw authorityError("a provider credential key is invalid.");
  }
  return value;
}

function requirePackageCredentialAgreement(
  planned: ChannelCredentialProviderSpec | undefined,
  declared: HarnessMessagingChannelProfile["credentialProvider"],
): void {
  if (!planned && !declared) return;
  if (
    !planned ||
    !declared ||
    planned.profilePath !== declared.profilePath ||
    planned.profileId !== declared.profileId ||
    planned.credentialEnv !== declared.credentialEnv ||
    planned.sourceInputId !== declared.sourceInputId ||
    !isDeepStrictEqual(planned.refresh, declared.refresh)
  ) {
    throw authorityError("the persisted messaging provider disagrees with its package profile.");
  }
}

function messagingBindings(
  sandboxName: string,
  integration: HarnessMessagingIntegration,
  plan: SandboxMessagingPlan,
): ReceiptOwnedProviderBinding[] {
  if (integration.kind !== "channels") {
    throw authorityError(
      "the persisted messaging plan belongs to a package with messaging disabled.",
    );
  }
  const declaredChannels = new Map(
    integration.channels.map((channel) => [channel.channelId, channel] as const),
  );
  const plannedChannels = new Map(plan.channels.map((channel) => [channel.channelId, channel]));
  const coreCredentials = new Map(
    listMessagingCredentialMetadata().map((credential) => [
      `${credential.channelId}\0${credential.credentialId}`,
      credential,
    ]),
  );

  return plan.credentialBindings.map((binding) => {
    const plannedChannel = plannedChannels.get(binding.channelId);
    const declaredChannel = declaredChannels.get(binding.channelId);
    const coreCredential = coreCredentials.get(`${binding.channelId}\0${binding.credentialId}`);
    if (!plannedChannel || !declaredChannel || !coreCredential) {
      throw authorityError("a persisted messaging credential has no package-approved channel.");
    }
    requirePackageCredentialAgreement(
      plannedChannel.credentialProvider,
      declaredChannel.credentialProvider,
    );
    const expectedName = coreCredential.providerNameTemplate.replaceAll(
      "{sandboxName}",
      sandboxName,
    );
    if (
      binding.providerName !== expectedName ||
      binding.sourceInput !== coreCredential.sourceInput ||
      binding.providerEnvKey !== coreCredential.providerEnvKey
    ) {
      throw authorityError("a persisted messaging credential disagrees with its core channel.");
    }
    const packageProvider = declaredChannel.credentialProvider;
    if (
      packageProvider &&
      (binding.sourceInput !== packageProvider.sourceInputId ||
        binding.providerEnvKey !== packageProvider.credentialEnv)
    ) {
      throw authorityError("a persisted messaging credential disagrees with its package binding.");
    }
    return Object.freeze({
      name: requireProviderName(sandboxName, binding.providerName),
      type: packageProvider?.profileId ?? MESSAGING_CREDENTIAL_PROVIDER_TYPE,
      credentialKey: requireCredentialKey(binding.providerEnvKey),
      credentialShape: packageProvider?.refresh ? "family" : "only",
    });
  });
}

function defaultLoadWebSearchBinding(
  identity: HarnessPackageIdentity,
  provider: "brave" | "tavily",
  options: HarnessPackageStoreOptions,
): HarnessWebSearchProviderBinding | null {
  const installed = resolvePinnedHarnessPackage(identity, options);
  const capability = readWebSearchCapability(installed.packageManifest.manifest);
  return packageWebSearchProviderBinding({ web_search: capability }, provider);
}

function webSearchBindings(
  sandboxName: string,
  sandbox: SandboxEntry,
  deps: ReceiptProviderCleanupDeps,
): ReceiptOwnedProviderBinding[] {
  if (sandbox.webSearchEnabled !== true) return [];
  const provider = sandbox.webSearchProvider;
  if (provider !== "brave" && provider !== "tavily") {
    throw authorityError("enabled web search has no exact provider receipt.");
  }
  const binding = (deps.loadWebSearchBinding ?? defaultLoadWebSearchBinding)(
    sandbox.harnessPackage!,
    provider,
    deps.storeRoot === undefined ? {} : { storeRoot: deps.storeRoot },
  );
  if (!binding || binding.provider !== provider) {
    throw authorityError("the selected web-search provider is not declared by its package.");
  }
  return [
    Object.freeze({
      name: requireProviderName(sandboxName, `${sandboxName}-${provider}-search`),
      type: binding.profile_type,
      credentialKey: requireCredentialKey(binding.credential_env),
      credentialShape: "only" as const,
    }),
  ];
}

function requireUniqueBindings(
  bindings: readonly ReceiptOwnedProviderBinding[],
): readonly ReceiptOwnedProviderBinding[] {
  const byName = new Map<string, ReceiptOwnedProviderBinding>();
  for (const binding of bindings) {
    const existing = byName.get(binding.name);
    if (existing && !isDeepStrictEqual(existing, binding)) {
      throw authorityError(`provider '${binding.name}' has conflicting persisted bindings.`);
    }
    byName.set(binding.name, binding);
  }
  return Object.freeze([...byName.values()].map((binding) => Object.freeze({ ...binding })));
}

function inspectProviderBinding(
  binding: ReceiptOwnedProviderBinding,
  deps: ReceiptProviderCleanupDeps,
): GatewayCredentialOnlyProviderInspection {
  const expected = {
    name: binding.name,
    type: binding.type,
    credentialKey: binding.credentialKey,
  };
  return binding.credentialShape === "family"
    ? (deps.inspectCredentialFamily ?? inspectGatewayCredentialFamilyProviderBinding)(
        expected,
        deps.runOpenshell,
      )
    : (deps.inspectCredentialOnly ?? inspectGatewayCredentialOnlyProviderBinding)(
        expected,
        deps.runOpenshell,
      );
}

function requireSafeProviderInspection(
  binding: ReceiptOwnedProviderBinding,
  inspection: GatewayCredentialOnlyProviderInspection,
): "exact" | "missing" {
  if (inspection.kind === "collision") {
    throw authorityError(`provider '${binding.name}' does not match its persisted binding.`);
  }
  if (inspection.kind === "indeterminate") {
    throw authorityError(`provider '${binding.name}' could not be inspected.`);
  }
  return inspection.kind;
}

function snapshotProviderAuthority(sandbox: SandboxEntry): ReceiptProviderAuthoritySnapshot {
  return Object.freeze({
    gatewayName: sandbox.gatewayName,
    gatewayPort: sandbox.gatewayPort,
    harnessPackage: Object.freeze({ ...sandbox.harnessPackage! }),
    lifecycleGeneration: sandbox.lifecycleGeneration,
    lifecycleLiveIdentityFingerprint: sandbox.lifecycleLiveIdentityFingerprint,
    messaging: sandbox.messaging === undefined ? undefined : structuredClone(sandbox.messaging),
    pendingCreateIdentity:
      sandbox.pendingCreateIdentity === undefined
        ? undefined
        : structuredClone(sandbox.pendingCreateIdentity),
    webSearchEnabled: sandbox.webSearchEnabled,
    webSearchProvider: sandbox.webSearchProvider,
  });
}

function requireCurrentProviderAuthority(
  prepared: PreparedReceiptProviderCleanup,
  deps: ReceiptProviderCleanupDeps,
): void {
  const current = deps.getSandbox(prepared.sandboxName);
  if (
    !current?.harnessPackage ||
    current.name !== prepared.sandboxName ||
    !isDeepStrictEqual(snapshotProviderAuthority(current), prepared.snapshot)
  ) {
    throw authorityError("the sandbox registry receipt changed during cleanup.");
  }
}

/** Capture and validate the exact provider inventory owned by one package receipt. */
export function prepareReceiptProviderCleanup(
  sandboxName: string,
  sandbox: SandboxEntry,
  deps: ReceiptProviderCleanupDeps,
): PreparedReceiptProviderCleanup {
  if (!sandbox.harnessPackage || sandbox.name !== sandboxName) {
    throw authorityError("an exact harness package receipt is required.");
  }
  let messaging: ReceiptOwnedProviderBinding[] = [];
  if (sandbox.messaging !== undefined) {
    const integration = (deps.loadMessagingIntegration ?? loadHarnessMessagingIntegration)(
      sandbox.harnessPackage,
      deps.storeRoot === undefined ? {} : { storeRoot: deps.storeRoot },
    );
    const manifests = listMessagingChannelsForIntegration(
      sandbox.harnessPackage.id,
      integration,
      createBuiltInChannelManifestRegistry(),
    );
    const plan = parseSandboxMessagingPlan(sandbox.messaging.plan, {
      sandboxName,
      agent: sandbox.harnessPackage.id,
      manifests,
      supportedChannelIds: manifests.map((manifest) => manifest.id),
    });
    if (sandbox.messaging.schemaVersion !== 1 || !plan) {
      throw authorityError(
        "the persisted messaging plan is invalid or belongs to another sandbox.",
      );
    }
    messaging = messagingBindings(sandboxName, integration, plan);
  }
  const bindings = requireUniqueBindings([
    ...messaging,
    ...webSearchBindings(sandboxName, sandbox, deps),
  ]);
  for (const binding of bindings) {
    requireSafeProviderInspection(binding, inspectProviderBinding(binding, deps));
  }
  return Object.freeze({
    sandboxName,
    bindings,
    snapshot: snapshotProviderAuthority(sandbox),
  });
}

/** Strictly detach only the still-exact providers captured from the receipt. */
export function detachPreparedReceiptProviders(
  prepared: PreparedReceiptProviderCleanup,
  deps: ReceiptProviderCleanupDeps,
): DetachSandboxProvidersResult {
  const detached: string[] = [];
  for (const binding of prepared.bindings) {
    requireCurrentProviderAuthority(prepared, deps);
    if (
      requireSafeProviderInspection(binding, inspectProviderBinding(binding, deps)) === "missing"
    ) {
      continue;
    }
    const result = runNamedSandboxProviderPreDeleteCleanup(prepared.sandboxName, [binding.name], {
      runOpenshell: deps.runOpenshell,
    });
    if (result.failures.length > 0) {
      throw authorityError(`provider '${binding.name}' could not be detached.`);
    }
    requireCurrentProviderAuthority(prepared, deps);
    requireSafeProviderInspection(binding, inspectProviderBinding(binding, deps));
    detached.push(...result.detached);
  }
  return { detached, failures: [] };
}

/** Delete each exact receipt-owned provider and confirm its absence. */
export function removePreparedReceiptProviders(
  prepared: PreparedReceiptProviderCleanup,
  deps: ReceiptProviderCleanupDeps,
): void {
  for (const binding of prepared.bindings) {
    requireCurrentProviderAuthority(prepared, deps);
    if (
      requireSafeProviderInspection(binding, inspectProviderBinding(binding, deps)) === "missing"
    ) {
      continue;
    }
    const deleted: ProviderDeleteWithRecoveryResult = (
      deps.deleteProvider ?? deleteProviderWithRecovery
    )(binding.name, {
      allowedSandboxes: [prepared.sandboxName],
      runOpenshell: deps.runOpenshell,
    });
    if (!deleted.ok) {
      throw authorityError(`provider '${binding.name}' could not be deleted.`);
    }
    requireCurrentProviderAuthority(prepared, deps);
    if (
      requireSafeProviderInspection(binding, inspectProviderBinding(binding, deps)) !== "missing"
    ) {
      throw authorityError(`provider '${binding.name}' deletion was not confirmed.`);
    }
  }
}
