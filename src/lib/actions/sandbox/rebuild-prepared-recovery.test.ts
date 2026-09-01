// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";
import { expectNoSandboxDelete } from "../../../../test/helpers/rebuild-delete-assertions";
import { restoreEnv } from "../../../../test/helpers/env-test-helpers";
import {
  createRebuildFlowHarness,
  installRebuildFlowTestHooks,
  makePreparedRecoveryManifest,
} from "../../../../test/helpers/rebuild-flow-dcode-harness";
import { makeRebuildAgentAuthority } from "./rebuild-flow-test-fixtures";
import {
  installRebuildHarnessPackage,
  registryPersistence,
  sandboxAgent,
  sandboxState,
} from "../../../../test/helpers/rebuild-flow-harness";
import { createHarnessPackageFixture } from "../../../../test/helpers/harness-packages";

const LEGACY_OPENCLAW_MIGRATION = {
  schemaVersion: 1 as const,
  source: "legacy-current-bundle" as const,
  legacyAgent: null,
  migratedAt: "2026-08-28T05:00:00.000Z",
};

type RebuildFlowOverrides = NonNullable<Parameters<typeof createRebuildFlowHarness>[0]>;

function createPreparedRecoveryHarness(overrides: RebuildFlowOverrides = {}) {
  return createRebuildFlowHarness({
    ...overrides,
    sandboxEntry: {
      harnessPackageMigration: LEGACY_OPENCLAW_MIGRATION,
      ...(overrides.sandboxEntry ?? {}),
    },
  });
}

function schemaV2RecoveryManifest(
  harnessPackage: NonNullable<ReturnType<typeof installRebuildHarnessPackage>>,
) {
  return {
    ...makePreparedRecoveryManifest(),
    version: 2,
    harnessPackage,
    backupComplete: true,
  };
}

function harnessStoreRoot(): string {
  assert.ok(process.env.HOME, "rebuild test HOME is required");
  return path.join(process.env.HOME, ".nemoclaw", "harnesses");
}

describe("prepared rebuild recovery", () => {
  installRebuildFlowTestHooks({ acceptThirdPartySoftware: true });

  it("restores the validated pre-upgrade manifest without taking a second backup (#6114)", async () => {
    const harness = createPreparedRecoveryHarness({
      applyPreset: () => true,
      sandboxInventory: {
        sandboxes: [{ name: "alpha", phase: "Error", readiness: "terminal" }],
      },
      sandboxEntry: { harnessPackageMigration: LEGACY_OPENCLAW_MIGRATION },
    });
    const recoveryManifest = makePreparedRecoveryManifest();

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], {
        throwOnError: true,
        recoveryManifest,
      }),
    ).resolves.toBeUndefined();

    expect(harness.backupSandboxStateSpy).not.toHaveBeenCalled();
    expect(harness.preflightAuthoritativeRebuildTargetSpy).toHaveBeenCalledWith(
      expect.objectContaining({ deferInferenceRouteUntilOnboard: true }),
    );
    expect(harness.runOpenshellSpy).toHaveBeenCalledWith(
      ["sandbox", "delete", "-g", "nemoclaw", "alpha"],
      expect.objectContaining({ ignoreError: true }),
    );
    expect(harness.restoreSandboxStateSpy).toHaveBeenCalledWith(
      "alpha",
      recoveryManifest.backupPath,
      expect.objectContaining({ targetAgentType: "openclaw" }),
    );
    expect(sandboxState.validateRebuildRecoveryManifest).toHaveBeenCalledTimes(5);
    const expectedRecovery = expect.objectContaining({
      sandboxName: recoveryManifest.sandboxName,
      timestamp: recoveryManifest.timestamp,
      backupPath: recoveryManifest.backupPath,
    });
    expect(sandboxState.validateRebuildRecoveryManifest.mock.calls).toEqual(
      Array.from({ length: 5 }, () => ["alpha", null, expectedRecovery]),
    );
  });

  it.each([
    ["missing", null],
    [
      "mismatched",
      {
        ...LEGACY_OPENCLAW_MIGRATION,
        legacyAgent: "hermes",
      },
    ],
  ] as const)(
    "rejects %s legacy package migration authority before delete",
    async (_case, migration) => {
      const harness = createPreparedRecoveryHarness({
        sandboxEntry: { harnessPackageMigration: migration },
      });

      await expect(
        harness.rebuildSandbox("alpha", ["--yes"], {
          throwOnError: true,
          recoveryManifest: makePreparedRecoveryManifest(),
        }),
      ).rejects.toThrow("legacy backup owner could not be resolved");

      expect(sandboxState.validateRebuildRecoveryManifest).not.toHaveBeenCalled();
      expectNoSandboxDelete(harness.runOpenshellSpy);
    },
  );

  it("re-resolves the pinned legacy package before delete", async () => {
    const resolveLegacyOwner = sandboxAgent.resolveLegacyBackupRecoveryOwner.bind(sandboxAgent);
    let resolutionCount = 0;
    vi.spyOn(sandboxAgent, "resolveLegacyBackupRecoveryOwner").mockImplementation(
      (...args: unknown[]) => {
        resolutionCount++;
        assert.notEqual(resolutionCount, 2, "pinned package authority changed");
        return resolveLegacyOwner(...args);
      },
    );
    const harness = createPreparedRecoveryHarness({
      harnessPackage: installRebuildHarnessPackage("openclaw"),
    });

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], {
        throwOnError: true,
        recoveryManifest: makePreparedRecoveryManifest(),
      }),
    ).rejects.toThrow(
      "legacy backup owner could not be resolved: pinned package authority changed",
    );

    expect(resolutionCount).toBe(2);
    expect(sandboxState.validateRebuildRecoveryManifest).toHaveBeenCalledOnce();
    expectNoSandboxDelete(harness.runOpenshellSpy);
  });

  it("keeps the complete package owner through schema v2 recovery and transaction fences", async () => {
    const harnessPackage = installRebuildHarnessPackage("openclaw");
    expect(harnessPackage).not.toBeNull();
    const recoveryManifest = schemaV2RecoveryManifest(harnessPackage!);
    const harness = createPreparedRecoveryHarness({
      harnessPackage,
      preDeleteLatestManifest: recoveryManifest,
    });

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], {
        throwOnError: true,
        recoveryManifest,
      }),
    ).resolves.toBeUndefined();

    const expectedOwner = expect.objectContaining({
      agent: null,
      harnessPackage,
    });
    const expectedRecovery = expect.objectContaining({
      sandboxName: recoveryManifest.sandboxName,
      timestamp: recoveryManifest.timestamp,
      backupPath: recoveryManifest.backupPath,
      harnessPackage,
    });
    expect(sandboxState.validateRebuildRecoveryManifest).toHaveBeenCalledTimes(5);
    expect(sandboxState.validateRebuildRecoveryManifest.mock.calls).toEqual(
      Array.from({ length: 5 }, () => ["alpha", expectedOwner, expectedRecovery]),
    );
  });

  it.each([
    ["before rebuild preflight", 1, "Pi candidate qualification receipt was removed"],
    ["before prepared recovery deletion", 2, "prepared recovery agent authority"],
    ["at the sandbox delete edge", 3, "prepared recovery agent authority"],
  ] as const)(
    "refuses package-backed Pi when qualification is withdrawn %s",
    async (_edge, withdrawAtResolution, expectedError) => {
      const piAuthority = makeRebuildAgentAuthority("pi");
      assert.ok(piAuthority.harnessPackage);
      const recoveryManifest = {
        ...schemaV2RecoveryManifest(piAuthority.harnessPackage),
        agentType: "pi",
      };
      let resolutionCount = 0;
      vi.spyOn(sandboxAgent, "resolveSandboxAgent").mockImplementation((_entry, options) => {
        resolutionCount++;
        expect(options).toMatchObject({ requireLifecycleEligibility: true });
        return resolutionCount === withdrawAtResolution
          ? (() => {
              throw new Error("Pi candidate qualification receipt was removed");
            })()
          : piAuthority;
      });
      const harness = createPreparedRecoveryHarness({
        agentName: "pi",
        harnessPackage: piAuthority.harnessPackage,
        preDeleteLatestManifest: recoveryManifest,
        sandboxEntry: {
          agent: "pi",
          harnessPackageMigration: null,
        },
      });

      await expect(
        harness.rebuildSandbox("alpha", ["--yes"], {
          throwOnError: true,
          recoveryManifest,
        }),
      ).rejects.toThrow(expectedError);

      expect(resolutionCount).toBe(withdrawAtResolution);
      expectNoSandboxDelete(harness.runOpenshellSpy);
      expect(harness.onboardSpy).not.toHaveBeenCalled();
    },
  );

  it.each(["object", "receipt"] as const)(
    "rejects %s drift observed only at the delete edge",
    async (authorityKind) => {
      const harnessPackage = installRebuildHarnessPackage("openclaw");
      expect(harnessPackage).not.toBeNull();
      const recoveryManifest = schemaV2RecoveryManifest(harnessPackage!);
      let validationCount = 0;
      let resolutionCount = 0;
      const resolveExact = sandboxAgent.resolveSandboxAgent.bind(sandboxAgent);
      const rejectDrift = (..._args: unknown[]) => {
        throw new Error(`retained harness package ${authorityKind} failed integrity validation`);
      };
      vi.spyOn(sandboxAgent, "resolveSandboxAgent").mockImplementation((...args: unknown[]) => {
        resolutionCount++;
        return (resolutionCount === 3 ? rejectDrift : resolveExact)(...args);
      });
      const harness = createPreparedRecoveryHarness({
        harnessPackage,
        preDeleteLatestManifest: recoveryManifest,
        recoveryManifestValidation: (manifest) => {
          validationCount++;
          return { ok: true as const, manifest };
        },
      });

      await expect(
        harness.rebuildSandbox("alpha", ["--yes"], {
          throwOnError: true,
          recoveryManifest,
        }),
      ).rejects.toThrow("prepared recovery agent authority could not be resolved");

      expect(resolutionCount).toBe(3);
      expect(validationCount).toBe(3);
      expectNoSandboxDelete(harness.runOpenshellSpy);
      expect(harness.onboardSpy).not.toHaveBeenCalled();
    },
  );

  it("rejects a definition mismatch observed only at the delete edge", async () => {
    const harnessPackage = installRebuildHarnessPackage("openclaw");
    expect(harnessPackage).not.toBeNull();
    const recoveryManifest = schemaV2RecoveryManifest(harnessPackage!);
    let validationCount = 0;
    let resolutionCount = 0;
    const resolveExact = sandboxAgent.resolveSandboxAgent.bind(sandboxAgent);
    vi.spyOn(sandboxAgent, "resolveSandboxAgent").mockImplementation((...args: unknown[]) => {
      resolutionCount++;
      const authority = resolveExact(...args);
      return resolutionCount === 3
        ? {
            ...authority,
            definition: { ...authority.definition, name: "hermes" },
          }
        : authority;
    });
    const harness = createPreparedRecoveryHarness({
      harnessPackage,
      preDeleteLatestManifest: recoveryManifest,
      recoveryManifestValidation: (manifest) => {
        validationCount++;
        return { ok: true as const, manifest };
      },
    });

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], {
        throwOnError: true,
        recoveryManifest,
      }),
    ).rejects.toThrow("resolved agent authority does not match the owning sandbox");

    expect(resolutionCount).toBe(3);
    expect(validationCount).toBe(3);
    expectNoSandboxDelete(harness.runOpenshellSpy);
    expect(harness.onboardSpy).not.toHaveBeenCalled();
  });

  it.each([
    ["pre-delete", 2, 1],
    ["delete edge", 3, 3],
  ] as const)(
    "rejects same-name definition root drift at the %s recovery fence",
    async (_edge, driftAtResolution, expectedValidationCount) => {
      const harnessPackage = installRebuildHarnessPackage("openclaw");
      expect(harnessPackage).not.toBeNull();
      const recoveryManifest = schemaV2RecoveryManifest(harnessPackage!);
      let validationCount = 0;
      let resolutionCount = 0;
      const resolveExact = sandboxAgent.resolveSandboxAgent.bind(sandboxAgent);
      vi.spyOn(sandboxAgent, "resolveSandboxAgent").mockImplementation((...args: unknown[]) => {
        resolutionCount++;
        const authority = resolveExact(...args);
        return resolutionCount === driftAtResolution
          ? {
              ...authority,
              definition: {
                ...authority.definition,
                packageRoot: `${authority.definition.packageRoot}/changed`,
              },
            }
          : authority;
      });
      const harness = createPreparedRecoveryHarness({
        harnessPackage,
        preDeleteLatestManifest: recoveryManifest,
        recoveryManifestValidation: (manifest) => {
          validationCount++;
          return { ok: true as const, manifest };
        },
      });

      await expect(
        harness.rebuildSandbox("alpha", ["--yes"], {
          throwOnError: true,
          recoveryManifest,
        }),
      ).rejects.toThrow("resolved agent authority does not match the owning sandbox");

      expect(resolutionCount).toBe(driftAtResolution);
      expect(validationCount).toBe(expectedValidationCount);
      expectNoSandboxDelete(harness.runOpenshellSpy);
      expect(harness.onboardSpy).not.toHaveBeenCalled();
    },
  );

  it("ignores active-pointer advancement for an exact prepared recovery", async () => {
    const harnessPackage = installRebuildHarnessPackage("openclaw");
    expect(harnessPackage).not.toBeNull();
    const recoveryManifest = schemaV2RecoveryManifest(harnessPackage!);
    const packageFixture = createHarnessPackageFixture({ storeRoot: harnessStoreRoot() });
    let validationCount = 0;
    const resolveExact = sandboxAgent.resolveSandboxAgent.bind(sandboxAgent);
    const resolvedAuthorities: Array<ReturnType<typeof resolveExact>> = [];
    const resolutionValidationCounts: number[] = [];
    vi.spyOn(sandboxAgent, "resolveSandboxAgent").mockImplementation((...args: unknown[]) => {
      const authority = resolveExact(...args);
      resolvedAuthorities.push(authority);
      resolutionValidationCounts.push(validationCount);
      return authority;
    });
    const advancedPackages: Array<ReturnType<typeof packageFixture.advanceActivePointer>> = [];
    const validationActions = new Map<number, () => void>([
      [
        1,
        () => {
          advancedPackages.push(packageFixture.advanceActivePointer("openclaw"));
        },
      ],
    ]);
    const harness = createPreparedRecoveryHarness({
      harnessPackage,
      preDeleteLatestManifest: recoveryManifest,
      recoveryManifestValidation: (manifest) => {
        validationActions.get(++validationCount)?.();
        return { ok: true as const, manifest };
      },
    });

    try {
      await expect(
        harness.rebuildSandbox("alpha", ["--yes"], {
          throwOnError: true,
          recoveryManifest,
        }),
      ).resolves.toBeUndefined();
    } finally {
      packageFixture.cleanup();
    }

    expect(validationCount).toBe(5);
    const advancedPackage = advancedPackages[0];
    assert.ok(advancedPackage, "prepared recovery test must advance the active package");
    expect(advancedPackage.identity).not.toEqual(harnessPackage);
    expect(resolutionValidationCounts.slice(0, 3)).toEqual([0, 1, 3]);
    expect(resolvedAuthorities.map((authority) => authority.harnessPackage)).toEqual(
      Array.from({ length: resolvedAuthorities.length }, () => harnessPackage),
    );
    expect(
      new Set(resolvedAuthorities.map((authority) => authority.definition.packageRoot)),
    ).toEqual(new Set([resolvedAuthorities[0]!.definition.packageRoot]));
    expect(resolvedAuthorities[0]!.definition.packageRoot).not.toBe(advancedPackage.packageRoot);
    expect(harness.restoreSandboxStateSpy).toHaveBeenCalledWith(
      "alpha",
      recoveryManifest.backupPath,
      expect.objectContaining({ targetAgentType: "openclaw" }),
    );
  });

  it("rejects candidate gate loss observed only at the delete edge", async () => {
    const priorCuaEnabled = process.env.NEMOCLAW_CUA_ENABLED;
    process.env.NEMOCLAW_CUA_ENABLED = "1";
    const recoveryManifest = {
      ...makePreparedRecoveryManifest(),
      version: 2,
      agentType: "nemocua",
      harnessPackage: null,
      backupComplete: true,
    };
    const validationActions = new Map<number, () => void>([
      [
        2,
        () => {
          delete process.env.NEMOCLAW_CUA_ENABLED;
        },
      ],
    ]);
    let validationCount = 0;
    const harness = createPreparedRecoveryHarness({
      harnessPackage: null,
      sandboxEntry: {
        agent: "nemocua",
        harnessPackage: null,
        harnessPackageMigration: null,
      },
      preDeleteLatestManifest: recoveryManifest,
      recoveryManifestValidation: (manifest) => {
        validationActions.get(++validationCount)?.();
        return { ok: true as const, manifest };
      },
    });

    try {
      await expect(
        harness.rebuildSandbox("alpha", ["--yes"], {
          throwOnError: true,
          recoveryManifest,
        }),
      ).rejects.toThrow("prepared recovery agent authority could not be resolved");
    } finally {
      restoreEnv("NEMOCLAW_CUA_ENABLED", priorCuaEnabled);
    }

    expect(validationCount).toBe(3);
    expectNoSandboxDelete(harness.runOpenshellSpy);
    expect(harness.onboardSpy).not.toHaveBeenCalled();
  });

  it("rejects registry drift introduced after the pre-delete recovery check", async () => {
    const harnessPackage = installRebuildHarnessPackage("openclaw");
    expect(harnessPackage).not.toBeNull();
    const recoveryManifest = schemaV2RecoveryManifest(harnessPackage!);
    let validationCount = 0;
    let driftAfterPreparedCheck = false;
    const harness = createPreparedRecoveryHarness({
      harnessPackage,
      preDeleteLatestManifest: recoveryManifest,
      recoveryManifestValidation: (manifest) => {
        driftAfterPreparedCheck = ++validationCount >= 2;
        return { ok: true as const, manifest };
      },
    });
    const readRegistry = registryPersistence.load.getMockImplementation() as
      | (() => { sandboxes: Record<string, Record<string, unknown>> })
      | undefined;
    assert.ok(readRegistry, "rebuild registry fixture must expose its read implementation");
    const observedRegistryReads: Array<{ drift: boolean; model: unknown }> = [];
    registryPersistence.load.mockImplementation(() => {
      const snapshot = structuredClone(readRegistry());
      const currentEntry = snapshot.sandboxes.alpha;
      assert.ok(currentEntry, "prepared recovery registry fixture must retain alpha");
      currentEntry.model = driftAfterPreparedCheck ? "delete-edge-drift" : currentEntry.model;
      observedRegistryReads.push({
        drift: driftAfterPreparedCheck,
        model: currentEntry.model,
      });
      return snapshot;
    });

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], {
        throwOnError: true,
        recoveryManifest,
      }),
    ).rejects.toThrow("Recovery registry configuration changed during preflight");

    expect(validationCount).toBe(3);
    expect(observedRegistryReads).toContainEqual({
      drift: true,
      model: "delete-edge-drift",
    });
    expectNoSandboxDelete(harness.runOpenshellSpy);
    expect(harness.onboardSpy).not.toHaveBeenCalled();
  });

  it("does not defer route validation for an ordinary rebuild (#6114)", async () => {
    const harness = createPreparedRecoveryHarness({ applyPreset: () => true });

    await expect(harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true })).resolves.toBe(
      undefined,
    );

    expect(harness.preflightAuthoritativeRebuildTargetSpy).toHaveBeenCalledWith(
      expect.not.objectContaining({ deferInferenceRouteUntilOnboard: true }),
    );
  });

  it("carries confirmed legacy managed-image recovery through the delete edge (#6114)", async () => {
    const harness = createPreparedRecoveryHarness({
      applyPreset: () => true,
      sandboxInventory: {
        sandboxes: [{ name: "alpha", phase: "Error", readiness: "terminal" }],
      },
      sandboxEntry: {
        nemoclawVersion: null,
        harnessPackageMigration: LEGACY_OPENCLAW_MIGRATION,
      },
      managedImageEvidence: false,
    });
    const recoveryManifest = makePreparedRecoveryManifest();

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], {
        throwOnError: true,
        recoveryManifest,
        allowLegacyManagedImageRecovery: true,
      }),
    ).resolves.toBeUndefined();

    expect(harness.backupSandboxStateSpy).not.toHaveBeenCalled();
    expect(harness.runOpenshellSpy).toHaveBeenCalledWith(
      ["sandbox", "delete", "-g", "nemoclaw", "alpha"],
      expect.objectContaining({ ignoreError: true }),
    );
    expect(harness.restoreSandboxStateSpy).toHaveBeenCalledWith(
      "alpha",
      recoveryManifest.backupPath,
      expect.objectContaining({ targetAgentType: "openclaw" }),
    );
  });

  it("rejects an ambiguous legacy image without the scoped recovery capability (#6114)", async () => {
    const harness = createPreparedRecoveryHarness({
      sandboxInventory: {
        sandboxes: [{ name: "alpha", phase: "Error", readiness: "terminal" }],
      },
      sandboxEntry: { nemoclawVersion: null },
      managedImageEvidence: false,
    });

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], {
        throwOnError: true,
        recoveryManifest: makePreparedRecoveryManifest(),
      }),
    ).rejects.toThrow("no NemoClaw-managed image fingerprint");

    expectNoSandboxDelete(harness.runOpenshellSpy);
    expect(harness.onboardSpy).not.toHaveBeenCalled();
  });

  it("rejects recorded custom-image evidence despite the scoped recovery capability (#6114)", async () => {
    const harness = createPreparedRecoveryHarness({
      sandboxInventory: {
        sandboxes: [{ name: "alpha", phase: "Error", readiness: "terminal" }],
      },
      sandboxEntry: {
        nemoclawVersion: null,
        fromDockerfile: "/tmp/custom.Dockerfile",
      },
      managedImageEvidence: false,
    });

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], {
        throwOnError: true,
        recoveryManifest: makePreparedRecoveryManifest(),
        allowLegacyManagedImageRecovery: true,
      }),
    ).rejects.toThrow("no NemoClaw-managed image fingerprint");

    expectNoSandboxDelete(harness.runOpenshellSpy);
  });

  it("rejects a mismatched prepared manifest before deleting the sandbox (#6114)", async () => {
    const harness = createPreparedRecoveryHarness({
      recoveryManifestValidation: () => ({
        ok: false,
        reason: "manifest sandbox 'beta' does not match 'alpha'",
      }),
    });

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], {
        throwOnError: true,
        recoveryManifest: makePreparedRecoveryManifest(),
      }),
    ).rejects.toThrow("Invalid recovery manifest");

    expect(harness.backupSandboxStateSpy).not.toHaveBeenCalled();
    expectNoSandboxDelete(harness.runOpenshellSpy);
    expect(harness.onboardSpy).not.toHaveBeenCalled();
  });

  it("revalidates the prepared manifest immediately before deleting the sandbox (#6114)", async () => {
    let validationCount = 0;
    const harness = createPreparedRecoveryHarness({
      recoveryManifestValidation: (manifest) => {
        validationCount++;
        return validationCount === 1
          ? { ok: true as const, manifest }
          : { ok: false as const, reason: "persisted backup identity changed during validation" };
      },
    });

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], {
        throwOnError: true,
        recoveryManifest: makePreparedRecoveryManifest(),
      }),
    ).rejects.toThrow("Invalid recovery manifest");

    expect(validationCount).toBe(2);
    expect(harness.backupSandboxStateSpy).not.toHaveBeenCalled();
    expectNoSandboxDelete(harness.runOpenshellSpy);
    expect(harness.onboardSpy).not.toHaveBeenCalled();
  });

  it("rejects same-agent registry configuration drift before deleting the sandbox (#6114)", async () => {
    const harness = createPreparedRecoveryHarness({
      preDeleteSandboxEntry: {
        name: "alpha",
        provider: "compatible-endpoint",
        model: "new-model",
        agent: null,
        agentVersion: "0.1.0",
        nemoclawVersion: "0.0.71",
      },
    });

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], {
        throwOnError: true,
        recoveryManifest: makePreparedRecoveryManifest(),
      }),
    ).rejects.toThrow("Recovery registry configuration changed during preflight");

    expect(harness.backupSandboxStateSpy).not.toHaveBeenCalled();
    expectNoSandboxDelete(harness.runOpenshellSpy);
  });

  it("uses the single refreshed registry snapshot for recreate rollback (#6114)", async () => {
    const harness = createPreparedRecoveryHarness({
      preDeleteDefaultSandbox: "beta",
      onboard: () => {
        throw new Error("recreate failed");
      },
    });

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], {
        throwOnError: true,
        recoveryManifest: makePreparedRecoveryManifest(),
      }),
    ).rejects.toThrow("Recreate failed");

    expect(harness.restoreSandboxEntrySpy).toHaveBeenCalledWith(
      expect.objectContaining({ name: "alpha", agentVersion: "0.1.0" }),
      {},
    );
  });

  it("rejects a latest-backup change immediately before deleting the sandbox (#6114)", async () => {
    const harness = createPreparedRecoveryHarness({
      preDeleteLatestManifest: {
        ...makePreparedRecoveryManifest(),
        timestamp: "2026-07-01T07-00-00-000Z",
        backupPath: "/tmp/rebuild-backups/alpha/2026-07-01T07-00-00-000Z",
      },
    });

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], {
        throwOnError: true,
        recoveryManifest: makePreparedRecoveryManifest(),
      }),
    ).rejects.toThrow("Recovery backup identity changed during preflight");

    expect(harness.backupSandboxStateSpy).not.toHaveBeenCalled();
    expectNoSandboxDelete(harness.runOpenshellSpy);
  });

  it("rejects same-path prepared-manifest substitution before deleting the sandbox", async () => {
    const recoveryManifest = makePreparedRecoveryManifest();
    const harness = createPreparedRecoveryHarness({
      preDeleteLatestManifest: {
        ...recoveryManifest,
        agentVersion: "substituted-version",
      },
    });

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], {
        throwOnError: true,
        recoveryManifest,
      }),
    ).rejects.toThrow("Recovery backup identity changed during preflight");

    expect(harness.backupSandboxStateSpy).not.toHaveBeenCalled();
    expectNoSandboxDelete(harness.runOpenshellSpy);
  });

  it("restores the registry entry when prepared-backup recreation fails (#6114)", async () => {
    const harness = createPreparedRecoveryHarness({
      onboard: () => {
        throw new Error("recreate failed");
      },
    });
    const recoveryManifest = makePreparedRecoveryManifest();

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], {
        throwOnError: true,
        recoveryManifest,
      }),
    ).rejects.toThrow("Recreate failed");

    expect(harness.backupSandboxStateSpy).not.toHaveBeenCalled();
    // The journaled source row survives the delete, so no default-sandbox
    // transition happened and none has to be reversed (#7734).
    expect(harness.restoreSandboxEntrySpy).toHaveBeenCalledWith(
      expect.objectContaining({ name: "alpha", agentVersion: "0.1.0" }),
      {},
    );
    expect(harness.restoreSandboxStateSpy).not.toHaveBeenCalled();
  });
});
