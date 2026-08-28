// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createHarnessPackageFixture,
  type HarnessPackageFixture,
} from "../../../../test/helpers/harness-packages";
import { listHarnessPackageInventory } from "../../harness/package-catalog";
import type { BundledHarnessPackageSourceIdentity } from "../../harness/package-receipt";
import { resolvePinnedHarnessPackage } from "../../harness/package-store";
import {
  prepareLegacyHarnessMigration,
  reconcileLegacyHarnessMigration,
  type LegacyHarnessMigrationDependencies,
} from "../../state/harness-migration";
import { createSession, type Session } from "../../state/onboard-session";
import type { RetainedSandboxRecoveryRecord } from "../../state/onboard-session/retained-sandbox-recovery";
import { normalizeSandboxPolicyAttribution } from "../../state/registry-normalization";
import type { SandboxEntry, SandboxRegistry } from "../../state/registry/types";
import {
  InstallerHarnessReconciliationError,
  reconcileInstallerHarnesses,
} from "./harness-reconcile";

const SOURCE_IDENTITY: BundledHarnessPackageSourceIdentity = {
  kind: "bundled",
  nemoclawBuildIdentity: {
    nemoclawVersion: "0.0.113",
    sourceRevision: "a".repeat(40),
  },
};
const MIGRATED_AT = "2026-08-28T12:34:56.789Z";

type ReconcileDependencies = NonNullable<Parameters<typeof reconcileInstallerHarnesses>[1]>;

function legacySession(agent: string | null, sandboxName: string | null): Session {
  return createSession({
    agent,
    sandboxName,
    sessionId: "installer-session",
    startedAt: "2026-08-28T10:00:00.000Z",
    updatedAt: "2026-08-28T10:00:00.000Z",
  });
}

function registryEntry(name: string, agent: string | null): SandboxEntry {
  return { name, agent, createdAt: "2026-08-28T09:00:00.000Z" };
}

function candidateRegistryEntry(name: string, agent: "pi" | "nemocua"): SandboxEntry {
  return normalizeSandboxPolicyAttribution(registryEntry(name, agent));
}

function migration(legacyAgent: string | null, migratedAt = MIGRATED_AT) {
  return {
    schemaVersion: 1 as const,
    source: "legacy-current-bundle" as const,
    legacyAgent,
    migratedAt,
  };
}

function legacyRetainedRecord(sandboxName: string): RetainedSandboxRecoveryRecord {
  return {
    schemaVersion: 1,
    recordId: `legacy-${sandboxName}`,
    sandboxName,
    sandboxIdentityFingerprint: null,
    identityWasUnavailable: true,
    gatewayName: "nemoclaw",
    gatewayPort: 8080,
    lifecycleGeneration: null,
    verifiedEffectivePolicyIdentity: null,
    resources: {
      sharedInferenceProviders: [],
      sandboxScopedProviders: [],
      credentialEnvironmentVariables: [],
    },
    reason: "retained_after_sandbox_creation_failure",
    recordedAt: "2026-08-28T11:00:00.000Z",
  };
}

class InstallerStateHarness {
  session: Session | null;
  registry: SandboxRegistry;
  retained: RetainedSandboxRecoveryRecord[];
  readonly prepareCalls: string[] = [];
  readonly reconcileCalls: string[] = [];

  constructor(
    session: Session | null = null,
    entries: readonly SandboxEntry[] = [],
    retained: readonly RetainedSandboxRecoveryRecord[] = [],
  ) {
    this.session = session ? structuredClone(session) : null;
    this.registry = {
      defaultSandbox: null,
      sandboxes: Object.fromEntries(entries.map((entry) => [entry.name, structuredClone(entry)])),
    };
    this.retained = structuredClone(retained) as RetainedSandboxRecoveryRecord[];
  }

  migrationDependencies(): Partial<LegacyHarnessMigrationDependencies> {
    return {
      assertWriterLockOwned: () => undefined,
      compareAndSwapSession: (matches, mutator) => {
        const updateMatchingSession = () => {
          const candidate = structuredClone(this.session!);
          this.session = structuredClone(mutator(candidate) ?? candidate);
          return "updated" as const;
        };
        return this.session && matches(structuredClone(this.session))
          ? updateMatchingSession()
          : "mismatch";
      },
      loadRegistry: () => structuredClone(this.registry),
      loadSession: () => (this.session ? structuredClone(this.session) : null),
      now: () => new Date(MIGRATED_AT),
      saveRegistry: (registry) => {
        this.registry = structuredClone(registry);
      },
      withRegistryLock: (operation) => operation(),
    };
  }

  dependencies(fixture: HarnessPackageFixture): ReconcileDependencies {
    const migrationDependencies = this.migrationDependencies();
    return {
      acquireOnboardLock: () => ({ acquired: true, lockFile: "lock", stale: false }),
      listRetainedRecords: () => structuredClone(this.retained),
      readRegistryState: () => ({ status: "valid", registry: structuredClone(this.registry) }),
      readSessionState: () =>
        this.session
          ? { status: "valid", session: structuredClone(this.session) }
          : { status: "absent" },
      prepareLegacyMigration: (input) => {
        this.prepareCalls.push(input.owner.kind);
        return prepareLegacyHarnessMigration(input, migrationDependencies);
      },
      reconcileLegacyMigration: (prepared) => {
        this.reconcileCalls.push(prepared.owner.kind);
        return reconcileLegacyHarnessMigration(prepared, migrationDependencies);
      },
      releaseOnboardLock: () => undefined,
      resolvePinnedPackage: resolvePinnedHarnessPackage,
      listInventory: listHarnessPackageInventory,
      resolveSandboxAgent: (entry) => ({
        recordedAgent: entry.agent ?? null,
        effectiveAgentId: entry.agent ?? "openclaw",
        definition: { name: entry.agent ?? "openclaw" } as never,
        harnessPackage: null,
        harnessPackageMigration: null,
      }),
      reconcileRetainedPackage: ({ expectedRecord, harnessPackage }) => {
        const selectedIndex = this.retained.findIndex(
          (record) => record.recordId === expectedRecord.recordId,
        );
        expect(selectedIndex, "selected retained record changed").toBeGreaterThanOrEqual(0);
        const selected = this.retained[selectedIndex]!;
        const verifyCurrentRecord = (
          current: Extract<RetainedSandboxRecoveryRecord, { schemaVersion: 2 }>,
        ) => {
          expect(current.harnessPackage, "retained package mismatch").toEqual(harnessPackage);
          return { status: "verified", record: structuredClone(current) } as const;
        };
        const upgradeLegacyRecord = (
          legacy: Extract<RetainedSandboxRecoveryRecord, { schemaVersion: 1 }>,
        ) => {
          const upgraded = {
            ...legacy,
            schemaVersion: 2 as const,
            recordId: `current-${legacy.sandboxName}`,
            harnessPackage: structuredClone(harnessPackage),
          };
          this.retained.splice(selectedIndex, 1, upgraded);
          return { status: "upgraded", record: structuredClone(upgraded) } as const;
        };
        return selected.schemaVersion === 2
          ? verifyCurrentRecord(selected)
          : upgradeLegacyRecord(selected);
      },
    };
  }
}

let fixture: HarnessPackageFixture;

beforeEach(() => {
  fixture = createHarnessPackageFixture();
});

afterEach(() => {
  fixture.cleanup();
  vi.restoreAllMocks();
});

function reconcile(
  harness: InstallerStateHarness,
  dependencyOverrides: Partial<ReconcileDependencies> = {},
) {
  return reconcileInstallerHarnesses(
    {
      bundledRoot: fixture.bundledRoot,
      storeRoot: fixture.storeRoot,
      sourceIdentity: SOURCE_IDENTITY,
    },
    { ...harness.dependencies(fixture), ...dependencyOverrides },
  );
}

describe("reconcileInstallerHarnesses", () => {
  it("returns a bounded empty-store outcome for zero durable state", () => {
    const result = reconcile(new InstallerStateHarness());

    expect(result).toEqual({
      schemaVersion: 1,
      outcome: "empty-store",
      standardOwnerCount: 0,
      candidateOwnerCount: 0,
      migratedOwnerCount: 0,
      retainedRecordCount: 0,
      upgradedRetainedRecordCount: 0,
    });
  });

  it("migrates one same-name session and registry owner through the shared service", () => {
    const harness = new InstallerStateHarness(legacySession("hermes", "agent-one"), [
      registryEntry("agent-one", "hermes"),
    ]);

    const result = reconcile(harness);

    expect(result).toMatchObject({
      outcome: "ready",
      standardOwnerCount: 1,
      migratedOwnerCount: 1,
    });
    expect(harness.prepareCalls).toEqual(["session"]);
    expect(harness.reconcileCalls).toEqual(["session"]);
    expect(harness.session?.harnessPackage?.id).toBe("hermes");
    expect(harness.registry.sandboxes["agent-one"]?.harnessPackage).toEqual(
      harness.session?.harnessPackage,
    );
    expect(harness.registry.sandboxes["agent-one"]?.harnessPackageMigration).toEqual({
      schemaVersion: 1,
      source: "legacy-current-bundle",
      legacyAgent: "hermes",
      migratedAt: MIGRATED_AT,
    });
  });

  it("converges a partial owner write without advancing its exact identity", () => {
    const installed = fixture.install("openclaw");
    const session = legacySession(null, "agent-one");
    const entry = {
      ...registryEntry("agent-one", null),
      harnessPackage: installed.identity,
      harnessPackageMigration: migration(null),
    };
    const harness = new InstallerStateHarness(session, [entry]);

    reconcile(harness);

    expect(harness.session?.harnessPackage).toEqual(installed.identity);
    expect(harness.registry.sandboxes["agent-one"]?.harnessPackage).toEqual(installed.identity);
  });

  it("keeps unrelated exact owners on different package identities and migration times", () => {
    const first = fixture.install("hermes");
    const second = fixture.advanceActivePointer("hermes", "0.2.0");
    const firstMigration = migration("hermes", "2026-08-27T10:00:00.000Z");
    const secondMigration = migration("hermes", "2026-08-28T10:00:00.000Z");
    const harness = new InstallerStateHarness(null, [
      {
        ...registryEntry("alpha", "hermes"),
        harnessPackage: first.identity,
        harnessPackageMigration: firstMigration,
      },
      {
        ...registryEntry("beta", "hermes"),
        harnessPackage: second.identity,
        harnessPackageMigration: secondMigration,
      },
    ]);

    const result = reconcile(harness);

    expect(result).toMatchObject({ standardOwnerCount: 2, migratedOwnerCount: 0 });
    expect(harness.registry.sandboxes.alpha?.harnessPackage).toEqual(first.identity);
    expect(harness.registry.sandboxes.alpha?.harnessPackageMigration).toEqual(firstMigration);
    expect(harness.registry.sandboxes.beta?.harnessPackage).toEqual(second.identity);
    expect(harness.registry.sandboxes.beta?.harnessPackageMigration).toEqual(secondMigration);
  });

  it("rejects a same-owner identity conflict", () => {
    const openclaw = fixture.install("openclaw");
    const hermes = fixture.install("hermes");
    const session = legacySession(null, "agent-one");
    session.harnessPackage = openclaw.identity;
    session.harnessPackageMigration = migration(null);
    const harness = new InstallerStateHarness(session, [
      {
        ...registryEntry("agent-one", null),
        harnessPackage: hermes.identity,
        harnessPackageMigration: migration(null),
      },
    ]);

    expect(() => reconcile(harness)).toThrow(InstallerHarnessReconciliationError);
  });

  it("accepts explicit Session nulls and normalized registry omission for candidates", () => {
    const session = legacySession("pi", "pi-owner");
    const harness = new InstallerStateHarness(session, [
      candidateRegistryEntry("pi-owner", "pi"),
      candidateRegistryEntry("cua-owner", "nemocua"),
    ]);

    const result = reconcile(harness);

    expect(result).toMatchObject({
      outcome: "empty-store",
      candidateOwnerCount: 2,
      standardOwnerCount: 0,
      migratedOwnerCount: 0,
    });
    expect(harness.prepareCalls).toEqual([]);
    expect(harness.session).toHaveProperty("harnessPackage", null);
    expect(harness.session).toHaveProperty("harnessPackageMigration", null);
    expect(harness.registry.sandboxes["pi-owner"]).not.toHaveProperty("harnessPackage");
    expect(harness.registry.sandboxes["pi-owner"]).not.toHaveProperty("harnessPackageMigration");
    expect(harness.registry.sandboxes["cua-owner"]).not.toHaveProperty("harnessPackage");
    expect(harness.registry.sandboxes["cua-owner"]).not.toHaveProperty("harnessPackageMigration");
  });

  it("fails closed without writes when candidate qualification disappears", () => {
    const harness = new InstallerStateHarness(
      null,
      [candidateRegistryEntry("pi-owner", "pi")],
      [legacyRetainedRecord("pi-owner")],
    );
    const initialState = structuredClone({
      registry: harness.registry,
      retained: harness.retained,
      session: harness.session,
    });
    const qualifiedResolver = harness.dependencies(fixture).resolveSandboxAgent!;
    let qualificationChecks = 0;

    expect(() =>
      reconcile(harness, {
        resolveSandboxAgent: (entry, options) => {
          qualificationChecks += 1;
          return qualificationChecks === 2
            ? (() => {
                throw new Error("qualification disappeared");
              })()
            : qualifiedResolver(entry, options);
        },
      }),
    ).toThrow(InstallerHarnessReconciliationError);
    expect(qualificationChecks).toBe(2);
    expect({
      registry: harness.registry,
      retained: harness.retained,
      session: harness.session,
    }).toEqual(initialState);
    expect(harness.prepareCalls).toEqual([]);
    expect(harness.reconcileCalls).toEqual([]);
  });

  it("upgrades a same-name legacy retained record with identity only", () => {
    const harness = new InstallerStateHarness(
      null,
      [registryEntry("agent-one", "hermes")],
      [legacyRetainedRecord("agent-one")],
    );

    const result = reconcile(harness);

    expect(result).toMatchObject({ retainedRecordCount: 1, upgradedRetainedRecordCount: 1 });
    expect(harness.retained).toHaveLength(1);
    expect(harness.retained[0]).toMatchObject({
      schemaVersion: 2,
      harnessPackage: harness.registry.sandboxes["agent-one"]?.harnessPackage,
    });
    expect(harness.retained[0]).not.toHaveProperty("harnessPackageMigration");
    expect(harness.retained[0]).not.toHaveProperty("migratedAt");
  });

  it("upgrades candidate retained recovery with explicit null authority", () => {
    const harness = new InstallerStateHarness(
      null,
      [candidateRegistryEntry("pi-owner", "pi")],
      [legacyRetainedRecord("pi-owner")],
    );

    const result = reconcile(harness);

    expect(result.upgradedRetainedRecordCount).toBe(1);
    expect(harness.retained[0]).toMatchObject({ schemaVersion: 2, harnessPackage: null });
  });

  it("rejects a registry owner that disappears before final verification", () => {
    const installed = fixture.install("hermes");
    const harness = new InstallerStateHarness(null, [
      { ...registryEntry("owner", "hermes"), harnessPackage: installed.identity },
    ]);
    let registryReads = 0;

    expect(() =>
      reconcile(harness, {
        readRegistryState: () => {
          registryReads += 1;
          registryReads === 4 ? delete harness.registry.sandboxes.owner : undefined;
          return { status: "valid", registry: structuredClone(harness.registry) };
        },
      }),
    ).toThrow(/owner set changed|appeared or disappeared/u);
  });

  it("rejects a new same-name registry peer before final verification", () => {
    const harness = new InstallerStateHarness(legacySession("hermes", "owner"));
    let registryReads = 0;

    expect(() =>
      reconcile(harness, {
        readRegistryState: () => {
          registryReads += 1;
          registryReads === 5
            ? (harness.registry.sandboxes.owner = {
                ...registryEntry("owner", "hermes"),
                harnessPackage: structuredClone(harness.session!.harnessPackage!),
                harnessPackageMigration: structuredClone(harness.session!.harnessPackageMigration!),
              })
            : undefined;
          return { status: "valid", registry: structuredClone(harness.registry) };
        },
      }),
    ).toThrow(/owner set changed|appeared or disappeared/u);
  });

  it("rejects an orphaned retained record before migration", () => {
    const harness = new InstallerStateHarness(null, [], [legacyRetainedRecord("orphan")]);

    expect(() => reconcile(harness)).toThrow(/no same-name registry owner/u);
    expect(harness.prepareCalls).toEqual([]);
  });

  it("rejects malformed present authority and a missing pinned object", () => {
    const malformed = new InstallerStateHarness(null, [
      {
        ...registryEntry("bad", "hermes"),
        harnessPackage: { id: "hermes" } as never,
      },
    ]);
    expect(() => reconcile(malformed)).toThrow(InstallerHarnessReconciliationError);

    const installed = fixture.install("openclaw");
    fixture.cleanup();
    const missing = new InstallerStateHarness(null, [
      {
        ...registryEntry("missing", null),
        harnessPackage: installed.identity,
      },
    ]);
    expect(() => reconcile(missing)).toThrow(InstallerHarnessReconciliationError);
  });
});
