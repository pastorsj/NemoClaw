// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { HarnessManagedImageDeclaration } from "@nvidia/nemoclaw-harness-contract";
import type { SandboxEntry } from "../../state/registry/types";
import {
  managedStartupStateRoots,
  type ManagedStartupStateRoot,
} from "../managed-startup/state-roots";
import {
  removeManagedStateVolumes,
  type ManagedStateVolumeCleanupResult,
} from "../managed-workload/managed-state-volumes";

export { managedStartupStateRoots, removeManagedStateVolumes };
export {
  prepareProviderBrokerCleanup,
  removePreparedProviderBroker,
  type PreparedProviderBrokerCleanup,
} from "../../agent-runtime/provider-broker-cleanup";

export interface RecreatedSourceStateInput {
  readonly sandboxName: string;
  readonly sourceAgent: {
    readonly name: string;
    readonly managedImage?: HarnessManagedImageDeclaration | null;
  } | null;
  readonly sourceEntry: SandboxEntry | null;
}

export interface RecreatedStateCleanupInput extends RecreatedSourceStateInput {
  readonly sourceConfirmedAbsent: boolean;
  readonly targetRoots: readonly ManagedStartupStateRoot[];
}

export interface RecreatedStateCleanupDependencies {
  readonly removeManagedStateVolumes: (
    roots: readonly ManagedStartupStateRoot[],
  ) => readonly ManagedStateVolumeCleanupResult[];
  readonly removeSourceRegistryEntry: (entry: SandboxEntry, sandboxName: string) => void;
  readonly note: (message: string) => void;
  readonly warn: (message: string) => void;
  readonly redact: (message: string) => string;
}

/**
 * Reconstruct the source package's owned state resources from its pinned
 * definition. The registry row proves the old workload kind; the definition
 * supplies package-specific paths and runtime identity without a harness ID
 * branch in core orchestration.
 */
export function resolveRecreatedSourceStateRoots(
  input: RecreatedSourceStateInput,
): readonly ManagedStartupStateRoot[] {
  if (input.sourceEntry?.workload?.kind !== "managed-image") return Object.freeze([]);
  const managedImage = input.sourceAgent?.managedImage;
  if (!managedImage) return Object.freeze([]);
  return managedStartupStateRoots({
    packageId: input.sourceAgent.name,
    sandboxName: input.sandboxName,
    managedImage,
  });
}

/**
 * Remove only source resources that the replacement package will not reuse.
 * Resource identity, not a harness-specific mount path, determines ownership
 * continuity across rebuilds and package changes.
 */
export function finalizeRecreatedSourceState(
  input: RecreatedStateCleanupInput,
  deps: RecreatedStateCleanupDependencies,
): void {
  if (!input.sourceConfirmedAbsent || !input.sourceEntry) return;

  const retained = new Set(input.targetRoots.map((root) => root.resourceIdentity));
  const obsoleteRoots = resolveRecreatedSourceStateRoots(input).filter(
    (root) => !retained.has(root.resourceIdentity),
  );
  const results = deps.removeManagedStateVolumes(obsoleteRoots);
  if (results.length !== obsoleteRoots.length) {
    throw new Error("Managed state cleanup returned an incomplete result set.");
  }
  results.forEach((cleanup, index) => {
    const root = obsoleteRoots[index];
    if (!root) throw new Error("Managed state cleanup returned an unexpected result.");
    if (cleanup.status === "failed") {
      throw new Error(
        `OpenShell confirmed that sandbox '${input.sandboxName}' is absent, but the runtime could not remove its managed package state volume '${cleanup.volumeName}': ${deps.redact(cleanup.detail)}. NemoClaw preserved the sandbox registry entry so a subsequent recreation can retry the volume removal.`,
      );
    }
    if (cleanup.status === "not-owned") {
      deps.warn(`  Left state volume '${cleanup.volumeName}' untouched because ${cleanup.detail}.`);
    } else if (cleanup.status === "removed") {
      deps.note(`  Removed managed package state volume '${root.resourceIdentity}'.`);
    }
  });

  deps.removeSourceRegistryEntry(input.sourceEntry, input.sandboxName);
}
