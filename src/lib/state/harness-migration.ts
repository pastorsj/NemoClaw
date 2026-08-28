// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isDeepStrictEqual } from "node:util";
import path from "node:path";

import {
  resolveHarnessPackageInstallSelection,
  type AvailableHarnessPackageRecord,
} from "../harness/package-catalog";
import {
  harnessPackageIdentitiesEqual,
  inspectHarnessPackageState,
  parseHarnessPackageIdentity,
  parseHarnessPackageMigration,
  type HarnessPackageIdentity,
  type HarnessPackageMigration,
} from "../harness/package-identity";
import {
  installHarnessPackage,
  type InstallHarnessPackageOptions,
  type ReviewedHarnessPackageInstallSource,
} from "../harness/package-install";
import {
  parseBundledHarnessPackageSourceIdentity,
  type BundledHarnessPackageSourceIdentity,
} from "../harness/package-receipt";
import {
  resolvePinnedHarnessPackage,
  type HarnessPackageStoreOptions,
  type InstalledHarnessPackage,
} from "../harness/package-store";
import {
  assertOnboardLockOwned,
  compareAndSwapSession,
  hasInvalidSessionHarnessPackage,
  loadSession,
  type CompareAndSwapSessionResult,
  type Session,
} from "./onboard-session";
import { bindCheckpointHarnessPackageAuthority } from "./onboard-checkpoint-migrate";
import { withLock } from "./registry/lock";
import { load as loadRegistry, save as saveRegistry } from "./registry/persistence";
import type { SandboxEntry, SandboxRegistry } from "./registry/types";

const STANDARD_LEGACY_AGENTS = new Set(["openclaw", "hermes", "langchain-deepagents-code"]);

export type LegacyHarnessMigrationOwner =
  | { readonly kind: "session"; readonly session: Session }
  | { readonly kind: "registry"; readonly sandboxName: string };

export interface PrepareLegacyHarnessMigrationInput {
  readonly owner: LegacyHarnessMigrationOwner;
  readonly bundledRoot: string;
  readonly storeRoot: string;
  readonly sourceIdentity: BundledHarnessPackageSourceIdentity;
}

export interface PreparedLegacyHarnessMigration {
  readonly owner:
    | {
        readonly kind: "session";
        readonly session: Session;
        readonly sandboxName: string | null;
      }
    | {
        readonly kind: "registry";
        readonly sandboxName: string;
      };
  readonly registryEntry: SandboxEntry | null;
  readonly bundledRoot: string;
  readonly storeRoot: string;
  readonly packageRoot: string;
  readonly sourceIdentity: BundledHarnessPackageSourceIdentity;
  readonly harnessPackage: HarnessPackageIdentity;
  readonly harnessPackageMigration: HarnessPackageMigration;
}

export interface LegacyHarnessMigrationDependencies {
  readonly assertWriterLockOwned: () => void;
  readonly compareAndSwapSession: (
    matches: (session: Session) => boolean,
    mutator: (session: Session) => Session | void,
    command?: string,
  ) => CompareAndSwapSessionResult;
  readonly installPackage: (
    source: ReviewedHarnessPackageInstallSource,
    options: InstallHarnessPackageOptions,
  ) => InstalledHarnessPackage;
  readonly loadRegistry: () => SandboxRegistry;
  readonly loadSession: () => Session | null;
  readonly now: () => Date;
  readonly resolveAvailablePackage: (
    selector: string,
    options: { readonly bundledRoot: string; readonly storeRoot: string },
  ) => AvailableHarnessPackageRecord;
  readonly resolvePinnedPackage: (
    identity: HarnessPackageIdentity,
    options: HarnessPackageStoreOptions,
  ) => InstalledHarnessPackage;
  readonly saveRegistry: (registry: SandboxRegistry) => void;
  readonly withRegistryLock: <T>(operation: () => T) => T;
}

export interface ReconciledLegacyHarnessMigration {
  readonly harnessPackage: HarnessPackageIdentity;
  readonly harnessPackageMigration: HarnessPackageMigration;
}

type Authority =
  | { readonly status: "absent" }
  | {
      readonly status: "migrated";
      readonly harnessPackage: HarnessPackageIdentity;
      readonly harnessPackageMigration: HarnessPackageMigration;
    };

const DEFAULT_DEPENDENCIES: LegacyHarnessMigrationDependencies = {
  assertWriterLockOwned: assertOnboardLockOwned,
  compareAndSwapSession,
  installPackage: installHarnessPackage,
  loadRegistry,
  loadSession,
  now: () => new Date(),
  resolveAvailablePackage: resolveHarnessPackageInstallSelection,
  resolvePinnedPackage: resolvePinnedHarnessPackage,
  saveRegistry,
  withRegistryLock: withLock,
};

function migrationError(message: string): Error {
  return new Error(`Cannot migrate legacy harness authority: ${message}`);
}

function dependencies(
  overrides: Partial<LegacyHarnessMigrationDependencies>,
): LegacyHarnessMigrationDependencies {
  return { ...DEFAULT_DEPENDENCIES, ...overrides };
}

function canonicalLegacyAgent(value: unknown, label: string): string | null {
  if (value === null) return null;
  if (typeof value === "string" && STANDARD_LEGACY_AGENTS.has(value)) return value;
  throw migrationError(`${label} is not a standard legacy harness`);
}

function effectiveAgent(value: string | null): string {
  return value ?? "openclaw";
}

function sessionAuthority(session: Session): Authority {
  if (hasInvalidSessionHarnessPackage(session)) {
    throw migrationError("the onboarding session has malformed package authority");
  }
  return packageAuthority(session.harnessPackage, session.harnessPackageMigration, "session");
}

function registryAuthority(entry: SandboxEntry): Authority {
  const hasIdentity = Object.prototype.hasOwnProperty.call(entry, "harnessPackage");
  const hasMigration = Object.prototype.hasOwnProperty.call(entry, "harnessPackageMigration");
  if (
    (hasIdentity && entry.harnessPackage == null) ||
    (hasMigration && entry.harnessPackageMigration == null)
  ) {
    throw migrationError("the sandbox registry row has malformed package authority");
  }
  return packageAuthority(entry.harnessPackage, entry.harnessPackageMigration, "registry row");
}

function packageAuthority(identity: unknown, migration: unknown, label: string): Authority {
  const inspected = inspectHarnessPackageState(identity, migration);
  if (inspected.status === "invalid") {
    throw migrationError(`the ${label} has malformed package authority`);
  }
  if (inspected.status === "absent") return inspected;
  if (inspected.harnessPackageMigration === null) {
    throw migrationError(`the ${label} is already package-managed without legacy provenance`);
  }
  return {
    status: "migrated",
    harnessPackage: inspected.harnessPackage,
    harnessPackageMigration: inspected.harnessPackageMigration,
  };
}

function sameMigration(left: HarnessPackageMigration, right: HarnessPackageMigration): boolean {
  return isDeepStrictEqual(left, right);
}

function adoptSameOwnerAuthority(
  authorities: readonly Authority[],
): Extract<Authority, { status: "migrated" }> | null {
  const migrated = authorities.filter(
    (authority): authority is Extract<Authority, { status: "migrated" }> =>
      authority.status === "migrated",
  );
  const first = migrated[0];
  if (!first) return null;
  if (
    migrated.some(
      (authority) =>
        !harnessPackageIdentitiesEqual(authority.harnessPackage, first.harnessPackage) ||
        !sameMigration(authority.harnessPackageMigration, first.harnessPackageMigration),
    )
  ) {
    throw migrationError("same-owner package authorities conflict");
  }
  return first;
}

function requireCompatibleAgent(value: unknown, expected: string, label: string): string | null {
  const recorded = canonicalLegacyAgent(value, label);
  if (effectiveAgent(recorded) !== expected) {
    throw migrationError(`${label} conflicts with its same-owner peer`);
  }
  return recorded;
}

function selectedRegistryEntry(
  owner: LegacyHarnessMigrationOwner,
  registry: SandboxRegistry,
): SandboxEntry | null {
  const sandboxName = owner.kind === "session" ? owner.session.sandboxName : owner.sandboxName;
  if (sandboxName === null) return null;
  return registry.sandboxes[sandboxName] ?? null;
}

function migrationTimestamp(now: Date): string {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw migrationError("the migration clock is invalid");
  }
  return now.toISOString();
}

function cloneMigration(value: HarnessPackageMigration, identity: HarnessPackageIdentity) {
  return parseHarnessPackageMigration(structuredClone(value), identity);
}

function cloneIdentity(value: HarnessPackageIdentity): HarnessPackageIdentity {
  return parseHarnessPackageIdentity(structuredClone(value));
}

/**
 * Read and bind one legacy owner to the exact reviewed package bytes it may migrate to.
 * This phase deliberately performs no package-store, session, or registry write.
 */
export function prepareLegacyHarnessMigration(
  input: PrepareLegacyHarnessMigrationInput,
  dependencyOverrides: Partial<LegacyHarnessMigrationDependencies> = {},
): PreparedLegacyHarnessMigration {
  const deps = dependencies(dependencyOverrides);
  const bundledRoot = path.resolve(input.bundledRoot);
  const storeRoot = path.resolve(input.storeRoot);
  const sourceIdentity = parseBundledHarnessPackageSourceIdentity(input.sourceIdentity);
  const registryEntry = selectedRegistryEntry(input.owner, deps.loadRegistry());
  if (input.owner.kind === "registry" && registryEntry === null) {
    throw migrationError(`sandbox registry row '${input.owner.sandboxName}' does not exist`);
  }

  const authorities: Authority[] = [];
  let ownerLegacyAgent: string | null;
  if (input.owner.kind === "session") {
    authorities.push(sessionAuthority(input.owner.session));
    ownerLegacyAgent = canonicalLegacyAgent(
      input.owner.session.agent,
      "the onboarding session agent",
    );
  } else {
    ownerLegacyAgent = canonicalLegacyAgent(registryEntry!.agent ?? null, "the registry row agent");
  }
  if (registryEntry) authorities.push(registryAuthority(registryEntry));

  const adopted = adoptSameOwnerAuthority(authorities);
  const expectedAgent = adopted
    ? effectiveAgent(adopted.harnessPackageMigration.legacyAgent)
    : effectiveAgent(ownerLegacyAgent);
  requireCompatibleAgent(ownerLegacyAgent, expectedAgent, "the owner legacy agent");
  if (registryEntry) {
    requireCompatibleAgent(registryEntry.agent ?? null, expectedAgent, "the registry row agent");
  }

  const selected = deps.resolveAvailablePackage(expectedAgent, { bundledRoot, storeRoot });
  if (selected.id !== expectedAgent || selected.identity.id !== expectedAgent) {
    throw migrationError("the reviewed package selection does not match the legacy harness");
  }

  const harnessPackage = adopted?.harnessPackage ?? selected.identity;
  if (!harnessPackageIdentitiesEqual(harnessPackage, selected.identity)) {
    throw migrationError("persisted same-owner authority no longer matches the reviewed bundle");
  }
  const harnessPackageMigration = adopted?.harnessPackageMigration ?? {
    schemaVersion: 1,
    source: "legacy-current-bundle",
    legacyAgent: ownerLegacyAgent,
    migratedAt: migrationTimestamp(deps.now()),
  };
  const parsedMigration = cloneMigration(harnessPackageMigration, harnessPackage);

  return Object.freeze({
    owner:
      input.owner.kind === "session"
        ? Object.freeze({
            kind: "session" as const,
            session: structuredClone(input.owner.session),
            sandboxName: input.owner.session.sandboxName,
          })
        : Object.freeze({
            kind: "registry" as const,
            sandboxName: input.owner.sandboxName,
          }),
    registryEntry: registryEntry ? structuredClone(registryEntry) : null,
    bundledRoot,
    storeRoot,
    packageRoot: selected.packageRoot,
    sourceIdentity: structuredClone(sourceIdentity),
    harnessPackage: cloneIdentity(harnessPackage),
    harnessPackageMigration: parsedMigration,
  });
}

function authorityMatchesDesired(
  identity: unknown,
  migration: unknown,
  prepared: PreparedLegacyHarnessMigration,
): boolean {
  const inspected = inspectHarnessPackageState(identity, migration);
  return (
    inspected.status === "valid" &&
    inspected.harnessPackageMigration !== null &&
    harnessPackageIdentitiesEqual(inspected.harnessPackage, prepared.harnessPackage) &&
    sameMigration(inspected.harnessPackageMigration, prepared.harnessPackageMigration)
  );
}

interface PackageOwnerFields {
  readonly agent?: string | null;
  readonly harnessPackage?: unknown;
  readonly harnessPackageMigration?: unknown;
}

function packageOwnerFieldsMatch(
  current: PackageOwnerFields,
  prepared: PackageOwnerFields,
): boolean {
  return (
    current.agent === prepared.agent &&
    isDeepStrictEqual(current.harnessPackage, prepared.harnessPackage) &&
    isDeepStrictEqual(current.harnessPackageMigration, prepared.harnessPackageMigration)
  );
}

function assertPreparedBundleStillMatches(
  prepared: PreparedLegacyHarnessMigration,
  deps: LegacyHarnessMigrationDependencies,
): void {
  const selected = deps.resolveAvailablePackage(prepared.harnessPackage.id, {
    bundledRoot: prepared.bundledRoot,
    storeRoot: prepared.storeRoot,
  });
  if (
    selected.packageRoot !== prepared.packageRoot ||
    !harnessPackageIdentitiesEqual(selected.identity, prepared.harnessPackage)
  ) {
    throw migrationError("the reviewed package changed after migration preparation");
  }
}

function reconcileSession(
  prepared: PreparedLegacyHarnessMigration,
  deps: LegacyHarnessMigrationDependencies,
): void {
  if (prepared.owner.kind !== "session") return;
  const sessionOwner = prepared.owner;
  const current = deps.loadSession();
  if (!current) throw migrationError("the prepared onboarding session no longer exists");
  if (
    current.sessionId !== sessionOwner.session.sessionId ||
    current.sandboxName !== sessionOwner.sandboxName
  ) {
    throw migrationError("the prepared onboarding session owner changed");
  }
  if (current.agent !== sessionOwner.session.agent) {
    throw migrationError("the prepared onboarding session compatibility agent changed");
  }
  const ownerAuthorityIsDesired = authorityMatchesDesired(
    current.harnessPackage,
    current.harnessPackageMigration,
    prepared,
  );
  const repairedCheckpoint = bindCheckpointHarnessPackageAuthority(
    current.checkpoint,
    prepared.harnessPackage,
  );
  if (ownerAuthorityIsDesired && isDeepStrictEqual(repairedCheckpoint, current.checkpoint)) {
    return;
  }
  if (!ownerAuthorityIsDesired && !packageOwnerFieldsMatch(current, sessionOwner.session)) {
    throw migrationError("the prepared onboarding session package owner changed before migration");
  }
  const result = deps.compareAndSwapSession(
    (candidate) =>
      candidate.sessionId === sessionOwner.session.sessionId &&
      candidate.sandboxName === sessionOwner.sandboxName &&
      packageOwnerFieldsMatch(candidate, current) &&
      isDeepStrictEqual(candidate.checkpoint, current.checkpoint),
    (candidate) => ({
      ...candidate,
      harnessPackage: cloneIdentity(prepared.harnessPackage),
      harnessPackageMigration: cloneMigration(
        prepared.harnessPackageMigration,
        prepared.harnessPackage,
      ),
      checkpoint: repairedCheckpoint,
    }),
    "nemoclaw legacy harness migration",
  );
  if (result !== "updated") {
    throw migrationError(`the onboarding session compare-and-swap returned ${result}`);
  }
  const reread = deps.loadSession();
  if (
    !reread ||
    reread.sessionId !== sessionOwner.session.sessionId ||
    !authorityMatchesDesired(reread.harnessPackage, reread.harnessPackageMigration, prepared) ||
    !isDeepStrictEqual(
      reread.checkpoint,
      bindCheckpointHarnessPackageAuthority(reread.checkpoint, prepared.harnessPackage),
    )
  ) {
    throw migrationError("the onboarding session package authority did not survive readback");
  }
}

function reconcileRegistry(
  prepared: PreparedLegacyHarnessMigration,
  deps: LegacyHarnessMigrationDependencies,
): void {
  const sandboxName = prepared.owner.sandboxName;
  if (sandboxName === null) return;
  deps.withRegistryLock(() => {
    const registry = deps.loadRegistry();
    const current = registry.sandboxes[sandboxName] ?? null;
    if (prepared.registryEntry === null) {
      if (current !== null) {
        throw migrationError("a matching registry row appeared after migration preparation");
      }
      return;
    }
    if (current === null) {
      throw migrationError("the prepared registry row no longer exists");
    }
    if (
      current.name !== prepared.registryEntry.name ||
      (current.agent ?? null) !== (prepared.registryEntry.agent ?? null)
    ) {
      throw migrationError("the prepared registry compatibility agent changed");
    }
    if (
      authorityMatchesDesired(current.harnessPackage, current.harnessPackageMigration, prepared)
    ) {
      return;
    }
    if (!packageOwnerFieldsMatch(current, prepared.registryEntry)) {
      throw migrationError("the prepared registry package owner changed before migration");
    }
    registry.sandboxes[sandboxName] = {
      ...current,
      harnessPackage: cloneIdentity(prepared.harnessPackage),
      harnessPackageMigration: cloneMigration(
        prepared.harnessPackageMigration,
        prepared.harnessPackage,
      ),
    };
    deps.saveRegistry(registry);
    const reread = deps.loadRegistry().sandboxes[sandboxName];
    if (
      !reread ||
      !authorityMatchesDesired(reread.harnessPackage, reread.harnessPackageMigration, prepared)
    ) {
      throw migrationError("the registry package authority did not survive readback");
    }
  });
}

/**
 * Commit a prepared owner in the only supported lock order: onboarding writer,
 * package publication and exact readback, optional Session CAS, then registry.
 */
export function reconcileLegacyHarnessMigration(
  prepared: PreparedLegacyHarnessMigration,
  dependencyOverrides: Partial<LegacyHarnessMigrationDependencies> = {},
): ReconciledLegacyHarnessMigration {
  const deps = dependencies(dependencyOverrides);
  deps.assertWriterLockOwned();
  assertPreparedBundleStillMatches(prepared, deps);
  const installed = deps.installPackage(
    { packageRoot: prepared.packageRoot, sourceIdentity: prepared.sourceIdentity },
    { storeRoot: prepared.storeRoot },
  );
  if (!harnessPackageIdentitiesEqual(installed.identity, prepared.harnessPackage)) {
    throw migrationError("package installation returned a different identity");
  }
  const pinned = deps.resolvePinnedPackage(prepared.harnessPackage, {
    storeRoot: prepared.storeRoot,
  });
  if (!harnessPackageIdentitiesEqual(pinned.identity, prepared.harnessPackage)) {
    throw migrationError("the exact installed object and receipt do not match preparation");
  }

  deps.assertWriterLockOwned();
  reconcileSession(prepared, deps);
  deps.assertWriterLockOwned();
  reconcileRegistry(prepared, deps);
  deps.assertWriterLockOwned();

  return Object.freeze({
    harnessPackage: cloneIdentity(prepared.harnessPackage),
    harnessPackageMigration: cloneMigration(
      prepared.harnessPackageMigration,
      prepared.harnessPackage,
    ),
  });
}
