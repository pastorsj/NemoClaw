// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { loadAgent } from "../../src/lib/agent/defs";
import type { HarnessPackageIdentity } from "../../src/lib/harness/package-identity";
import type { BackupOptions, SnapshotRestoreOptions } from "../../src/lib/state/sandbox";

type SnapshotAuthorityReader = Pick<
  typeof import("../../src/lib/state/sandbox"),
  "captureSnapshotRestoreAuthority" | "getLatestBackup"
>;

export function createSnapshotHarnessPackageFixture(agentId: string): HarnessPackageIdentity {
  return {
    kind: "agent-runtime",
    id: agentId,
    packageVersion: "1.2.3",
    contractVersion: 1,
    contentDigest: "a".repeat(64),
  };
}

export function createSnapshotBackupAuthorityFixture(
  agentId: string,
): Required<Pick<BackupOptions, "agentDefinition" | "harnessPackage">> {
  return {
    agentDefinition: loadAgent(agentId),
    harnessPackage: createSnapshotHarnessPackageFixture(agentId),
  };
}

export function createSnapshotRestoreAuthorityFixture(
  state: SnapshotAuthorityReader,
  sandboxName: string,
  agentId: string,
  backupPath: string,
): Required<
  Pick<SnapshotRestoreOptions, "agentDefinition" | "authority" | "validateBeforeMutation">
> {
  const manifest = state.getLatestBackup(sandboxName);
  if (!manifest) throw new Error(`No snapshot fixture exists for '${sandboxName}'`);
  const authority = state.captureSnapshotRestoreAuthority(backupPath, manifest);
  if (!authority) throw new Error(`Could not capture snapshot authority for '${sandboxName}'`);
  return {
    agentDefinition: loadAgent(agentId),
    authority,
    validateBeforeMutation: () => undefined,
  };
}
