// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { AgentDefinition } from "../agent/defs";
import type { HarnessPackageIdentity } from "../agent-runtime/package/identity";
import type { SandboxEntry } from "../state/registry";
import { parseManagedImageExtensions } from "../state/snapshot/managed-extensions";
import { type BackupResult } from "../state/sandbox";
import * as sandboxState from "../state/sandbox";
import { allowsLegacyImagePluginProvenance } from "../state/snapshot/legacy-manifest";

export interface PreRecreateBackupAuthority {
  readonly agentDefinition: AgentDefinition;
  readonly harnessPackage: HarnessPackageIdentity | null;
  readonly validateBeforePublish?: () => void;
}

export type SandboxBackupImpl = (
  sandboxName: string,
  authority?: PreRecreateBackupAuthority,
) => BackupResult;

export interface PreRecreateBackupOptions {
  sandboxName: string;
  sandboxEntry?: SandboxEntry | null;
  sourceBackupAuthority?: PreRecreateBackupAuthority | null;
  requireOpenClawImagePluginProvenance?: boolean;
  backupImpl?: SandboxBackupImpl;
  log?: (msg: string) => void;
  errorLog?: (msg: string) => void;
}

export type PreRecreateBackupFailureKind =
  | "none"
  | "partial"
  | "empty"
  | "threw"
  | "managed-extension-provenance";

export interface PreRecreateBackupResult {
  ok: boolean;
  backup: BackupResult | null;
  failureKind: PreRecreateBackupFailureKind;
  errorMessage?: string;
}

export function backupSandboxBeforeRecreate(
  opts: PreRecreateBackupOptions,
): PreRecreateBackupResult {
  const log = opts.log ?? ((m: string) => console.log(m));
  const errorLog = opts.errorLog ?? ((m: string) => console.error(m));
  const sandboxEntry = opts.sandboxEntry ?? null;
  const sourceBackupAuthority = opts.sourceBackupAuthority ?? null;
  const receiptRequiresImagePluginProvenance = sourceBackupAuthority?.harnessPackage
    ? sourceBackupAuthority.agentDefinition.stateLifecycle.rebuild.managed_extensions.support ===
      "managed"
    : null;
  const requiresImagePluginProvenance =
    receiptRequiresImagePluginProvenance ??
    (opts.requireOpenClawImagePluginProvenance === true ||
      (Boolean(sandboxEntry?.fromDockerfile) &&
        allowsLegacyImagePluginProvenance(sandboxEntry?.agent ?? "openclaw")));
  const customImageWithPluginProvenance =
    requiresImagePluginProvenance &&
    (receiptRequiresImagePluginProvenance === null || Boolean(sandboxEntry?.fromDockerfile));
  try {
    const backup = opts.backupImpl
      ? sourceBackupAuthority
        ? opts.backupImpl(opts.sandboxName, sourceBackupAuthority)
        : opts.backupImpl(opts.sandboxName)
      : sourceBackupAuthority
        ? sandboxState.backupSandboxState(opts.sandboxName, sourceBackupAuthority)
        : (() => {
            throw new Error(
              `Sandbox '${opts.sandboxName}' has no registered agent package authority.`,
            );
          })();
    if (backup.success && backup.manifest?.backupPath) {
      const managedExtensions =
        sourceBackupAuthority?.harnessPackage &&
        sourceBackupAuthority.agentDefinition.stateLifecycle.rebuild.managed_extensions.support ===
          "managed"
          ? sourceBackupAuthority.agentDefinition.stateLifecycle.rebuild.managed_extensions
          : null;
      const hasManagedExtensionProvenance =
        managedExtensions !== null &&
        backup.manifest.reconcileManagedImageExtensions === true &&
        parseManagedImageExtensions(backup.manifest.managedImageExtensions, managedExtensions).ok;
      if (
        (customImageWithPluginProvenance ||
          backup.manifest.reconcileManagedImageExtensions === true ||
          backup.manifest.reconcileOpenClawImagePluginProvenance === true) &&
        !hasManagedExtensionProvenance &&
        !sandboxState.hasAuthoritativeOpenClawImagePluginProvenance(backup.manifest)
      ) {
        errorLog(
          "  Managed image extension provenance is missing; aborting recreate before delete.",
        );
        errorLog(
          "  Keep the sandbox and backup untouched; onboard under a new name and manually migrate user-owned state.",
        );
        errorLog(
          "  Or take an independent manual backup, then explicitly accept destructive recreation with NEMOCLAW_RECREATE_WITHOUT_BACKUP=1.",
        );
        return { ok: false, backup, failureKind: "managed-extension-provenance" };
      }
      log(
        `  ✓ State backed up (${backup.backedUpDirs.length} directories, ${backup.backedUpFiles.length} files)`,
      );
      return { ok: true, backup, failureKind: "none" };
    }
    if (backup.backedUpDirs.length > 0 || backup.backedUpFiles.length > 0) {
      errorLog(
        `  Partial backup: ${backup.backedUpDirs.length} dirs / ${backup.backedUpFiles.length} files saved; ${backup.failedDirs.length} dirs / ${backup.failedFiles.length} files failed.`,
      );
      errorLog("  Aborting recreate — failed entries would be lost on delete.");
      return { ok: false, backup, failureKind: "partial" };
    }
    errorLog("  State backup failed — aborting recreate to prevent data loss.");
    if (backup.error) errorLog(`  Reason: ${backup.error}`);
    return { ok: false, backup: null, failureKind: "empty" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    errorLog(`  State backup threw: ${message} — aborting recreate.`);
    return { ok: false, backup: null, failureKind: "threw", errorMessage: message };
  }
}

export function shouldSkipPreRecreateBackup(env: NodeJS.ProcessEnv): boolean {
  return env.NEMOCLAW_RECREATE_WITHOUT_BACKUP === "1";
}
