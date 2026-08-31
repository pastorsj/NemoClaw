// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-retained-recovery-"));
  vi.stubEnv("HOME", home);
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
});

const evidence = {
  sharedInferenceProviders: ["nvidia"],
  sandboxScopedProviders: ["sandbox-telegram"],
  credentialEnvironmentVariables: ["NVIDIA_API_KEY", "TELEGRAM_BOT_TOKEN"],
} as const;
const recoveryAuthority = {
  createAttemptNonce: "c".repeat(62),
} as const;

const harnessPackage = {
  kind: "agent-runtime",
  id: "openclaw",
  packageVersion: "1.2.3",
  contentDigest: "c".repeat(64),
} as const;

function seedRecoverySession(recovery: typeof import("./onboard-session")): void {
  recovery.saveSession(
    recovery.createSession({
      sandboxName: "retained-sb",
      harnessPackage,
    }),
  );
}

function createLegacyRecoveryRecord() {
  const fields = {
    sandboxName: "legacy-sb",
    sandboxIdentityFingerprint: "9".repeat(64),
    identityWasUnavailable: false,
    gatewayName: "nemoclaw",
    gatewayPort: 8080,
    lifecycleGeneration: "legacy-generation",
    ...recoveryAuthority,
    resources: evidence,
    reason: "cancelled_after_sandbox_creation",
    recordedAt: "2026-08-27T00:00:00.000Z",
  } as const;
  const recordId = createHash("sha256")
    .update(
      JSON.stringify([
        fields.gatewayName,
        fields.gatewayPort,
        fields.sandboxName,
        fields.sandboxIdentityFingerprint,
        fields.lifecycleGeneration,
        fields.createAttemptNonce,
      ]),
    )
    .digest("hex");
  return { schemaVersion: 1 as const, recordId, ...fields };
}

describe("retained sandbox recovery state", () => {
  it("persists verified identity and secret-free resource evidence independently", async () => {
    const recovery = await import("./onboard-session");
    const fingerprint = "a".repeat(64);
    const input = {
      sandboxName: "retained-sb",
      sandboxIdentityFingerprint: fingerprint,
      gatewayName: "nemoclaw",
      gatewayPort: 8080,
      lifecycleGeneration: "00000000-0000-4000-8000-000000000001",
      ...recoveryAuthority,
      harnessPackage,
      resources: evidence,
      reason: "cancelled_after_sandbox_creation",
      recordedAt: "2026-08-27T00:00:00.000Z",
    } as const;

    const recorded = recovery.recordRetainedSandboxRecovery(input);

    expect(recovery.listRetainedSandboxRecoveryRecords()).toEqual([recorded]);
    expect(recorded).toMatchObject({
      schemaVersion: 2,
      sandboxName: "retained-sb",
      sandboxIdentityFingerprint: fingerprint,
      harnessPackage,
      identityWasUnavailable: false,
      resources: evidence,
    });
    expect(recorded).not.toHaveProperty("harnessPackageMigration");
    expect(fs.readFileSync(recovery.RETAINED_SANDBOX_RECOVERY_FILE, "utf8")).not.toContain(
      "secret-value",
    );
  });

  it("records an explicit missing identity", async () => {
    const recovery = await import("./onboard-session");

    const recorded = recovery.recordRetainedSandboxRecovery({
      sandboxName: "missing-id",
      sandboxIdentityFingerprint: null,
      gatewayName: "nemoclaw",
      gatewayPort: 8080,
      lifecycleGeneration: null,
      ...recoveryAuthority,
      harnessPackage: null,
      resources: {
        sharedInferenceProviders: [],
        sandboxScopedProviders: [],
        credentialEnvironmentVariables: [],
      },
      reason: "retained_after_sandbox_creation_failure",
    });

    expect(recorded).toMatchObject({
      schemaVersion: 2,
      sandboxIdentityFingerprint: null,
      identityWasUnavailable: true,
      harnessPackage: null,
      lifecycleGeneration: null,
    });
  });

  it("keeps a version 1 record readable as explicit legacy package absence", async () => {
    const recovery = await import("./onboard-session");
    const legacy = createLegacyRecoveryRecord();
    fs.mkdirSync(path.dirname(recovery.RETAINED_SANDBOX_RECOVERY_FILE), { recursive: true });
    fs.writeFileSync(
      recovery.RETAINED_SANDBOX_RECOVERY_FILE,
      JSON.stringify({
        schemaVersion: 1,
        unresolved: [legacy],
        resolutions: [],
      }),
    );

    const [record] = recovery.listRetainedSandboxRecoveryRecords();

    expect(record).toEqual(legacy);
    expect(record).not.toHaveProperty("harnessPackage");
  });

  it("binds one selected legacy record to exact package authority durably", async () => {
    const recovery = await import("./onboard-session");
    const legacy = createLegacyRecoveryRecord();
    fs.mkdirSync(path.dirname(recovery.RETAINED_SANDBOX_RECOVERY_FILE), { recursive: true });
    fs.writeFileSync(
      recovery.RETAINED_SANDBOX_RECOVERY_FILE,
      JSON.stringify({ schemaVersion: 1, unresolved: [legacy], resolutions: [] }),
    );

    const reconciliation = recovery.reconcileRetainedRecoveryPackage({
      expectedRecord: legacy,
      harnessPackage,
    });
    const bound = reconciliation.record;

    expect(reconciliation.status).toBe("upgraded");
    expect(bound).toMatchObject({ schemaVersion: 2, harnessPackage });
    expect(bound.recordId).not.toBe(legacy.recordId);
    expect(bound).not.toHaveProperty("harnessPackageMigration");
    expect(recovery.listRetainedSandboxRecoveryRecords()).toEqual([bound]);
    expect(
      recovery.reconcileRetainedRecoveryPackage({
        expectedRecord: legacy,
        harnessPackage,
      }),
    ).toEqual({ status: "verified", record: bound });
    expect(
      recovery.reconcileRetainedRecoveryPackage({
        expectedRecord: bound,
        harnessPackage,
      }),
    ).toEqual({ status: "verified", record: bound });
  });

  it("canonicalizes a valid reordered package identity before durable publication", async () => {
    const recovery = await import("./onboard-session");
    const reorderedHarnessPackage = {
      contentDigest: harnessPackage.contentDigest,
      packageVersion: harnessPackage.packageVersion,
      id: harnessPackage.id,
      kind: harnessPackage.kind,
    } as const;

    const recorded = recovery.recordRetainedSandboxRecovery({
      sandboxName: "reordered-package",
      sandboxIdentityFingerprint: "8".repeat(64),
      gatewayName: "nemoclaw",
      gatewayPort: 8080,
      lifecycleGeneration: "reordered-generation",
      ...recoveryAuthority,
      harnessPackage: reorderedHarnessPackage,
      resources: evidence,
      reason: "cancelled_after_sandbox_creation",
      recordedAt: "2026-08-27T00:00:00.000Z",
    });

    expect(recorded).toMatchObject({ harnessPackage });
    expect(recovery.listRetainedSandboxRecoveryRecords()).toEqual([recorded]);
  });

  it("rejects duplicate copies of the selected legacy record", async () => {
    const recovery = await import("./onboard-session");
    const legacy = createLegacyRecoveryRecord();
    fs.mkdirSync(path.dirname(recovery.RETAINED_SANDBOX_RECOVERY_FILE), { recursive: true });
    fs.writeFileSync(
      recovery.RETAINED_SANDBOX_RECOVERY_FILE,
      JSON.stringify({ schemaVersion: 1, unresolved: [legacy, legacy], resolutions: [] }),
    );

    expect(() =>
      recovery.reconcileRetainedRecoveryPackage({
        expectedRecord: legacy,
        harnessPackage,
      }),
    ).toThrow(/record changed before package reconciliation/u);
  });

  it("rejects a conflicting version 2 destination for a legacy package binding", async () => {
    const recovery = await import("./onboard-session");
    const legacy = createLegacyRecoveryRecord();
    const conflicting = recovery.recordRetainedSandboxRecovery({
      sandboxName: legacy.sandboxName,
      sandboxIdentityFingerprint: legacy.sandboxIdentityFingerprint,
      gatewayName: legacy.gatewayName,
      gatewayPort: legacy.gatewayPort,
      lifecycleGeneration: legacy.lifecycleGeneration,
      ...recoveryAuthority,
      harnessPackage,
      resources: {
        sharedInferenceProviders: [],
        sandboxScopedProviders: [],
        credentialEnvironmentVariables: [],
      },
      reason: "retained_after_sandbox_creation_failure",
      recordedAt: "2026-08-27T01:00:00.000Z",
    });
    fs.writeFileSync(
      recovery.RETAINED_SANDBOX_RECOVERY_FILE,
      JSON.stringify({
        schemaVersion: 1,
        unresolved: [legacy, conflicting],
        resolutions: [],
      }),
    );

    expect(() =>
      recovery.reconcileRetainedRecoveryPackage({
        expectedRecord: legacy,
        harnessPackage,
      }),
    ).toThrow(/conflicts with another record/u);
  });

  it("rejects changed current version 2 authority and a mismatched requested package", async () => {
    const recovery = await import("./onboard-session");
    const input = {
      sandboxName: "current-package",
      sandboxIdentityFingerprint: "6".repeat(64),
      gatewayName: "nemoclaw",
      gatewayPort: 8080,
      lifecycleGeneration: "current-generation",
      ...recoveryAuthority,
      resources: evidence,
      reason: "cancelled_after_sandbox_creation" as const,
      recordedAt: "2026-08-27T00:00:00.000Z",
    };
    const expected = recovery.recordRetainedSandboxRecovery({
      ...input,
      harnessPackage,
    });
    const changedHarnessPackage = {
      ...harnessPackage,
      contentDigest: "d".repeat(64),
    } as const;

    expect(() =>
      recovery.reconcileRetainedRecoveryPackage({
        expectedRecord: expected,
        harnessPackage: changedHarnessPackage,
      }),
    ).toThrow(/package authority does not match its current record/u);

    const changed = recovery.recordRetainedSandboxRecovery({
      ...input,
      harnessPackage: changedHarnessPackage,
    });
    fs.writeFileSync(
      recovery.RETAINED_SANDBOX_RECOVERY_FILE,
      JSON.stringify({ schemaVersion: 1, unresolved: [changed], resolutions: [] }),
    );

    expect(() =>
      recovery.reconcileRetainedRecoveryPackage({
        expectedRecord: expected,
        harnessPackage,
      }),
    ).toThrow(/record changed before package reconciliation/u);
  });

  it("upgrades a candidate legacy record to explicit null idempotently", async () => {
    const recovery = await import("./onboard-session");
    const legacy = createLegacyRecoveryRecord();
    fs.mkdirSync(path.dirname(recovery.RETAINED_SANDBOX_RECOVERY_FILE), { recursive: true });
    fs.writeFileSync(
      recovery.RETAINED_SANDBOX_RECOVERY_FILE,
      JSON.stringify({ schemaVersion: 1, unresolved: [legacy], resolutions: [] }),
    );

    const reconciliation = recovery.reconcileRetainedRecoveryPackage({
      expectedRecord: legacy,
      harnessPackage: null,
    });

    expect(reconciliation).toMatchObject({
      status: "upgraded",
      record: { schemaVersion: 2, harnessPackage: null },
    });
    expect(
      recovery.reconcileRetainedRecoveryPackage({
        expectedRecord: legacy,
        harnessPackage: null,
      }),
    ).toEqual({ status: "verified", record: reconciliation.record });
    expect(
      recovery.reconcileRetainedRecoveryPackage({
        expectedRecord: reconciliation.record,
        harnessPackage: null,
      }),
    ).toEqual({ status: "verified", record: reconciliation.record });
  });

  it.each([
    [
      "changed package identity",
      (record: Record<string, unknown>) => {
        record.harnessPackage = { ...harnessPackage, contentDigest: "d".repeat(64) };
      },
    ],
    [
      "owner-only migration provenance",
      (record: Record<string, unknown>) => {
        record.harnessPackageMigration = {
          schemaVersion: 1,
          source: "legacy-current-bundle",
          legacyAgent: "openclaw",
          migratedAt: "2026-08-27T00:00:00.000Z",
        };
      },
    ],
    [
      "malformed package identity",
      (record: Record<string, unknown>) => {
        record.harnessPackage = { ...harnessPackage, contentDigest: "not-a-digest" };
      },
    ],
  ])("rejects a version 2 record with %s", async (_case, mutate) => {
    const recovery = await import("./onboard-session");
    recovery.recordRetainedSandboxRecovery({
      sandboxName: "retained-sb",
      sandboxIdentityFingerprint: "7".repeat(64),
      gatewayName: "nemoclaw",
      gatewayPort: 8080,
      lifecycleGeneration: "generation-7",
      ...recoveryAuthority,
      harnessPackage,
      resources: evidence,
      reason: "cancelled_after_sandbox_creation",
    });
    const state = JSON.parse(fs.readFileSync(recovery.RETAINED_SANDBOX_RECOVERY_FILE, "utf8")) as {
      unresolved: Array<Record<string, unknown>>;
    };
    mutate(state.unresolved[0]);
    fs.writeFileSync(recovery.RETAINED_SANDBOX_RECOVERY_FILE, JSON.stringify(state));

    expect(() => recovery.listRetainedSandboxRecoveryRecords()).toThrow(
      /invalid; onboarding remains blocked/u,
    );
  });

  it("rejects a recovery target outside the canonical sandbox-name contract", async () => {
    const recovery = await import("./onboard-session");

    expect(() =>
      recovery.recordRetainedSandboxRecovery({
        sandboxName: "1sandbox",
        sandboxIdentityFingerprint: "a".repeat(64),
        gatewayName: "nemoclaw",
        gatewayPort: 8080,
        lifecycleGeneration: "00000000-0000-4000-8000-000000000001",
        ...recoveryAuthority,
        harnessPackage: null,
        resources: evidence,
        reason: "retained_after_sandbox_creation_failure",
      }),
    ).toThrow("Cannot persist invalid retained sandbox recovery evidence");
  });

  it("preserves distinct unresolved lifecycle tuples for one sandbox name (#9833)", async () => {
    const recovery = await import("./onboard-session");
    const first = recovery.recordRetainedSandboxRecovery({
      sandboxName: "retained-sb",
      sandboxIdentityFingerprint: "1".repeat(64),
      gatewayName: "nemoclaw-18080",
      gatewayPort: 18080,
      lifecycleGeneration: "00000000-0000-4000-8000-000000000001",
      ...recoveryAuthority,
      harnessPackage,
      resources: evidence,
      reason: "cancelled_after_sandbox_creation",
    });
    const second = recovery.recordRetainedSandboxRecovery({
      sandboxName: "retained-sb",
      sandboxIdentityFingerprint: "2".repeat(64),
      gatewayName: "nemoclaw-18080",
      gatewayPort: 18080,
      lifecycleGeneration: "00000000-0000-4000-8000-000000000002",
      ...recoveryAuthority,
      harnessPackage,
      resources: evidence,
      reason: "retained_after_sandbox_creation_failure",
    });

    expect(recovery.listRetainedSandboxRecoveryRecords()).toEqual([first, second]);
  });

  it("refuses a symbolic-link recovery state without reading its target", async () => {
    const recovery = await import("./onboard-session");
    const externalState = path.join(home, "external-recovery.json");
    const externalContents = "{not recovery json";
    fs.writeFileSync(externalState, externalContents);
    fs.mkdirSync(path.dirname(recovery.RETAINED_SANDBOX_RECOVERY_FILE), { recursive: true });
    fs.symlinkSync(externalState, recovery.RETAINED_SANDBOX_RECOVERY_FILE);

    expect(() => recovery.listRetainedSandboxRecoveryRecords()).toThrow(/symbolic link/u);
    expect(fs.readFileSync(externalState, "utf8")).toBe(externalContents);
  });

  it("refuses a symbolic-link recovery state directory ancestor (#9833)", async () => {
    const externalStateDirectory = path.join(home, "external-state");
    fs.mkdirSync(externalStateDirectory);
    fs.symlinkSync(externalStateDirectory, path.join(home, ".nemoclaw"), "dir");
    const recovery = await import("./onboard-session");

    expect(() => recovery.listRetainedSandboxRecoveryRecords()).toThrow(/symbolic link/u);
  });

  it("refuses recovery publication after the locked state directory is replaced (#9833)", async () => {
    const recovery = await import("./onboard-session");
    expect(recovery.acquireOnboardLock("recovery directory replacement test").acquired).toBe(true);
    const originalDirectory = path.dirname(recovery.RETAINED_SANDBOX_RECOVERY_FILE);
    const displacedDirectory = `${originalDirectory}.displaced`;
    const replacementDirectory = path.join(home, "replacement-state");
    fs.renameSync(originalDirectory, displacedDirectory);
    fs.mkdirSync(replacementDirectory);
    fs.symlinkSync(replacementDirectory, originalDirectory, "dir");

    expect(() =>
      recovery.recordRetainedSandboxRecovery({
        sandboxName: "retained-sb",
        sandboxIdentityFingerprint: "f".repeat(64),
        gatewayName: "nemoclaw",
        gatewayPort: 8080,
        lifecycleGeneration: "generation-1",
        ...recoveryAuthority,
        harnessPackage: null,
        resources: evidence,
        reason: "retained_after_sandbox_creation_failure",
      }),
    ).toThrow(/symbolic link|lock ownership changed/u);
    expect(fs.existsSync(path.join(replacementDirectory, "retained-sandbox-recovery.json"))).toBe(
      false,
    );
    expect(fs.existsSync(path.join(displacedDirectory, "onboard.lock"))).toBe(true);
  });

  it("writes no recovery evidence after the state directory changes at temporary open (#9833)", async () => {
    const recovery = await import("./onboard-session");
    const stateDirectory = path.dirname(recovery.RETAINED_SANDBOX_RECOVERY_FILE);
    const displacedDirectory = `${stateDirectory}.displaced`;
    const openSync = fs.openSync.bind(fs);
    let replaced = false;
    vi.spyOn(fs, "openSync").mockImplementation((file, flags, mode) => {
      !replaced &&
        path.basename(String(file)).startsWith(".retained-sandbox-recovery.") &&
        (() => {
          replaced = true;
          fs.renameSync(stateDirectory, displacedDirectory);
          fs.mkdirSync(stateDirectory, { mode: 0o700 });
        })();
      return openSync(file, flags, mode);
    });

    expect(() =>
      recovery.recordRetainedSandboxRecovery({
        sandboxName: "retained-sb",
        sandboxIdentityFingerprint: "f".repeat(64),
        gatewayName: "nemoclaw",
        gatewayPort: 8080,
        lifecycleGeneration: "generation-1",
        ...recoveryAuthority,
        harnessPackage: null,
        resources: evidence,
        reason: "retained_after_sandbox_creation_failure",
      }),
    ).toThrow(/state directory changed|lock ownership changed/u);
    expect(replaced).toBe(true);
    expect(
      fs
        .readdirSync(stateDirectory)
        .map((name) => fs.statSync(path.join(stateDirectory, name)).size)
        .filter((size) => size > 0),
    ).toEqual([]);
  });

  it("writes no session evidence after the state directory changes at temporary open (#9833)", async () => {
    const recovery = await import("./onboard-session");
    const stateDirectory = path.dirname(recovery.SESSION_FILE);
    const displacedDirectory = `${stateDirectory}.displaced`;
    const openSync = fs.openSync.bind(fs);
    let replaced = false;
    vi.spyOn(fs, "openSync").mockImplementation((file, flags, mode) => {
      !replaced &&
        path.basename(String(file)).startsWith(".onboard-session.") &&
        (() => {
          replaced = true;
          fs.renameSync(stateDirectory, displacedDirectory);
          fs.mkdirSync(stateDirectory, { mode: 0o700 });
        })();
      return openSync(file, flags, mode);
    });

    expect(() =>
      recovery.markRetainedSandboxRecovery(
        "retained-sb",
        "Sandbox creation failed after identity verification.",
        "f".repeat(64),
        {
          gatewayName: "nemoclaw",
          gatewayPort: 8080,
          lifecycleGeneration: "generation-1",
          createAttemptNonce: recoveryAuthority.createAttemptNonce,
        },
      ),
    ).toThrow(/state directory changed|lock ownership changed/u);
    expect(replaced).toBe(true);
    expect(
      fs
        .readdirSync(stateDirectory)
        .map((name) => fs.statSync(path.join(stateDirectory, name)).size)
        .filter((size) => size > 0),
    ).toEqual([]);
  });

  it("retires only the exact retained recovery record after verified cleanup (#10547)", async () => {
    const recovery = await import("./onboard-session");
    const fingerprint = "b".repeat(64);
    const recorded = recovery.recordRetainedSandboxRecovery({
      sandboxName: "retained-sb",
      sandboxIdentityFingerprint: fingerprint,
      gatewayName: "nemoclaw",
      gatewayPort: 8080,
      lifecycleGeneration: "generation-1",
      ...recoveryAuthority,
      harnessPackage,
      resources: evidence,
      reason: "cancelled_after_sandbox_creation",
    });

    expect(() =>
      recovery.resolveRetainedSandboxRecovery({
        ...recorded,
        sandboxIdentityFingerprint: "d".repeat(64),
      }),
    ).toThrow(/changed before cleanup completed/u);
    expect(recovery.listRetainedSandboxRecoveryRecords()).toEqual([recorded]);

    expect(recovery.resolveRetainedSandboxRecovery(recorded)).toBe(true);
    expect(recovery.resolveRetainedSandboxRecovery(recorded)).toBe(false);
    expect(recovery.listRetainedSandboxRecoveryRecords()).toEqual([]);
  });

  it("releases the matching recovery-only onboarding session after cleanup (#10547)", async () => {
    const recovery = await import("./onboard-session");
    seedRecoverySession(recovery);
    recovery.markRetainedSandboxRecovery(
      "retained-sb",
      "Sandbox creation failed after identity verification.",
      "b".repeat(64),
      {
        gatewayName: "nemoclaw",
        gatewayPort: 8080,
        lifecycleGeneration: "generation-1",
        ...recoveryAuthority,
      },
    );
    const [recorded] = recovery.listRetainedSandboxRecoveryRecords();

    expect(() =>
      recovery.resolveRetainedSandboxRecovery({
        ...recorded!,
        reason: "cancelled_after_sandbox_creation",
      }),
    ).toThrow(/changed before cleanup completed/u);
    expect(recovery.loadSession()).toMatchObject({
      status: "recovery_required",
      sandboxName: "retained-sb",
    });

    expect(recovery.resolveRetainedSandboxRecovery(recorded!)).toBe(true);

    expect(recovery.loadSession()).toMatchObject({
      status: "failed",
      resumable: false,
      sandboxName: null,
      cancellationRecovery: null,
    });
    expect(recovery.listRetainedSandboxRecoveryRecords()).toEqual([]);
  });

  it("keeps the exact record when retirement fails after session release (#10547)", async () => {
    const recovery = await import("./onboard-session");
    seedRecoverySession(recovery);
    recovery.markRetainedSandboxRecovery(
      "retained-sb",
      "Sandbox creation failed after identity verification.",
      "b".repeat(64),
      {
        gatewayName: "nemoclaw",
        gatewayPort: 8080,
        lifecycleGeneration: "generation-1",
        ...recoveryAuthority,
      },
    );
    const [recorded] = recovery.listRetainedSandboxRecoveryRecords();
    const renameSync = fs.renameSync.bind(fs);
    vi.spyOn(fs, "renameSync").mockImplementation((source, destination) =>
      String(destination) === recovery.RETAINED_SANDBOX_RECOVERY_FILE
        ? (() => {
            throw new Error("simulated recovery retirement write failure");
          })()
        : renameSync(source, destination),
    );

    expect(() => recovery.resolveRetainedSandboxRecovery(recorded!)).toThrow(
      /simulated recovery retirement write failure/u,
    );
    expect(recovery.loadSession()).toMatchObject({
      status: "failed",
      resumable: false,
      sandboxName: null,
      cancellationRecovery: null,
    });
    expect(recovery.listRetainedSandboxRecoveryRecords()).toEqual([recorded]);
  });
  it("preserves the exact record when recovery-only session release cannot be written (#10547)", async () => {
    const recovery = await import("./onboard-session");
    seedRecoverySession(recovery);
    recovery.markRetainedSandboxRecovery(
      "retained-sb",
      "Sandbox creation failed after identity verification.",
      "b".repeat(64),
      {
        gatewayName: "nemoclaw",
        gatewayPort: 8080,
        lifecycleGeneration: "generation-1",
        ...recoveryAuthority,
      },
    );
    const [recorded] = recovery.listRetainedSandboxRecoveryRecords();
    const renameSync = fs.renameSync.bind(fs);
    vi.spyOn(fs, "renameSync").mockImplementation((source, destination) =>
      String(destination) === recovery.SESSION_FILE
        ? (() => {
            throw new Error("simulated recovery session release write failure");
          })()
        : renameSync(source, destination),
    );

    expect(() => recovery.resolveRetainedSandboxRecovery(recorded!)).toThrow(
      /simulated recovery session release write failure/u,
    );
    expect(recovery.loadSession()).toMatchObject({
      status: "recovery_required",
      sandboxName: "retained-sb",
    });
    expect(recovery.listRetainedSandboxRecoveryRecords()).toEqual([recorded]);
  });
});
