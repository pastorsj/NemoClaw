// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isDeepStrictEqual } from "node:util";

import { readManagedImageDeclaration } from "../../agent-runtime/managed-image";
import { harnessPackageIdentitiesEqual } from "../../agent-runtime/package/identity-validation";
import {
  resolvePinnedHarnessPackage,
  type HarnessPackageStoreOptions,
  type InstalledHarnessPackage,
} from "../../agent-runtime/package/pinned";
import type { HarnessPackageIdentity } from "../../agent-runtime/package/types";
import { isManagedImageAgent, qualifiedManagedImageDeclaration } from "../managed-image/agents";
import {
  managedStartupStateRoots,
  type ManagedStartupStateRoot,
} from "../managed-startup/state-roots";
import type {
  RuntimeProviderBundle,
  RuntimeProviderBundleRegistry,
  RuntimeProviderContainerEngineOperation,
} from "../runtime-provider/contract";
import {
  removeManagedStateVolumes,
  type ManagedStateVolumeCleanupResult,
  type ManagedStateVolumeDeps,
} from "./managed-state-volumes";

export interface ManagedAgentStateVolumeContext {
  readonly agentName: string | null | undefined;
  readonly harnessPackage?: HarnessPackageIdentity;
  readonly runtimeProviderId: string | null | undefined;
  readonly sandboxName: string;
  readonly workloadKind: string;
}

export interface PreparedManagedAgentStateVolumeCleanup {
  readonly context: ManagedAgentStateVolumeContext;
  readonly receiptBacked: boolean;
  readonly roots: readonly ManagedStartupStateRoot[];
}

type LegacyContainerEngineRun = NonNullable<ManagedStateVolumeDeps["runContainerEngine"]>;

export type ManagedAgentStateVolumeDeps = Omit<
  ManagedStateVolumeDeps,
  "runContainerEngine" | "runtimeProvider"
> & {
  readonly packageStoreRoot?: string;
  readonly resolvePinnedPackage?: (
    identity: HarnessPackageIdentity,
    options?: HarnessPackageStoreOptions,
  ) => InstalledHarnessPackage;
  readonly runDocker?: LegacyContainerEngineRun;
  readonly runtimeProvider?: RuntimeProviderBundle;
  readonly runtimeProviders?: RuntimeProviderBundleRegistry;
};

function selectedRuntimeProvider(
  runtimeProviderId: string | null | undefined,
  providers?: RuntimeProviderBundleRegistry,
  runtimeProvider?: RuntimeProviderBundle,
): RuntimeProviderBundle | undefined {
  if (runtimeProvider) return runtimeProvider;
  const providerId = runtimeProviderId?.trim().toLowerCase();
  return providerId && providers ? providers[providerId] : undefined;
}

function supportsContainerEngineOperation(
  provider: RuntimeProviderBundle | undefined,
  operation: RuntimeProviderContainerEngineOperation,
): boolean {
  return (
    provider?.containerEngine.supported === true &&
    provider.containerEngine.identities.some((identity) => identity.operation === operation)
  );
}

function genericDeps(
  deps: ManagedAgentStateVolumeDeps,
  runtimeProviderId: string | null | undefined,
): ManagedStateVolumeDeps {
  const runtimeProvider =
    deps.runtimeProvider ??
    selectedRuntimeProvider(runtimeProviderId, deps.runtimeProviders, deps.runtimeProvider);
  return {
    ...(deps.runDocker && !runtimeProvider ? { runContainerEngine: deps.runDocker } : {}),
    ...(runtimeProvider ? { runtimeProvider } : {}),
    ...(deps.registerExitCleanup ? { registerExitCleanup: deps.registerExitCleanup } : {}),
  };
}

function packageStateRoots(
  context: ManagedAgentStateVolumeContext,
  identity: HarnessPackageIdentity,
  deps: ManagedAgentStateVolumeDeps,
): readonly ManagedStartupStateRoot[] {
  if (context.agentName !== identity.id) {
    throw new Error("Managed state cleanup package identity does not match the sandbox agent.");
  }
  const installed = (deps.resolvePinnedPackage ?? resolvePinnedHarnessPackage)(identity, {
    ...(deps.packageStoreRoot ? { storeRoot: deps.packageStoreRoot } : {}),
  });
  if (!harnessPackageIdentitiesEqual(installed.identity, identity)) {
    throw new Error("Managed state cleanup resolved a different harness package identity.");
  }
  const managedImage = readManagedImageDeclaration(installed.packageManifest.manifest);
  if (!managedImage) {
    throw new Error(
      "Receipt-backed managed workload state cleanup requires its pinned package managed-image declaration.",
    );
  }
  return managedStartupStateRoots({
    packageId: identity.id,
    sandboxName: context.sandboxName,
    managedImage,
  });
}

function legacyStateRoots(
  context: ManagedAgentStateVolumeContext,
): readonly ManagedStartupStateRoot[] {
  if (typeof context.agentName !== "string" || !isManagedImageAgent(context.agentName)) return [];
  return managedStartupStateRoots({
    packageId: context.agentName,
    sandboxName: context.sandboxName,
    managedImage: qualifiedManagedImageDeclaration(context.agentName),
  });
}

function resolveStateRoots(
  context: ManagedAgentStateVolumeContext,
  deps: ManagedAgentStateVolumeDeps,
): readonly ManagedStartupStateRoot[] {
  if (context.workloadKind !== "managed-image") return Object.freeze([]);
  return context.harnessPackage
    ? packageStateRoots(context, context.harnessPackage, deps)
    : legacyStateRoots(context);
}

function hasCleanupAuthority(
  context: ManagedAgentStateVolumeContext,
  deps: ManagedAgentStateVolumeDeps,
): boolean {
  if (!deps.runtimeProviders && !deps.runtimeProvider) return deps.runDocker !== undefined;
  return supportsContainerEngineOperation(
    selectedRuntimeProvider(context.runtimeProviderId, deps.runtimeProviders, deps.runtimeProvider),
    "workload-cleanup",
  );
}

function immutableContext(context: ManagedAgentStateVolumeContext): ManagedAgentStateVolumeContext {
  return Object.freeze({
    agentName: context.agentName,
    ...(context.harnessPackage
      ? { harnessPackage: Object.freeze({ ...context.harnessPackage }) }
      : {}),
    runtimeProviderId: context.runtimeProviderId,
    sandboxName: context.sandboxName,
    workloadKind: context.workloadKind,
  });
}

/**
 * Resolve state-volume authority before sandbox deletion. Receipt-backed rows
 * may use only their exact installed package object; the closed stock table is
 * retained solely for rows that predate package receipts.
 */
export function prepareManagedAgentStateVolumeCleanup(
  context: ManagedAgentStateVolumeContext,
  deps: ManagedAgentStateVolumeDeps = {},
): PreparedManagedAgentStateVolumeCleanup {
  const capturedContext = immutableContext(context);
  const roots = resolveStateRoots(capturedContext, deps);
  if (capturedContext.harnessPackage && roots.length > 0 && !hasCleanupAuthority(context, deps)) {
    throw new Error(
      "Receipt-backed managed state cleanup requires runtime workload-cleanup authority.",
    );
  }
  return Object.freeze({
    context: capturedContext,
    receiptBacked: capturedContext.harnessPackage !== undefined,
    roots,
  });
}

/** Revalidate package authority, then remove only volumes carrying its exact labels. */
export function removePreparedManagedAgentStateVolumes(
  prepared: PreparedManagedAgentStateVolumeCleanup,
  deps: ManagedAgentStateVolumeDeps = {},
): readonly ManagedStateVolumeCleanupResult[] {
  const currentRoots = resolveStateRoots(prepared.context, deps);
  if (!isDeepStrictEqual(currentRoots, prepared.roots)) {
    throw new Error("Managed state cleanup package authority changed after preparation.");
  }
  if (
    prepared.receiptBacked &&
    currentRoots.length > 0 &&
    !hasCleanupAuthority(prepared.context, deps)
  ) {
    throw new Error(
      "Receipt-backed managed state cleanup lost runtime workload-cleanup authority.",
    );
  }
  return removeManagedStateVolumes(
    { roots: currentRoots },
    genericDeps(deps, prepared.context.runtimeProviderId),
  );
}

/** Compatibility helper for callers that do not cross a destructive boundary. */
export function removeManagedAgentStateVolumes(
  context: ManagedAgentStateVolumeContext,
  deps: ManagedAgentStateVolumeDeps = {},
): readonly ManagedStateVolumeCleanupResult[] {
  return removePreparedManagedAgentStateVolumes(
    prepareManagedAgentStateVolumeCleanup(context, deps),
    deps,
  );
}
