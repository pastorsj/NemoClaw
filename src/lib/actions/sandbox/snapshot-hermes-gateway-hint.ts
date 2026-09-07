// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

interface SnapshotStateFile {
  path: string;
  strategy: "copy" | "sqlite_backup";
}

interface SnapshotRestoreHintAuthority {
  agent?: string | null;
  harnessPackage?: unknown;
}

/**
 * Recommend a gateway restart after restoring a Hermes SQLite state file.
 *
 * The restored SQLite databases replace files the running Hermes gateway
 * still holds open, so it serves pre-restore state until it reopens them
 * (#7312).
 */
export function printLegacyHermesGatewayRestoreHint(
  sandboxName: string,
  authority: SnapshotRestoreHintAuthority,
  restoredFiles: readonly string[],
  snapshotStateFiles: readonly SnapshotStateFile[],
  cliName: string,
  writeLine: (message: string) => void = console.log,
): void {
  // A package receipt owns all harness-specific restore behavior. This hint is
  // retained only for legacy Hermes sandboxes that predate package receipts.
  if (authority.harnessPackage != null || authority.agent !== "hermes") return;
  const restoredFileSet = new Set(restoredFiles);
  const restoredSqliteDatabase = snapshotStateFiles.some(
    (stateFile) => stateFile.strategy === "sqlite_backup" && restoredFileSet.has(stateFile.path),
  );
  if (!restoredSqliteDatabase) return;
  writeLine(
    `  Restart the gateway to open the restored state databases: run \`${cliName} ${sandboxName} gateway restart\``,
  );
}
