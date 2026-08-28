// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isDeepStrictEqual } from "node:util";
import path from "node:path";

import { isCandidateAgent } from "../../agent/candidate";
import { resolveSandboxAgent, type ResolvedSandboxAgent } from "../../onboard/sandbox-agent";
import {
  getBundledHarnessPackageRoot,
  listHarnessPackageInventory,
  type HarnessPackageInventory,
} from "../../harness/package-catalog";
import {
  harnessPackageIdentitiesEqual,
  inspectHarnessPackageState,
  type HarnessPackageIdentity,
  type HarnessPackageMigration,
} from "../../harness/package-identity";
import type { BundledHarnessPackageSourceIdentity } from "../../harness/package-receipt";
import {
  getHarnessPackageStoreRoot,
  resolvePinnedHarnessPackage,
  type HarnessPackageStoreOptions,
  type InstalledHarnessPackage,
} from "../../harness/package-store";
import {
  prepareLegacyHarnessMigration,
  reconcileLegacyHarnessMigration,
  type LegacyHarnessMigrationOwner,
  type PrepareLegacyHarnessMigrationInput,
  type PreparedLegacyHarnessMigration,
  type ReconciledLegacyHarnessMigration,
} from "../../state/harness-migration";
import {
  acquireOnboardLock,
  hasInvalidSessionHarnessPackage,
  listRetainedSandboxRecoveryRecords,
  readOnboardSessionState,
  reconcileRetainedRecoveryPackage,
  releaseOnboardLock,
  type LockResult,
  type OnboardSessionReadResult,
  type Session,
} from "../../state/onboard-session";
import type {
  ReconcileRetainedPackageInput,
  ReconciledRetainedPackage,
  RetainedSandboxRecoveryRecord,
} from "../../state/onboard-session/retained-sandbox-recovery";
import {
  readSandboxRegistryState,
  type SandboxRegistryReadResult,
} from "../../state/registry/persistence";
import type { SandboxEntry, SandboxRegistry } from "../../state/registry/types";

const STANDARD_HARNESS_IDS = new Set(["openclaw", "hermes", "langchain-deepagents-code"]);

export interface ReconcileInstallerHarnessesInput {
  readonly sourceIdentity: BundledHarnessPackageSourceIdentity;
  readonly bundledRoot?: string;
  readonly storeRoot?: string;
}

export interface InstallerHarnessReconciliationResult {
  readonly schemaVersion: 1;
  readonly outcome: "ready" | "empty-store";
  readonly standardOwnerCount: number;
  readonly candidateOwnerCount: number;
  readonly migratedOwnerCount: number;
  readonly retainedRecordCount: number;
  readonly upgradedRetainedRecordCount: number;
}

export class InstallerHarnessReconciliationError extends Error {
  override readonly name = "InstallerHarnessReconciliationError";

  constructor(message: string) {
    super(`Harness package reconciliation failed: ${message}`);
  }
}

interface InstallerHarnessReconciliationDependencies {
  readonly acquireOnboardLock: (command?: string | null) => LockResult;
  readonly listInventory: (options: {
    readonly bundledRoot: string;
    readonly storeRoot: string;
  }) => HarnessPackageInventory;
  readonly listRetainedRecords: () => readonly RetainedSandboxRecoveryRecord[];
  readonly readRegistryState: () => SandboxRegistryReadResult;
  readonly readSessionState: () => OnboardSessionReadResult;
  readonly prepareLegacyMigration: (
    input: PrepareLegacyHarnessMigrationInput,
  ) => PreparedLegacyHarnessMigration;
  readonly reconcileLegacyMigration: (
    prepared: PreparedLegacyHarnessMigration,
  ) => ReconciledLegacyHarnessMigration;
  readonly reconcileRetainedPackage: (
    input: ReconcileRetainedPackageInput,
  ) => ReconciledRetainedPackage;
  readonly releaseOnboardLock: () => void;
  readonly resolveSandboxAgent: (
    entry: Pick<SandboxEntry, "agent" | "harnessPackage" | "harnessPackageMigration">,
    options: { readonly storeRoot: string },
  ) => ResolvedSandboxAgent;
  readonly resolvePinnedPackage: (
    identity: HarnessPackageIdentity,
    options: HarnessPackageStoreOptions,
  ) => InstalledHarnessPackage;
}

interface OwnerSelection {
  readonly sessionId: string | null;
  readonly sandboxName: string | null;
  readonly registryOwnerExpected: boolean;
}

interface OwnerSnapshot {
  readonly selection: OwnerSelection;
  readonly session: Session | null;
  readonly registryEntry: SandboxEntry | null;
}

interface InstallerDurableState {
  readonly session: Session | null;
  readonly registry: SandboxRegistry;
}

interface PreflightedOwner {
  readonly selection: OwnerSelection;
  readonly initialOwner: OwnerSnapshot;
  readonly desiredAuthority: ExactOwnerAuthority;
  readonly preparedMigration: PreparedLegacyHarnessMigration | null;
  readonly retainedRecords: readonly RetainedSandboxRecoveryRecord[];
}

interface ExactOwnerAuthority {
  readonly kind: "standard" | "candidate";
  readonly effectiveAgentId: string;
  readonly harnessPackage: HarnessPackageIdentity | null;
  readonly harnessPackageMigration: HarnessPackageMigration | null;
  readonly requiresMigration: boolean;
}

const DEFAULT_DEPENDENCIES: InstallerHarnessReconciliationDependencies = {
  acquireOnboardLock,
  listInventory: listHarnessPackageInventory,
  listRetainedRecords: listRetainedSandboxRecoveryRecords,
  readRegistryState: readSandboxRegistryState,
  readSessionState: readOnboardSessionState,
  prepareLegacyMigration: prepareLegacyHarnessMigration,
  reconcileLegacyMigration: reconcileLegacyHarnessMigration,
  reconcileRetainedPackage: reconcileRetainedRecoveryPackage,
  releaseOnboardLock,
  resolveSandboxAgent,
  resolvePinnedPackage: resolvePinnedHarnessPackage,
};

function reconciliationError(message: string): InstallerHarnessReconciliationError {
  return new InstallerHarnessReconciliationError(message);
}

function effectiveAgentId(value: unknown): string {
  if (value === null || value === undefined || value === "openclaw") return "openclaw";
  if (typeof value !== "string" || value.length === 0) {
    throw reconciliationError("an owner has an invalid harness identifier");
  }
  if (STANDARD_HARNESS_IDS.has(value) || value === "nemocua" || isCandidateAgent(value)) {
    return value;
  }
  throw reconciliationError("an owner uses an unsupported harness identifier");
}

function sameMigration(
  left: HarnessPackageMigration | null,
  right: HarnessPackageMigration | null,
): boolean {
  return isDeepStrictEqual(left, right);
}

function ownerSelections(session: Session | null, registry: SandboxRegistry): OwnerSelection[] {
  const selections: OwnerSelection[] = [];
  const pairedSandboxName = session?.sandboxName ?? null;
  if (session) {
    selections.push({
      sessionId: session.sessionId,
      sandboxName: pairedSandboxName,
      registryOwnerExpected:
        pairedSandboxName !== null && registry.sandboxes[pairedSandboxName] !== undefined,
    });
  }
  for (const sandboxName of Object.keys(registry.sandboxes).sort()) {
    if (session && sandboxName === pairedSandboxName) continue;
    selections.push({ sessionId: null, sandboxName, registryOwnerExpected: true });
  }
  return selections;
}

function readDurableState(deps: InstallerHarnessReconciliationDependencies): InstallerDurableState {
  const sessionState = deps.readSessionState();
  if (sessionState.status === "invalid") {
    throw reconciliationError("the present onboarding session is invalid");
  }
  const registryState = deps.readRegistryState();
  if (registryState.status === "invalid") {
    throw reconciliationError("the present sandbox registry is invalid");
  }
  return {
    session: sessionState.status === "valid" ? sessionState.session : null,
    registry:
      registryState.status === "valid"
        ? registryState.registry
        : { defaultSandbox: null, sandboxes: {} },
  };
}

function readOwner(
  selection: OwnerSelection,
  deps: InstallerHarnessReconciliationDependencies,
): OwnerSnapshot {
  const state = readDurableState(deps);
  const session = state.session;
  const selectedSession =
    selection.sessionId === null
      ? null
      : session?.sessionId === selection.sessionId
        ? session
        : null;
  if (selection.sessionId !== null && selectedSession === null) {
    throw reconciliationError("the onboarding session owner changed during reconciliation");
  }
  if (selectedSession && selectedSession.sandboxName !== selection.sandboxName) {
    throw reconciliationError("the onboarding session sandbox owner changed during reconciliation");
  }
  const registry = state.registry;
  const registryEntry =
    selection.sandboxName === null ? null : (registry.sandboxes[selection.sandboxName] ?? null);
  if (selection.registryOwnerExpected !== (registryEntry !== null)) {
    throw reconciliationError(
      "a sandbox registry owner appeared or disappeared during reconciliation",
    );
  }
  return { selection, session: selectedSession, registryEntry };
}

type DurableAuthorityPeer =
  | { readonly kind: "session"; readonly value: Session }
  | { readonly kind: "registry"; readonly value: SandboxEntry };

function ownsProperty(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function inspectPeerAuthority(peer: DurableAuthorityPeer): {
  readonly effectiveAgentId: string;
  readonly candidate: boolean;
  readonly state: ReturnType<typeof inspectHarnessPackageState>;
} {
  const agentId = effectiveAgentId(peer.value.agent);
  const candidate = agentId === "nemocua" || isCandidateAgent(agentId);
  const state = inspectHarnessPackageState(
    peer.value.harnessPackage,
    peer.value.harnessPackageMigration,
  );
  if (state.status === "invalid") {
    throw reconciliationError("an owner has malformed harness package authority");
  }
  if (candidate) {
    const hasExpectedAbsentAuthority =
      peer.kind === "session"
        ? ownsProperty(peer.value, "harnessPackage") &&
          peer.value.harnessPackage === null &&
          ownsProperty(peer.value, "harnessPackageMigration") &&
          peer.value.harnessPackageMigration === null
        : !ownsProperty(peer.value, "harnessPackage") &&
          !ownsProperty(peer.value, "harnessPackageMigration");
    if (state.status !== "absent" || !hasExpectedAbsentAuthority) {
      throw reconciliationError("a qualified repository harness has fabricated package authority");
    }
    return { effectiveAgentId: agentId, candidate, state };
  }
  if (state.status === "valid" && state.harnessPackage.id !== agentId) {
    throw reconciliationError("an owner harness does not match its package identity");
  }
  return { effectiveAgentId: agentId, candidate, state };
}

function inspectOwner(owner: OwnerSnapshot): ExactOwnerAuthority {
  if (owner.session && hasInvalidSessionHarnessPackage(owner.session)) {
    throw reconciliationError("the onboarding session has malformed harness package authority");
  }
  const peers = [
    ...(owner.session ? [inspectPeerAuthority({ kind: "session", value: owner.session })] : []),
    ...(owner.registryEntry
      ? [inspectPeerAuthority({ kind: "registry", value: owner.registryEntry })]
      : []),
  ];
  const first = peers[0];
  if (!first) throw reconciliationError("an empty owner group was selected");
  if (peers.some((peer) => peer.effectiveAgentId !== first.effectiveAgentId)) {
    throw reconciliationError("same-owner session and registry harnesses conflict");
  }
  if (first.candidate) {
    return {
      kind: "candidate",
      effectiveAgentId: first.effectiveAgentId,
      harnessPackage: null,
      harnessPackageMigration: null,
      requiresMigration: false,
    };
  }

  const exactPeers = peers.filter(
    (peer): peer is typeof peer & { state: Extract<typeof peer.state, { status: "valid" }> } =>
      peer.state.status === "valid",
  );
  const firstExact = exactPeers[0]?.state;
  if (firstExact) {
    if (
      exactPeers.some(
        (peer) =>
          !harnessPackageIdentitiesEqual(peer.state.harnessPackage, firstExact.harnessPackage) ||
          !sameMigration(peer.state.harnessPackageMigration, firstExact.harnessPackageMigration),
      )
    ) {
      throw reconciliationError("same-owner package authorities conflict");
    }
    const requiresMigration = exactPeers.length !== peers.length;
    if (requiresMigration && firstExact.harnessPackageMigration === null) {
      throw reconciliationError(
        "a legacy peer cannot adopt package authority without migration provenance",
      );
    }
    return {
      kind: "standard",
      effectiveAgentId: first.effectiveAgentId,
      harnessPackage: firstExact.harnessPackage,
      harnessPackageMigration: firstExact.harnessPackageMigration,
      requiresMigration,
    };
  }
  return {
    kind: "standard",
    effectiveAgentId: first.effectiveAgentId,
    harnessPackage: null,
    harnessPackageMigration: null,
    requiresMigration: true,
  };
}

function legacyMigrationOwner(owner: OwnerSnapshot): LegacyHarnessMigrationOwner {
  return owner.session
    ? { kind: "session", session: owner.session }
    : { kind: "registry", sandboxName: owner.selection.sandboxName! };
}

function verifyExactOwnerPackage(
  authority: ExactOwnerAuthority,
  storeRoot: string,
  deps: InstallerHarnessReconciliationDependencies,
): void {
  if (authority.kind === "candidate") return;
  if (authority.harnessPackage === null) {
    throw reconciliationError("a standard harness owner is missing exact package authority");
  }
  const installed = deps.resolvePinnedPackage(authority.harnessPackage, { storeRoot });
  if (!harnessPackageIdentitiesEqual(installed.identity, authority.harnessPackage)) {
    throw reconciliationError("an exact harness package did not survive verification");
  }
}

function verifyCandidateQualification(
  owner: OwnerSnapshot,
  authority: ExactOwnerAuthority,
  storeRoot: string,
  deps: InstallerHarnessReconciliationDependencies,
): void {
  if (authority.kind !== "candidate") return;
  const peer = owner.registryEntry ?? owner.session;
  if (!peer) throw reconciliationError("a candidate owner has no durable authority peer");
  const resolved = deps.resolveSandboxAgent(
    {
      agent: peer.agent,
      ...(peer.harnessPackage == null ? {} : { harnessPackage: peer.harnessPackage }),
      ...(peer.harnessPackageMigration == null
        ? {}
        : { harnessPackageMigration: peer.harnessPackageMigration }),
    },
    { storeRoot },
  );
  if (
    resolved.effectiveAgentId !== authority.effectiveAgentId ||
    resolved.harnessPackage !== null ||
    resolved.harnessPackageMigration !== null ||
    resolved.definition.name !== authority.effectiveAgentId
  ) {
    throw reconciliationError("qualified repository harness authority did not revalidate");
  }
}

function currentRetainedRecordsForOwner(
  sandboxName: string,
  deps: InstallerHarnessReconciliationDependencies,
): readonly RetainedSandboxRecoveryRecord[] {
  return deps
    .listRetainedRecords()
    .filter((record) => record.sandboxName === sandboxName)
    .sort((left, right) =>
      left.recordId < right.recordId ? -1 : left.recordId > right.recordId ? 1 : 0,
    );
}

function preflightRetainedRecords(
  owner: OwnerSnapshot,
  harnessPackage: HarnessPackageIdentity | null,
  deps: InstallerHarnessReconciliationDependencies,
): readonly RetainedSandboxRecoveryRecord[] {
  if (!owner.registryEntry || owner.selection.sandboxName === null) return [];
  const records = currentRetainedRecordsForOwner(owner.selection.sandboxName, deps);
  for (const record of records) {
    if (record.schemaVersion === 2 && !isDeepStrictEqual(record.harnessPackage, harnessPackage)) {
      throw reconciliationError("a retained recovery record conflicts with its registry owner");
    }
  }
  return records;
}

function preflightOwner(
  owner: OwnerSnapshot,
  input: {
    readonly bundledRoot: string;
    readonly sourceIdentity: BundledHarnessPackageSourceIdentity;
    readonly storeRoot: string;
  },
  deps: InstallerHarnessReconciliationDependencies,
): PreflightedOwner {
  const authority = inspectOwner(owner);
  if (authority.kind === "candidate") {
    verifyCandidateQualification(owner, authority, input.storeRoot, deps);
    return {
      selection: owner.selection,
      initialOwner: owner,
      desiredAuthority: authority,
      preparedMigration: null,
      retainedRecords: preflightRetainedRecords(owner, null, deps),
    };
  }
  if (!authority.requiresMigration) {
    verifyExactOwnerPackage(authority, input.storeRoot, deps);
    return {
      selection: owner.selection,
      initialOwner: owner,
      desiredAuthority: authority,
      preparedMigration: null,
      retainedRecords: preflightRetainedRecords(owner, authority.harnessPackage, deps),
    };
  }
  const preparedMigration = deps.prepareLegacyMigration({
    owner: legacyMigrationOwner(owner),
    bundledRoot: input.bundledRoot,
    storeRoot: input.storeRoot,
    sourceIdentity: input.sourceIdentity,
  });
  const desiredAuthority: ExactOwnerAuthority = {
    kind: "standard",
    effectiveAgentId: preparedMigration.harnessPackage.id,
    harnessPackage: preparedMigration.harnessPackage,
    harnessPackageMigration: preparedMigration.harnessPackageMigration,
    requiresMigration: false,
  };
  if (desiredAuthority.effectiveAgentId !== authority.effectiveAgentId) {
    throw reconciliationError("prepared migration selected a different harness owner");
  }
  return {
    selection: owner.selection,
    initialOwner: owner,
    desiredAuthority,
    preparedMigration,
    retainedRecords: preflightRetainedRecords(owner, desiredAuthority.harnessPackage, deps),
  };
}

function sameOwnerAuthority(left: ExactOwnerAuthority, right: ExactOwnerAuthority): boolean {
  return (
    left.kind === right.kind &&
    left.effectiveAgentId === right.effectiveAgentId &&
    isDeepStrictEqual(left.harnessPackage, right.harnessPackage) &&
    sameMigration(left.harnessPackageMigration, right.harnessPackageMigration)
  );
}

function sameOwnerBeforeMutation(left: OwnerSnapshot, right: OwnerSnapshot): boolean {
  const fields = (owner: OwnerSnapshot) => ({
    sessionId: owner.session?.sessionId ?? null,
    sessionSandboxName: owner.session?.sandboxName ?? null,
    sessionAgent: owner.session?.agent ?? null,
    sessionPackage: owner.session?.harnessPackage ?? null,
    sessionMigration: owner.session?.harnessPackageMigration ?? null,
    registryName: owner.registryEntry?.name ?? null,
    registryAgent: owner.registryEntry?.agent ?? null,
    registryPackage: owner.registryEntry?.harnessPackage ?? null,
    registryMigration: owner.registryEntry?.harnessPackageMigration ?? null,
  });
  return isDeepStrictEqual(fields(left), fields(right));
}

function reconcileRetainedRecords(
  owner: OwnerSnapshot,
  authority: ExactOwnerAuthority,
  initial: readonly RetainedSandboxRecoveryRecord[],
  deps: InstallerHarnessReconciliationDependencies,
): { readonly total: number; readonly upgraded: number } {
  if (!owner.registryEntry || owner.selection.sandboxName === null)
    return { total: 0, upgraded: 0 };
  const sandboxName = owner.selection.sandboxName;
  let upgraded = 0;
  for (const expectedRecord of initial) {
    const result = deps.reconcileRetainedPackage({
      expectedRecord,
      harnessPackage: authority.harnessPackage,
    });
    if (result.status === "upgraded") upgraded += 1;
    const rereadOwner = inspectOwner(readOwner(owner.selection, deps));
    if (
      rereadOwner.effectiveAgentId !== authority.effectiveAgentId ||
      !isDeepStrictEqual(rereadOwner.harnessPackage, authority.harnessPackage) ||
      !sameMigration(rereadOwner.harnessPackageMigration, authority.harnessPackageMigration)
    ) {
      throw reconciliationError("an owner changed while reconciling its retained recovery record");
    }
    const currentRecords = currentRetainedRecordsForOwner(sandboxName, deps);
    if (currentRecords.length !== initial.length) {
      throw reconciliationError("the retained recovery owner set changed during reconciliation");
    }
    const reread = currentRecords.find((record) => record.recordId === result.record.recordId);
    if (!reread || reread.schemaVersion !== 2 || !isDeepStrictEqual(reread, result.record)) {
      throw reconciliationError("a retained recovery package binding did not survive readback");
    }
  }
  return { total: initial.length, upgraded };
}

function assertNoOrphanedRetainedRecords(
  registry: SandboxRegistry,
  records: readonly RetainedSandboxRecoveryRecord[],
): void {
  if (records.some((record) => registry.sandboxes[record.sandboxName] === undefined)) {
    throw reconciliationError(
      "a retained sandbox recovery record has no same-name registry owner; resolve it before upgrading",
    );
  }
}

function verifyFinalOwners(
  preflightedOwners: readonly PreflightedOwner[],
  storeRoot: string,
  deps: InstallerHarnessReconciliationDependencies,
): void {
  const finalState = readDurableState(deps);
  const finalSelections = ownerSelections(finalState.session, finalState.registry);
  const initialSelections = preflightedOwners.map(({ selection }) => selection);
  if (!isDeepStrictEqual(finalSelections, initialSelections)) {
    throw reconciliationError("the durable harness owner set changed during reconciliation");
  }
  for (const preflighted of preflightedOwners) {
    const owner = readOwner(preflighted.selection, deps);
    const authority = inspectOwner(owner);
    if (
      authority.requiresMigration ||
      !sameOwnerAuthority(authority, preflighted.desiredAuthority)
    ) {
      throw reconciliationError("an owner remained legacy after reconciliation");
    }
    verifyExactOwnerPackage(authority, storeRoot, deps);
    verifyCandidateQualification(owner, authority, storeRoot, deps);
    if (preflighted.selection.sandboxName !== null) {
      for (const record of currentRetainedRecordsForOwner(
        preflighted.selection.sandboxName,
        deps,
      )) {
        if (
          record.schemaVersion !== 2 ||
          !isDeepStrictEqual(record.harnessPackage, authority.harnessPackage)
        ) {
          throw reconciliationError("a retained recovery record does not match its registry owner");
        }
      }
    }
  }
}

/**
 * Reconcile installer-visible legacy owners before backup or runtime mutation.
 * Package installation and durable owner writes remain owned by the shared
 * migration and retained-record transactions.
 */
export function reconcileInstallerHarnesses(
  input: ReconcileInstallerHarnessesInput,
  dependencyOverrides: Partial<InstallerHarnessReconciliationDependencies> = {},
): InstallerHarnessReconciliationResult {
  const deps = { ...DEFAULT_DEPENDENCIES, ...dependencyOverrides };
  const bundledRoot = path.resolve(input.bundledRoot ?? getBundledHarnessPackageRoot());
  const storeRoot = path.resolve(input.storeRoot ?? getHarnessPackageStoreRoot());
  const lock = deps.acquireOnboardLock("nemoclaw installer harness reconciliation");
  if (!lock.acquired) {
    throw reconciliationError("another onboarding operation owns the writer lock");
  }

  try {
    const initialState = readDurableState(deps);
    const initialRetained = deps.listRetainedRecords();
    assertNoOrphanedRetainedRecords(initialState.registry, initialRetained);
    const initialInventory = deps.listInventory({ bundledRoot, storeRoot });
    if (initialInventory.installed.some((record) => record.state === "damaged")) {
      throw reconciliationError("the installed harness package store is damaged");
    }
    const selections = ownerSelections(initialState.session, initialState.registry);
    // Prepare and verify every owner before the first package or durable-state
    // write. A malformed later owner therefore cannot leave earlier owners
    // partially reconciled.
    const preflightedOwners = selections.map((selection) =>
      preflightOwner(
        readOwner(selection, deps),
        { bundledRoot, sourceIdentity: input.sourceIdentity, storeRoot },
        deps,
      ),
    );
    const standardOwnerCount = preflightedOwners.filter(
      ({ desiredAuthority }) => desiredAuthority.kind === "standard",
    ).length;
    const candidateOwnerCount = preflightedOwners.length - standardOwnerCount;
    const migratedOwnerCount = preflightedOwners.filter(
      ({ preparedMigration }) => preparedMigration !== null,
    ).length;
    let retainedRecordCount = 0;
    let upgradedRetainedRecordCount = 0;

    for (const preflighted of preflightedOwners) {
      let owner = readOwner(preflighted.selection, deps);
      if (!sameOwnerBeforeMutation(owner, preflighted.initialOwner)) {
        throw reconciliationError("an owner changed after installer reconciliation preflight");
      }
      if (preflighted.preparedMigration) {
        deps.reconcileLegacyMigration(preflighted.preparedMigration);
        owner = readOwner(preflighted.selection, deps);
      }
      const authority = inspectOwner(owner);
      if (
        authority.requiresMigration ||
        !sameOwnerAuthority(authority, preflighted.desiredAuthority)
      ) {
        throw reconciliationError("a reconciled owner did not converge on exact authority");
      }
      verifyExactOwnerPackage(authority, storeRoot, deps);
      verifyCandidateQualification(owner, authority, storeRoot, deps);

      const retained = reconcileRetainedRecords(
        owner,
        authority,
        preflighted.retainedRecords,
        deps,
      );
      retainedRecordCount += retained.total;
      upgradedRetainedRecordCount += retained.upgraded;
    }

    const finalState = readDurableState(deps);
    const finalRetained = deps.listRetainedRecords();
    assertNoOrphanedRetainedRecords(finalState.registry, finalRetained);
    verifyFinalOwners(preflightedOwners, storeRoot, deps);
    const inventory = deps.listInventory({ bundledRoot, storeRoot });
    if (inventory.installed.some((record) => record.state === "damaged")) {
      throw reconciliationError("the installed harness package store is damaged");
    }

    return Object.freeze({
      schemaVersion: 1,
      outcome:
        standardOwnerCount === 0 && inventory.installed.length === 0 ? "empty-store" : "ready",
      standardOwnerCount,
      candidateOwnerCount,
      migratedOwnerCount,
      retainedRecordCount,
      upgradedRetainedRecordCount,
    });
  } catch (error) {
    if (error instanceof InstallerHarnessReconciliationError) throw error;
    throw reconciliationError("durable state or package verification was rejected");
  } finally {
    deps.releaseOnboardLock();
  }
}
