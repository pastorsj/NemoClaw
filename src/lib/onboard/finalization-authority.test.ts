// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type { RebuildManifest } from "../state/sandbox";
import { finalizeCreatedSandbox } from "./created-sandbox-finalization";

const OPENCLAW_PACKAGE = {
  kind: "agent-runtime" as const,
  id: "openclaw",
  packageVersion: "1.2.3",
  contractVersion: 1 as const,
  contentDigest: "a".repeat(64),
};

const PLUGIN_INSTALLS = [
  {
    id: "weather",
    installPath: "/sandbox/.openclaw/extensions/weather",
    loadPaths: [],
  },
];

function openClawManifest(): RebuildManifest {
  return {
    version: 2,
    sandboxName: "openclaw",
    timestamp: "2026-08-28T00:00:00.000Z",
    agentType: "openclaw",
    agentVersion: "1.2.3",
    expectedVersion: "1.2.3",
    harnessPackage: OPENCLAW_PACKAGE,
    stateDirs: ["extensions"],
    dir: "/sandbox/.openclaw",
    backupPath: "/tmp/openclaw-backup",
    blueprintDigest: null,
  };
}

describe("created OpenClaw restore authority", () => {
  it("restores an ordinary schema-v2 recreate with exact package authority", () => {
    const order: string[] = [];
    const manifest = openClawManifest();
    const authority = {
      schemaVersion: 1 as const,
      backupPath: "/tmp/openclaw-backup",
      contentSha256: "b".repeat(64),
    };
    const agentDefinition = {
      name: "openclaw",
      packageRoot: "/state/harnesses/objects/openclaw",
    };
    const register = vi.fn(() => {
      order.push("register");
    });
    const revalidateHarnessPackageAuthority = vi.fn(() => OPENCLAW_PACKAGE);
    const restoreRecreatedSandboxState = vi.fn((_name, _backup, options) => {
      order.push("restore");
      options.validateBeforeMutation?.();
      return {
        success: true,
        restoredDirs: ["extensions"],
        failedDirs: [],
        restoredFiles: ["openclaw.json"],
        failedFiles: [],
      };
    });

    finalizeCreatedSandbox(
      {
        sandboxName: "openclaw",
        restoreBackupPath: "/tmp/openclaw-backup",
        preUpgradeBackup: false,
        targetAgentType: "openclaw",
        agentDefinition: agentDefinition as never,
        discoverOpenClawImagePluginInstalls: true,
        validateManagedDcode: false,
        provider: "compatible-endpoint",
        model: "demo",
        preferredInferenceApi: "openai-completions",
      },
      {
        discoverFreshOpenClawImagePluginInstalls: () => {
          order.push("discover");
          return { ok: true, extensionDirs: ["weather"], pluginInstalls: PLUGIN_INSTALLS };
        },
        restoreRecreatedSandboxState,
        readSandboxStateBackupManifest: () => manifest,
        captureSnapshotRestoreAuthority: vi.fn(() => authority),
        revalidateHarnessPackageAuthority,
        revalidatePolicyAuthority: vi.fn(),
        getDcodeSelectionDrift: vi.fn(),
        register,
        note: vi.fn(),
        error: vi.fn(),
        exitProcess: (code): never => {
          throw new Error(`exit ${code}`);
        },
      },
    );

    expect(order).toEqual(["discover", "restore", "register"]);
    expect(restoreRecreatedSandboxState).toHaveBeenCalledWith("openclaw", "/tmp/openclaw-backup", {
      targetAgentType: "openclaw",
      agentDefinition,
      freshOpenClawImagePluginInstalls: PLUGIN_INSTALLS,
      authority,
      validateBeforeMutation: expect.any(Function),
    });
    expect(revalidateHarnessPackageAuthority).toHaveBeenCalledWith(
      "restore files for sandbox 'openclaw'",
    );
    expect(register).toHaveBeenCalledWith(PLUGIN_INSTALLS);
  });

  it("fails closed when the selected harness package drifts before restore mutation", () => {
    const register = vi.fn();
    const error = vi.fn();
    const restoreRecreatedSandboxState = vi.fn((_name, _backup, options) => {
      try {
        options.validateBeforeMutation?.();
        return {
          success: true,
          restoredDirs: ["extensions"],
          failedDirs: [],
          restoredFiles: [],
          failedFiles: [],
        };
      } catch (cause) {
        return {
          success: false,
          restoredDirs: [],
          failedDirs: ["extensions"],
          restoredFiles: [],
          failedFiles: [],
          error: `Runtime authority changed before filesystem mutation: ${String(cause)}`,
        };
      }
    });

    expect(() =>
      finalizeCreatedSandbox(
        {
          sandboxName: "openclaw",
          restoreBackupPath: "/tmp/openclaw-backup",
          preUpgradeBackup: false,
          targetAgentType: "openclaw",
          agentDefinition: { name: "openclaw" } as never,
          validateManagedDcode: false,
          provider: "compatible-endpoint",
          model: "demo",
          preferredInferenceApi: "openai-completions",
        },
        {
          discoverFreshOpenClawImagePluginInstalls: vi.fn(),
          restoreRecreatedSandboxState,
          readSandboxStateBackupManifest: openClawManifest,
          captureSnapshotRestoreAuthority: () => ({
            schemaVersion: 1,
            backupPath: "/tmp/openclaw-backup",
            contentSha256: "b".repeat(64),
          }),
          revalidateHarnessPackageAuthority: () => ({
            ...OPENCLAW_PACKAGE,
            contentDigest: "c".repeat(64),
          }),
          revalidatePolicyAuthority: vi.fn(),
          getDcodeSelectionDrift: vi.fn(),
          register,
          note: vi.fn(),
          error,
          exitProcess: (code): never => {
            throw new Error(`exit ${code}`);
          },
        },
      ),
    ).toThrow("exit 1");

    expect(restoreRecreatedSandboxState).toHaveBeenCalledOnce();
    expect(register).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("snapshot harness package authority changed"),
    );
  });

  it("refuses filesystem restore after the created sandbox live identity changes", () => {
    const register = vi.fn();
    const error = vi.fn();
    let liveIdentity = "created-sandbox-id";
    let filesystemMutationStarted = false;
    const revalidatePolicyAuthority = vi.fn(() =>
      liveIdentity === "created-sandbox-id"
        ? undefined
        : (() => {
            throw new Error("created sandbox live identity changed");
          })(),
    );
    const restoreRecreatedSandboxState = vi.fn((_name, _backup, options) => {
      liveIdentity = "replacement-sandbox-id";
      try {
        options.validateBeforeMutation?.();
        filesystemMutationStarted = true;
        return {
          success: true,
          restoredDirs: ["extensions"],
          failedDirs: [],
          restoredFiles: [],
          failedFiles: [],
        };
      } catch (cause) {
        return {
          success: false,
          restoredDirs: [],
          failedDirs: ["extensions"],
          restoredFiles: [],
          failedFiles: [],
          error: `Runtime authority changed before filesystem mutation: ${String(cause)}`,
        };
      }
    });

    expect(() =>
      finalizeCreatedSandbox(
        {
          sandboxName: "openclaw",
          restoreBackupPath: "/tmp/openclaw-backup",
          preUpgradeBackup: false,
          targetAgentType: "openclaw",
          agentDefinition: { name: "openclaw" } as never,
          validateManagedDcode: false,
          provider: "compatible-endpoint",
          model: "demo",
          preferredInferenceApi: "openai-completions",
        },
        {
          discoverFreshOpenClawImagePluginInstalls: vi.fn(),
          restoreRecreatedSandboxState,
          readSandboxStateBackupManifest: openClawManifest,
          captureSnapshotRestoreAuthority: () => ({
            schemaVersion: 1,
            backupPath: "/tmp/openclaw-backup",
            contentSha256: "b".repeat(64),
          }),
          revalidateHarnessPackageAuthority: () => OPENCLAW_PACKAGE,
          revalidatePolicyAuthority,
          getDcodeSelectionDrift: vi.fn(),
          register,
          note: vi.fn(),
          error,
          exitProcess: (code): never => {
            throw new Error(`exit ${code}`);
          },
        },
      ),
    ).toThrow("created sandbox live identity changed");

    expect(filesystemMutationStarted).toBe(false);
    expect(revalidatePolicyAuthority).toHaveBeenCalledTimes(3);
    expect(register).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });
});
