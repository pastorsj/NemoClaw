// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as f from "./snapshot-restore-test-fixture";
import {
  OPENCLAW_PACKAGE,
  configureCloneGateway,
  configureCloneRegistry,
  expectSnapshotStateRestore,
  harnessPackage,
  isSandboxGet,
  legacyPackageMigration,
  liveSandboxGetResult,
  packageManagedSandbox,
  packageManagedSnapshot,
  pendingPackageManagedSandbox,
  runWhen,
} from "./snapshot/lifecycle-fixture";

beforeEach(() => {
  f.resetSnapshotRestoreMocks();
});
afterEach(() => {
  f.cleanupSnapshotRestoreMocks();
});
describe("runSandboxSnapshot restore: lifecycle and destination safety", () => {
  it("refuses state restore after a finalized target is replaced by the same package", async () => {
    const entries = configureCloneRegistry(packageManagedSandbox("alpha", OPENCLAW_PACKAGE));
    f.getLatestBackupMock.mockReturnValue({ ...f.latestBackupFixture });
    f.captureOpenshellMock.mockImplementation((args) =>
      f.openshellResponses(args, {
        "sandbox exec": { status: 0, output: f.dcodeProbeOutput("no-runtime") },
        "sandbox list": { status: 0, output: "alpha Ready\nbeta Ready\n" },
      }),
    );
    let replacement: f.SandboxRecord | null = null;
    f.restoreSandboxStateMock.mockImplementation((_name, _backupPath, options) => {
      const finalized = entries.get("beta")!;
      replacement = {
        ...finalized,
        lifecycleGeneration: "same-package-replacement-generation",
        lifecycleLiveIdentityFingerprint: "f".repeat(64),
      };
      entries.set("beta", replacement);
      options.validateBeforeMutation();
      throw new Error("unreachable after restore authority validation");
    });
    const { runSandboxSnapshot } = await import("./snapshot");

    await expect(runSandboxSnapshot("alpha", { kind: "restore", to: "beta" })).rejects.toThrow(
      "changed after restore authority was captured",
    );

    expect(entries.get("beta")).toEqual(replacement);
    expect(f.finalizePendingSandboxRegistrationMock).toHaveBeenCalledOnce();
    expect(f.restoreSandboxStateMock).toHaveBeenCalledOnce();
    expect(f.establishRestoredSandboxGatewayPairingMock).not.toHaveBeenCalled();
  });

  it("refuses the first filesystem mutation when the live target identity changes", async () => {
    const source = packageManagedSandbox("alpha", OPENCLAW_PACKAGE);
    const entries = new Map<string, f.SandboxRecord>([["alpha", source]]);
    f.getSandboxMock.mockImplementation((name) => entries.get(name ?? "") ?? null);
    f.getLatestBackupMock.mockReturnValue(packageManagedSnapshot(OPENCLAW_PACKAGE));
    f.parseLiveSandboxNamesMock.mockReturnValue(new Set(["alpha"]));
    let liveIdentity = "alpha-original-live-id";
    f.captureOpenshellMock.mockImplementation((args) => {
      return isSandboxGet(args)
        ? liveSandboxGetResult("alpha", liveIdentity)
        : f.openshellResponses(args, {
            "sandbox exec": { status: 0, output: f.dcodeProbeOutput("no-runtime") },
            "sandbox list": { status: 0, output: "alpha Ready\n" },
          });
    });
    let remoteFilesystemMutated = false;
    f.restoreSandboxStateMock.mockImplementation((_name, _backupPath, options) => {
      liveIdentity = "alpha-replacement-live-id";
      options.validateBeforeMutation();
      remoteFilesystemMutated = true;
      return {
        success: true,
        restoredDirs: ["workspace"],
        restoredFiles: [],
        failedDirs: [],
        failedFiles: [],
      };
    });
    const { runSandboxSnapshot } = await import("./snapshot");

    await expect(runSandboxSnapshot("alpha", { kind: "restore" })).rejects.toThrow(
      "live identity changed after restore authority was captured",
    );

    expect(f.restoreSandboxStateMock).toHaveBeenCalledOnce();
    expect(remoteFilesystemMutated).toBe(false);
    expect(f.establishRestoredSandboxGatewayPairingMock).not.toHaveBeenCalled();
  });

  it("refuses the first clone filesystem mutation when its live identity changes", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const entries = configureCloneRegistry(packageManagedSandbox("alpha", OPENCLAW_PACKAGE));
    f.getLatestBackupMock.mockReturnValue(packageManagedSnapshot(OPENCLAW_PACKAGE));
    configureCloneGateway();
    const captureCloneGateway = f.captureOpenshellMock.getMockImplementation()!;
    let cloneLiveIdentity = "beta-live-id";
    f.captureOpenshellMock.mockImplementation((args) =>
      isSandboxGet(args, "beta")
        ? liveSandboxGetResult("beta", cloneLiveIdentity)
        : captureCloneGateway(args),
    );
    let remoteFilesystemMutated = false;
    f.restoreSandboxStateMock.mockImplementation((_name, _backupPath, options) => {
      cloneLiveIdentity = "beta-replacement-live-id";
      options.validateBeforeMutation();
      remoteFilesystemMutated = true;
      return {
        success: true,
        restoredDirs: ["workspace"],
        restoredFiles: [],
        failedDirs: [],
        failedFiles: [],
      };
    });
    const { runSandboxSnapshot } = await import("./snapshot");

    await expect(
      runSandboxSnapshot("alpha", { kind: "restore", to: "beta" }),
    ).rejects.toMatchObject({ exitCode: 1 });

    expect(entries.get("beta")).toMatchObject({
      name: "beta",
      harnessPackage: OPENCLAW_PACKAGE,
    });
    expect(remoteFilesystemMutated).toBe(false);
    expect(f.establishRestoredSandboxGatewayPairingMock).not.toHaveBeenCalled();
    expect(consoleError.mock.calls.flat().join("\n")).toContain(
      "no longer has the live identity captured by its registry entry",
    );
  });

  it.each(["config repair", "custom policy", "built-in policy", "gateway pairing"] as const)(
    "re-proves the restored live identity before %s",
    async (boundary) => {
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      configureCloneRegistry(packageManagedSandbox("alpha", OPENCLAW_PACKAGE));
      const restoredCustomPolicy = {
        name: "restored-custom",
        content: "version: 1\nnetwork_policies: {}\n",
        sourcePath: "/tmp/restored-custom.yaml",
      };
      f.getLatestBackupMock.mockReturnValue({
        ...packageManagedSnapshot(OPENCLAW_PACKAGE),
        policyPresets: boundary === "gateway pairing" ? ["github"] : [],
        customPolicies:
          boundary === "custom policy" || boundary === "built-in policy"
            ? [restoredCustomPolicy]
            : [],
      });
      configureCloneGateway();
      const captureCloneGateway = f.captureOpenshellMock.getMockImplementation()!;
      let cloneLiveIdentity = "beta-live-id";
      const replaceCloneLiveIdentity = (): void => {
        cloneLiveIdentity = `beta-replaced-before-${boundary.replaceAll(" ", "-")}`;
      };
      f.captureOpenshellMock.mockImplementation((args) =>
        isSandboxGet(args, "beta")
          ? liveSandboxGetResult("beta", cloneLiveIdentity)
          : captureCloneGateway(args),
      );
      f.shieldsMock.repairMutableConfigPermsMock.mockImplementation(() => {
        runWhen(boundary === "custom policy", replaceCloneLiveIdentity);
        return { applied: true, verified: true, errors: [] };
      });
      f.applyPresetContentMock.mockImplementation(() => {
        runWhen(boundary === "built-in policy", replaceCloneLiveIdentity);
        return true;
      });
      f.applyPresetMock.mockImplementation(() => {
        runWhen(boundary === "gateway pairing", replaceCloneLiveIdentity);
        return true;
      });
      f.restoreSandboxStateMock.mockImplementation((_name, _backupPath, options) => {
        options.validateBeforeMutation();
        runWhen(boundary === "config repair", replaceCloneLiveIdentity);
        return {
          success: true,
          restoredDirs: ["workspace"],
          restoredFiles: ["openclaw.json"],
          failedDirs: [],
          failedFiles: [],
        };
      });
      const { runSandboxSnapshot } = await import("./snapshot");

      await expect(
        runSandboxSnapshot("alpha", { kind: "restore", to: "beta" }),
      ).rejects.toMatchObject({ exitCode: 1 });

      boundary === "config repair"
        ? expect(f.shieldsMock.repairMutableConfigPermsMock).not.toHaveBeenCalled()
        : expect(f.shieldsMock.repairMutableConfigPermsMock).toHaveBeenCalledWith("beta");
      runWhen(boundary === "custom policy", () => {
        expect(f.applyPresetContentMock).not.toHaveBeenCalled();
      });
      runWhen(boundary === "built-in policy", () => {
        expect(f.applyPresetContentMock).toHaveBeenCalledWith(
          "beta",
          restoredCustomPolicy.name,
          restoredCustomPolicy.content,
          expect.anything(),
        );
        expect(f.applyPresetMock).not.toHaveBeenCalled();
      });
      runWhen(boundary === "gateway pairing", () => {
        expect(f.applyPresetMock).toHaveBeenCalledWith("beta", "github", {
          nonFatal: true,
          skipRegistryUpdate: true,
        });
      });
      expect(f.establishRestoredSandboxGatewayPairingMock).not.toHaveBeenCalled();
      expect(consoleError.mock.calls.flat().join("\n")).toContain(
        "no longer has the live identity captured by its registry entry",
      );
    },
  );

  it("does not apply a second custom policy after the first mutation changes live identity", async () => {
    configureCloneRegistry(packageManagedSandbox("alpha", OPENCLAW_PACKAGE));
    f.getLatestBackupMock.mockReturnValue({
      ...packageManagedSnapshot(OPENCLAW_PACKAGE),
      policyPresets: [],
      customPolicies: [
        { name: "first-custom", content: "network_policies:\n  first: {}\n" },
        { name: "second-custom", content: "network_policies:\n  second: {}\n" },
      ],
    });
    configureCloneGateway();
    const captureCloneGateway = f.captureOpenshellMock.getMockImplementation()!;
    let cloneLiveIdentity = "beta-live-id";
    f.captureOpenshellMock.mockImplementation((args) =>
      isSandboxGet(args, "beta")
        ? liveSandboxGetResult("beta", cloneLiveIdentity)
        : captureCloneGateway(args),
    );
    f.applyPresetContentMock.mockImplementation(() => {
      cloneLiveIdentity = "beta-replaced-by-first-custom-policy";
      return true;
    });
    const { runSandboxSnapshot } = await import("./snapshot");

    await expect(
      runSandboxSnapshot("alpha", { kind: "restore", to: "beta" }),
    ).rejects.toMatchObject({ exitCode: 1 });

    expect(f.applyPresetContentMock).toHaveBeenCalledTimes(1);
    expect(f.applyPresetContentMock.mock.calls[0]?.[1]).toBe("first-custom");
    expect(f.updateSandboxIfCurrentMock).not.toHaveBeenCalled();
    expect(f.establishRestoredSandboxGatewayPairingMock).not.toHaveBeenCalled();
  });

  it("does not apply a second built-in policy after the first mutation changes live identity", async () => {
    configureCloneRegistry(packageManagedSandbox("alpha", OPENCLAW_PACKAGE));
    f.getLatestBackupMock.mockReturnValue({
      ...packageManagedSnapshot(OPENCLAW_PACKAGE),
      policyPresets: ["github", "brave"],
      customPolicies: [],
    });
    configureCloneGateway();
    const captureCloneGateway = f.captureOpenshellMock.getMockImplementation()!;
    let cloneLiveIdentity = "beta-live-id";
    f.captureOpenshellMock.mockImplementation((args) =>
      isSandboxGet(args, "beta")
        ? liveSandboxGetResult("beta", cloneLiveIdentity)
        : captureCloneGateway(args),
    );
    f.applyPresetMock.mockImplementation(() => {
      cloneLiveIdentity = "beta-replaced-by-first-built-in-policy";
      return true;
    });
    const { runSandboxSnapshot } = await import("./snapshot");

    await expect(
      runSandboxSnapshot("alpha", { kind: "restore", to: "beta" }),
    ).rejects.toMatchObject({ exitCode: 1 });

    expect(f.applyPresetMock).toHaveBeenCalledTimes(1);
    expect(f.applyPresetMock.mock.calls[0]?.[1]).toBe("github");
    expect(f.updateSandboxIfCurrentMock).not.toHaveBeenCalled();
    expect(f.establishRestoredSandboxGatewayPairingMock).not.toHaveBeenCalled();
  });

  it("does not attribute a restored policy to a replacement row swapped in before registry publication", async () => {
    const entries = configureCloneRegistry(packageManagedSandbox("alpha", OPENCLAW_PACKAGE));
    f.getLatestBackupMock.mockReturnValue({
      ...packageManagedSnapshot(OPENCLAW_PACKAGE),
      policyPresets: [],
      customPolicies: [
        { name: "first-custom", content: "network_policies:\n  first: {}\n" },
        { name: "second-custom", content: "network_policies:\n  second: {}\n" },
      ],
    });
    configureCloneGateway();
    let replacement: f.SandboxRecord | null = null;
    f.updateSandboxIfCurrentMock.mockImplementation((expected) => {
      const current = entries.get(expected.name);
      runWhen(current !== undefined, () => {
        replacement = { ...structuredClone(current!), model: "replacement-model" };
        entries.set(expected.name, replacement!);
      });
      return false;
    });
    const { runSandboxSnapshot } = await import("./snapshot");

    await expect(runSandboxSnapshot("alpha", { kind: "restore", to: "beta" })).rejects.toThrow(
      "policy attribution could not be recorded",
    );

    expect(f.applyPresetContentMock).toHaveBeenCalledTimes(1);
    expect(f.updateSandboxIfCurrentMock).toHaveBeenCalledWith(
      expect.objectContaining({ name: "beta" }),
      expect.objectContaining({
        customPolicies: [expect.objectContaining({ name: "first-custom" })],
      }),
    );
    expect(entries.get("beta")).toEqual(replacement);
    expect(entries.get("beta")?.customPolicies).toBeUndefined();
    expect(f.establishRestoredSandboxGatewayPairingMock).not.toHaveBeenCalled();
  });

  it("leaves snapshot state untouched when the clone supervisor never becomes ready (#7818)", async () => {
    const entries = configureCloneRegistry(packageManagedSandbox("alpha", OPENCLAW_PACKAGE));
    f.getLatestBackupMock.mockReturnValue({ ...f.latestBackupFixture });
    f.captureOpenshellMock.mockImplementation((args) =>
      f.openshellResponses(args, {
        "sandbox exec": { status: 0, output: f.dcodeProbeOutput("no-runtime") },
        "sandbox list": { status: 0, output: "alpha Ready\nbeta Ready\n" },
      }),
    );
    f.waitForRestoredSandboxGatewaySupervisorMock.mockReturnValue(false);
    const { runSandboxSnapshot } = await import("./snapshot");

    await expect(
      runSandboxSnapshot("alpha", { kind: "restore", to: "beta" }),
    ).rejects.toMatchObject({ exitCode: 1 });

    expect(f.restoreSandboxStateMock).not.toHaveBeenCalled();
    expect(f.establishRestoredSandboxGatewayPairingMock).not.toHaveBeenCalled();
    expect(f.removeSandboxRouteReservationIfCurrentMock).not.toHaveBeenCalled();
    expect(entries.get("beta")).toMatchObject({
      name: "beta",
      pendingRouteReservation: true,
    });
  });

  it("preserves a fresh pending clone when its live identity changes during supervisor wait", async () => {
    const entries = configureCloneRegistry(packageManagedSandbox("alpha", OPENCLAW_PACKAGE));
    f.getLatestBackupMock.mockReturnValue(packageManagedSnapshot(OPENCLAW_PACKAGE));
    configureCloneGateway();
    const captureCloneGateway = f.captureOpenshellMock.getMockImplementation()!;
    let cloneLiveIdentity = "beta-live-id";
    f.captureOpenshellMock.mockImplementation((args) =>
      isSandboxGet(args, "beta")
        ? liveSandboxGetResult("beta", cloneLiveIdentity)
        : captureCloneGateway(args),
    );
    f.waitForRestoredSandboxGatewaySupervisorMock.mockImplementation(() => {
      cloneLiveIdentity = "beta-replacement-during-supervisor-wait";
      return true;
    });
    const { runSandboxSnapshot } = await import("./snapshot");

    await expect(
      runSandboxSnapshot("alpha", { kind: "restore", to: "beta" }),
    ).rejects.toMatchObject({
      lines: expect.arrayContaining([
        "  Snapshot state was not restored. The pending registry entry and live clone were preserved for identity-bound recovery.",
      ]),
    });

    expect(f.finalizePendingSandboxRegistrationMock).not.toHaveBeenCalled();
    expect(entries.get("beta")).toMatchObject({
      name: "beta",
      pendingRouteReservation: true,
    });
    expect(f.restoreSandboxStateMock).not.toHaveBeenCalled();
  });

  it("preserves a pending clone registration when finalization fails before snapshot restore", async () => {
    const entries = new Map<string, f.SandboxRecord>([
      ["alpha", packageManagedSandbox("alpha", OPENCLAW_PACKAGE)],
    ]);
    configureCloneRegistry(entries.get("alpha")!, entries);
    f.finalizePendingSandboxRegistrationMock.mockReturnValue(false);
    f.getLatestBackupMock.mockReturnValue({ ...f.latestBackupFixture });
    f.captureOpenshellMock.mockImplementation((args) =>
      f.openshellResponses(args, {
        "sandbox exec": { status: 0, output: f.dcodeProbeOutput("no-runtime") },
        "sandbox list": { status: 0, output: "alpha Ready\nbeta Ready\n" },
      }),
    );
    const { runSandboxSnapshot } = await import("./snapshot");

    await expect(
      runSandboxSnapshot("alpha", { kind: "restore", to: "beta" }),
    ).rejects.toMatchObject({
      exitCode: 1,
      lines: expect.arrayContaining([
        "  Snapshot state was not restored. The pending registry entry and live clone were preserved for identity-bound recovery.",
      ]),
    });

    expect(f.registerSandboxMock).toHaveBeenCalledWith(
      expect.objectContaining({ name: "beta" }),
      undefined,
      { pending: true, expectedCurrent: null },
    );
    expect(f.finalizePendingSandboxRegistrationMock).toHaveBeenCalledWith(
      expect.objectContaining({ name: "beta", pendingRouteReservation: true }),
    );
    expect(f.removeSandboxRouteReservationIfCurrentMock).not.toHaveBeenCalled();
    expect(f.registerSandboxMock.mock.invocationCallOrder[0]).toBeLessThan(
      f.finalizePendingSandboxRegistrationMock.mock.invocationCallOrder[0],
    );
    expect(entries.get("beta")).toMatchObject({
      name: "beta",
      pendingRouteReservation: true,
    });
    expect(f.restoreSandboxStateMock).not.toHaveBeenCalled();
    expect(f.establishRestoredSandboxGatewayPairingMock).not.toHaveBeenCalled();
  });

  it("reports an ownership conflict when clone finalization loses its pending row", async () => {
    const source = packageManagedSandbox("alpha", OPENCLAW_PACKAGE);
    const entries = new Map<string, f.SandboxRecord>([["alpha", source]]);
    configureCloneRegistry(source, entries);
    let replacement: f.SandboxRecord | null = null;
    f.finalizePendingSandboxRegistrationMock.mockImplementation((expected) => {
      const changedEntry: f.SandboxRecord = {
        ...expected,
        pendingRouteReservation: undefined,
        lifecycleGeneration: "replacement-generation",
        lifecycleLiveIdentityFingerprint: "f".repeat(64),
      };
      replacement = changedEntry;
      entries.set(expected.name, changedEntry);
      return false;
    });
    f.getLatestBackupMock.mockReturnValue(packageManagedSnapshot(OPENCLAW_PACKAGE));
    configureCloneGateway();
    const { runSandboxSnapshot } = await import("./snapshot");

    await expect(
      runSandboxSnapshot("alpha", { kind: "restore", to: "beta" }),
    ).rejects.toMatchObject({
      exitCode: 1,
      lines: expect.arrayContaining([
        expect.stringContaining("registry row changed after the pending clone was captured"),
      ]),
    });

    expect(entries.get("beta")).toEqual(replacement);
    expect(f.removeSandboxRouteReservationIfCurrentMock).not.toHaveBeenCalled();
    expect(f.restoreSandboxStateMock).not.toHaveBeenCalled();
  });

  it("finalizes an identity-matching pending clone after a process restart", async () => {
    const pendingFingerprint = createHash("sha256").update("beta-live-id").digest("hex");
    const entries = new Map<string, f.SandboxRecord>([
      ["alpha", packageManagedSandbox("alpha", OPENCLAW_PACKAGE)],
      [
        "beta",
        {
          ...pendingPackageManagedSandbox("beta", OPENCLAW_PACKAGE),
          name: "beta",
          createdAt: "2026-08-20T00:00:00.000Z",
          pendingRouteReservation: true,
          imageTag: "nemoclaw-alpha:test",
          gatewayName: "nemoclaw",
          lifecycleGeneration: "clone-generation",
          lifecycleLiveIdentityFingerprint: pendingFingerprint,
        },
      ],
    ]);
    f.getSandboxMock.mockImplementation((name) => entries.get(name ?? "") ?? null);
    f.parseLiveSandboxNamesMock.mockReturnValue(new Set(["alpha", "beta"]));
    f.finalizePendingSandboxRegistrationMock.mockImplementation((expected) => {
      const current = entries.get(expected.name);
      expect(current?.pendingRouteReservation).toBe(true);
      expect(current).toEqual(expected);
      const { pendingRouteReservation: _pending, ...finalized } = current!;
      entries.set(expected.name, finalized);
      return true;
    });
    f.getLatestBackupMock.mockReturnValue({ ...f.latestBackupFixture });
    f.captureOpenshellMock.mockImplementation((args) =>
      f.openshellResponses(args, {
        "sandbox exec": { status: 0, output: f.dcodeProbeOutput("no-runtime") },
        "sandbox list": { status: 0, output: "alpha Ready\nbeta Ready\n" },
      }),
    );
    const { runSandboxSnapshot } = await import("./snapshot");

    await runSandboxSnapshot("alpha", { kind: "restore", to: "beta" });

    expect(f.finalizePendingSandboxRegistrationMock).toHaveBeenCalledWith(
      expect.objectContaining({ name: "beta", pendingRouteReservation: true }),
    );
    expect(f.streamSandboxCreateMock).not.toHaveBeenCalled();
    expectSnapshotStateRestore("beta");
    expect(entries.get("beta")?.pendingRouteReservation).toBeUndefined();
  });

  it("preserves a recovered pending clone when prepared snapshot content changes before cleanup", async () => {
    const pendingFingerprint = createHash("sha256").update("beta-live-id").digest("hex");
    const pending: f.SandboxRecord = {
      ...pendingPackageManagedSandbox("beta", OPENCLAW_PACKAGE),
      createdAt: "2026-08-20T00:00:00.000Z",
      pendingRouteReservation: true,
      imageTag: "nemoclaw-alpha:test",
      gatewayName: "nemoclaw",
      lifecycleGeneration: "clone-generation",
      lifecycleLiveIdentityFingerprint: pendingFingerprint,
    };
    const entries = new Map<string, f.SandboxRecord>([
      ["alpha", packageManagedSandbox("alpha", OPENCLAW_PACKAGE)],
      ["beta", pending],
    ]);
    f.getSandboxMock.mockImplementation((name) => entries.get(name ?? "") ?? null);
    f.parseLiveSandboxNamesMock.mockReturnValue(new Set(["alpha", "beta"]));
    f.getLatestBackupMock.mockReturnValue(packageManagedSnapshot(OPENCLAW_PACKAGE));
    f.captureOpenshellMock.mockImplementation((args) =>
      f.openshellResponses(args, {
        "sandbox exec": { status: 0, output: f.dcodeProbeOutput("no-runtime") },
        "sandbox list": { status: 0, output: "alpha Ready\nbeta Ready\n" },
      }),
    );
    f.waitForRestoredSandboxGatewaySupervisorMock.mockReturnValue(false);
    const validate = vi.fn(() => {
      throw new Error("operation-owned snapshot content changed before lifecycle mutation");
    });
    const cleanup = vi.fn();
    f.prepareSnapshotRestoreContentMock.mockReturnValue({
      schemaVersion: 1,
      selectedBackupPath: "/tmp/backup-alpha",
      stagedBackupPath: "/tmp/owned-backup-alpha",
      authority: {
        schemaVersion: 1,
        backupPath: "/tmp/backup-alpha",
        contentSha256: "d".repeat(64),
      },
      validate,
      cleanup,
    });
    const { runSandboxSnapshot } = await import("./snapshot");

    await expect(
      runSandboxSnapshot("alpha", { kind: "restore", to: "beta" }),
    ).rejects.toMatchObject({ exitCode: 1 });

    expect(validate).toHaveBeenCalled();
    expect(f.lifecycleMock.events).not.toContain("delete");
    expect(f.streamSandboxCreateMock).not.toHaveBeenCalled();
    expect(f.restoreSandboxStateMock).not.toHaveBeenCalled();
    expect(entries.get("beta")).toEqual(pending);
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("preserves a recovered pending clone when its live identity changes during supervisor wait", async () => {
    const pendingFingerprint = createHash("sha256").update("beta-live-id").digest("hex");
    const pending: f.SandboxRecord = {
      ...pendingPackageManagedSandbox("beta", OPENCLAW_PACKAGE),
      createdAt: "2026-08-20T00:00:00.000Z",
      pendingRouteReservation: true,
      imageTag: "nemoclaw-alpha:test",
      gatewayName: "nemoclaw",
      lifecycleGeneration: "clone-generation",
      lifecycleLiveIdentityFingerprint: pendingFingerprint,
    };
    const entries = new Map<string, f.SandboxRecord>([
      ["alpha", packageManagedSandbox("alpha", OPENCLAW_PACKAGE)],
      ["beta", pending],
    ]);
    f.getSandboxMock.mockImplementation((name) => entries.get(name ?? "") ?? null);
    f.parseLiveSandboxNamesMock.mockReturnValue(new Set(["alpha", "beta"]));
    f.getLatestBackupMock.mockReturnValue(packageManagedSnapshot(OPENCLAW_PACKAGE));
    let cloneLiveIdentity = "beta-live-id";
    f.captureOpenshellMock.mockImplementation((args) =>
      isSandboxGet(args, "beta")
        ? liveSandboxGetResult("beta", cloneLiveIdentity)
        : f.openshellResponses(args, {
            "sandbox exec": { status: 0, output: f.dcodeProbeOutput("no-runtime") },
            "sandbox list": { status: 0, output: "alpha Ready\nbeta Ready\n" },
          }),
    );
    f.waitForRestoredSandboxGatewaySupervisorMock.mockImplementation(() => {
      cloneLiveIdentity = "beta-replacement-during-supervisor-wait";
      return true;
    });
    const { runSandboxSnapshot } = await import("./snapshot");

    await expect(runSandboxSnapshot("alpha", { kind: "restore", to: "beta" })).rejects.toThrow(
      "changed live identity while its supervisor was being verified",
    );

    expect(entries.get("beta")).toEqual(pending);
    expect(f.finalizePendingSandboxRegistrationMock).not.toHaveBeenCalled();
    expect(f.restoreSandboxStateMock).not.toHaveBeenCalled();
  });

  it("does not finalize a recovered pending clone when package authority changes during reconciliation", async () => {
    const changedPackage = { ...OPENCLAW_PACKAGE, contentDigest: "c".repeat(64) };
    const pendingFingerprint = createHash("sha256").update("beta-live-id").digest("hex");
    const entries = new Map<string, f.SandboxRecord>([
      ["alpha", packageManagedSandbox("alpha", OPENCLAW_PACKAGE)],
      [
        "beta",
        {
          ...pendingPackageManagedSandbox("beta", OPENCLAW_PACKAGE),
          createdAt: "2026-08-20T00:00:00.000Z",
          pendingRouteReservation: true,
          imageTag: "nemoclaw-alpha:test",
          gatewayName: "nemoclaw",
          lifecycleGeneration: "clone-generation",
          lifecycleLiveIdentityFingerprint: pendingFingerprint,
        },
      ],
    ]);
    f.getSandboxMock.mockImplementation((name) => entries.get(name ?? "") ?? null);
    f.parseLiveSandboxNamesMock.mockReturnValue(new Set(["alpha", "beta"]));
    f.getLatestBackupMock.mockReturnValue(packageManagedSnapshot(OPENCLAW_PACKAGE));
    f.captureOpenshellMock.mockImplementation((args) =>
      f.openshellResponses(args, {
        "sandbox exec": { status: 0, output: f.dcodeProbeOutput("no-runtime") },
        "sandbox list": { status: 0, output: "alpha Ready\nbeta Ready\n" },
      }),
    );
    f.waitForRestoredSandboxGatewaySupervisorMock.mockImplementation(() => {
      entries.set("alpha", packageManagedSandbox("alpha", changedPackage));
      return true;
    });
    const { runSandboxSnapshot } = await import("./snapshot");

    await expect(runSandboxSnapshot("alpha", { kind: "restore", to: "beta" })).rejects.toThrow(
      "harness package authority differs",
    );

    expect(f.finalizePendingSandboxRegistrationMock).not.toHaveBeenCalled();
    expect(f.streamSandboxCreateMock).not.toHaveBeenCalled();
    expect(entries.get("beta")?.pendingRouteReservation).toBe(true);
    expect(f.restoreSandboxStateMock).not.toHaveBeenCalled();
  });

  it("refuses snapshot recovery of a session-owned pending registration", async () => {
    const pendingFingerprint = createHash("sha256").update("beta-live-id").digest("hex");
    const entries = new Map<string, f.SandboxRecord>([
      ["alpha", packageManagedSandbox("alpha", OPENCLAW_PACKAGE)],
      [
        "beta",
        {
          ...pendingPackageManagedSandbox("beta", OPENCLAW_PACKAGE),
          name: "beta",
          createdAt: "2026-08-20T00:00:00.000Z",
          pendingRouteReservation: true,
          reservationSessionId: "onboard-session",
          imageTag: "nemoclaw-alpha:test",
          gatewayName: "nemoclaw",
          lifecycleGeneration: "clone-generation",
          lifecycleLiveIdentityFingerprint: pendingFingerprint,
        },
      ],
    ]);
    f.getSandboxMock.mockImplementation((name) => entries.get(name ?? "") ?? null);
    f.parseLiveSandboxNamesMock.mockReturnValue(new Set(["alpha", "beta"]));
    f.finalizePendingSandboxRegistrationMock.mockImplementation((expected) => {
      const current = entries.get(expected.name);
      expect(current).toMatchObject({
        pendingRouteReservation: true,
        reservationSessionId: "onboard-session",
      });
      return false;
    });
    f.getLatestBackupMock.mockReturnValue({ ...f.latestBackupFixture });
    f.captureOpenshellMock.mockImplementation((args) =>
      f.openshellResponses(args, {
        "sandbox exec": { status: 0, output: f.dcodeProbeOutput("no-runtime") },
        "sandbox list": { status: 0, output: "alpha Ready\nbeta Ready\n" },
      }),
    );
    const { runSandboxSnapshot } = await import("./snapshot");

    await expect(
      runSandboxSnapshot("alpha", { kind: "restore", to: "beta" }),
    ).rejects.toMatchObject({ exitCode: 1 });

    expect(f.finalizePendingSandboxRegistrationMock).not.toHaveBeenCalled();
    expect(f.restoreSandboxStateMock).not.toHaveBeenCalled();
    expect(entries.get("beta")).toMatchObject({
      pendingRouteReservation: true,
      reservationSessionId: "onboard-session",
    });
  });

  it("preserves an exactly matching pending clone during transient gateway absence", async () => {
    const entries = new Map<string, f.SandboxRecord>([
      ["alpha", packageManagedSandbox("alpha", OPENCLAW_PACKAGE)],
      [
        "beta",
        {
          ...pendingPackageManagedSandbox("beta", OPENCLAW_PACKAGE),
          createdAt: "2026-08-20T00:00:00.000Z",
          pendingRouteReservation: true,
          imageTag: "nemoclaw-alpha:test",
          gatewayName: "nemoclaw",
          lifecycleGeneration: "clone-generation",
          lifecycleLiveIdentityFingerprint: createHash("sha256")
            .update("expected-live-id")
            .digest("hex"),
        },
      ],
    ]);
    configureCloneRegistry(entries.get("alpha")!, entries);
    f.parseLiveSandboxNamesMock.mockImplementation(
      (output: string) => new Set(output.includes("beta Ready") ? ["alpha", "beta"] : ["alpha"]),
    );
    f.getLatestBackupMock.mockReturnValue({ ...f.latestBackupFixture });
    let gatewayListCalls = 0;
    f.captureOpenshellMock.mockImplementation((args) => {
      gatewayListCalls += Number(
        args[0] === "sandbox" && args[1] === "list" && args.includes("-g"),
      );
      return f.openshellResponses(args, {
        "sandbox exec": { status: 0, output: f.dcodeProbeOutput("no-runtime") },
        "sandbox list": {
          status: 0,
          output: gatewayListCalls > 2 ? "alpha Ready\nbeta Ready\n" : "alpha Ready\n",
        },
      });
    });
    const { runSandboxSnapshot } = await import("./snapshot");

    await expect(
      runSandboxSnapshot("alpha", { kind: "restore", to: "beta" }),
    ).rejects.toMatchObject({
      lines: expect.arrayContaining([
        expect.stringContaining("transient absence does not prove its captured live identity"),
      ]),
    });

    expect(entries.get("beta")).toMatchObject({
      name: "beta",
      pendingRouteReservation: true,
      lifecycleGeneration: "clone-generation",
    });
    expect(f.removeSandboxIfCurrentMock).not.toHaveBeenCalled();
    expect(f.removeSandboxRegistryEntryOutcomeMock).not.toHaveBeenCalled();
    expect(f.streamSandboxCreateMock).not.toHaveBeenCalled();
    expect(f.restoreSandboxStateMock).not.toHaveBeenCalled();
  });

  it("does not reconcile a pending clone after a non-package source field changes", async () => {
    const source = packageManagedSandbox("alpha", OPENCLAW_PACKAGE);
    const pendingFingerprint = createHash("sha256").update("beta-live-id").digest("hex");
    const pending: f.SandboxRecord = {
      ...pendingPackageManagedSandbox("beta", OPENCLAW_PACKAGE),
      createdAt: "2026-08-20T00:00:00.000Z",
      pendingRouteReservation: true,
      imageTag: source.imageTag,
      gatewayName: "nemoclaw",
      gatewayPort: 8080,
      lifecycleGeneration: "clone-generation",
      lifecycleLiveIdentityFingerprint: pendingFingerprint,
    };
    const changedSource: f.SandboxRecord = {
      ...source,
      hostMounts: [
        {
          source: "/host/replacement",
          target: "/sandbox/replacement",
          readOnly: true,
        },
      ],
    };
    const entries = new Map<string, f.SandboxRecord>([
      ["alpha", changedSource],
      ["beta", pending],
    ]);
    f.getSandboxMock.mockImplementation((name) => entries.get(name ?? "") ?? null);
    f.getLatestBackupMock.mockReturnValue(packageManagedSnapshot(OPENCLAW_PACKAGE));
    f.parseLiveSandboxNamesMock.mockReturnValue(new Set(["alpha", "beta"]));
    f.captureOpenshellMock.mockImplementation((args) =>
      f.openshellResponses(args, {
        "sandbox exec": { status: 0, output: f.dcodeProbeOutput("no-runtime") },
        "sandbox list": { status: 0, output: "alpha Ready\nbeta Ready\n" },
      }),
    );
    const { runSandboxSnapshot } = await import("./snapshot");

    await expect(runSandboxSnapshot("alpha", { kind: "restore", to: "beta" })).rejects.toThrow(
      "does not match this snapshot restore",
    );

    expect(entries.get("beta")).toEqual(pending);
    expect(f.finalizePendingSandboxRegistrationMock).not.toHaveBeenCalled();
    expect(f.lifecycleMock.events).not.toContain("delete");
    expect(f.restoreSandboxStateMock).not.toHaveBeenCalled();
  });

  it("does not retry a transient absence before preserving pending ownership", async () => {
    const pending: f.SandboxRecord = {
      ...pendingPackageManagedSandbox("beta", OPENCLAW_PACKAGE),
      createdAt: "2026-08-20T00:00:00.000Z",
      pendingRouteReservation: true,
      imageTag: "nemoclaw-alpha:test",
      gatewayName: "nemoclaw",
      lifecycleGeneration: "clone-generation",
      lifecycleLiveIdentityFingerprint: createHash("sha256")
        .update("expected-live-id")
        .digest("hex"),
    };
    const entries = new Map<string, f.SandboxRecord>([
      ["alpha", packageManagedSandbox("alpha", OPENCLAW_PACKAGE)],
      ["beta", pending],
    ]);
    configureCloneRegistry(entries.get("alpha")!, entries);
    f.parseLiveSandboxNamesMock.mockImplementation(
      (output: string) => new Set(output.includes("beta Ready") ? ["alpha", "beta"] : ["alpha"]),
    );
    f.getLatestBackupMock.mockReturnValue({ ...f.latestBackupFixture });
    let gatewayListCalls = 0;
    f.captureOpenshellMock.mockImplementation((args) => {
      gatewayListCalls += Number(
        args[0] === "sandbox" && args[1] === "list" && args.includes("-g"),
      );
      return f.openshellResponses(args, {
        "sandbox exec": { status: 0, output: f.dcodeProbeOutput("no-runtime") },
        "sandbox list": {
          status: 0,
          output: gatewayListCalls > 1 ? "alpha Ready\nbeta Ready\n" : "alpha Ready\n",
        },
      });
    });
    const { runSandboxSnapshot } = await import("./snapshot");

    await expect(runSandboxSnapshot("alpha", { kind: "restore", to: "beta" })).rejects.toThrow(
      "transient absence does not prove its captured live identity",
    );

    expect(gatewayListCalls).toBe(1);
    expect(entries.get("beta")).toEqual(pending);
    expect(f.removeSandboxIfCurrentMock).not.toHaveBeenCalled();
    expect(f.streamSandboxCreateMock).not.toHaveBeenCalled();
    expect(f.restoreSandboxStateMock).not.toHaveBeenCalled();
    expect(f.lifecycleMock.events).not.toContain("delete");
  });

  it("preserves a pending row and a different same-name live identity", async () => {
    const pending = {
      ...pendingPackageManagedSandbox("beta", OPENCLAW_PACKAGE),
      createdAt: "2026-08-20T00:00:00.000Z",
      pendingRouteReservation: true as const,
      imageTag: "nemoclaw-alpha:test",
      gatewayName: "nemoclaw",
      lifecycleGeneration: "clone-generation",
      lifecycleLiveIdentityFingerprint: createHash("sha256")
        .update("expected-live-id")
        .digest("hex"),
    };
    const entries = new Map<string, f.SandboxRecord>([
      ["alpha", packageManagedSandbox("alpha", OPENCLAW_PACKAGE)],
      ["beta", pending],
    ]);
    f.getSandboxMock.mockImplementation((name) => entries.get(name ?? "") ?? null);
    f.parseLiveSandboxNamesMock.mockReturnValue(new Set(["alpha", "beta"]));
    f.getLatestBackupMock.mockReturnValue({ ...f.latestBackupFixture });
    f.captureOpenshellMock.mockImplementation((args) =>
      f.openshellResponses(args, {
        "sandbox exec": { status: 0, output: f.dcodeProbeOutput("no-runtime") },
        "sandbox list": { status: 0, output: "alpha Ready\nbeta Ready\n" },
      }),
    );
    const { runSandboxSnapshot } = await import("./snapshot");

    await expect(runSandboxSnapshot("alpha", { kind: "restore", to: "beta" })).rejects.toThrow(
      "different live sandbox identity",
    );

    expect(entries.get("beta")).toEqual(pending);
    expect(f.runOpenshellMock).not.toHaveBeenCalledWith(
      expect.arrayContaining(["sandbox", "delete", "beta"]),
      expect.anything(),
    );
    expect(f.removeSandboxIfCurrentMock).not.toHaveBeenCalled();
    expect(f.removeSandboxRegistryEntryOutcomeMock).not.toHaveBeenCalled();
    expect(f.streamSandboxCreateMock).not.toHaveBeenCalled();
    expect(f.restoreSandboxStateMock).not.toHaveBeenCalled();
  });

  it("blocks a cross-sandbox clone before deleting the target when source policy repair is pending (#7178)", async () => {
    const common = {
      agent: "openclaw",
      harnessPackage: OPENCLAW_PACKAGE,
      harnessPackageMigration: legacyPackageMigration(OPENCLAW_PACKAGE),
      openshellDriver: "docker",
      provider: "nvidia-nim",
      model: "nvidia/model-a",
    };
    f.getSandboxMock.mockImplementation((name) => {
      return name === "alpha"
        ? {
            ...common,
            name: "alpha",
            imageTag: "nemoclaw-alpha:test",
            baselineExclusionTransition: {
              id: "0b2f3297-a9ab-4c2f-80da-bf1760a1afbf",
              operation: "restore",
              exclusion: {
                version: 1 as const,
                agent: "openclaw",
                key: "agents.openclaw.default",
                digest: "a".repeat(64),
              },
              startedAt: "2026-07-19T00:00:00.000Z",
              targetLiveDigest: "b".repeat(64),
            },
          }
        : name === "beta"
          ? { ...common, name: "beta", imageTag: "nemoclaw-beta:test" }
          : null;
    });
    f.parseLiveSandboxNamesMock.mockReturnValue(new Set(["alpha", "beta"]));
    f.captureOpenshellMock.mockImplementation((args) =>
      f.openshellResponses(args, {
        "sandbox exec": { status: 0, output: f.dcodeProbeOutput("no-runtime") },
        "sandbox list": { status: 0, output: "alpha Ready\nbeta Ready\n" },
      }),
    );
    f.getLatestBackupMock.mockReturnValue({ ...f.latestBackupFixture });
    const { runSandboxSnapshot } = await import("./snapshot");

    await expect(
      runSandboxSnapshot("alpha", {
        kind: "restore",
        to: "beta",
        force: true,
        yes: true,
      }),
    ).rejects.toThrow(
      "Cannot clone baseline policy while 'restore agents.openclaw.default' needs repair",
    );

    expect(f.lifecycleMock.events).not.toContain("delete");
    expect(f.streamSandboxCreateMock).not.toHaveBeenCalled();
    expect(f.registerSandboxMock).not.toHaveBeenCalled();
  });

  it("blocks a forced clone before deleting a destination whose policy repair is pending (#7178)", async () => {
    const pendingTransition = {
      id: "0b2f3297-a9ab-4c2f-80da-bf1760a1afbf",
      operation: "restore" as const,
      exclusion: {
        version: 1 as const,
        agent: "openclaw",
        key: "agents.openclaw.default",
        digest: "a".repeat(64),
      },
      startedAt: "2026-07-19T00:00:00.000Z",
      targetLiveDigest: "b".repeat(64),
    };
    f.getSandboxMock.mockImplementation((name) =>
      name
        ? {
            name,
            agent: "openclaw",
            harnessPackage: OPENCLAW_PACKAGE,
            imageTag: `nemoclaw-${name}:test`,
            openshellDriver: "docker",
            provider: "nvidia-nim",
            model: "nvidia/model-a",
            ...(name === "beta" ? { baselineExclusionTransition: pendingTransition } : {}),
          }
        : null,
    );
    f.getLatestBackupMock.mockReturnValue({ ...f.latestBackupFixture });
    f.captureOpenshellMock.mockImplementation((args) =>
      f.openshellResponses(args, {
        "sandbox exec": { status: 0, output: f.dcodeProbeOutput("no-runtime") },
        "sandbox list": { status: 0, output: "alpha Ready\nbeta Ready\n" },
      }),
    );
    const { runSandboxSnapshot } = await import("./snapshot");

    await expect(
      runSandboxSnapshot("alpha", {
        kind: "restore",
        to: "beta",
        force: true,
        yes: true,
      }),
    ).rejects.toMatchObject({ exitCode: 1 });

    expect(f.lifecycleMock.events).not.toContain("delete");
    expect(f.streamSandboxCreateMock).not.toHaveBeenCalled();
    expect(f.registerSandboxMock).not.toHaveBeenCalled();
  });
});
