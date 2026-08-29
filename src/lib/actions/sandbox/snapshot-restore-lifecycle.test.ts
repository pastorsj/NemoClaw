// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { testTimeoutOptions } from "../../../../test/helpers/timeouts";
import { fingerprintSandboxRecreateValue } from "../../onboard/sandbox-recreate-transaction";
import * as f from "./snapshot-restore-test-fixture";
import {
  HERMES_PACKAGE,
  OPENCLAW_PACKAGE,
  candidateSandbox,
  candidateSnapshot,
  configureCloneGateway,
  configureCloneRegistry,
  harnessPackage,
  packageManagedSandbox,
  packageManagedSnapshot,
  packageSnapshotWithCompletionEvidence,
  pendingPackageManagedSandbox,
  runWhen,
  storePendingClone,
} from "./snapshot/lifecycle-fixture";

beforeEach(() => {
  f.resetSnapshotRestoreMocks();
});
afterEach(() => {
  f.cleanupSnapshotRestoreMocks();
});
describe("runSandboxSnapshot restore: lifecycle and destination safety", () => {
  it.each([
    ["schema v1 with explicit false", 1, false, true],
    ["schema v2 with explicit false", 2, false, true],
    ["schema v2 with missing completion", 2, undefined, true],
    ["schema v2 with missing content evidence", 2, true, false],
  ] as const)(
    "rejects $0 before forced destination mutation",
    async (_label, version, backupComplete, includeContentEvidence) => {
      const entries = new Map<string, f.SandboxRecord>([
        ["alpha", packageManagedSandbox("alpha", OPENCLAW_PACKAGE)],
        ["beta", packageManagedSandbox("beta", OPENCLAW_PACKAGE)],
      ]);
      configureCloneRegistry(entries.get("alpha")!, entries);
      f.getLatestBackupMock.mockReturnValue(
        packageSnapshotWithCompletionEvidence(version, backupComplete, includeContentEvidence),
      );
      f.parseLiveSandboxNamesMock.mockReturnValue(new Set(["alpha", "beta"]));
      const { runSandboxSnapshot } = await import("./snapshot");

      await expect(
        runSandboxSnapshot("alpha", {
          kind: "restore",
          to: "beta",
          force: true,
          yes: true,
        }),
      ).rejects.toMatchObject({ exitCode: 1 });

      expect(f.stopNimContainerMock).not.toHaveBeenCalled();
      expect(f.stopNimContainerByNameMock).not.toHaveBeenCalled();
      expect(f.shieldsMock.shieldsUpMock).not.toHaveBeenCalled();
      expect(f.runOpenshellMock.mock.calls).not.toContainEqual([
        expect.arrayContaining(["sandbox", "delete"]),
      ]);
      expect(f.runOpenshellMock.mock.calls).not.toContainEqual([
        expect.arrayContaining(["provider", "delete"]),
      ]);
      expect(f.removeSandboxMock).not.toHaveBeenCalled();
      expect(f.streamSandboxCreateMock).not.toHaveBeenCalled();
      expect(f.restoreSandboxStateMock).not.toHaveBeenCalled();
    },
  );

  it("stops before forced destination mutation when private snapshot preparation fails", async () => {
    const entries = new Map<string, f.SandboxRecord>([
      ["alpha", packageManagedSandbox("alpha", OPENCLAW_PACKAGE)],
      ["beta", packageManagedSandbox("beta", OPENCLAW_PACKAGE)],
    ]);
    configureCloneRegistry(entries.get("alpha")!, entries);
    f.getLatestBackupMock.mockReturnValue(packageManagedSnapshot(OPENCLAW_PACKAGE));
    f.parseLiveSandboxNamesMock.mockReturnValue(new Set(["alpha", "beta"]));
    f.prepareSnapshotRestoreContentMock.mockReturnValue(null);
    const { runSandboxSnapshot } = await import("./snapshot");

    await expect(
      runSandboxSnapshot("alpha", {
        kind: "restore",
        to: "beta",
        force: true,
        yes: true,
      }),
    ).rejects.toMatchObject({ exitCode: 1 });

    expect(f.runOpenshellMock.mock.calls).not.toContainEqual([
      expect.arrayContaining(["sandbox", "delete"]),
    ]);
    expect(f.streamSandboxCreateMock).not.toHaveBeenCalled();
    expect(f.restoreSandboxStateMock).not.toHaveBeenCalled();
    expect(f.preparedSnapshotCleanupMock).not.toHaveBeenCalled();
  });

  it("carries the pre-delete snapshot copy through forced replacement and then removes it", async () => {
    const entries = new Map<string, f.SandboxRecord>([
      ["alpha", packageManagedSandbox("alpha", OPENCLAW_PACKAGE)],
      ["beta", packageManagedSandbox("beta", OPENCLAW_PACKAGE)],
    ]);
    configureCloneRegistry(entries.get("alpha")!, entries);
    f.removeSandboxRegistryEntryOutcomeMock.mockImplementation((name) => {
      entries.delete(name);
      return { status: "complete", removed: true };
    });
    f.getLatestBackupMock.mockReturnValue(packageManagedSnapshot(OPENCLAW_PACKAGE));
    f.parseLiveSandboxNamesMock.mockReturnValue(new Set(["alpha", "beta"]));
    f.captureOpenshellMock.mockImplementation((args) =>
      f.openshellResponses(args, {
        "sandbox exec": { status: 0, output: f.dcodeProbeOutput("no-runtime") },
        "sandbox list": { status: 0, output: "alpha Ready\nbeta Ready\n" },
      }),
    );
    let selectedSnapshotAvailable = true;
    const cleanup = vi.fn();
    const preparedContent = {
      schemaVersion: 1 as const,
      selectedBackupPath: "/tmp/backup-alpha",
      stagedBackupPath: "/tmp/owned-backup-alpha",
      authority: {
        schemaVersion: 1 as const,
        backupPath: "/tmp/backup-alpha",
        contentSha256: "d".repeat(64),
      },
      validate: vi.fn(),
      cleanup,
    };
    f.prepareSnapshotRestoreContentMock.mockImplementation(() => {
      f.lifecycleMock.events.push("prepare-snapshot");
      return preparedContent;
    });
    f.runOpenshellMock.mockImplementation((args) => {
      runWhen(args[0] === "sandbox" && args[1] === "delete", () => {
        f.lifecycleMock.events.push("delete");
        selectedSnapshotAvailable = false;
      });
      return { status: 0, output: "" };
    });
    f.restoreSandboxStateMock.mockImplementation((_name, _backupPath, options) => {
      expect(selectedSnapshotAvailable).toBe(false);
      expect(options.preparedContent).toBe(preparedContent);
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

    expect(f.lifecycleMock.events.indexOf("prepare-snapshot")).toBeLessThan(
      f.lifecycleMock.events.indexOf("delete"),
    );
    expect(f.restoreSandboxStateMock).toHaveBeenCalledWith(
      "beta",
      "/tmp/backup-alpha",
      expect.objectContaining({
        authority: preparedContent.authority,
        preparedContent,
      }),
    );
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("revalidates the prepared snapshot after policy preparation and before destination deletion", async () => {
    const source: f.SandboxRecord = {
      ...packageManagedSandbox("alpha", OPENCLAW_PACKAGE),
      baselineExclusions: [
        {
          version: 1,
          agent: "openclaw",
          key: "legacy-policy",
          digest: "a".repeat(64),
        },
      ],
    };
    const entries = new Map<string, f.SandboxRecord>([
      ["alpha", source],
      ["beta", packageManagedSandbox("beta", OPENCLAW_PACKAGE)],
    ]);
    configureCloneRegistry(entries.get("alpha")!, entries);
    f.getLatestBackupMock.mockReturnValue(packageManagedSnapshot(OPENCLAW_PACKAGE));
    f.parseLiveSandboxNamesMock.mockReturnValue(new Set(["alpha", "beta"]));
    const validate = vi.fn();
    const cleanup = vi.fn();
    let policyPrepared = false;
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
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
    f.prepareInitialSandboxCreatePolicyMock.mockImplementation((policyPath) => {
      policyPrepared = true;
      validate.mockImplementation(() => {
        throw new Error("operation-owned snapshot content changed before lifecycle mutation");
      });
      return { policyPath, appliedPresets: [] };
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

    expect(policyPrepared).toBe(true);
    expect(validate).toHaveBeenCalled();
    expect(consoleError.mock.calls.flat().join("\n")).toContain(
      "operation-owned snapshot content changed before lifecycle mutation",
    );
    expect(f.lifecycleMock.events).not.toContain("delete");
    expect(f.streamSandboxCreateMock).not.toHaveBeenCalled();
    expect(f.restoreSandboxStateMock).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it.each([
    ["self", 2, false],
    ["new destination", 2, undefined],
  ] as const)(
    "keeps manual salvage restore into a $0 available for an incomplete snapshot",
    async (mode, version, backupComplete) => {
      const source = packageManagedSandbox("alpha", OPENCLAW_PACKAGE);
      configureCloneRegistry(source);
      f.getLatestBackupMock.mockReturnValue(
        packageSnapshotWithCompletionEvidence(version, backupComplete),
      );
      runWhen(mode === "new destination", configureCloneGateway);
      const { runSandboxSnapshot } = await import("./snapshot");

      await runSandboxSnapshot(
        "alpha",
        mode === "new destination" ? { kind: "restore", to: "beta" } : { kind: "restore" },
      );

      expect(f.restoreSandboxStateMock).toHaveBeenCalledWith(
        mode === "new destination" ? "beta" : "alpha",
        "/tmp/backup-alpha",
        expect.objectContaining({ validateBeforeMutation: expect.any(Function) }),
      );
    },
  );

  it(
    "revalidates package authority before a self-restore mutates sandbox state",
    testTimeoutOptions(20_000),
    async () => {
      const source = packageManagedSandbox("alpha");
      f.getSandboxMock.mockImplementation((name) => (name === "alpha" ? source : null));
      f.getLatestBackupMock.mockReturnValue(packageManagedSnapshot());
      let stateMutationStarted = false;
      f.restoreSandboxStateMock.mockImplementation((_name, _backupPath, options) => {
        options.validateBeforeMutation();
        stateMutationStarted = true;
        return {
          success: true,
          restoredDirs: ["workspace"],
          restoredFiles: [],
          failedDirs: [],
          failedFiles: [],
        };
      });
      const { runSandboxSnapshot } = await import("./snapshot");

      await runSandboxSnapshot("alpha", { kind: "restore" });

      expect(stateMutationStarted).toBe(true);
      expect(f.restoreSandboxStateMock).toHaveBeenCalledWith(
        "alpha",
        "/tmp/backup-alpha",
        expect.objectContaining({
          agentDefinition: expect.objectContaining({
            name: "hermes",
            packageRoot: `/state/harnesses/objects/${HERMES_PACKAGE.contentDigest}`,
          }),
          authority: expect.objectContaining({ backupPath: "/tmp/backup-alpha" }),
          validateBeforeMutation: expect.any(Function),
        }),
      );
      expect(f.resolvePinnedHarnessPackageMock.mock.calls.map(([identity]) => identity)).toEqual(
        expect.arrayContaining([HERMES_PACKAGE, HERMES_PACKAGE]),
      );
    },
  );

  it("clones the selected package identity and resolves baseline policy from its definition", async () => {
    const entries = new Map<string, f.SandboxRecord>([["alpha", packageManagedSandbox("alpha")]]);
    configureCloneRegistry(entries.get("alpha")!, entries);
    f.removeSandboxMock.mockImplementation((name) => entries.delete(name));
    f.getLatestBackupMock.mockReturnValue(packageManagedSnapshot());
    configureCloneGateway();
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

    await runSandboxSnapshot("alpha", { kind: "restore", to: "beta" });

    const pendingClone = f.registerSandboxMock.mock.calls[0]?.[0];
    expect(pendingClone).toMatchObject({
      name: "beta",
      agent: "hermes",
      harnessPackage: HERMES_PACKAGE,
      snapshotSourceRegistryFingerprint: fingerprintSandboxRecreateValue(entries.get("alpha")!),
    });
    expect(f.resolveAgentDefinitionBaselinePolicyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "hermes",
        packageRoot: `/state/harnesses/objects/${HERMES_PACKAGE.contentDigest}`,
        policyAdditionsPath: `/state/harnesses/objects/${HERMES_PACKAGE.contentDigest}/policy-additions.yaml`,
      }),
    );
    expect(f.resolveAgentBaselinePolicyMock).not.toHaveBeenCalled();
    expect(f.loadAgentMock).not.toHaveBeenCalled();
    expect(f.restoreSandboxStateMock).toHaveBeenCalledWith(
      "beta",
      "/tmp/backup-alpha",
      expect.objectContaining({ validateBeforeMutation: expect.any(Function) }),
    );
    expect(entries.get("beta")?.harnessPackage).toEqual(HERMES_PACKAGE);
  });

  it.each(["source registry", "target registry", "retained object"] as const)(
    "stops a forced package restore before destructive work when the %s changes",
    async (changedAuthority) => {
      const changedPackage = {
        ...HERMES_PACKAGE,
        contentDigest: "e".repeat(64),
      };
      const entries = new Map<string, f.SandboxRecord>([
        [
          "alpha",
          {
            ...packageManagedSandbox("alpha"),
            baselineExclusions: [
              {
                version: 1,
                agent: "hermes",
                key: "network_policies.hermes",
                digest: "f".repeat(64),
              },
            ],
          },
        ],
        ["beta", packageManagedSandbox("beta")],
      ]);
      f.getSandboxMock.mockImplementation((name) => entries.get(name ?? "") ?? null);
      f.getLatestBackupMock.mockReturnValue(packageManagedSnapshot());
      f.parseLiveSandboxNamesMock.mockReturnValue(new Set(["alpha", "beta"]));
      f.captureOpenshellMock.mockImplementation((args) =>
        f.openshellResponses(args, {
          "sandbox exec": { status: 0, output: f.dcodeProbeOutput("no-runtime") },
          "sandbox list": { status: 0, output: "alpha Ready\nbeta Ready\n" },
        }),
      );
      f.lifecycleMock.readTimerMarkerMock.mockReturnValue({
        pid: 4242,
        sandboxName: "beta",
        snapshotPath: "/tmp/policy.yaml",
        restoreAt: "2026-08-20T06:00:00.000Z",
        processToken: "b".repeat(32),
      });
      const resolvePinnedPackage = f.resolvePinnedHarnessPackageMock.getMockImplementation();
      let retainedObjectAvailable = true;
      f.resolvePinnedHarnessPackageMock.mockImplementation((identity) => {
        return retainedObjectAvailable
          ? resolvePinnedPackage!(identity)
          : (() => {
              throw new Error("retained object changed");
            })();
      });
      f.captureSnapshotRestoreAuthorityMock.mockImplementation(() => {
        const mutateAuthority = {
          "source registry": () =>
            entries.set("alpha", packageManagedSandbox("alpha", changedPackage)),
          "target registry": () =>
            entries.set("beta", packageManagedSandbox("beta", changedPackage)),
          "retained object": () => {
            retainedObjectAvailable = false;
          },
        } satisfies Record<typeof changedAuthority, () => unknown>;
        mutateAuthority[changedAuthority]();
        return {
          schemaVersion: 1,
          backupPath: "/tmp/backup-alpha",
          contentSha256: "a".repeat(64),
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
      ).rejects.toThrow();

      expect(f.shieldsMock.shieldsUpMock).not.toHaveBeenCalled();
      expect(f.lifecycleMock.events).not.toContain("delete");
      expect(f.prepareInitialSandboxCreatePolicyMock).not.toHaveBeenCalled();
      expect(f.streamSandboxCreateMock).not.toHaveBeenCalled();
      expect(f.registerSandboxMock).not.toHaveBeenCalled();
      expect(f.restoreSandboxStateMock).not.toHaveBeenCalled();
    },
  );

  it("does not delete a forced destination when its package changes during gateway verification", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const changedPackage = { ...OPENCLAW_PACKAGE, contentDigest: "c".repeat(64) };
    const entries = new Map<string, f.SandboxRecord>([
      ["alpha", packageManagedSandbox("alpha", OPENCLAW_PACKAGE)],
      ["beta", packageManagedSandbox("beta", OPENCLAW_PACKAGE)],
    ]);
    configureCloneRegistry(entries.get("alpha")!, entries);
    f.getLatestBackupMock.mockReturnValue(packageManagedSnapshot(OPENCLAW_PACKAGE));
    f.lifecycleMock.readTimerMarkerMock.mockReturnValue({ sandboxName: "beta" });
    f.captureOpenshellMock.mockImplementation((args) =>
      f.openshellResponses(args, {
        "sandbox exec": { status: 0, output: f.dcodeProbeOutput("no-runtime") },
        "sandbox list": { status: 0, output: "alpha Ready\nbeta Ready\n" },
      }),
    );
    let liveSandboxParses = 0;
    f.parseLiveSandboxNamesMock.mockImplementation(() => {
      liveSandboxParses += 1;
      runWhen(liveSandboxParses === 2, () => {
        entries.set("beta", packageManagedSandbox("beta", changedPackage));
      });
      return new Set(["alpha", "beta"]);
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

    expect(liveSandboxParses).toBe(2);
    expect(entries.get("beta")?.harnessPackage).toEqual(changedPackage);
    expect(f.stopNimContainerMock).not.toHaveBeenCalled();
    expect(f.stopNimContainerByNameMock).not.toHaveBeenCalled();
    expect(f.shieldsMock.shieldsUpMock).not.toHaveBeenCalled();
    expect(f.lifecycleMock.events).not.toContain("delete");
    expect(f.streamSandboxCreateMock).not.toHaveBeenCalled();
  });

  it("does not delete a forced destination when a non-package source field changes after policy preparation", async () => {
    const source = packageManagedSandbox("alpha", OPENCLAW_PACKAGE);
    const entries = new Map<string, f.SandboxRecord>([
      ["alpha", source],
      ["beta", packageManagedSandbox("beta", OPENCLAW_PACKAGE)],
    ]);
    configureCloneRegistry(source, entries);
    f.getLatestBackupMock.mockReturnValue(packageManagedSnapshot(OPENCLAW_PACKAGE));
    f.parseLiveSandboxNamesMock.mockReturnValue(new Set(["alpha", "beta"]));
    f.captureOpenshellMock.mockImplementation((args) =>
      f.openshellResponses(args, {
        "sandbox exec": { status: 0, output: f.dcodeProbeOutput("no-runtime") },
        "sandbox list": { status: 0, output: "alpha Ready\nbeta Ready\n" },
      }),
    );
    f.resolveAgentDefinitionBaselinePolicyMock.mockImplementation((agent) => {
      entries.set("alpha", { ...source, imageTag: "nemoclaw-alpha:replacement" });
      return {
        agent: agent.name,
        policyPath: agent.policyAdditionsPath ?? "/repo/openclaw-policy.yaml",
        content: "version: 1\nnetwork_policies: {}\n",
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

    expect(entries.get("alpha")?.imageTag).toBe("nemoclaw-alpha:replacement");
    expect(entries.has("beta")).toBe(true);
    expect(f.lifecycleMock.events).not.toContain("delete");
    expect(f.streamSandboxCreateMock).not.toHaveBeenCalled();
    expect(f.registerSandboxMock).not.toHaveBeenCalled();
    expect(f.restoreSandboxStateMock).not.toHaveBeenCalled();
  });

  it("does not clean up a forced destination after candidate qualification is lost", async () => {
    const entries = new Map<string, f.SandboxRecord>([
      ["alpha", candidateSandbox("alpha")],
      ["beta", candidateSandbox("beta")],
    ]);
    let candidateSelectable = true;
    f.loadAgentMock.mockImplementation((name) => {
      runWhen(name === "pi" && !candidateSelectable, () => {
        throw new Error("candidate qualification was withdrawn");
      });
      return {
        name,
        packageRoot: `/repo/agents/${name}`,
        policyAdditionsPath: `/repo/agents/${name}/policy-additions.yaml`,
      };
    });
    f.getSandboxMock.mockImplementation((name) => entries.get(name ?? "") ?? null);
    f.getLatestBackupMock.mockReturnValue(candidateSnapshot());
    f.lifecycleMock.readTimerMarkerMock.mockReturnValue({ sandboxName: "beta" });
    f.captureOpenshellMock.mockImplementation((args) =>
      f.openshellResponses(args, {
        "sandbox exec": { status: 0, output: f.dcodeProbeOutput("no-runtime") },
        "sandbox list": { status: 0, output: "alpha Ready\nbeta Ready\n" },
      }),
    );
    let liveSandboxParses = 0;
    f.parseLiveSandboxNamesMock.mockImplementation(() => {
      liveSandboxParses += 1;
      runWhen(liveSandboxParses === 2, () => {
        candidateSelectable = false;
      });
      return new Set(["alpha", "beta"]);
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

    expect(liveSandboxParses).toBe(2);
    expect(f.stopNimContainerMock).not.toHaveBeenCalled();
    expect(f.stopNimContainerByNameMock).not.toHaveBeenCalled();
    expect(f.shieldsMock.shieldsUpMock).not.toHaveBeenCalled();
    expect(f.lifecycleMock.events).not.toContain("delete");
    expect(f.streamSandboxCreateMock).not.toHaveBeenCalled();
  });

  it("does not clean up a forced destination after its candidate definition changes", async () => {
    const entries = new Map<string, f.SandboxRecord>([
      ["alpha", candidateSandbox("alpha")],
      ["beta", candidateSandbox("beta")],
    ]);
    let definitionChanged = false;
    f.loadAgentMock.mockImplementation((name) => ({
      name,
      packageRoot: `/repo/agents/${name}`,
      policyAdditionsPath: `/repo/agents/${name}/policy-additions.yaml`,
      stateFiles: definitionChanged ? [{ path: "different.json", strategy: "copy" as const }] : [],
    }));
    f.getSandboxMock.mockImplementation((name) => entries.get(name ?? "") ?? null);
    f.getLatestBackupMock.mockReturnValue(candidateSnapshot());
    f.lifecycleMock.readTimerMarkerMock.mockReturnValue({ sandboxName: "beta" });
    f.captureOpenshellMock.mockImplementation((args) =>
      f.openshellResponses(args, {
        "sandbox exec": { status: 0, output: f.dcodeProbeOutput("no-runtime") },
        "sandbox list": { status: 0, output: "alpha Ready\nbeta Ready\n" },
      }),
    );
    let liveSandboxParses = 0;
    f.parseLiveSandboxNamesMock.mockImplementation(() => {
      liveSandboxParses += 1;
      runWhen(liveSandboxParses === 2, () => {
        definitionChanged = true;
      });
      return new Set(["alpha", "beta"]);
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

    expect(liveSandboxParses).toBe(2);
    expect(f.stopNimContainerMock).not.toHaveBeenCalled();
    expect(f.stopNimContainerByNameMock).not.toHaveBeenCalled();
    expect(f.shieldsMock.shieldsUpMock).not.toHaveBeenCalled();
    expect(f.lifecycleMock.events).not.toContain("delete");
    expect(f.streamSandboxCreateMock).not.toHaveBeenCalled();
  });

  it("carries the candidate definition selected inside clone locks through final restore", async () => {
    const source = candidateSandbox("alpha");
    const entries = configureCloneRegistry(source);
    let definitionSelections = 0;
    f.loadAgentMock.mockImplementation((name) => {
      definitionSelections += 1;
      return {
        name,
        packageRoot: `/repo/agents/${name}`,
        policyAdditionsPath: `/repo/agents/${name}/policy-additions.yaml`,
        stateFiles: [
          {
            path: definitionSelections === 1 ? "outer-selection.json" : "locked-selection.json",
            strategy: "copy" as const,
          },
        ],
      };
    });
    f.getLatestBackupMock.mockReturnValue(candidateSnapshot());
    configureCloneGateway();
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

    await runSandboxSnapshot("alpha", { kind: "restore", to: "beta" });

    expect(definitionSelections).toBeGreaterThan(2);
    expect(f.resolveAgentDefinitionBaselinePolicyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        stateFiles: [{ path: "locked-selection.json", strategy: "copy" }],
      }),
    );
    expect(f.restoreSandboxStateMock).toHaveBeenCalledWith(
      "beta",
      "/tmp/backup-alpha",
      expect.objectContaining({
        agentDefinition: expect.objectContaining({
          stateFiles: [{ path: "locked-selection.json", strategy: "copy" }],
        }),
      }),
    );
    expect(entries.get("beta")).toMatchObject({ name: "beta", agent: "pi" });
  });

  it("does not create a candidate clone after its same-root definition changes", async () => {
    const source = candidateSandbox("alpha");
    const entries = configureCloneRegistry(source);
    let definitionChanged = false;
    f.loadAgentMock.mockImplementation((name) => ({
      name,
      packageRoot: `/repo/agents/${name}`,
      policyAdditionsPath: `/repo/agents/${name}/policy-additions.yaml`,
      stateFiles: definitionChanged ? [{ path: "different.json", strategy: "copy" as const }] : [],
    }));
    f.resolveAgentDefinitionBaselinePolicyMock.mockImplementation((agent) => {
      definitionChanged = true;
      return {
        agent: agent.name,
        policyPath: agent.policyAdditionsPath ?? "/repo/openclaw-policy.yaml",
        content: "version: 1\nnetwork_policies: {}\n",
      };
    });
    f.getLatestBackupMock.mockReturnValue(candidateSnapshot());
    configureCloneGateway();
    const { runSandboxSnapshot } = await import("./snapshot");

    await expect(
      runSandboxSnapshot("alpha", { kind: "restore", to: "beta" }),
    ).rejects.toMatchObject({ exitCode: 1 });

    expect(definitionChanged).toBe(true);
    expect(entries.has("beta")).toBe(false);
    expect(f.streamSandboxCreateMock).not.toHaveBeenCalled();
    expect(f.registerSandboxMock).not.toHaveBeenCalled();
  });

  it("does not finalize a candidate clone after its same-root definition changes", async () => {
    const source = candidateSandbox("alpha");
    const entries = configureCloneRegistry(source);
    let definitionChanged = false;
    f.loadAgentMock.mockImplementation((name) => ({
      name,
      packageRoot: `/repo/agents/${name}`,
      policyAdditionsPath: `/repo/agents/${name}/policy-additions.yaml`,
      stateFiles: definitionChanged ? [{ path: "different.json", strategy: "copy" as const }] : [],
    }));
    let pendingTargetReads = 0;
    f.getSandboxMock.mockImplementation((name) => {
      const current = entries.get(name ?? "") ?? null;
      runWhen(name === "beta" && current?.pendingRouteReservation === true, () => {
        pendingTargetReads += 1;
        runWhen(pendingTargetReads === 2, () => {
          definitionChanged = true;
        });
      });
      return current;
    });
    f.getLatestBackupMock.mockReturnValue(candidateSnapshot());
    configureCloneGateway();
    const { runSandboxSnapshot } = await import("./snapshot");

    await expect(
      runSandboxSnapshot("alpha", { kind: "restore", to: "beta" }),
    ).rejects.toMatchObject({ exitCode: 1 });

    expect(definitionChanged).toBe(true);
    expect(pendingTargetReads).toBe(2);
    expect(entries.get("beta")?.pendingRouteReservation).toBe(true);
    expect(f.streamSandboxCreateMock).toHaveBeenCalledOnce();
    expect(f.registerSandboxMock).toHaveBeenCalledOnce();
    expect(f.finalizePendingSandboxRegistrationMock).not.toHaveBeenCalled();
    expect(f.restoreSandboxStateMock).not.toHaveBeenCalled();
  });

  it("does not delete a pending clone when its package changes during gateway reconciliation", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const changedPackage = { ...OPENCLAW_PACKAGE, contentDigest: "c".repeat(64) };
    const entries = new Map<string, f.SandboxRecord>([
      ["alpha", packageManagedSandbox("alpha", OPENCLAW_PACKAGE)],
      [
        "beta",
        {
          ...pendingPackageManagedSandbox("beta", OPENCLAW_PACKAGE),
          pendingRouteReservation: true,
          createdAt: "2026-08-20T00:00:00.000Z",
          imageTag: "nemoclaw-alpha:test",
          gatewayName: "nemoclaw",
          lifecycleGeneration: "clone-generation",
          lifecycleLiveIdentityFingerprint: createHash("sha256")
            .update("expected-live-id")
            .digest("hex"),
        },
      ],
    ]);
    f.getSandboxMock.mockImplementation((name) => entries.get(name ?? "") ?? null);
    f.getLatestBackupMock.mockReturnValue(packageManagedSnapshot(OPENCLAW_PACKAGE));
    f.captureOpenshellMock.mockImplementation((args) =>
      f.openshellResponses(args, {
        "sandbox exec": { status: 0, output: f.dcodeProbeOutput("no-runtime") },
        "sandbox list": { status: 0, output: "alpha Ready\n" },
      }),
    );
    let liveSandboxParses = 0;
    f.parseLiveSandboxNamesMock.mockImplementation(() => {
      liveSandboxParses += 1;
      runWhen(liveSandboxParses === 2, () => {
        entries.set("beta", { ...entries.get("beta")!, harnessPackage: changedPackage });
      });
      return liveSandboxParses === 1 ? new Set(["alpha", "beta"]) : new Set(["alpha"]);
    });
    const { runSandboxSnapshot } = await import("./snapshot");

    await expect(
      runSandboxSnapshot("alpha", { kind: "restore", to: "beta" }),
    ).rejects.toMatchObject({ exitCode: 1 });

    expect(liveSandboxParses).toBe(2);
    expect(entries.get("beta")?.harnessPackage).toEqual(changedPackage);
    expect(f.lifecycleMock.events).not.toContain("delete");
    expect(f.streamSandboxCreateMock).not.toHaveBeenCalled();
  });

  it("does not create a clone when the source package changes during route reservation", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const changedPackage = { ...OPENCLAW_PACKAGE, contentDigest: "c".repeat(64) };
    const source: f.SandboxRecord = {
      ...packageManagedSandbox("alpha", OPENCLAW_PACKAGE),
      gatewayName: "nemoclaw",
      gatewayPort: 18080,
      hostLocalInferenceReceipt: "host-local-receipt",
      hostLocalInferenceProvenance: {
        schemaVersion: 1,
        origin: "startup-selection",
        runtimeOwnerSandboxName: "alpha",
        transactionId: "d".repeat(64),
        receiptSha256: "e".repeat(64),
      },
    };
    const entries = new Map<string, f.SandboxRecord>([["alpha", source]]);
    configureCloneRegistry(source, entries);
    f.getLatestBackupMock.mockReturnValue(packageManagedSnapshot(OPENCLAW_PACKAGE));
    configureCloneGateway();
    f.reserveSandboxInferenceRouteMock.mockImplementation((name, route) => {
      entries.set(name, {
        ...(route as Partial<f.SandboxRecord>),
        name,
        pendingRouteReservation: true,
      });
      entries.set("alpha", { ...source, harnessPackage: changedPackage });
      return true;
    });
    const { runSandboxSnapshot } = await import("./snapshot");

    await expect(
      runSandboxSnapshot("alpha", { kind: "restore", to: "beta" }),
    ).rejects.toMatchObject({ exitCode: 1 });

    expect(f.reserveSandboxInferenceRouteMock).toHaveBeenCalledOnce();
    expect(consoleError.mock.calls.flat().join("\n")).toContain(
      "Snapshot package authority changed at clone creation",
    );
    expect(f.streamSandboxCreateMock).not.toHaveBeenCalled();
    expect(f.registerSandboxMock).not.toHaveBeenCalled();
  });

  it("preserves a changed host-local route row when clone setup releases its reservation", async () => {
    const source: f.SandboxRecord = {
      ...packageManagedSandbox("alpha", OPENCLAW_PACKAGE),
      gatewayName: "nemoclaw",
      gatewayPort: 18080,
      hostLocalInferenceReceipt: "host-local-receipt",
      hostLocalInferenceProvenance: {
        schemaVersion: 1,
        origin: "startup-selection",
        runtimeOwnerSandboxName: "alpha",
        transactionId: "d".repeat(64),
        receiptSha256: "e".repeat(64),
      },
    };
    const entries = new Map<string, f.SandboxRecord>([["alpha", source]]);
    configureCloneRegistry(source, entries);
    let changedRoute: f.SandboxRecord | null = null;
    f.reserveSandboxInferenceRouteMock.mockImplementation((name, route) => {
      entries.set(name, {
        name,
        pendingRouteReservation: true,
        ...(route as Partial<f.SandboxRecord>),
      });
      return true;
    });
    let capturedReservation = false;
    f.getSandboxMock.mockImplementation((name) => {
      const current = entries.get(name ?? "") ?? null;
      runWhen(
        name === "beta" && current?.pendingRouteReservation === true && !capturedReservation,
        () => {
          capturedReservation = true;
          const replacementRoute = { ...current!, gatewayPort: 18081 };
          changedRoute = replacementRoute;
          entries.set("beta", replacementRoute);
        },
      );
      return current;
    });
    f.getLatestBackupMock.mockReturnValue(packageManagedSnapshot(OPENCLAW_PACKAGE));
    configureCloneGateway();
    const { runSandboxSnapshot } = await import("./snapshot");

    await expect(
      runSandboxSnapshot("alpha", { kind: "restore", to: "beta" }),
    ).rejects.toMatchObject({ exitCode: 1 });

    expect(f.removeSandboxRouteReservationIfCurrentMock).toHaveBeenCalledWith(
      expect.objectContaining({ name: "beta", gatewayPort: 18080 }),
    );
    expect(entries.get("beta")).toEqual(changedRoute);
    expect(f.streamSandboxCreateMock).not.toHaveBeenCalled();
    expect(f.registerSandboxMock).not.toHaveBeenCalled();
  });

  it("does not publish a pending clone when the source package changes during creation", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const changedPackage = { ...OPENCLAW_PACKAGE, contentDigest: "c".repeat(64) };
    const entries = new Map<string, f.SandboxRecord>([
      ["alpha", packageManagedSandbox("alpha", OPENCLAW_PACKAGE)],
    ]);
    f.getSandboxMock.mockImplementation((name) => entries.get(name ?? "") ?? null);
    f.getLatestBackupMock.mockReturnValue(packageManagedSnapshot(OPENCLAW_PACKAGE));
    configureCloneGateway(() => {
      entries.set("alpha", packageManagedSandbox("alpha", changedPackage));
    });
    const { runSandboxSnapshot } = await import("./snapshot");

    await expect(
      runSandboxSnapshot("alpha", { kind: "restore", to: "beta" }),
    ).rejects.toMatchObject({ exitCode: 1 });

    expect(consoleError.mock.calls.flat().join("\n")).toContain(
      "Snapshot package authority changed at clone creation",
    );
    expect(f.streamSandboxCreateMock).toHaveBeenCalledOnce();
    expect(f.registerSandboxMock).not.toHaveBeenCalled();
    expect(f.finalizePendingSandboxRegistrationMock).not.toHaveBeenCalled();
    expect(f.restoreSandboxStateMock).not.toHaveBeenCalled();
  });

  it("does not publish over a foreign same-package row created during clone publication", async () => {
    const entries = new Map<string, f.SandboxRecord>([
      ["alpha", packageManagedSandbox("alpha", OPENCLAW_PACKAGE)],
    ]);
    configureCloneRegistry(entries.get("alpha")!, entries);
    let foreignRow: f.SandboxRecord | null = null;
    f.registerSandboxMock.mockImplementation((entry, _route, options = {}) => {
      const insertedForeignRow: f.SandboxRecord = {
        ...entry,
        createdAt: "2026-08-29T00:00:00.000Z",
        lifecycleGeneration: "foreign-generation",
        lifecycleLiveIdentityFingerprint: "f".repeat(64),
      };
      foreignRow = insertedForeignRow;
      entries.set(entry.name, insertedForeignRow);
      const current = entries.get(entry.name) ?? null;
      runWhen(
        Object.prototype.hasOwnProperty.call(options, "expectedCurrent") &&
          !isDeepStrictEqual(current, options.expectedCurrent ?? null),
        () => {
          throw new Error("foreign same-package row won publication race");
        },
      );
      return storePendingClone(entries, entry);
    });
    f.getLatestBackupMock.mockReturnValue(packageManagedSnapshot(OPENCLAW_PACKAGE));
    configureCloneGateway();
    const { runSandboxSnapshot } = await import("./snapshot");

    await expect(
      runSandboxSnapshot("alpha", { kind: "restore", to: "beta" }),
    ).rejects.toMatchObject({ exitCode: 1 });

    expect(f.registerSandboxMock).toHaveBeenCalledWith(
      expect.objectContaining({ name: "beta", harnessPackage: OPENCLAW_PACKAGE }),
      undefined,
      { pending: true, expectedCurrent: null },
    );
    expect(entries.get("beta")).toEqual(foreignRow);
    expect(f.finalizePendingSandboxRegistrationMock).not.toHaveBeenCalled();
    expect(f.removeSandboxRouteReservationIfCurrentMock).not.toHaveBeenCalled();
    expect(f.restoreSandboxStateMock).not.toHaveBeenCalled();
  });

  it("does not finalize a pending clone when the source package changes during supervisor proof", async () => {
    const changedPackage = { ...OPENCLAW_PACKAGE, contentDigest: "c".repeat(64) };
    const entries = new Map<string, f.SandboxRecord>([
      ["alpha", packageManagedSandbox("alpha", OPENCLAW_PACKAGE)],
    ]);
    configureCloneRegistry(entries.get("alpha")!, entries);
    f.getLatestBackupMock.mockReturnValue(packageManagedSnapshot(OPENCLAW_PACKAGE));
    configureCloneGateway();
    f.waitForRestoredSandboxGatewaySupervisorMock.mockImplementation(() => {
      entries.set("alpha", packageManagedSandbox("alpha", changedPackage));
      return true;
    });
    const { runSandboxSnapshot } = await import("./snapshot");

    await expect(
      runSandboxSnapshot("alpha", { kind: "restore", to: "beta" }),
    ).rejects.toMatchObject({ exitCode: 1 });

    expect(f.registerSandboxMock).toHaveBeenCalledOnce();
    expect(f.finalizePendingSandboxRegistrationMock).not.toHaveBeenCalled();
    expect(entries.get("beta")?.harnessPackage).toEqual(OPENCLAW_PACKAGE);
    expect(f.registerSandboxMock).toHaveBeenCalledWith(
      expect.objectContaining({ name: "beta", harnessPackage: OPENCLAW_PACKAGE }),
      undefined,
      { pending: true, expectedCurrent: null },
    );
    expect(f.restoreSandboxStateMock).not.toHaveBeenCalled();
  });
});
