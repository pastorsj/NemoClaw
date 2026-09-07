// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type { SandboxEntry } from "../state/registry";
import type { RebuildManifest, RestoreResult } from "../state/sandbox";
import { finalizeCreatedSandbox } from "./created-sandbox-finalization";

const legacyManifest: RebuildManifest = {
  version: 1,
  sandboxName: "dcode",
  timestamp: "2026-08-28T00:00:00.000Z",
  agentType: "langchain-deepagents-code",
  agentVersion: "0.1.0",
  expectedVersion: "0.1.0",
  stateDirs: [],
  dir: "/sandbox/.deepagents",
  backupPath: "/tmp/dcode-backup",
  blueprintDigest: null,
};

const packageIdentity = {
  kind: "agent-runtime" as const,
  id: "langchain-deepagents-code",
  packageVersion: "0.1.0",
  contentDigest: "a".repeat(64),
};

function preparedRestoreAuthority(sandboxName: string) {
  const prepared = { name: sandboxName } as SandboxEntry;
  return {
    prepareRegistration: () => prepared,
    revalidatePreparedRegistration: (target: SandboxEntry) => target,
  };
}

describe("ordinary recreate restore authority", () => {
  it("rejects legacy snapshot restore when its reconciled package changes", () => {
    const changedPackage = { ...packageIdentity, contentDigest: "b".repeat(64) };
    const revalidateHarnessPackageAuthority = vi
      .fn()
      .mockReturnValueOnce(packageIdentity)
      .mockReturnValue(changedPackage);
    const register = vi.fn();
    const error = vi.fn();
    const restoreRecreatedSandboxState = vi.fn(
      (_name, _backup, _options, resolveTarget): RestoreResult => {
        try {
          resolveTarget?.();
          return {
            success: true,
            restoredDirs: [],
            failedDirs: [],
            restoredFiles: [],
            failedFiles: [],
          };
        } catch (cause) {
          return {
            success: false,
            restoredDirs: [],
            failedDirs: ["manifest"],
            restoredFiles: [],
            failedFiles: [],
            error: String(cause),
          };
        }
      },
    );

    expect(() =>
      finalizeCreatedSandbox(
        {
          sandboxName: "dcode",
          restoreBackupPath: legacyManifest.backupPath,
          preUpgradeBackup: false,
          targetAgentType: legacyManifest.agentType,
          agentDefinition: { name: legacyManifest.agentType } as never,
          validateManagedDcode: false,
          provider: "nvidia-prod",
          model: "test-model",
          preferredInferenceApi: null,
        },
        {
          ...preparedRestoreAuthority("dcode"),
          readSandboxStateBackupManifest: () => legacyManifest,
          captureSnapshotRestoreAuthority: () => ({
            schemaVersion: 1,
            backupPath: legacyManifest.backupPath,
            contentSha256: "c".repeat(64),
          }),
          revalidateSandboxIdentity: vi.fn(),
          revalidateHarnessPackageAuthority,
          discoverFreshOpenClawImagePluginInstalls: vi.fn(),
          restoreRecreatedSandboxState,
          getDcodeSelectionDrift: vi.fn(),
          register,
          note: vi.fn(),
          error,
          exitProcess: (code): never => {
            throw new Error(`exit ${String(code)}`);
          },
        },
      ),
    ).toThrow("exit 1");

    expect(revalidateHarnessPackageAuthority).toHaveBeenNthCalledWith(
      1,
      "preparing state restore for sandbox 'dcode'",
    );
    expect(revalidateHarnessPackageAuthority).toHaveBeenNthCalledWith(
      2,
      "restoring files for sandbox 'dcode'",
    );
    expect(register).not.toHaveBeenCalled();
    expect(error.mock.calls.flat().join("\n")).toContain("harness package authority changed");
  });
});
