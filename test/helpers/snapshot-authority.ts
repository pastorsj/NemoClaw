// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { loadAgent } from "../../src/lib/agent/defs";
import type { HarnessPackageIdentity } from "../../src/lib/agent-runtime/package/identity";
import type { BackupOptions, SnapshotRestoreOptions } from "../../src/lib/state/sandbox";

type SnapshotAuthorityReader = Pick<
  typeof import("../../src/lib/state/sandbox"),
  "captureSnapshotRestoreAuthority" | "readSandboxStateBackupManifest"
>;

export function createSnapshotHarnessPackageFixture(agentId: string): HarnessPackageIdentity {
  return {
    kind: "agent-runtime",
    id: agentId,
    packageVersion: "1.2.3",
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
  const manifest = state.readSandboxStateBackupManifest(backupPath);
  if (!manifest || manifest.sandboxName !== sandboxName) {
    throw new Error(`No matching snapshot fixture exists for '${sandboxName}'`);
  }
  const authority = state.captureSnapshotRestoreAuthority(backupPath, manifest);
  if (!authority) throw new Error(`Could not capture snapshot authority for '${sandboxName}'`);
  return {
    agentDefinition: loadAgent(agentId),
    authority,
    validateBeforeMutation: () => undefined,
  };
}
