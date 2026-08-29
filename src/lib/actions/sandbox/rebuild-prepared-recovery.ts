// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isDeepStrictEqual } from "node:util";

import { RD as _RD, R } from "../../cli/terminal-style";
import {
  resolveLegacyBackupRecoveryOwner,
  resolveSandboxAgent,
  type ResolvedSandboxAgent,
} from "../../onboard/sandbox-agent";
import type { SandboxRegistry } from "../../state/registry";
import { load as loadRegistry } from "../../state/registry/persistence";
import * as sandboxState from "../../state/sandbox";
import type { RebuildBail } from "./rebuild-credential-preflight";
import type { RebuildSandboxEntry } from "./rebuild-flow-helpers";
import { rebuildAgentAuthoritiesMatch } from "./rebuild/authority";

export interface RebuildSandboxExecutionOptions {
  throwOnError?: boolean;
  /** Internal installer recovery input; never exposed as a CLI option. */
  recoveryManifest?: sandboxState.RebuildManifest;
  /** Per-row capability granted only after explicit legacy managed-image confirmation. */
  allowLegacyManagedImageRecovery?: boolean;
}

function failPreparedRecoveryPreDelete(
  detail: string,
  errorMessage: string,
  bail: RebuildBail,
): never {
  console.error("");
  console.error(`  ${_RD}Recovery pre-delete check failed:${R} ${detail}.`);
  console.error("  Sandbox is untouched — no data was lost.");
  return bail(errorMessage);
}

function registryEntryWithoutOpenClawPluginProvenance(
  entry: RebuildSandboxEntry,
): Omit<RebuildSandboxEntry, "openclawImagePluginInstalls"> {
  const { openclawImagePluginInstalls: _provenance, ...rest } = entry;
  return rest;
}

function isPreparedRecoveryImageAllowed(
  manifest: sandboxState.RebuildManifest,
  entry: RebuildSandboxEntry,
  allowLegacyManagedImageRecovery: boolean,
): boolean {
  return (
    sandboxState.hasAuthoritativeOpenClawImagePluginProvenance(manifest) ||
    sandboxState.isManagedImageRecoveryAllowed(entry, allowLegacyManagedImageRecovery)
  );
}

function rebuildRecoveryManifestOwner(
  sandboxEntry: RebuildSandboxEntry,
  candidate: sandboxState.RebuildManifest,
): RebuildSandboxEntry | string | null {
  return sandboxState.inspectRebuildManifestHarnessPackage(candidate).status === "legacy"
    ? resolveLegacyBackupRecoveryOwner(sandboxEntry)
    : sandboxEntry;
}

function preparedRecoveryAuthorityIssue(
  sandboxEntry: RebuildSandboxEntry,
  candidate: sandboxState.RebuildManifest,
  authority: ResolvedSandboxAgent,
): string | null {
  const manifestPackage = sandboxState.inspectRebuildManifestHarnessPackage(candidate);
  if (manifestPackage.status === "legacy") return null;
  if (manifestPackage.status === "invalid") {
    return "backup manifest package authority is invalid";
  }

  const recordedAgent = sandboxEntry.agent ?? null;
  if (
    authority.recordedAgent !== recordedAgent ||
    authority.effectiveAgentId !== candidate.agentType ||
    authority.definition.name !== authority.effectiveAgentId ||
    !isDeepStrictEqual(authority.harnessPackage, sandboxEntry.harnessPackage ?? null) ||
    !isDeepStrictEqual(
      authority.harnessPackageMigration,
      sandboxEntry.harnessPackageMigration ?? null,
    )
  ) {
    return "resolved agent authority does not match the owning sandbox";
  }

  if (manifestPackage.status === "candidate") {
    return authority.harnessPackage === null
      ? null
      : "candidate backup authority resolved to a harness package";
  }
  return isDeepStrictEqual(authority.harnessPackage, manifestPackage.harnessPackage)
    ? null
    : "resolved harness package does not match the backup manifest";
}

function validatePreparedRecoveryCandidate(
  sandboxName: string,
  sandboxEntry: RebuildSandboxEntry,
  candidate: sandboxState.RebuildManifest,
  selectedAuthority?: ResolvedSandboxAgent,
): sandboxState.RebuildRecoveryManifestValidation {
  const manifestPackage = sandboxState.inspectRebuildManifestHarnessPackage(candidate);
  try {
    if (manifestPackage.status !== "legacy") {
      const authority = selectedAuthority ?? resolveSandboxAgent(sandboxEntry);
      const issue = preparedRecoveryAuthorityIssue(sandboxEntry, candidate, authority);
      if (issue) return { ok: false, reason: issue };
    }
    return sandboxState.validateRebuildRecoveryManifest(
      sandboxName,
      rebuildRecoveryManifestOwner(sandboxEntry, candidate),
      candidate,
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      reason:
        manifestPackage.status === "legacy"
          ? `legacy backup owner could not be resolved: ${detail}`
          : `prepared recovery agent authority could not be resolved: ${detail}`,
    };
  }
}

export function validatePreparedRecoveryManifest(
  sandboxName: string,
  sandboxEntry: RebuildSandboxEntry,
  candidate: sandboxState.RebuildManifest | undefined,
  allowLegacyManagedImageRecovery: boolean,
  bail: RebuildBail,
  selectedAuthority?: ResolvedSandboxAgent,
): sandboxState.RebuildManifest | null {
  if (!candidate) return null;
  const validation = validatePreparedRecoveryCandidate(
    sandboxName,
    sandboxEntry,
    candidate,
    selectedAuthority,
  );
  if (!validation.ok) {
    console.error("");
    console.error(`  ${_RD}Recovery preflight failed:${R} ${validation.reason}.`);
    console.error("  Sandbox is untouched — no data was lost.");
    bail(`Invalid recovery manifest: ${validation.reason}`);
    return null;
  }
  if (
    !isPreparedRecoveryImageAllowed(
      validation.manifest,
      sandboxEntry,
      allowLegacyManagedImageRecovery,
    )
  ) {
    console.error("");
    console.error(
      `  ${_RD}Recovery preflight failed:${R} registry has no NemoClaw-managed image fingerprint.`,
    );
    console.error("  Pre-fingerprint and custom-image sandboxes are not recreated automatically.");
    console.error("  Sandbox is untouched — no data was lost.");
    bail("Recovery registry entry has no NemoClaw-managed image fingerprint.");
    return null;
  }
  return validation.manifest;
}

type PreparedRecoveryReread =
  | {
      readonly ok: true;
      readonly manifest: sandboxState.RebuildManifest | null;
      readonly registrySnapshot: SandboxRegistry | null;
    }
  | {
      readonly ok: false;
      readonly detail: string;
      readonly message: string;
    };

function rereadPreparedRecoveryAuthority(
  sandboxName: string,
  initialEntry: RebuildSandboxEntry,
  selectedAuthority: ResolvedSandboxAgent,
  candidate: sandboxState.RebuildManifest | null,
  registrySnapshot: SandboxRegistry | null,
  allowLegacyManagedImageRecovery: boolean,
): PreparedRecoveryReread {
  if (!candidate) return { ok: true, manifest: null, registrySnapshot };

  const refreshedRegistrySnapshot = loadRegistry();
  const currentEntry = refreshedRegistrySnapshot.sandboxes[sandboxName];
  if (!currentEntry) {
    return {
      ok: false,
      detail: "registry entry no longer exists",
      message: "Recovery registry identity changed during preflight.",
    };
  }
  const authoritativePluginProvenance =
    sandboxState.hasAuthoritativeOpenClawImagePluginProvenance(candidate);
  const registryConfigurationMatches = authoritativePluginProvenance
    ? isDeepStrictEqual(
        registryEntryWithoutOpenClawPluginProvenance(currentEntry),
        registryEntryWithoutOpenClawPluginProvenance(initialEntry),
      )
    : isDeepStrictEqual(currentEntry, initialEntry);
  if (!registryConfigurationMatches) {
    return {
      ok: false,
      detail: "registered sandbox configuration changed during preflight",
      message: "Recovery registry configuration changed during preflight.",
    };
  }

  let currentAuthority: ResolvedSandboxAgent;
  try {
    // Re-run candidate qualification and retained-package receipt validation,
    // then compare the complete definition selected before any mutation.
    currentAuthority = resolveSandboxAgent(currentEntry);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const reason = `prepared recovery agent authority could not be resolved: ${detail}`;
    return {
      ok: false,
      detail: reason,
      message: `Invalid recovery manifest: ${reason}`,
    };
  }
  if (!rebuildAgentAuthoritiesMatch(currentAuthority, selectedAuthority)) {
    const reason = "resolved agent authority does not match the owning sandbox";
    return {
      ok: false,
      detail: reason,
      message: `Invalid recovery manifest: ${reason}`,
    };
  }

  const latestManifest = sandboxState.getLatestBackup(sandboxName);
  // candidate and latestManifest are independent reads of the same prepared
  // backup, enforced by the identity and persisted-authority checks below.
  if (
    !latestManifest ||
    !isDeepStrictEqual(
      sandboxState.snapshotManifestAuthority(latestManifest),
      sandboxState.snapshotManifestAuthority(candidate),
    )
  ) {
    return {
      ok: false,
      detail: "latest prepared backup changed during preflight",
      message: "Recovery backup identity changed during preflight.",
    };
  }

  const validation = validatePreparedRecoveryCandidate(
    sandboxName,
    currentEntry,
    latestManifest,
    currentAuthority,
  );
  if (!validation.ok) {
    return {
      ok: false,
      detail: validation.reason,
      message: `Invalid recovery manifest: ${validation.reason}`,
    };
  }
  if (
    !isPreparedRecoveryImageAllowed(
      validation.manifest,
      currentEntry,
      allowLegacyManagedImageRecovery,
    )
  ) {
    return {
      ok: false,
      detail: "registry no longer has a NemoClaw-managed image fingerprint",
      message: "Recovery registry entry has no NemoClaw-managed image fingerprint.",
    };
  }

  return {
    ok: true,
    manifest: validation.manifest,
    registrySnapshot: refreshedRegistrySnapshot,
  };
}

export function revalidatePreparedRecoveryBeforeDelete(
  sandboxName: string,
  initialEntry: RebuildSandboxEntry,
  selectedAuthority: ResolvedSandboxAgent,
  candidate: sandboxState.RebuildManifest | null,
  registrySnapshot: SandboxRegistry | null,
  allowLegacyManagedImageRecovery: boolean,
  bail: RebuildBail,
): {
  manifest: sandboxState.RebuildManifest | null;
  registrySnapshot: SandboxRegistry | null;
} {
  const reread = rereadPreparedRecoveryAuthority(
    sandboxName,
    initialEntry,
    selectedAuthority,
    candidate,
    registrySnapshot,
    allowLegacyManagedImageRecovery,
  );
  if (!reread.ok) {
    return failPreparedRecoveryPreDelete(reread.detail, reread.message, bail);
  }
  return {
    manifest: reread.manifest,
    registrySnapshot: reread.registrySnapshot,
  };
}

export type PreparedRecoveryDeleteEdgeValidation =
  | {
      readonly ok: true;
      readonly manifest: sandboxState.RebuildManifest | null;
      readonly registrySnapshot: SandboxRegistry | null;
    }
  | { readonly ok: false; readonly message: string };

/** Re-read every prepared-recovery authority in the synchronous delete callback. */
export function validatePreparedRecoveryAtDeleteEdge(
  sandboxName: string,
  initialEntry: RebuildSandboxEntry,
  selectedAuthority: ResolvedSandboxAgent,
  candidate: sandboxState.RebuildManifest | null,
  registrySnapshot: SandboxRegistry | null,
  allowLegacyManagedImageRecovery: boolean,
): PreparedRecoveryDeleteEdgeValidation {
  const reread = rereadPreparedRecoveryAuthority(
    sandboxName,
    initialEntry,
    selectedAuthority,
    candidate,
    registrySnapshot,
    allowLegacyManagedImageRecovery,
  );
  if (reread.ok) return reread;
  return {
    ok: false,
    message: `${reread.message} Sandbox deletion was refused.`,
  };
}
