// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";

import { describe, expect, it, vi } from "vitest";
import { expectNoSandboxDelete } from "../../../../test/helpers/rebuild-delete-assertions";
import {
  createRebuildFlowHarness,
  installRebuildFlowTestHooks,
  makePreparedRecoveryManifest,
} from "../../../../test/helpers/rebuild-flow-dcode-harness";
import {
  installRebuildHarnessPackage,
  sandboxAgent,
  sandboxState,
} from "../../../../test/helpers/rebuild-flow-harness";

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
    expect(sandboxState.validateRebuildRecoveryManifest).toHaveBeenNthCalledWith(
      1,
      "alpha",
      null,
      recoveryManifest,
    );
    expect(sandboxState.validateRebuildRecoveryManifest).toHaveBeenNthCalledWith(
      2,
      "alpha",
      null,
      recoveryManifest,
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

  it("keeps the complete package owner at both schema v2 recovery fences", async () => {
    const harnessPackage = installRebuildHarnessPackage("openclaw");
    expect(harnessPackage).not.toBeNull();
    const recoveryManifest = {
      ...makePreparedRecoveryManifest(),
      version: 2,
      harnessPackage,
      backupComplete: true,
    };
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
    expect(sandboxState.validateRebuildRecoveryManifest).toHaveBeenNthCalledWith(
      1,
      "alpha",
      expectedOwner,
      recoveryManifest,
    );
    expect(sandboxState.validateRebuildRecoveryManifest).toHaveBeenNthCalledWith(
      2,
      "alpha",
      expectedOwner,
      recoveryManifest,
    );
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
        policies: ["npm", "github"],
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
