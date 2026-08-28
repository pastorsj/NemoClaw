// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { listBundledHarnessSources } from "../harness/bundled-source";
import { installHarnessPackage } from "../harness/package-install";
import type {
  BundledHarnessPackageSourceIdentity,
  HarnessPackageReceipt,
} from "../harness/package-receipt";
import {
  resolvePinnedHarnessPackage,
  type InstalledHarnessPackage,
} from "../harness/package-store";
import type { HarnessPackageIdentity } from "../harness/package-types";
import { createSession, type Session } from "./onboard-session";
import type { SandboxEntry, SandboxRegistry } from "./registry/types";
import {
  prepareLegacyHarnessMigration,
  reconcileLegacyHarnessMigration,
  type LegacyHarnessMigrationDependencies,
  type PreparedLegacyHarnessMigration,
} from "./harness-migration";

const TEST_PARENT = path.join(
  process.cwd(),
  "node_modules/.cache/nemoclaw-harness-migration-tests",
);
const MIGRATED_AT = "2026-08-28T12:34:56.789Z";
const SOURCE_IDENTITY: BundledHarnessPackageSourceIdentity = {
  kind: "bundled",
  nemoclawBuildIdentity: {
    nemoclawVersion: "0.0.113",
    sourceRevision: "a".repeat(40),
  },
};

fs.mkdirSync(TEST_PARENT, { recursive: true, mode: 0o700 });

let fixtureRoot = path.join(process.cwd(), ".nemoclaw-harness-migration-unused");
let bundledRoot = path.join(fixtureRoot, "bundled");
let storeRoot = path.join(fixtureRoot, "store");

function writeFile(root: string, relativePath: string, contents: string): void {
  const target = path.join(root, ...relativePath.split("/"));
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.writeFileSync(target, contents, { mode: 0o600 });
  fs.chmodSync(target, 0o600);
}

function writeReviewedBundle(): void {
  fs.mkdirSync(bundledRoot, { recursive: true, mode: 0o700 });
  for (const declaration of listBundledHarnessSources()) {
    const packageRoot = path.join(bundledRoot, `nemoclaw-${declaration.id}`);
    fs.mkdirSync(packageRoot, { recursive: true, mode: 0o700 });
    writeFile(
      packageRoot,
      "nemoclaw-package.json",
      `${JSON.stringify({
        schemaVersion: 1,
        kind: "agent-runtime",
        id: declaration.id,
        displayName: declaration.displayName,
        packageVersion: declaration.packageVersion,
        contractVersion: 1,
        manifest: declaration.manifestPath,
      })}\n`,
    );
    writeFile(
      packageRoot,
      declaration.manifestPath,
      `name: ${declaration.id}\ndisplay_name: ${JSON.stringify(declaration.displayName)}\ndescription: Reviewed migration fixture\n`,
    );
    writeFile(packageRoot, "runtime/payload.txt", `${declaration.id}\n`);
  }
}

function legacySession(agent: string | null, sandboxName: string | null = "owner"): Session {
  return createSession({
    agent,
    sandboxName,
    sessionId: "migration-session",
    startedAt: "2026-08-28T10:00:00.000Z",
    updatedAt: "2026-08-28T10:00:00.000Z",
  });
}

function legacyRegistryEntry(name: string, agent: string | null): SandboxEntry {
  return { name, agent, createdAt: "2026-08-28T09:00:00.000Z" };
}

function migrationRecord(legacyAgent: string | null, migratedAt = MIGRATED_AT) {
  return {
    schemaVersion: 1 as const,
    source: "legacy-current-bundle" as const,
    legacyAgent,
    migratedAt,
  };
}

class MigrationHarness {
  session: Session | null;
  registry: SandboxRegistry;
  readonly events: string[] = [];
  failAfterRegistrySave = false;
  failRegistryLock = false;
  failPinnedRead = false;

  constructor(session: Session | null, entries: readonly SandboxEntry[]) {
    this.session = session ? structuredClone(session) : null;
    this.registry = {
      defaultSandbox: null,
      sandboxes: Object.fromEntries(entries.map((entry) => [entry.name, structuredClone(entry)])),
    };
  }

  private commitSessionCandidate(
    candidate: Session,
    mutator: (session: Session) => Session | void,
  ): "updated" {
    this.session = structuredClone(mutator(candidate) ?? candidate);
    return "updated";
  }

  private runRegistryOperation<T>(operation: () => T): T {
    try {
      return operation();
    } finally {
      this.events.push("registry-lock-exit");
    }
  }

  prepareDependencies(): Partial<LegacyHarnessMigrationDependencies> {
    return {
      loadRegistry: () => structuredClone(this.registry),
      now: () => new Date(MIGRATED_AT),
    };
  }

  reconcileDependencies(): Partial<LegacyHarnessMigrationDependencies> {
    return {
      assertWriterLockOwned: () => {
        this.events.push("writer-lock-asserted");
      },
      compareAndSwapSession: (matches, mutator) => {
        this.events.push("session-cas");
        const candidate = this.session === null ? null : structuredClone(this.session);
        return candidate !== null && matches(candidate)
          ? this.commitSessionCandidate(candidate, mutator)
          : "mismatch";
      },
      installPackage: (source, options) => {
        this.events.push("package-install");
        return installHarnessPackage(source, options);
      },
      loadRegistry: () => structuredClone(this.registry),
      loadSession: () => (this.session ? structuredClone(this.session) : null),
      resolvePinnedPackage: (identity, options) => {
        this.events.push("exact-package-read");
        const shouldFail = this.failPinnedRead;
        this.failPinnedRead = false;
        return shouldFail
          ? throwInjectedFailure("injected exact package read failure")
          : resolvePinnedHarnessPackage(identity, options);
      },
      saveRegistry: (registry) => {
        this.events.push("registry-save");
        this.registry = structuredClone(registry);
        const shouldFail = this.failAfterRegistrySave;
        this.failAfterRegistrySave = false;
        return shouldFail ? throwInjectedFailure("injected post-registry-save failure") : undefined;
      },
      withRegistryLock: (operation) => {
        this.events.push("registry-lock-enter");
        const shouldFail = this.failRegistryLock;
        this.failRegistryLock = false;
        return shouldFail
          ? throwInjectedFailure("injected registry lock failure")
          : this.runRegistryOperation(operation);
      },
    };
  }
}

function throwInjectedFailure(message: string): never {
  throw new Error(message);
}

function prepareSession(
  harness: MigrationHarness,
  session: Session = harness.session!,
): PreparedLegacyHarnessMigration {
  return prepareLegacyHarnessMigration(
    {
      owner: { kind: "session", session },
      bundledRoot,
      storeRoot,
      sourceIdentity: SOURCE_IDENTITY,
    },
    harness.prepareDependencies(),
  );
}

function prepareRegistry(
  harness: MigrationHarness,
  sandboxName: string,
): PreparedLegacyHarnessMigration {
  return prepareLegacyHarnessMigration(
    {
      owner: { kind: "registry", sandboxName },
      bundledRoot,
      storeRoot,
      sourceIdentity: SOURCE_IDENTITY,
    },
    harness.prepareDependencies(),
  );
}

function reconcile(harness: MigrationHarness, prepared: PreparedLegacyHarnessMigration): void {
  reconcileLegacyHarnessMigration(prepared, harness.reconcileDependencies());
}

beforeEach(() => {
  fixtureRoot = fs.mkdtempSync(path.join(TEST_PARENT, "fixture-"));
  fs.chmodSync(fixtureRoot, 0o700);
  bundledRoot = path.join(fixtureRoot, "bundled");
  storeRoot = path.join(fixtureRoot, "store");
  fs.mkdirSync(storeRoot, { mode: 0o700 });
  writeReviewedBundle();
});

afterEach(() => {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
});

describe("legacy harness migration", () => {
  it.each([
    [null, "openclaw"],
    ["openclaw", "openclaw"],
    ["hermes", "hermes"],
    ["langchain-deepagents-code", "langchain-deepagents-code"],
  ] as const)("maps legacy agent %s to the exact reviewed %s package", (agent, expectedId) => {
    const session = legacySession(agent);
    const harness = new MigrationHarness(session, [
      legacyRegistryEntry("owner", agent ?? "openclaw"),
    ]);
    const sessionBefore = structuredClone(harness.session);
    const registryBefore = structuredClone(harness.registry);
    const storeBefore = fs.readdirSync(storeRoot);

    const prepared = prepareSession(harness);

    expect(prepared.harnessPackage.id).toBe(expectedId);
    expect(prepared.harnessPackageMigration.legacyAgent).toBe(agent);
    expect(harness.session).toEqual(sessionBefore);
    expect(harness.registry).toEqual(registryBefore);
    expect(fs.readdirSync(storeRoot)).toEqual(storeBefore);

    reconcile(harness, prepared);

    expect(harness.session?.harnessPackage).toEqual(prepared.harnessPackage);
    expect(harness.session?.harnessPackageMigration).toEqual(prepared.harnessPackageMigration);
    expect(harness.registry.sandboxes.owner?.harnessPackage).toEqual(prepared.harnessPackage);
    expect(harness.registry.sandboxes.owner?.harnessPackageMigration).toEqual(
      prepared.harnessPackageMigration,
    );
    expect(Object.keys(prepared.harnessPackageMigration)).toEqual([
      "schemaVersion",
      "source",
      "legacyAgent",
      "migratedAt",
    ]);
    expect(resolvePinnedHarnessPackage(prepared.harnessPackage, { storeRoot }).identity).toEqual(
      prepared.harnessPackage,
    );
    expect(harness.events).toEqual([
      "writer-lock-asserted",
      "package-install",
      "exact-package-read",
      "writer-lock-asserted",
      "session-cas",
      "writer-lock-asserted",
      "registry-lock-enter",
      "registry-save",
      "registry-lock-exit",
      "writer-lock-asserted",
    ]);
  });

  it("commits a session-only owner without fabricating a registry row", () => {
    const session = legacySession("hermes", null);
    const unrelated = legacyRegistryEntry(session.sessionId, "openclaw");
    const harness = new MigrationHarness(session, [unrelated]);
    const prepared = prepareSession(harness);

    reconcile(harness, prepared);

    expect(harness.session?.harnessPackage?.id).toBe("hermes");
    expect(harness.registry.sandboxes).toEqual({ [session.sessionId]: unrelated });
    expect(harness.events).not.toContain("registry-lock-enter");
  });

  it("commits a registry-only owner without fabricating a session", () => {
    const harness = new MigrationHarness(null, [legacyRegistryEntry("hermes", "hermes")]);
    const prepared = prepareRegistry(harness, "hermes");

    reconcile(harness, prepared);

    expect(harness.session).toBeNull();
    expect(harness.registry.sandboxes.hermes?.harnessPackage?.id).toBe("hermes");
    expect(harness.events).not.toContain("session-cas");
  });

  it("leaves unrelated package owners with different identities and migration times untouched", () => {
    const session = legacySession("openclaw", "owner");
    const unrelatedIdentity: HarnessPackageIdentity = {
      kind: "agent-runtime",
      id: "hermes",
      packageVersion: "9.9.9",
      contractVersion: 1,
      contentDigest: "d".repeat(64),
    };
    const unrelated: SandboxEntry = {
      name: "unrelated",
      agent: "hermes",
      harnessPackage: unrelatedIdentity,
      harnessPackageMigration: migrationRecord("hermes", "2026-01-02T03:04:05.678Z"),
    };
    const harness = new MigrationHarness(session, [
      legacyRegistryEntry("owner", "openclaw"),
      unrelated,
    ]);

    reconcile(harness, prepareSession(harness));

    expect(harness.registry.sandboxes.unrelated).toEqual(unrelated);
  });

  it("adopts a valid same-owner peer without changing its migratedAt", () => {
    const initial = new MigrationHarness(legacySession("hermes"), [
      legacyRegistryEntry("owner", "hermes"),
    ]);
    const firstPreparation = prepareSession(initial);
    initial.failRegistryLock = true;
    expect(() => reconcile(initial, firstPreparation)).toThrow("injected registry lock failure");
    expect(initial.session?.harnessPackageMigration?.migratedAt).toBe(MIGRATED_AT);
    expect(initial.registry.sandboxes.owner?.harnessPackage).toBeUndefined();

    const retryPreparation = prepareSession(initial);
    expect(retryPreparation.harnessPackageMigration).toEqual(
      initial.session?.harnessPackageMigration,
    );
    reconcile(initial, retryPreparation);

    expect(initial.registry.sandboxes.owner?.harnessPackageMigration?.migratedAt).toBe(MIGRATED_AT);
  });

  it("adopts a migrated registry peer when its paired session remains legacy", () => {
    const harness = new MigrationHarness(legacySession("hermes"), [
      legacyRegistryEntry("owner", "hermes"),
    ]);
    const firstPreparation = prepareSession(harness);
    harness.registry.sandboxes.owner = {
      ...harness.registry.sandboxes.owner!,
      harnessPackage: firstPreparation.harnessPackage,
      harnessPackageMigration: firstPreparation.harnessPackageMigration,
    };

    const retryPreparation = prepareSession(harness);
    reconcile(harness, retryPreparation);

    expect(retryPreparation.harnessPackageMigration.migratedAt).toBe(MIGRATED_AT);
    expect(harness.session?.harnessPackage).toEqual(firstPreparation.harnessPackage);
    expect(harness.session?.harnessPackageMigration).toEqual(
      firstPreparation.harnessPackageMigration,
    );
  });

  it("converges after object publication when exact receipt readback first fails", () => {
    const harness = new MigrationHarness(legacySession("openclaw"), [
      legacyRegistryEntry("owner", "openclaw"),
    ]);
    const prepared = prepareSession(harness);
    harness.failPinnedRead = true;

    expect(() => reconcile(harness, prepared)).toThrow("injected exact package read failure");
    expect(harness.session?.harnessPackage).toBeNull();
    expect(harness.registry.sandboxes.owner?.harnessPackage).toBeUndefined();

    reconcile(harness, prepared);
    expect(harness.session?.harnessPackage).toEqual(prepared.harnessPackage);
  });

  it("converges after a registry save that persisted before reporting failure", () => {
    const harness = new MigrationHarness(legacySession("langchain-deepagents-code"), [
      legacyRegistryEntry("owner", "langchain-deepagents-code"),
    ]);
    const prepared = prepareSession(harness);
    harness.failAfterRegistrySave = true;

    expect(() => reconcile(harness, prepared)).toThrow("injected post-registry-save failure");
    expect(harness.session?.harnessPackageMigration).toEqual(prepared.harnessPackageMigration);
    expect(harness.registry.sandboxes.owner?.harnessPackageMigration).toEqual(
      prepared.harnessPackageMigration,
    );

    const retry = prepareSession(harness);
    reconcile(harness, retry);
    expect(retry.harnessPackageMigration.migratedAt).toBe(MIGRATED_AT);
  });

  it("fails closed when same-owner valid peers conflict", () => {
    const session = legacySession("openclaw");
    const harness = new MigrationHarness(session, [legacyRegistryEntry("owner", "openclaw")]);
    const openclaw = prepareSession(harness);
    const conflictingIdentity: HarnessPackageIdentity = {
      ...openclaw.harnessPackage,
      contentDigest: "e".repeat(64),
    };
    harness.session = {
      ...session,
      harnessPackage: openclaw.harnessPackage,
      harnessPackageMigration: migrationRecord(null),
    };
    harness.registry.sandboxes.owner = {
      ...harness.registry.sandboxes.owner!,
      harnessPackage: conflictingIdentity,
      harnessPackageMigration: migrationRecord(null),
    };

    expect(() => prepareSession(harness)).toThrow("same-owner package authorities conflict");
  });

  it.each(["pi", "nemocua", "unknown-agent"])("rejects non-standard legacy agent %s", (agent) => {
    const harness = new MigrationHarness(legacySession(agent), [
      legacyRegistryEntry("owner", agent),
    ]);
    expect(() => prepareSession(harness)).toThrow("is not a standard legacy harness");
  });

  it("rejects malformed or non-migration package authority", () => {
    const malformed = {
      ...legacySession("hermes"),
      harnessPackage: { id: "hermes" },
      harnessPackageMigration: null,
    } as unknown as Session;
    const malformedHarness = new MigrationHarness(malformed, []);
    expect(() => prepareSession(malformedHarness, malformed)).toThrow(
      "malformed package authority",
    );

    const healthyHarness = new MigrationHarness(legacySession("hermes"), []);
    const prepared = prepareSession(healthyHarness);
    const packageManaged = {
      ...healthyHarness.session!,
      harnessPackage: prepared.harnessPackage,
      harnessPackageMigration: null,
    };
    healthyHarness.session = packageManaged;
    expect(() => prepareSession(healthyHarness, packageManaged)).toThrow(
      "already package-managed without legacy provenance",
    );
  });

  it("does not accept an install result or active pointer without exact pinned readback", () => {
    const harness = new MigrationHarness(legacySession("openclaw"), []);
    const prepared = prepareSession(harness);
    const fakeInstalled: InstalledHarnessPackage = {
      state: "installed",
      identity: prepared.harnessPackage,
      receipt: {
        schemaVersion: 1,
        identity: prepared.harnessPackage,
        sourceIdentity: SOURCE_IDENTITY,
        installedAt: MIGRATED_AT,
      } satisfies HarnessPackageReceipt,
      packageRoot: "/not-an-exact-object",
      packageManifest: {} as InstalledHarnessPackage["packageManifest"],
    };

    expect(() =>
      reconcileLegacyHarnessMigration(prepared, {
        ...harness.reconcileDependencies(),
        installPackage: () => fakeInstalled,
        resolvePinnedPackage: () => {
          throw new Error("receipt is absent");
        },
      }),
    ).toThrow("receipt is absent");
    expect(harness.session?.harnessPackage).toBeNull();
  });

  it("rejects reviewed bytes that change between preparation and commit", () => {
    const harness = new MigrationHarness(legacySession("openclaw"), []);
    const prepared = prepareSession(harness);
    writeFile(
      path.join(bundledRoot, "nemoclaw-openclaw"),
      "runtime/payload.txt",
      "changed after preparation\n",
    );

    expect(() => reconcile(harness, prepared)).toThrow(
      "reviewed package changed after migration preparation",
    );
    expect(harness.session?.harnessPackage).toBeNull();
    expect(fs.readdirSync(storeRoot)).toEqual([]);
  });
});
