// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";
import { type BackupResult } from "../state/sandbox";
import * as sandboxState from "../state/sandbox";
import {
  backupSandboxBeforeRecreate,
  shouldSkipPreRecreateBackup,
} from "./sandbox-backup-on-recreate";

function makeBackup(overrides: Partial<BackupResult> = {}): BackupResult {
  return {
    success: true,
    backedUpDirs: ["workspace", "skills"],
    failedDirs: [],
    backedUpFiles: ["UPGRADE_MARKER.md"],
    failedFiles: [],
    manifest: {
      backupPath: "/tmp/backups/x",
      timestamp: "2026-05-25T00:00:00Z",
    } as BackupResult["manifest"],
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("backupSandboxBeforeRecreate", () => {
  it("returns ok with backup result on success", () => {
    const backup = makeBackup();
    const backupImpl = vi.fn().mockReturnValue(backup);
    const log = vi.fn();
    const result = backupSandboxBeforeRecreate({
      sandboxName: "my-assistant",
      backupImpl,
      log,
      errorLog: vi.fn(),
    });
    expect(result.ok).toBe(true);
    expect(result.backup).toBe(backup);
    expect(result.failureKind).toBe("none");
    expect(backupImpl).toHaveBeenCalledWith("my-assistant");
    expect(log).toHaveBeenCalledWith(expect.stringContaining("State backed up"));
  });

  it("passes source package authority to the default state backup", () => {
    const harnessPackage = {
      kind: "agent-runtime" as const,
      id: "hermes",
      packageVersion: "0.13.0",
      contentDigest: "b".repeat(64),
    };
    const sandboxEntry = {
      name: "hermes",
      agent: "hermes",
      harnessPackage,
    };
    const agentDefinition = {
      name: "hermes",
      packageRoot: `/state/harnesses/objects/${harnessPackage.contentDigest}`,
      stateLifecycle: {
        rebuild: {
          managed_extensions: {
            support: "disabled",
            reason: "Test package has no managed extensions.",
          },
        },
      },
    };
    const backup = makeBackup();
    const validateBeforePublish = vi.fn();
    const sourceBackupAuthority = {
      agentDefinition: agentDefinition as never,
      harnessPackage,
      validateBeforePublish,
    };
    const backupSandboxState = vi.spyOn(sandboxState, "backupSandboxState").mockReturnValue(backup);

    const result = backupSandboxBeforeRecreate({
      sandboxName: "hermes",
      sandboxEntry,
      sourceBackupAuthority,
      log: vi.fn(),
      errorLog: vi.fn(),
    });

    expect(result).toMatchObject({ ok: true, backup, failureKind: "none" });
    expect(backupSandboxState).toHaveBeenCalledWith("hermes", sourceBackupAuthority);
  });

  it("rejects a default backup that has no registered agent package authority", () => {
    const backupSandboxState = vi.spyOn(sandboxState, "backupSandboxState");
    const errorLog = vi.fn();

    const result = backupSandboxBeforeRecreate({
      sandboxName: "orphan",
      sandboxEntry: null,
      log: vi.fn(),
      errorLog,
    });

    expect(result).toMatchObject({ ok: false, failureKind: "threw" });
    expect(backupSandboxState).not.toHaveBeenCalled();
    expect(errorLog).toHaveBeenCalledWith(
      expect.stringContaining("has no registered agent package authority"),
    );
  });

  it("rejects an unmarked custom OpenClaw backup before recreate deletion (#6108)", () => {
    const errorLog = vi.fn();
    const result = backupSandboxBeforeRecreate({
      sandboxName: "my-assistant",
      sandboxEntry: {
        name: "my-assistant",
        agent: "openclaw",
        fromDockerfile: "/tmp/Dockerfile.custom",
      },
      backupImpl: () => makeBackup(),
      log: vi.fn(),
      errorLog,
    });

    expect(result.ok).toBe(false);
    expect(result.failureKind).toBe("managed-extension-provenance");
    expect(errorLog).toHaveBeenCalledWith(
      expect.stringContaining("aborting recreate before delete"),
    );
  });

  it("uses a future receipt package's managed-extension declaration", () => {
    const harnessPackage = {
      kind: "agent-runtime" as const,
      id: "future-harness",
      packageVersion: "1.0.0",
      contentDigest: "c".repeat(64),
    };
    const result = backupSandboxBeforeRecreate({
      sandboxName: "future",
      sandboxEntry: {
        name: "future",
        agent: "future-harness",
        harnessPackage,
        fromDockerfile: "/tmp/Dockerfile.custom",
      },
      sourceBackupAuthority: {
        harnessPackage,
        agentDefinition: {
          name: "future-harness",
          stateLifecycle: {
            rebuild: {
              managed_extensions: {
                support: "managed",
                controller: { command: ["/future-state"], timeout_seconds: 10 },
                state_directory: "extensions",
                preserved_directories: [],
                allowed_symlinks: [],
              },
            },
          },
        } as never,
      },
      backupImpl: () => makeBackup(),
      log: vi.fn(),
      errorLog: vi.fn(),
    });

    expect(result).toMatchObject({ ok: false, failureKind: "managed-extension-provenance" });
  });

  it("does not infer image-plugin behavior for a receipt package named OpenClaw", () => {
    const harnessPackage = {
      kind: "agent-runtime" as const,
      id: "openclaw",
      packageVersion: "1.0.0",
      contentDigest: "d".repeat(64),
    };
    const backup = makeBackup();
    const result = backupSandboxBeforeRecreate({
      sandboxName: "openclaw",
      sandboxEntry: {
        name: "openclaw",
        agent: "openclaw",
        harnessPackage,
        fromDockerfile: "/tmp/Dockerfile.custom",
      },
      sourceBackupAuthority: {
        harnessPackage,
        agentDefinition: {
          name: "openclaw",
          stateLifecycle: {
            rebuild: {
              managed_extensions: {
                support: "disabled",
                reason: "Test package has no managed extensions.",
              },
            },
          },
        } as never,
      },
      requireOpenClawImagePluginProvenance: true,
      backupImpl: () => backup,
      log: vi.fn(),
      errorLog: vi.fn(),
    });

    expect(result).toMatchObject({ ok: true, backup, failureKind: "none" });
  });

  it("rejects an unmarked backup for an orphan custom OpenClaw target (#6108)", () => {
    const errorLog = vi.fn();
    const result = backupSandboxBeforeRecreate({
      sandboxName: "orphan",
      sandboxEntry: null,
      requireOpenClawImagePluginProvenance: true,
      backupImpl: () => makeBackup(),
      log: vi.fn(),
      errorLog,
    });

    expect(result.ok).toBe(false);
    expect(result.failureKind).toBe("managed-extension-provenance");
    expect(errorLog).toHaveBeenCalledWith(expect.stringContaining("new name"));
    expect(errorLog).toHaveBeenCalledWith(
      expect.stringContaining("NEMOCLAW_RECREATE_WITHOUT_BACKUP=1"),
    );
  });

  it("returns ok:false with failureKind=partial when some entries failed", () => {
    const backup = makeBackup({
      success: false,
      backedUpDirs: ["workspace"],
      failedDirs: ["skills"],
      backedUpFiles: [],
      failedFiles: ["bad.bin"],
    });
    const errorLog = vi.fn();
    const result = backupSandboxBeforeRecreate({
      sandboxName: "my-assistant",
      backupImpl: () => backup,
      log: vi.fn(),
      errorLog,
    });
    expect(result.ok).toBe(false);
    expect(result.failureKind).toBe("partial");
    expect(result.backup).toBe(backup);
    expect(errorLog).toHaveBeenCalledWith(expect.stringContaining("Partial backup"));
    expect(errorLog).toHaveBeenCalledWith(expect.stringContaining("Aborting recreate"));
  });

  it("rejects backup result missing manifest backupPath", () => {
    const backup = makeBackup({ manifest: undefined });
    const errorLog = vi.fn();
    const result = backupSandboxBeforeRecreate({
      sandboxName: "my-assistant",
      backupImpl: () => backup,
      log: vi.fn(),
      errorLog,
    });
    expect(result.ok).toBe(false);
  });

  it("returns ok:false with failureKind=empty when nothing was backed up", () => {
    const backup = makeBackup({
      success: false,
      backedUpDirs: [],
      failedDirs: ["workspace"],
      backedUpFiles: [],
      failedFiles: [],
      error: "Pre-backup audit rejected an unsafe symlink",
    });
    const errorLog = vi.fn();
    const result = backupSandboxBeforeRecreate({
      sandboxName: "my-assistant",
      backupImpl: () => backup,
      errorLog,
      log: vi.fn(),
    });
    expect(result.ok).toBe(false);
    expect(result.failureKind).toBe("empty");
    expect(result.backup).toBeNull();
    expect(errorLog).toHaveBeenCalledWith(expect.stringContaining("aborting recreate"));
    expect(errorLog).toHaveBeenCalledWith("  Reason: Pre-backup audit rejected an unsafe symlink");
  });

  it("returns ok:false with failureKind=threw when backup throws", () => {
    const errorLog = vi.fn();
    const result = backupSandboxBeforeRecreate({
      sandboxName: "my-assistant",
      backupImpl: () => {
        throw new Error("disk full");
      },
      errorLog,
      log: vi.fn(),
    });
    expect(result.ok).toBe(false);
    expect(result.failureKind).toBe("threw");
    expect(result.errorMessage).toBe("disk full");
    expect(errorLog).toHaveBeenCalledWith(expect.stringContaining("State backup threw"));
  });
});

describe("shouldSkipPreRecreateBackup", () => {
  it("returns true when NEMOCLAW_RECREATE_WITHOUT_BACKUP=1", () => {
    expect(shouldSkipPreRecreateBackup({ NEMOCLAW_RECREATE_WITHOUT_BACKUP: "1" })).toBe(true);
  });

  it("returns false for any other value", () => {
    expect(shouldSkipPreRecreateBackup({})).toBe(false);
    expect(shouldSkipPreRecreateBackup({ NEMOCLAW_RECREATE_WITHOUT_BACKUP: "0" })).toBe(false);
    expect(shouldSkipPreRecreateBackup({ NEMOCLAW_RECREATE_WITHOUT_BACKUP: "true" })).toBe(false);
  });
});
