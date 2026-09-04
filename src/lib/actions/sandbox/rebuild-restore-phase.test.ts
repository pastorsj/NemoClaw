// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentDefinition } from "../../agent-runtime/manifest-types";
import * as sandboxConfig from "../../sandbox/config";
import { runRebuildRestorePhase } from "./rebuild-restore-phase";
import * as snapshotRestore from "./snapshot/restore-authority";

const backupManifest = {
  agentType: "openclaw",
  backupPath: "/tmp/rebuild-backup",
} as never;
const OPENCLAW_DEFINITION = { name: "openclaw" } as AgentDefinition;
const HERMES_DEFINITION = { name: "hermes" } as AgentDefinition;

describe("rebuild filesystem restore", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("restores through managed snapshot authority without replaying policy state", () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const restore = vi
      .spyOn(snapshotRestore, "restoreRecreatedSandboxStateWithManagedAuthority")
      .mockReturnValue({
        success: true,
        restoredDirs: ["workspace"],
        restoredFiles: ["user.md"],
        failedDirs: [],
        failedFiles: [],
      });

    const result = runRebuildRestorePhase({
      sandboxName: "alpha",
      agentDefinition: OPENCLAW_DEFINITION,
      targetImageIsCustom: false,
      backupManifest,
      log: vi.fn(),
    });

    expect(restore).toHaveBeenCalledWith(
      "alpha",
      backupManifest,
      { targetAgentType: "openclaw", agentDefinition: OPENCLAW_DEFINITION },
      { getSandbox: expect.any(Function), captureOpenshell: expect.any(Function) },
    );
    expect(result).toEqual({ restoreSucceeded: true });
  });

  it("allows whole-state file restore only for an explicit custom image", () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const restore = vi
      .spyOn(snapshotRestore, "restoreRecreatedSandboxStateWithManagedAuthority")
      .mockReturnValue({
        success: true,
        restoredDirs: [],
        restoredFiles: [],
        failedDirs: [],
        failedFiles: [],
      });

    runRebuildRestorePhase({
      sandboxName: "alpha",
      agentDefinition: OPENCLAW_DEFINITION,
      targetImageIsCustom: true,
      backupManifest,
      log: vi.fn(),
    });

    expect(restore).toHaveBeenCalledWith(
      "alpha",
      backupManifest,
      {
        targetAgentType: "openclaw",
        agentDefinition: OPENCLAW_DEFINITION,
        allowCustomImageWholeStateFileRestore: true,
      },
      { getSandbox: expect.any(Function), captureOpenshell: expect.any(Function) },
    );
  });

  it("migrates restored Hermes dashboard state into its current profile", () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(snapshotRestore, "restoreRecreatedSandboxStateWithManagedAuthority").mockReturnValue({
      success: true,
      restoredDirs: ["profiles", "dashboard-home"],
      restoredFiles: [],
      failedDirs: [],
      failedFiles: [],
    });
    const target = {
      agentName: "hermes",
      configDir: "/sandbox/.hermes",
      configPath: "/sandbox/.hermes/config.yaml",
      configFile: "config.yaml",
      format: "yaml",
    } as const;
    vi.spyOn(sandboxConfig, "resolveAgentConfig").mockReturnValue(target);
    const migrate = vi
      .spyOn(sandboxConfig, "restoreHermesDashboardConfig")
      .mockReturnValue("converged");
    const log = vi.fn();

    const result = runRebuildRestorePhase({
      sandboxName: "hermes",
      agentDefinition: HERMES_DEFINITION,
      targetImageIsCustom: false,
      backupManifest,
      log,
    });

    expect(migrate).toHaveBeenCalledWith("hermes", target);
    expect(log).toHaveBeenCalledWith("Hermes dashboard state after restore: converged");
    expect(result).toEqual({ restoreSucceeded: true });
  });

  it("reports an unresolved or failed Hermes dashboard migration as incomplete", () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(snapshotRestore, "restoreRecreatedSandboxStateWithManagedAuthority").mockReturnValue({
      success: true,
      restoredDirs: ["dashboard-home"],
      restoredFiles: [],
      failedDirs: [],
      failedFiles: [],
    });
    vi.spyOn(sandboxConfig, "resolveAgentConfig").mockReturnValue({
      agentName: "openclaw",
      configDir: "/sandbox/.openclaw",
      configPath: "/sandbox/.openclaw/openclaw.json",
      configFile: "openclaw.json",
      format: "json",
    });
    const migrate = vi.spyOn(sandboxConfig, "restoreHermesDashboardConfig");

    const result = runRebuildRestorePhase({
      sandboxName: "hermes",
      agentDefinition: HERMES_DEFINITION,
      targetImageIsCustom: false,
      backupManifest,
      log: vi.fn(),
    });

    expect(migrate).not.toHaveBeenCalled();
    expect(result).toEqual({ restoreSucceeded: false });
  });

  it("surfaces a filesystem restore failure without inventing policy recovery", () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const log = vi.fn();
    vi.spyOn(snapshotRestore, "restoreRecreatedSandboxStateWithManagedAuthority").mockReturnValue({
      success: false,
      restoredDirs: [],
      restoredFiles: [],
      failedDirs: ["extensions"],
      failedFiles: [],
      error: "could not read fresh OpenClaw plugin install registry",
    });

    const result = runRebuildRestorePhase({
      sandboxName: "alpha",
      agentDefinition: OPENCLAW_DEFINITION,
      targetImageIsCustom: false,
      backupManifest,
      log,
    });

    expect(result).toEqual({ restoreSucceeded: false });
    expect(consoleError).toHaveBeenCalledWith(
      "  Restore blocked: could not read fresh OpenClaw plugin install registry",
    );
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("error=could not read fresh OpenClaw plugin install registry"),
    );
  });
});
