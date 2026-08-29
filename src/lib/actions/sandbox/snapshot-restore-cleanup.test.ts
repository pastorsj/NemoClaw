// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { withSandboxMutationLock } from "../../state/mcp-lifecycle-lock";
import * as f from "./snapshot-restore-test-fixture";
import {
  HERMES_PACKAGE,
  OPENCLAW_PACKAGE,
  configureCloneRegistry,
  expectSnapshotStateRestore,
  harnessPackage,
  isSandboxGet,
  legacyPackageMigration,
  packageManagedSandbox,
  packageManagedSnapshot,
  runWhen,
} from "./snapshot/lifecycle-fixture";

const tempHomes: string[] = [];
beforeEach(() => {
  f.resetSnapshotRestoreMocks();
});
afterEach(() => {
  f.cleanupSnapshotRestoreMocks();
  for (const tempHome of tempHomes.splice(0)) {
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});
describe("runSandboxSnapshot restore: lifecycle and destination safety", () => {
  it("holds the per-sandbox mutation lock across snapshot creation", async () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-snapshot-create-lock-"));
    tempHomes.push(tempHome);
    vi.stubEnv("HOME", tempHome);
    let releaseLock: (() => void) | undefined;
    let signalLocked: (() => void) | undefined;
    const locked = new Promise<void>((resolve) => {
      signalLocked = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const externalMutation = withSandboxMutationLock("alpha", async () => {
      signalLocked?.();
      await release;
    });
    await locked;
    f.backupSandboxStateMock.mockReturnValue({
      success: true,
      manifest: {
        timestamp: "2026-07-31T00:00:00.000Z",
        backupPath: "/tmp/backup-alpha",
      },
      backedUpDirs: [],
      restoredDirs: [],
      backedUpFiles: [],
      failedDirs: [],
      failedFiles: [],
    });
    f.findBackupMock.mockReturnValue({
      match: {
        snapshotVersion: 4,
        timestamp: "2026-07-31T00:00:00.000Z",
        backupPath: "/tmp/backup-alpha",
      },
    });
    const { runSandboxSnapshot } = await import("./snapshot");

    const create = runSandboxSnapshot("alpha", { kind: "create" });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(f.backupSandboxStateMock).not.toHaveBeenCalled();

    releaseLock?.();
    await externalMutation;
    await create;
    expect(f.backupSandboxStateMock).toHaveBeenCalledWith("alpha", { name: null });
  });

  it("restores the latest snapshot into the source sandbox", async () => {
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    f.getLatestBackupMock.mockReturnValue({
      ...f.latestBackupFixture,
      name: "stable",
    });
    f.getSandboxMock.mockReturnValue(packageManagedSandbox("alpha", OPENCLAW_PACKAGE));
    f.restoreSandboxStateMock.mockReturnValue({
      success: true,
      restoredDirs: ["workspace"],
      restoredFiles: ["user.md"],
      failedDirs: [],
      failedFiles: [],
    });
    const { runSandboxSnapshot } = await import("./snapshot");

    await runSandboxSnapshot("alpha", { kind: "restore" });

    expectSnapshotStateRestore("alpha");
    const output = consoleLog.mock.calls.flat().join("\n");
    expect(output).toContain("Using latest snapshot v4 name=stable");
    expect(output).toContain("Restoring snapshot into 'alpha'");
    expect(output).toContain("Restored 1 directories, 1 files");
  });

  it("rechecks exact target authority after filesystem restore before provider confirmation", async () => {
    const receipt = "host-local-restore-receipt";
    const provenance = {
      schemaVersion: 1 as const,
      origin: "startup-selection" as const,
      runtimeOwnerSandboxName: "alpha",
      transactionId: "d".repeat(64),
      receiptSha256: "e".repeat(64),
    };
    const source: f.SandboxRecord = {
      ...packageManagedSandbox("alpha", OPENCLAW_PACKAGE),
      lifecycleGeneration: "captured-generation",
      lifecycleLiveIdentityFingerprint: createHash("sha256").update("alpha-live-id").digest("hex"),
      hostLocalInferenceReceipt: receipt,
      hostLocalInferenceProvenance: provenance,
    };
    const replacement: f.SandboxRecord = {
      ...source,
      lifecycleGeneration: "replacement-generation",
      lifecycleLiveIdentityFingerprint: "f".repeat(64),
    };
    const entries = new Map<string, f.SandboxRecord>([["alpha", source]]);
    f.getSandboxMock.mockImplementation((name) => entries.get(name ?? "") ?? null);
    f.getLatestBackupMock.mockReturnValue({
      ...packageManagedSnapshot(OPENCLAW_PACKAGE),
      hostLocalInferenceReceipt: receipt,
      hostLocalInferenceProvenance: provenance,
    });
    f.restoreSandboxStateMock.mockImplementation((_name, _backupPath, options) => {
      options?.validateBeforeMutation?.();
      entries.set("alpha", replacement);
      return {
        success: true,
        restoredDirs: ["workspace"],
        restoredFiles: [],
        failedDirs: [],
        failedFiles: [],
      };
    });
    const dependencies = await import("./snapshot/dependencies");
    vi.spyOn(dependencies, "requireCurrentSnapshotRuntimeProvider").mockReturnValue({
      id: "docker",
    } as never);
    vi.spyOn(dependencies, "prepareHostLocalInferenceAuthority").mockImplementation(
      (_provider, candidate, serializedReceipt) =>
        ({
          providerId: "docker",
          sandboxName: candidate.name,
          serializedReceipt,
        }) as never,
    );
    const confirmProviderAuthority = vi
      .spyOn(dependencies, "confirmHostLocalInferenceAuthority")
      .mockImplementation(() => undefined);
    const { runSandboxSnapshot } = await import("./snapshot");

    await expect(runSandboxSnapshot("alpha", { kind: "restore" })).rejects.toMatchObject({
      exitCode: 1,
    });

    expect(entries.get("alpha")).toEqual(replacement);
    expect(confirmProviderAuthority).toHaveBeenCalledOnce();
    expect(f.shieldsMock.repairMutableConfigPermsMock).not.toHaveBeenCalled();
    expect(f.establishRestoredSandboxGatewayPairingMock).not.toHaveBeenCalled();
  });

  it("rechecks live identity between post-filesystem provider mutations", async () => {
    const receipt = "host-local-restore-receipt";
    const provenance = {
      schemaVersion: 1 as const,
      origin: "startup-selection" as const,
      runtimeOwnerSandboxName: "alpha",
      transactionId: "d".repeat(64),
      receiptSha256: "e".repeat(64),
    };
    const source: f.SandboxRecord = {
      ...packageManagedSandbox("alpha", OPENCLAW_PACKAGE),
      lifecycleGeneration: "captured-generation",
      lifecycleLiveIdentityFingerprint: createHash("sha256").update("alpha-live-id").digest("hex"),
      hostLocalInferenceReceipt: receipt,
      hostLocalInferenceProvenance: provenance,
    };
    const replacement: f.SandboxRecord = {
      ...source,
      lifecycleGeneration: "replacement-generation",
      lifecycleLiveIdentityFingerprint: "f".repeat(64),
    };
    const entries = new Map<string, f.SandboxRecord>([["alpha", source]]);
    f.getSandboxMock.mockImplementation((name) => entries.get(name ?? "") ?? null);
    f.getLatestBackupMock.mockReturnValue({
      ...packageManagedSnapshot(OPENCLAW_PACKAGE),
      workload: { kind: "managed-image" },
      runtimeSnapshot: { providerId: "docker" },
      hostLocalInferenceReceipt: receipt,
      hostLocalInferenceProvenance: provenance,
    });
    const dependencies = await import("./snapshot/dependencies");
    vi.spyOn(dependencies, "readManagedSnapshotProfileAuthority").mockReturnValue({
      providerId: "docker",
    } as never);
    vi.spyOn(dependencies, "prepareManagedSnapshotProfileRestore").mockReturnValue({
      providerRestoreAuthority: { providerId: "docker" },
    } as never);
    vi.spyOn(dependencies, "requireCurrentSnapshotRuntimeProvider").mockReturnValue({
      identity: { id: "docker" },
    } as never);
    vi.spyOn(dependencies, "prepareSandboxRuntimeRestore").mockReturnValue({
      phase: "preflighted",
      targetProviderId: "docker",
      targetSandboxName: "alpha",
      source: { providerId: "docker" },
      preflight: {},
      managedProfile: {},
    } as never);
    vi.spyOn(dependencies, "prepareHostLocalInferenceAuthority").mockImplementation(
      (_provider, candidate, serializedReceipt) =>
        ({
          providerId: "docker",
          sandboxName: candidate.name,
          serializedReceipt,
        }) as never,
    );
    let runtimeProviderMutations = 0;
    vi.spyOn(dependencies, "confirmSandboxRuntimeRestore").mockImplementation(
      (_provider, _target, _prepared, options) => {
        options?.validateBeforeMutation?.();
        runtimeProviderMutations += 1;
        entries.set("alpha", replacement);
        return { phase: "validated" } as never;
      },
    );
    let hostLocalProviderMutations = 0;
    vi.spyOn(dependencies, "confirmHostLocalInferenceAuthority").mockImplementation(
      (_provider, _target, _prepared, options) => {
        options?.validateBeforeMutation?.();
        hostLocalProviderMutations += 1;
      },
    );
    const { runSandboxSnapshot } = await import("./snapshot");

    await expect(runSandboxSnapshot("alpha", { kind: "restore" })).rejects.toMatchObject({
      exitCode: 1,
    });

    expect(runtimeProviderMutations).toBe(1);
    expect(hostLocalProviderMutations).toBe(1);
    expect(entries.get("alpha")).toEqual(replacement);
  });

  it("delegates managed and custom-image snapshot restores to the state layer", async () => {
    f.getLatestBackupMock.mockReturnValue({
      ...f.latestBackupFixture,
      name: "stable",
      agentType: "langchain-deepagents-code",
    });
    const { runSandboxSnapshot } = await import("./snapshot");

    const dcodePackage = harnessPackage("langchain-deepagents-code", "c");
    f.getSandboxMock.mockReturnValue(packageManagedSandbox("alpha", dcodePackage));
    await runSandboxSnapshot("alpha", { kind: "restore" });
    expectSnapshotStateRestore("alpha");

    f.getSandboxMock.mockReturnValue({
      ...packageManagedSandbox("alpha", dcodePackage),
      fromDockerfile: "/tmp/Dockerfile",
    });
    await runSandboxSnapshot("alpha", { kind: "restore" });
    expectSnapshotStateRestore("alpha");
    expect(f.restoreSandboxStateMock).toHaveBeenCalledTimes(2);
  });

  it("keeps active-timer restore, permission repair, and policy reconciliation serialized", async () => {
    f.lifecycleMock.readTimerMarkerMock.mockReturnValue({
      pid: 4242,
      sandboxName: "alpha",
      snapshotPath: "/tmp/policy.yaml",
      restoreAt: "2026-06-27T06:00:00.000Z",
      processToken: "a".repeat(32),
    });
    f.getLatestBackupMock.mockReturnValue({
      ...f.latestBackupFixture,
      policyPresets: ["github"],
    });
    f.getSandboxMock.mockReturnValue(packageManagedSandbox("alpha", OPENCLAW_PACKAGE));
    f.restoreSandboxStateMock.mockReturnValue({
      success: true,
      restoredDirs: ["workspace"],
      restoredFiles: ["openclaw.json"],
      failedDirs: [],
      failedFiles: [],
    });
    const { runSandboxSnapshot } = await import("./snapshot");

    await runSandboxSnapshot("alpha", { kind: "restore" });

    expect(f.lifecycleMock.events).toContain("lock:restore sandbox snapshot");
    expectSnapshotStateRestore("alpha");
    expect(f.shieldsMock.repairMutableConfigPermsMock).toHaveBeenCalledWith("alpha");
    expect(f.applyPresetMock).toHaveBeenCalledWith("alpha", "github", {
      nonFatal: true,
      skipRegistryUpdate: true,
    });
  });

  it("hardens an active timer window before force-deleting a restore destination", async () => {
    f.lifecycleMock.readTimerMarkerMock.mockReturnValue({
      pid: 4242,
      sandboxName: "beta",
      snapshotPath: "/tmp/policy.yaml",
      restoreAt: "2026-06-27T06:00:00.000Z",
      processToken: "b".repeat(32),
    });
    const entries = new Map<string, f.SandboxRecord>([
      ["alpha", packageManagedSandbox("alpha", OPENCLAW_PACKAGE)],
      ["beta", packageManagedSandbox("beta", OPENCLAW_PACKAGE)],
    ]);
    configureCloneRegistry(entries.get("alpha")!, entries);
    f.removeSandboxRegistryEntryOutcomeMock.mockImplementation((name) => {
      entries.delete(name);
      return { status: "complete", removed: true };
    });
    f.parseLiveSandboxNamesMock.mockReturnValue(new Set(["alpha", "beta"]));
    f.captureOpenshellMock.mockImplementation((args) =>
      f.openshellResponses(args, {
        "sandbox exec": { status: 0, output: f.dcodeProbeOutput("no-runtime") },
        "sandbox list": { status: 0, output: "alpha Ready\nbeta Ready\n" },
      }),
    );
    f.getLatestBackupMock.mockReturnValue({ ...f.latestBackupFixture });
    f.restoreSandboxStateMock.mockReturnValue({
      success: true,
      restoredDirs: ["workspace"],
      restoredFiles: ["user.md"],
      failedDirs: [],
      failedFiles: [],
    });
    const { runSandboxSnapshot } = await import("./snapshot");

    await runSandboxSnapshot("alpha", {
      kind: "restore",
      to: "beta",
      force: true,
      yes: true,
    });

    expect(f.shieldsMock.shieldsUpMock).toHaveBeenCalledWith("beta", {
      throwOnError: true,
      allowLegacyHermesProtocol: true,
    });
    expect(f.lifecycleMock.events.indexOf("harden")).toBeLessThan(
      f.lifecycleMock.events.indexOf("delete"),
    );
    expect(f.lifecycleMock.events.indexOf("delete")).toBeLessThan(
      f.lifecycleMock.events.indexOf("cleanup-shields"),
    );
    expect(f.streamSandboxCreateMock).toHaveBeenCalled();
    expectSnapshotStateRestore("beta");
  });

  it("pins forced destination proof, cleanup, and clone creation to captured gateways", async () => {
    const destinationGateway = "nemoclaw-18080";
    const entries = new Map<string, f.SandboxRecord>([
      ["alpha", packageManagedSandbox("alpha", OPENCLAW_PACKAGE)],
      [
        "beta",
        {
          ...packageManagedSandbox("beta", OPENCLAW_PACKAGE),
          gatewayName: destinationGateway,
          gatewayPort: 18080,
        },
      ],
    ]);
    configureCloneRegistry(entries.get("alpha")!, entries);
    f.removeSandboxRegistryEntryOutcomeMock.mockImplementation((name) => {
      entries.delete(name);
      return { status: "complete", removed: true };
    });
    f.parseLiveSandboxNamesMock.mockReturnValue(new Set(["alpha", "beta"]));
    f.captureOpenshellMock.mockImplementation((args) =>
      f.openshellResponses(args, {
        "sandbox exec": { status: 0, output: f.dcodeProbeOutput("no-runtime") },
        "sandbox list": { status: 0, output: "alpha Ready\nbeta Ready\n" },
      }),
    );
    f.getLatestBackupMock.mockReturnValue(packageManagedSnapshot(OPENCLAW_PACKAGE));
    const { runSandboxSnapshot } = await import("./snapshot");

    await runSandboxSnapshot("alpha", {
      kind: "restore",
      to: "beta",
      force: true,
      yes: true,
    });

    expect(f.runOpenshellMock).toHaveBeenCalledWith(
      ["gateway", "select", "nemoclaw"],
      expect.anything(),
    );
    expect(f.captureOpenshellMock).toHaveBeenCalledWith(
      ["sandbox", "list", "-g", destinationGateway],
      { ignoreError: true },
    );
    expect(f.captureOpenshellMock).toHaveBeenCalledWith(
      ["sandbox", "get", "-g", destinationGateway, "beta"],
      { ignoreError: true },
    );
    expect(f.runOpenshellMock).toHaveBeenCalledWith(
      ["sandbox", "delete", "-g", destinationGateway, "beta"],
      expect.anything(),
    );
    const providerDeletes = f.runOpenshellMock.mock.calls.filter(
      ([args]) => args[0] === "provider" && args[1] === "delete",
    );
    expect(providerDeletes.length).toBeGreaterThan(0);
    expect(providerDeletes.every(([args]) => args[2] === "-g")).toBe(true);
    expect(providerDeletes.every(([args]) => args[3] === destinationGateway)).toBe(true);
    expect(f.streamSandboxCreateMock.mock.calls[0]?.[1].slice(0, 4)).toEqual([
      "sandbox",
      "create",
      "-g",
      "nemoclaw",
    ]);
  });

  it("force-replaces an OpenClaw destination from a Hermes snapshot under separate package authorities", async () => {
    const entries = new Map<string, f.SandboxRecord>([
      ["alpha", packageManagedSandbox("alpha", HERMES_PACKAGE)],
      ["beta", packageManagedSandbox("beta", OPENCLAW_PACKAGE)],
    ]);
    configureCloneRegistry(entries.get("alpha")!, entries);
    f.removeSandboxRegistryEntryOutcomeMock.mockImplementation((name) => {
      entries.delete(name);
      return { status: "complete", removed: true };
    });
    f.getLatestBackupMock.mockReturnValue(packageManagedSnapshot(HERMES_PACKAGE));
    f.parseLiveSandboxNamesMock.mockReturnValue(new Set(["alpha", "beta"]));
    f.captureOpenshellMock.mockImplementation((args) =>
      f.openshellResponses(args, {
        "sandbox exec": { status: 0, output: f.dcodeProbeOutput("no-runtime") },
        "sandbox list": { status: 0, output: "alpha Ready\nbeta Ready\n" },
      }),
    );
    f.restoreSandboxStateMock.mockImplementation((_name, _backupPath, options) => {
      options.validateBeforeMutation();
      return {
        success: true,
        restoredDirs: ["workspace"],
        restoredFiles: [],
        failedDirs: [],
        failedFiles: [],
      };
    });
    const { runSandboxSnapshot } = await import("./snapshot");

    await runSandboxSnapshot("alpha", {
      kind: "restore",
      to: "beta",
      force: true,
      yes: true,
    });

    expect(f.removeSandboxRegistryEntryIfCurrentOutcomeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "beta",
        agent: "openclaw",
        harnessPackage: OPENCLAW_PACKAGE,
      }),
    );
    expect(entries.get("beta")).toMatchObject({
      name: "beta",
      agent: "hermes",
      harnessPackage: HERMES_PACKAGE,
    });
    expectSnapshotStateRestore("beta");
  });

  it.each([
    {
      label: "an unknown runtime provider",
      destination: {
        name: "beta",
        agent: "openclaw",
        harnessPackage: OPENCLAW_PACKAGE,
        imageTag: "nemoclaw-beta:test",
        openshellDriver: "future-runtime",
        provider: "nvidia-nim",
        model: "nvidia/model-a",
      },
      expected: "is not registered for this operation",
    },
    {
      label: "a mismatched legacy workload receipt",
      destination: {
        name: "beta",
        agent: "openclaw",
        harnessPackage: OPENCLAW_PACKAGE,
        imageTag: "nemoclaw-beta:current",
        openshellDriver: "docker",
        provider: "nvidia-nim",
        model: "nvidia/model-a",
        workload: {
          schemaVersion: 1 as const,
          kind: "legacy-dockerfile" as const,
          reference: "nemoclaw-beta:recorded",
          shared: false as const,
        },
      },
      expected: "could not prove ownership",
    },
  ])(
    "refuses force deletion before every side effect for $label",
    async ({ destination, expected }) => {
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      f.getSandboxMock.mockImplementation((name) =>
        name === "alpha"
          ? packageManagedSandbox("alpha", OPENCLAW_PACKAGE)
          : name === "beta"
            ? destination
            : null,
      );
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
      ).rejects.toMatchObject({ exitCode: 1 });

      expect(consoleError.mock.calls.flat().join("\n")).toContain(expected);
      expect(f.stopNimContainerMock).not.toHaveBeenCalled();
      expect(f.stopNimContainerByNameMock).not.toHaveBeenCalled();
      expect(f.lifecycleMock.events).not.toContain("delete");
      expect(f.lifecycleMock.events).not.toContain("cleanup-shields");
      expect(f.runOpenshellMock).not.toHaveBeenCalledWith(
        expect.arrayContaining(["provider", "delete"]),
        expect.anything(),
      );
      expect(f.streamSandboxCreateMock).not.toHaveBeenCalled();
      expect(f.registerSandboxMock).not.toHaveBeenCalled();
    },
  );

  it("rechecks cleanup authority inside the destination lock before every side effect", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const destination = {
      ...packageManagedSandbox("beta", OPENCLAW_PACKAGE),
      workload: {
        schemaVersion: 1 as const,
        kind: "legacy-dockerfile" as const,
        reference: "nemoclaw-beta:test",
        shared: false as const,
      },
    };
    let lockedDestination = destination;
    const destinationAtLock = new Map<string, typeof destination>([
      [
        "delete snapshot restore destination",
        {
          ...destination,
          workload: {
            ...destination.workload,
            reference: "nemoclaw-beta:changed-owner",
          },
        },
      ],
    ]);
    f.getSandboxMock.mockImplementation((name) =>
      name === "alpha"
        ? packageManagedSandbox("alpha", OPENCLAW_PACKAGE)
        : name === "beta"
          ? lockedDestination
          : null,
    );
    f.lifecycleMock.withTimerBoundMock.mockImplementation((_sandboxName, command, fn) => {
      f.lifecycleMock.events.push(`lock:${command}`);
      lockedDestination = destinationAtLock.get(command) ?? lockedDestination;
      return fn();
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
    ).rejects.toMatchObject({ exitCode: 1 });

    expect(consoleError.mock.calls.flat().join("\n")).toContain("captured registry identity");
    expect(f.stopNimContainerMock).not.toHaveBeenCalled();
    expect(f.stopNimContainerByNameMock).not.toHaveBeenCalled();
    expect(f.lifecycleMock.events).not.toContain("delete");
    expect(f.lifecycleMock.events).not.toContain("cleanup-shields");
    expect(f.runOpenshellMock).not.toHaveBeenCalledWith(
      expect.arrayContaining(["provider", "delete"]),
      expect.anything(),
    );
    expect(f.removeSandboxRegistryEntryOutcomeMock).not.toHaveBeenCalled();
    expect(f.streamSandboxCreateMock).not.toHaveBeenCalled();
    expect(f.registerSandboxMock).not.toHaveBeenCalled();
  });

  it("preserves a forced target replaced by the same package with a new lifecycle", async () => {
    const expectedFingerprint = createHash("sha256").update("beta-live-id").digest("hex");
    const destination: f.SandboxRecord = {
      ...packageManagedSandbox("beta", OPENCLAW_PACKAGE),
      lifecycleGeneration: "captured-generation",
      lifecycleLiveIdentityFingerprint: expectedFingerprint,
    };
    const replacement: f.SandboxRecord = {
      ...destination,
      lifecycleGeneration: "replacement-generation",
      lifecycleLiveIdentityFingerprint: "f".repeat(64),
    };
    const entries = new Map<string, f.SandboxRecord>([
      ["alpha", packageManagedSandbox("alpha", OPENCLAW_PACKAGE)],
      ["beta", destination],
    ]);
    f.getSandboxMock.mockImplementation((name) => entries.get(name ?? "") ?? null);
    f.lifecycleMock.withTimerBoundMock.mockImplementation((_sandboxName, command, fn) => {
      f.lifecycleMock.events.push(`lock:${command}`);
      runWhen(command === "delete snapshot restore destination", () => {
        entries.set("beta", replacement);
      });
      return fn();
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
    ).rejects.toMatchObject({ exitCode: 1 });

    expect(entries.get("beta")).toEqual(replacement);
    expect(f.lifecycleMock.events).not.toContain("delete");
    expect(f.stopNimContainerMock).not.toHaveBeenCalled();
    expect(f.stopNimContainerByNameMock).not.toHaveBeenCalled();
    expect(f.removeSandboxRegistryEntryOutcomeMock).not.toHaveBeenCalled();
    expect(f.streamSandboxCreateMock).not.toHaveBeenCalled();
  });

  it("re-proves a forced target live identity immediately before NIM cleanup", async () => {
    const expectedFingerprint = createHash("sha256").update("beta-live-id").digest("hex");
    const destination: f.SandboxRecord = {
      ...packageManagedSandbox("beta", OPENCLAW_PACKAGE),
      lifecycleGeneration: "captured-generation",
      lifecycleLiveIdentityFingerprint: expectedFingerprint,
    };
    const entries = new Map<string, f.SandboxRecord>([
      ["alpha", packageManagedSandbox("alpha", OPENCLAW_PACKAGE)],
      ["beta", destination],
    ]);
    f.getSandboxMock.mockImplementation((name) => entries.get(name ?? "") ?? null);
    f.parseLiveSandboxNamesMock.mockReturnValue(new Set(["alpha", "beta"]));
    let destinationIdentityReads = 0;
    f.captureOpenshellMock.mockImplementation((args) => {
      const targetIdentityRequested = isSandboxGet(args, "beta");
      destinationIdentityReads += Number(targetIdentityRequested);
      const identity = destinationIdentityReads === 1 ? "beta-live-id" : "replacement-live-id";
      return targetIdentityRequested
        ? f.openshellResponses(args, {
            "sandbox get": {
              status: 0,
              output: `Name: beta\nId: ${identity}\nPhase: Ready\n`,
            },
          })
        : f.openshellResponses(args, {
            "sandbox exec": { status: 0, output: f.dcodeProbeOutput("no-runtime") },
            "sandbox list": { status: 0, output: "alpha Ready\nbeta Ready\n" },
          });
    });
    f.getLatestBackupMock.mockReturnValue({ ...f.latestBackupFixture });
    const { runSandboxSnapshot } = await import("./snapshot");

    await expect(
      runSandboxSnapshot("alpha", {
        kind: "restore",
        to: "beta",
        force: true,
        yes: true,
      }),
    ).rejects.toMatchObject({ exitCode: 1 });

    expect(destinationIdentityReads).toBe(2);
    expect(entries.get("beta")).toEqual(destination);
    expect(f.stopNimContainerMock).not.toHaveBeenCalled();
    expect(f.stopNimContainerByNameMock).not.toHaveBeenCalled();
    expect(f.shieldsMock.shieldsUpMock).not.toHaveBeenCalled();
    expect(f.lifecycleMock.events).not.toContain("delete");
    expect(f.removeSandboxRegistryEntryOutcomeMock).not.toHaveBeenCalled();
  });

  it("keeps an observed legacy live identity continuous through forced cleanup", async () => {
    const destination: f.SandboxRecord = packageManagedSandbox("beta", OPENCLAW_PACKAGE);
    const entries = new Map<string, f.SandboxRecord>([
      ["alpha", packageManagedSandbox("alpha", OPENCLAW_PACKAGE)],
      ["beta", destination],
    ]);
    f.getSandboxMock.mockImplementation((name) => entries.get(name ?? "") ?? null);
    f.parseLiveSandboxNamesMock.mockReturnValue(new Set(["alpha", "beta"]));
    let destinationIdentityReads = 0;
    f.captureOpenshellMock.mockImplementation((args) => {
      const targetIdentityRequested = isSandboxGet(args, "beta");
      destinationIdentityReads += Number(targetIdentityRequested);
      const identity = destinationIdentityReads === 1 ? "legacy-live-id" : "replacement-live-id";
      return targetIdentityRequested
        ? f.openshellResponses(args, {
            "sandbox get": {
              status: 0,
              output: `Name: beta\nId: ${identity}\nPhase: Ready\n`,
            },
          })
        : f.openshellResponses(args, {
            "sandbox exec": { status: 0, output: f.dcodeProbeOutput("no-runtime") },
            "sandbox list": { status: 0, output: "alpha Ready\nbeta Ready\n" },
          });
    });
    f.getLatestBackupMock.mockReturnValue({ ...f.latestBackupFixture });
    const { runSandboxSnapshot } = await import("./snapshot");

    await expect(
      runSandboxSnapshot("alpha", {
        kind: "restore",
        to: "beta",
        force: true,
        yes: true,
      }),
    ).rejects.toMatchObject({ exitCode: 1 });

    expect(destinationIdentityReads).toBe(2);
    expect(entries.get("beta")).toEqual(destination);
    expect(f.stopNimContainerMock).not.toHaveBeenCalled();
    expect(f.stopNimContainerByNameMock).not.toHaveBeenCalled();
    expect(f.shieldsMock.shieldsUpMock).not.toHaveBeenCalled();
    expect(f.lifecycleMock.events).not.toContain("delete");
    expect(f.removeSandboxRegistryEntryOutcomeMock).not.toHaveBeenCalled();
  });

  it("stops after deleting a destination when registry removal loses authority", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const destination = {
      ...packageManagedSandbox("beta", OPENCLAW_PACKAGE),
    };
    f.getSandboxMock.mockImplementation((name) =>
      name === "alpha"
        ? packageManagedSandbox("alpha", OPENCLAW_PACKAGE)
        : name === "beta"
          ? destination
          : null,
    );
    f.parseLiveSandboxNamesMock.mockReturnValue(new Set(["alpha", "beta"]));
    f.captureOpenshellMock.mockImplementation((args) =>
      f.openshellResponses(args, {
        "sandbox exec": { status: 0, output: f.dcodeProbeOutput("no-runtime") },
        "sandbox list": { status: 0, output: "alpha Ready\nbeta Ready\n" },
      }),
    );
    f.getLatestBackupMock.mockReturnValue({ ...f.latestBackupFixture });
    f.removeSandboxRegistryEntryOutcomeMock.mockReturnValue({
      status: "blocked",
      reason: "authority-unproven",
      removed: false,
    });
    const { runSandboxSnapshot } = await import("./snapshot");

    await expect(
      runSandboxSnapshot("alpha", {
        kind: "restore",
        to: "beta",
        force: true,
        yes: true,
      }),
    ).rejects.toMatchObject({ exitCode: 1 });

    expect(f.lifecycleMock.events).toContain("delete");
    expect(f.lifecycleMock.events).toContain("cleanup-shields");
    expect(consoleError.mock.calls.flat().join("\n")).toContain("registry entry was preserved");
    expect(f.getSandboxMock("beta")).toBe(destination);
    expect(f.streamSandboxCreateMock).not.toHaveBeenCalled();
    expect(f.registerSandboxMock).not.toHaveBeenCalled();
    expect(f.restoreSandboxStateMock).not.toHaveBeenCalled();
  });

  it("stops after live deletion when another writer replaces the destination registry row", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const destination = packageManagedSandbox("beta", OPENCLAW_PACKAGE);
    const replacement = {
      ...destination,
      lifecycleGeneration: "replacement-generation",
    };
    let currentDestination = destination;
    f.getSandboxMock.mockImplementation((name) =>
      name === "alpha"
        ? packageManagedSandbox("alpha", OPENCLAW_PACKAGE)
        : name === "beta"
          ? currentDestination
          : null,
    );
    f.parseLiveSandboxNamesMock.mockReturnValue(new Set(["alpha", "beta"]));
    f.captureOpenshellMock.mockImplementation((args) =>
      f.openshellResponses(args, {
        "sandbox exec": { status: 0, output: f.dcodeProbeOutput("no-runtime") },
        "sandbox list": { status: 0, output: "alpha Ready\nbeta Ready\n" },
      }),
    );
    f.getLatestBackupMock.mockReturnValue({ ...f.latestBackupFixture });
    f.removeSandboxRegistryEntryOutcomeMock.mockImplementation(() => {
      currentDestination = replacement;
      return {
        status: "blocked",
        reason: "registry-changed",
        removed: false,
      };
    });
    const { runSandboxSnapshot } = await import("./snapshot");

    await expect(
      runSandboxSnapshot("alpha", {
        kind: "restore",
        to: "beta",
        force: true,
        yes: true,
      }),
    ).rejects.toMatchObject({ exitCode: 1 });

    expect(f.lifecycleMock.events).toContain("delete");
    expect(f.lifecycleMock.events).toContain("cleanup-shields");
    expect(consoleError.mock.calls.flat().join("\n")).toContain(
      "changed after NemoClaw captured the destination ownership row",
    );
    expect(f.getSandboxMock("beta")).toBe(replacement);
    expect(f.streamSandboxCreateMock).not.toHaveBeenCalled();
    expect(f.registerSandboxMock).not.toHaveBeenCalled();
    expect(f.restoreSandboxStateMock).not.toHaveBeenCalled();
  });

  it("blocks auto-create before deleting a destination when a gateway peer conflicts", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    f.getSandboxMock.mockImplementation((name) => ({
      name: name ?? "alpha",
      agent: "openclaw",
      harnessPackage: OPENCLAW_PACKAGE,
      harnessPackageMigration: legacyPackageMigration(OPENCLAW_PACKAGE),
      gatewayName: "nemoclaw",
      imageTag: `nemoclaw-${name}:test`,
      openshellDriver: "docker",
      provider: name === "gamma" ? "anthropic-prod" : "nvidia-nim",
      model: name === "gamma" ? "claude-new" : "nvidia/model-a",
    }));
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
    ).rejects.toMatchObject({ exitCode: 1 });

    expect(consoleError.mock.calls.flat().join("\n")).toContain("gamma");
    expect(f.lifecycleMock.events).not.toContain("delete");
    expect(f.streamSandboxCreateMock).not.toHaveBeenCalled();
    expect(f.registerSandboxMock).not.toHaveBeenCalled();
  });

  it("holds the source and destination mutation locks until a cross-sandbox restore finishes (#7178)", async () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-snapshot-locks-"));
    tempHomes.push(tempHome);
    vi.stubEnv("HOME", tempHome);
    const events: string[] = [];
    let cloneCreated = false;
    let releaseCreate: (() => void) | undefined;
    let signalCreateStarted: (() => void) | undefined;
    const createStarted = new Promise<void>((resolve) => {
      signalCreateStarted = resolve;
    });
    const createRelease = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    configureCloneRegistry(packageManagedSandbox("alpha", OPENCLAW_PACKAGE));
    f.getLatestBackupMock.mockReturnValue({ ...f.latestBackupFixture });
    f.captureOpenshellMock.mockImplementation((args) =>
      f.openshellResponses(args, {
        "sandbox exec": { status: 0, output: f.dcodeProbeOutput("no-runtime") },
        "sandbox list": {
          status: 0,
          output: cloneCreated ? "alpha Ready\nbeta Ready\n" : "alpha Ready\n",
        },
      }),
    );
    f.streamSandboxCreateMock.mockImplementation(async () => {
      events.push("create-started");
      signalCreateStarted?.();
      await createRelease;
      cloneCreated = true;
      events.push("create-released");
      return { status: 0, output: "", sawProgress: false, forcedReady: false };
    });
    f.restoreSandboxStateMock.mockImplementation(() => {
      events.push("snapshot-restored");
      return {
        success: true,
        restoredDirs: ["workspace"],
        restoredFiles: [],
        failedDirs: [],
        failedFiles: [],
      };
    });
    const { runSandboxSnapshot } = await import("./snapshot");

    const restore = runSandboxSnapshot("alpha", { kind: "restore", to: "beta" });
    await createStarted;
    const sourceMutation = withSandboxMutationLock("alpha", () => {
      events.push("source-mutation");
    });
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(events).toEqual(["create-started"]);

    releaseCreate?.();
    await restore;
    await sourceMutation;

    expect(events).toEqual([
      "create-started",
      "create-released",
      "snapshot-restored",
      "source-mutation",
    ]);
  });

  it("proves the clone supervisor is ready before restoring snapshot state (#7818)", async () => {
    const events: string[] = [];
    configureCloneRegistry(packageManagedSandbox("alpha", OPENCLAW_PACKAGE));
    f.getLatestBackupMock.mockReturnValue({ ...f.latestBackupFixture });
    f.captureOpenshellMock.mockImplementation((args) =>
      f.openshellResponses(args, {
        "sandbox exec": { status: 0, output: f.dcodeProbeOutput("no-runtime") },
        "sandbox list": { status: 0, output: "alpha Ready\nbeta Ready\n" },
      }),
    );
    f.streamSandboxCreateMock.mockResolvedValue({
      status: 0,
      output: "Sandbox reported Ready before create stream exited; continuing.",
      sawProgress: true,
      forcedReady: true,
    });
    f.waitForRestoredSandboxGatewaySupervisorMock.mockImplementation(() => {
      events.push("supervisor-ready");
      return true;
    });
    f.restoreSandboxStateMock.mockImplementation(() => {
      events.push("snapshot-restored");
      return {
        success: true,
        restoredDirs: ["workspace"],
        restoredFiles: [],
        failedDirs: [],
        failedFiles: [],
      };
    });
    const { runSandboxSnapshot } = await import("./snapshot");

    await runSandboxSnapshot("alpha", { kind: "restore", to: "beta" });

    expect(f.waitForRestoredSandboxGatewaySupervisorMock).toHaveBeenCalledWith("beta");
    expect(events).toEqual(["supervisor-ready", "snapshot-restored"]);
  });
});
