// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isDeepStrictEqual } from "node:util";

import type { SandboxCreateOrchestrationRuntime } from "../../onboard";
import type { AgentDefinition } from "../../agent/defs";
import type {
  OpenShellProviderAdapter,
  OpenShellProviderError,
} from "../../adapters/openshell/provider-adapter";
import { createCliOpenShellProviderAdapter } from "../../adapters/openshell/provider-adapter-cli";
import type { OpenShellGatewayEndpointEnvironment } from "../../adapters/openshell/gateway-scope";
import { namedOpenShellGateway } from "../../adapters/openshell/sandbox-observer";
import { REPOSITORY_ROOT } from "../../core/repository-root";
import {
  messagingCredentialProviderProfilePath,
  MESSAGING_CREDENTIAL_PROVIDER_TYPE,
} from "../../messaging/provider-profile";
export {
  bindMessagingProviderReceipts,
  findMessagingProviderReceipt,
} from "../../messaging/provider-receipts";
import type { SandboxEntry } from "../../state/registry";
import { createBuiltInChannelManifestRegistry } from "../../messaging/channels/built-ins";
import {
  listMessagingChannelsForProfile,
  resolveSandboxMessagingProfileAuthority,
} from "../../messaging/profile-authority";
import type { HarnessPackageSessionAuthority } from "../package/package-authority";
import {
  matchesGatewayCredentialFamilyProviderBinding,
  matchesGatewayCredentialOnlyProviderBinding,
} from "../gateway-provider-metadata";
import { resolveRegisteredRuntimeProvider } from "../runtime-provider/selection";
import type { SandboxCreateIntent } from "../sandbox-create-intent-types";

type ProviderPreparationInput = {
  readonly openshellDriver: SandboxEntry["openshellDriver"];
  readonly inferenceProvider: string | null;
  readonly messagingProviders: readonly string[];
  readonly messagingProviderRequests: SandboxCreateIntent["messagingProviderRequests"];
  readonly extraProviders: readonly string[];
  readonly gatewayName: string;
};

export function resolveSandboxCreateMessagingManifests(
  session: HarnessPackageSessionAuthority,
  effectiveAgent: AgentDefinition,
) {
  const profile = resolveSandboxMessagingProfileAuthority({
    agent: session.agent,
    ...(session.harnessPackage ? { harnessPackage: session.harnessPackage } : {}),
    ...(session.harnessPackageMigration
      ? { harnessPackageMigration: session.harnessPackageMigration }
      : {}),
  });
  if (!isDeepStrictEqual(profile.agent, effectiveAgent)) {
    throw new Error("Selected messaging profile does not match package agent authority");
  }
  return listMessagingChannelsForProfile(profile, createBuiltInChannelManifestRegistry());
}

type ProviderPreparationDeps = Pick<SandboxCreateOrchestrationRuntime, "runOpenshell"> & {
  readonly cleanupCreateSources: () => void;
  readonly expectedMessagingProviderId?: (providerName: string) => string | undefined;
  readonly environment?: OpenShellGatewayEndpointEnvironment;
  readonly providerAdapter?: OpenShellProviderAdapter;
};

function expectedMessagingBindings(input: ProviderPreparationInput) {
  return new Map(
    input.messagingProviderRequests.map(
      ({ credentialKeys, credentialShape, envKey, name, providerType }) => [
        name,
        {
          name,
          type: providerType,
          credentialKey: envKey,
          credentialKeys,
          credentialShape,
        },
      ],
    ),
  );
}

function resolveProviderAdapter(deps: ProviderPreparationDeps): OpenShellProviderAdapter {
  return (
    deps.providerAdapter ??
    createCliOpenShellProviderAdapter({
      environment: deps.environment,
      run: (args, options) => deps.runOpenshell(args, options),
    })
  );
}

type ExpectedMessagingBindingInspection =
  | Readonly<{ kind: "exact"; providerId?: string }>
  | Readonly<{ kind: "mismatch" }>
  | Readonly<{ kind: "failed"; error: OpenShellProviderError }>;

async function inspectExpectedMessagingBinding(
  input: ProviderPreparationInput,
  adapter: OpenShellProviderAdapter,
  providerName: string,
  expectedBindings: ReturnType<typeof expectedMessagingBindings>,
  expectedProviderId?: string,
): Promise<ExpectedMessagingBindingInspection> {
  const expected = expectedBindings.get(providerName);
  if (!expected) return { kind: "exact" };
  const result = await adapter.getProvider({
    target: namedOpenShellGateway(input.gatewayName),
    providerName,
  });
  if (!result.ok) return { kind: "failed", error: result.error };
  const baseBinding = {
    name: expected.name,
    type: expected.type,
    credentialKey: expected.credentialKey,
  };
  const shapeMatches =
    expected.credentialShape === "family"
      ? matchesGatewayCredentialFamilyProviderBinding(result.value, baseBinding) &&
        expected.credentialKeys.every((key) => result.value.credentialKeys.includes(key))
      : expected.credentialKeys.length === 1 &&
        expected.credentialKeys[0] === expected.credentialKey &&
        matchesGatewayCredentialOnlyProviderBinding(result.value, baseBinding);
  const identityMatches =
    expectedProviderId === undefined || result.value.id === expectedProviderId;
  return shapeMatches && identityMatches
    ? {
        kind: "exact",
        ...(result.value.id ? { providerId: result.value.id } : {}),
      }
    : { kind: "mismatch" };
}

function throwAfterCleanup(deps: ProviderPreparationDeps, message: string): never {
  const providerFailure = new Error(message);
  try {
    deps.cleanupCreateSources();
  } catch (error) {
    const cleanupFailure =
      error instanceof Error ? error : new Error("Temporary sandbox create-source cleanup failed.");
    throw new AggregateError(
      [providerFailure, cleanupFailure],
      `${message} Temporary sandbox create-source cleanup also failed.`,
    );
  }
  throw providerFailure;
}

function requireExactMessagingBinding(
  providerName: string,
  inspection: ExpectedMessagingBindingInspection,
  phase: "before sandbox creation" | "after publication",
  deps: ProviderPreparationDeps,
  requireStableIdentity = false,
): string | undefined {
  if (inspection.kind === "exact") {
    if (!requireStableIdentity || inspection.providerId) return inspection.providerId;
    throwAfterCleanup(
      deps,
      `OpenShell did not return a stable identity for messaging provider '${providerName}' ${phase}.`,
    );
  }
  if (inspection.kind === "failed") {
    throwAfterCleanup(
      deps,
      `Could not inspect messaging provider '${providerName}' ${phase}: ${inspection.error.message}`,
    );
  }
  throwAfterCleanup(
    deps,
    `OpenShell did not confirm messaging provider '${providerName}' ${phase}.`,
  );
}

export async function validateAttachedMessagingProvidersBeforeSandboxCreation(
  input: ProviderPreparationInput,
  deps: ProviderPreparationDeps,
): Promise<void> {
  const expectedBindings = expectedMessagingBindings(input);
  const attachedMessagingProviders = [
    ...new Set(
      [input.inferenceProvider, ...input.messagingProviders, ...input.extraProviders].filter(
        (provider): provider is string => Boolean(provider),
      ),
    ),
  ].filter((name) => expectedBindings.has(name));
  if (attachedMessagingProviders.length === 0) return;

  const adapter = resolveProviderAdapter(deps);
  const target = namedOpenShellGateway(input.gatewayName);
  if (
    attachedMessagingProviders.some(
      (providerName) =>
        expectedBindings.get(providerName)?.type === MESSAGING_CREDENTIAL_PROVIDER_TYPE,
    )
  ) {
    const profile = await adapter.importProviderProfile({
      target,
      profilePath: messagingCredentialProviderProfilePath(REPOSITORY_ROOT),
    });
    if (!profile.ok) {
      throwAfterCleanup(
        deps,
        `Could not prepare the OpenShell messaging credential profile: ${profile.error.message}`,
      );
    }
  }

  for (const providerName of attachedMessagingProviders) {
    const expectedProviderId = deps.expectedMessagingProviderId?.(providerName);
    requireExactMessagingBinding(
      providerName,
      await inspectExpectedMessagingBinding(
        input,
        adapter,
        providerName,
        expectedBindings,
        expectedProviderId,
      ),
      "before sandbox creation",
      deps,
      expectedProviderId !== undefined,
    );
  }
}

export async function publishAttachedProvidersBeforeDockerSandboxCreation(
  input: ProviderPreparationInput,
  deps: ProviderPreparationDeps,
): Promise<ReadonlyMap<string, string>> {
  const runtimeProvider = resolveRegisteredRuntimeProvider(input.openshellDriver);
  if (
    !runtimeProvider ||
    runtimeProvider.gateway.launcher !== "nemoclaw" ||
    runtimeProvider.bootstrap.supported !== true
  )
    return new Map();

  const expectedBindings = expectedMessagingBindings(input);
  const providersRequiringExistenceProbe = new Set(
    [
      input.inferenceProvider,
      ...input.messagingProviders.filter((name) => !expectedBindings.has(name)),
    ].filter((provider): provider is string => Boolean(provider)),
  );
  const attachedProviders = new Set([
    ...providersRequiringExistenceProbe,
    ...input.messagingProviders,
    ...input.extraProviders,
  ]);
  const adapter = resolveProviderAdapter(deps);
  const target = namedOpenShellGateway(input.gatewayName);
  const providerIds = new Map<string, string>();
  for (const attachedProvider of attachedProviders) {
    if (providersRequiringExistenceProbe.has(attachedProvider)) {
      const observed = await adapter.getProvider({ target, providerName: attachedProvider });
      if (!observed.ok) {
        if (observed.error.kind === "command" && observed.error.reason === "not_found") continue;
        throwAfterCleanup(
          deps,
          `Could not inspect attached provider '${attachedProvider}' before publication: ${observed.error.message}`,
        );
      }
    }
    if (expectedBindings.has(attachedProvider)) {
      const expectedProviderId = deps.expectedMessagingProviderId?.(attachedProvider);
      requireExactMessagingBinding(
        attachedProvider,
        await inspectExpectedMessagingBinding(
          input,
          adapter,
          attachedProvider,
          expectedBindings,
          expectedProviderId,
        ),
        "before sandbox creation",
        deps,
        expectedProviderId !== undefined,
      );
    }
    const refreshed = await adapter.updateProvider({
      target,
      providerName: attachedProvider,
      credentials: [],
      config: [],
    });
    if (!refreshed.ok) {
      throwAfterCleanup(
        deps,
        `Could not publish attached provider '${attachedProvider}' before managed sandbox creation: ${refreshed.error.message}`,
      );
    }
    const providerId = requireExactMessagingBinding(
      attachedProvider,
      await inspectExpectedMessagingBinding(
        input,
        adapter,
        attachedProvider,
        expectedBindings,
        deps.expectedMessagingProviderId?.(attachedProvider),
      ),
      "after publication",
      deps,
      expectedBindings.has(attachedProvider),
    );
    if (providerId) providerIds.set(attachedProvider, providerId);
  }
  return providerIds;
}
