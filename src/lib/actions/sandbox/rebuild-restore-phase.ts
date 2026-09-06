// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { OpenShellRuntimeSelection } from "../../adapters/openshell/runtime-selection";
import { G, R, YW } from "../../cli/terminal-style";
import type { AgentDefinition } from "../../agent-runtime/manifest-types";
import { load as loadRegistry } from "../../state/registry/persistence";
import type { RebuildBackupManifest } from "./rebuild-backup-phase";
import type { RebuildLog } from "./rebuild-credential-preflight";
import * as snapshotRestore from "./snapshot/restore-authority";
import { reconcileLegacyDashboardProfile } from "./rebuild/legacy-dashboard";

export interface RebuildRestorePhaseInput {
  sandboxName: string;
  agentDefinition: AgentDefinition;
  targetImageIsCustom: boolean;
  backupManifest: RebuildBackupManifest;
  reconcileManagedDcodeObservability?: boolean;
  /** Explicit no-receipt compatibility; package receipts use post_restore.command. */
  reconcileLegacyDashboard?: boolean;
  runtimeSelection?: OpenShellRuntimeSelection;
  log: RebuildLog;
}

export interface RebuildRestorePhaseResult {
  restoreSucceeded: boolean;
}

/** Restore sandbox files. The replacement already received the captured live OpenShell policy. */
export function runRebuildRestorePhase(input: RebuildRestorePhaseInput): RebuildRestorePhaseResult {
  const {
    sandboxName,
    agentDefinition,
    targetImageIsCustom,
    backupManifest,
    runtimeSelection,
    log,
  } = input;
  let restoreSucceeded = true;
  if (backupManifest) {
    console.log("");
    console.log("  Restoring workspace state...");
    const restore = snapshotRestore.restoreRecreatedSandboxStateWithManagedAuthority(
      sandboxName,
      backupManifest,
      {
        targetAgentType: agentDefinition.name,
        agentDefinition,
        ...(targetImageIsCustom ? { allowCustomImageWholeStateFileRestore: true } : {}),
        ...(runtimeSelection ? { runtimeSelection } : {}),
      },
      snapshotRestore.createManagedRestoreAuthorityDependencies(
        (name) => loadRegistry().sandboxes[name] ?? null,
      ),
    );
    log(
      `Restore result: success=${restore.success}, restored=${restore.restoredDirs.join(",")}; files=${restore.restoredFiles.join(",")}, failed=${restore.failedDirs.join(",")}; failedFiles=${restore.failedFiles.join(",")}${restore.error ? `; error=${restore.error}` : ""}`,
    );
    restoreSucceeded = restore.success;
    if (
      input.reconcileLegacyDashboard === true &&
      restore.restoredDirs.some(
        (directory) => directory === "dashboard-home" || directory === "profiles",
      )
    ) {
      const seeded = reconcileLegacyDashboardProfile(sandboxName, agentDefinition);
      log(`Legacy dashboard state after restore: ${seeded}`);
      if (seeded === "failed") restoreSucceeded = false;
    }
    if (!restore.success) {
      if (restore.error) console.error(`  Restore blocked: ${restore.error}`);
      console.error(`  ${YW}Partial restore:${R} ${restore.restoredDirs.join(", ") || "none"}`);
      console.error(`  Manual restore available from: ${backupManifest.backupPath}`);
    } else if (restoreSucceeded) {
      console.log(
        `  ${G}✓${R} State restored (${restore.restoredDirs.length} directories, ${restore.restoredFiles.length} files)`,
      );
    }
  }
  return {
    restoreSucceeded,
  };
}
