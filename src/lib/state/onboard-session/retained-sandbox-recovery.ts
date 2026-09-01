// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import { openRegularFileNoFollow } from "../../adapters/fs/regular-file";
import {
  inspectHarnessPackageState,
  parseHarnessPackageIdentity,
  type HarnessPackageIdentity,
  type HarnessPackageMigration,
} from "../../agent-runtime/package/identity";
import { NAME_MAX_LENGTH, NAME_VALID_PATTERN } from "../../sandbox-name-contract";

const STATE_SCHEMA_VERSION = 1;
const LEGACY_RECORD_SCHEMA_VERSION = 1;
const RECORD_SCHEMA_VERSION = 2;
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/u;
const CREATE_ATTEMPT_NONCE_PATTERN = /^[0-9a-f]{62}$/u;
const SAFE_EVIDENCE_PATTERN = /^[A-Za-z0-9._:@/-]{1,256}$/u;
const LEGACY_RECORD_FIELDS = new Set([
  "schemaVersion",
  "recordId",
  "sandboxName",
  "sandboxIdentityFingerprint",
  "identityWasUnavailable",
  "gatewayName",
  "gatewayPort",
  "lifecycleGeneration",
  "createAttemptNonce",
  "resources",
  "reason",
  "recordedAt",
]);
const CURRENT_RECORD_FIELDS = new Set([...LEGACY_RECORD_FIELDS, "harnessPackage"]);

export function retainedSandboxRecoveryFile(sessionDirectory: string): string {
  return path.join(sessionDirectory, "retained-sandbox-recovery.json");
}

export type RetainedSandboxRecoveryReason =
  | "cancelled_after_sandbox_creation"
  | "retained_after_sandbox_creation_failure";

export interface RetainedSandboxResourceEvidence {
  readonly sharedInferenceProviders: readonly string[];
  readonly sandboxScopedProviders: readonly string[];
  readonly credentialEnvironmentVariables: readonly string[];
}

interface RetainedSandboxRecoveryRecordFields {
  readonly recordId: string;
  readonly sandboxName: string;
  readonly sandboxIdentityFingerprint: string | null;
  readonly identityWasUnavailable: boolean;
  readonly gatewayName: string;
  readonly gatewayPort: number;
  readonly lifecycleGeneration: string | null;
  readonly createAttemptNonce: string;
  readonly resources: RetainedSandboxResourceEvidence;
  readonly reason: RetainedSandboxRecoveryReason;
  readonly recordedAt: string;
}

export interface LegacyRetainedSandboxRecoveryRecord extends RetainedSandboxRecoveryRecordFields {
  readonly schemaVersion: typeof LEGACY_RECORD_SCHEMA_VERSION;
}

export interface CurrentRetainedSandboxRecoveryRecord extends RetainedSandboxRecoveryRecordFields {
  readonly schemaVersion: typeof RECORD_SCHEMA_VERSION;
  /** Exact package authority, or explicit null for a qualified candidate runtime. */
  readonly harnessPackage: HarnessPackageIdentity | null;
}

export type RetainedSandboxRecoveryRecord =
  | LegacyRetainedSandboxRecoveryRecord
  | CurrentRetainedSandboxRecoveryRecord;
interface RetainedSandboxRecoveryState {
  readonly schemaVersion: typeof STATE_SCHEMA_VERSION;
  readonly unresolved: readonly RetainedSandboxRecoveryRecord[];
}

interface RetainedSandboxStateDirectory {
  readonly ancestors: readonly { readonly path: string; readonly stat: fs.Stats }[];
  readonly descriptor: number;
  readonly path: string;
  readonly stat: fs.Stats;
}

export interface RecordRetainedSandboxRecoveryInput {
  readonly sandboxName: string;
  readonly sandboxIdentityFingerprint: string | null;
  readonly gatewayName: string;
  readonly gatewayPort: number;
  readonly lifecycleGeneration: string | null;
  readonly harnessPackage: HarnessPackageIdentity | null;
  readonly createAttemptNonce: string;
  readonly resources: RetainedSandboxResourceEvidence;
  readonly reason: RetainedSandboxRecoveryReason;
  readonly recordedAt?: string;
}

export interface ReconcileRetainedPackageInput {
  readonly expectedRecord: RetainedSandboxRecoveryRecord;
  readonly harnessPackage: HarnessPackageIdentity | null;
}

export interface ReconciledRetainedPackage {
  readonly status: "verified" | "upgraded";
  readonly record: CurrentRetainedSandboxRecoveryRecord;
}

interface RetainedPackageOwner {
  readonly agent: string | null;
  readonly harnessPackage: HarnessPackageIdentity | null;
  readonly harnessPackageMigration: HarnessPackageMigration | null;
}

/** Require exact package authority, or explicit null for a qualified repository agent. */
export function requireRetainedRecoveryPackage(
  owner: RetainedPackageOwner,
): HarnessPackageIdentity | null {
  const trimmedAgent = typeof owner.agent === "string" ? owner.agent.trim() : "";
  const effectiveAgentId = trimmedAgent && trimmedAgent !== "openclaw" ? trimmedAgent : "openclaw";
  const packageState = inspectHarnessPackageState(
    owner.harnessPackage,
    owner.harnessPackageMigration,
  );
  if (effectiveAgentId === "nemocua") {
    if (
      packageState.status !== "absent" ||
      owner.harnessPackage !== null ||
      owner.harnessPackageMigration !== null
    ) {
      throw new Error(
        "Cannot persist retained recovery with fabricated qualified-agent package authority.",
      );
    }
    return null;
  }
  if (packageState.status !== "valid" || packageState.harnessPackage.id !== effectiveAgentId) {
    throw new Error("Cannot persist retained recovery without exact harness package authority.");
  }
  return packageState.harnessPackage;
}

const emptyState = (): RetainedSandboxRecoveryState => ({
  schemaVersion: STATE_SCHEMA_VERSION,
  unresolved: [],
});

function sameFileIdentity(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function stateDirectoryAncestors(directory: string): string[] {
  const home = path.resolve(process.env.HOME ?? path.dirname(directory));
  const resolved = path.resolve(directory);
  const relative = path.relative(home, resolved);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    return [resolved];
  }
  const ancestors: string[] = [];
  let current = home;
  for (const component of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    ancestors.push(current);
  }
  return ancestors;
}

function assertStateDirectoryComponent(candidate: string, stat: fs.Stats): void {
  if (stat.isSymbolicLink()) {
    throw new Error(
      `Retained sandbox recovery state directory cannot be a symbolic link: ${candidate}`,
    );
  }
  if (!stat.isDirectory()) {
    throw new Error(`Retained sandbox recovery state directory is not a directory: ${candidate}`);
  }
}

function openStateDirectory(
  filePath: string,
  create: boolean,
): RetainedSandboxStateDirectory | null {
  const directory = path.dirname(filePath);
  const ancestorPaths = stateDirectoryAncestors(directory);
  for (const candidate of ancestorPaths) {
    try {
      assertStateDirectoryComponent(candidate, fs.lstatSync(candidate));
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        (error as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        continue;
      }
      throw error;
    }
  }
  if (create) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });

  const ancestors: Array<{ path: string; stat: fs.Stats }> = [];
  try {
    for (const candidate of ancestorPaths) {
      const stat = fs.lstatSync(candidate);
      assertStateDirectoryComponent(candidate, stat);
      ancestors.push({ path: candidate, stat });
    }
  } catch (error) {
    if (
      !create &&
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return null;
    }
    throw error;
  }

  const flags =
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_DIRECTORY ?? 0);
  const descriptor = fs.openSync(directory, flags);
  try {
    const descriptorStat = fs.fstatSync(descriptor);
    const pathStat = fs.lstatSync(directory);
    assertStateDirectoryComponent(directory, descriptorStat);
    assertStateDirectoryComponent(directory, pathStat);
    if (!sameFileIdentity(descriptorStat, pathStat)) {
      throw new Error("Retained sandbox recovery state directory changed during validation.");
    }
    return { ancestors, descriptor, path: directory, stat: descriptorStat };
  } catch (error) {
    fs.closeSync(descriptor);
    throw error;
  }
}

function revalidateStateDirectory(directory: RetainedSandboxStateDirectory): void {
  for (const ancestor of directory.ancestors) {
    const current = fs.lstatSync(ancestor.path);
    assertStateDirectoryComponent(ancestor.path, current);
    if (!sameFileIdentity(ancestor.stat, current)) {
      throw new Error("Retained sandbox recovery state directory changed during validation.");
    }
  }
  const descriptorStat = fs.fstatSync(directory.descriptor);
  const pathStat = fs.lstatSync(directory.path);
  assertStateDirectoryComponent(directory.path, descriptorStat);
  assertStateDirectoryComponent(directory.path, pathStat);
  if (
    !sameFileIdentity(directory.stat, descriptorStat) ||
    !sameFileIdentity(directory.stat, pathStat)
  ) {
    throw new Error("Retained sandbox recovery state directory changed during validation.");
  }
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactFields(value: Record<string, unknown>, fields: ReadonlySet<string>): boolean {
  const keys = Object.keys(value);
  return keys.length === fields.size && keys.every((key) => fields.has(key));
}

function readStateFile(filePath: string): unknown {
  const directory = openStateDirectory(filePath, false);
  if (directory === null) return emptyState();
  try {
    revalidateStateDirectory(directory);
    const file = openRegularFileNoFollow(filePath);
    try {
      const value = JSON.parse(file.readUtf8());
      revalidateStateDirectory(directory);
      return value;
    } finally {
      file.close();
    }
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return emptyState();
    }
    if (
      error instanceof Error &&
      "code" in error &&
      ((error as NodeJS.ErrnoException).code === "ELOOP" ||
        (error as NodeJS.ErrnoException).code === "EMLINK")
    ) {
      throw new Error("Retained sandbox recovery state cannot be a symbolic link.");
    }
    throw error;
  } finally {
    fs.closeSync(directory.descriptor);
  }
}

function assertTemporaryStateFile(descriptor: number, temporary: string): fs.Stats {
  const descriptorStat = fs.fstatSync(descriptor);
  const pathStat = fs.lstatSync(temporary);
  if (
    !descriptorStat.isFile() ||
    descriptorStat.nlink !== 1 ||
    pathStat.isSymbolicLink() ||
    !pathStat.isFile() ||
    pathStat.nlink !== 1 ||
    !sameFileIdentity(descriptorStat, pathStat)
  ) {
    throw new Error("Retained sandbox recovery temporary state changed during validation.");
  }
  return descriptorStat;
}

function writeStateFile(filePath: string, state: RetainedSandboxRecoveryState): void {
  const directory = openStateDirectory(filePath, true)!;
  try {
    revalidateStateDirectory(directory);
    if (fs.lstatSync(filePath).isSymbolicLink()) {
      throw new Error("Retained sandbox recovery state cannot be a symbolic link.");
    }
  } catch (error) {
    if (
      !(
        error instanceof Error &&
        "code" in error &&
        (error as NodeJS.ErrnoException).code === "ENOENT"
      )
    ) {
      fs.closeSync(directory.descriptor);
      throw error;
    }
  }
  const temporary = path.join(
    directory.path,
    `.retained-sandbox-recovery.${String(process.pid)}.${randomUUID()}.tmp`,
  );
  let descriptor: number | null = null;
  let temporaryStat: fs.Stats | null = null;
  try {
    descriptor = fs.openSync(
      temporary,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        (fs.constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    revalidateStateDirectory(directory);
    temporaryStat = assertTemporaryStateFile(descriptor, temporary);
    fs.writeFileSync(descriptor, JSON.stringify(state, null, 2));
    fs.fchmodSync(descriptor, 0o600);
    fs.fsyncSync(descriptor);
    temporaryStat = assertTemporaryStateFile(descriptor, temporary);
    fs.closeSync(descriptor);
    descriptor = null;
    revalidateStateDirectory(directory);
    fs.renameSync(temporary, filePath);
    revalidateStateDirectory(directory);
    fs.fsyncSync(directory.descriptor);
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
    try {
      revalidateStateDirectory(directory);
      const pathStat = fs.lstatSync(temporary);
      if (
        temporaryStat !== null &&
        pathStat.isFile() &&
        pathStat.nlink === 1 &&
        sameFileIdentity(temporaryStat, pathStat)
      ) {
        fs.unlinkSync(temporary);
      }
    } catch {
      // Preserve the original result. Ambiguous paths are left untouched.
    }
    fs.closeSync(directory.descriptor);
  }
}

function validSandboxName(value: unknown): value is string {
  return (
    typeof value === "string" && value.length <= NAME_MAX_LENGTH && NAME_VALID_PATTERN.test(value)
  );
}

function validSafeEvidence(value: unknown): value is string {
  return typeof value === "string" && SAFE_EVIDENCE_PATTERN.test(value);
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function validGatewayPort(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 1024 && Number(value) <= 65535;
}

function parseEvidence(value: unknown): RetainedSandboxResourceEvidence | null {
  if (!isObjectRecord(value)) return null;
  const parse = (candidate: unknown): string[] | null =>
    Array.isArray(candidate) && candidate.every(validSafeEvidence)
      ? [...new Set(candidate)].sort()
      : null;
  const sharedInferenceProviders = parse(value.sharedInferenceProviders);
  const sandboxScopedProviders = parse(value.sandboxScopedProviders);
  const credentialEnvironmentVariables = parse(value.credentialEnvironmentVariables);
  return sharedInferenceProviders && sandboxScopedProviders && credentialEnvironmentVariables
    ? { sharedInferenceProviders, sandboxScopedProviders, credentialEnvironmentVariables }
    : null;
}

function parseNullableHarnessPackageIdentity(
  value: unknown,
): HarnessPackageIdentity | null | undefined {
  if (value === null) return null;
  try {
    return parseHarnessPackageIdentity(value);
  } catch {
    return undefined;
  }
}

function parseRecord(value: unknown): RetainedSandboxRecoveryRecord | null {
  if (!isObjectRecord(value)) return null;
  const schemaVersion = value.schemaVersion;
  const fields =
    schemaVersion === LEGACY_RECORD_SCHEMA_VERSION
      ? LEGACY_RECORD_FIELDS
      : schemaVersion === RECORD_SCHEMA_VERSION
        ? CURRENT_RECORD_FIELDS
        : null;
  if (fields === null || !hasExactFields(value, fields)) return null;
  const resources = parseEvidence(value.resources);
  const fingerprint = value.sandboxIdentityFingerprint;
  const reason = value.reason;
  const harnessPackage =
    schemaVersion === RECORD_SCHEMA_VERSION
      ? parseNullableHarnessPackageIdentity(value.harnessPackage)
      : undefined;
  if (
    typeof value.recordId !== "string" ||
    !FINGERPRINT_PATTERN.test(value.recordId) ||
    !validSandboxName(value.sandboxName) ||
    (fingerprint !== null &&
      (typeof fingerprint !== "string" || !FINGERPRINT_PATTERN.test(fingerprint))) ||
    value.identityWasUnavailable !== (fingerprint === null) ||
    !validSafeEvidence(value.gatewayName) ||
    !validGatewayPort(value.gatewayPort) ||
    (value.lifecycleGeneration !== null && !validSafeEvidence(value.lifecycleGeneration)) ||
    typeof value.createAttemptNonce !== "string" ||
    !CREATE_ATTEMPT_NONCE_PATTERN.test(value.createAttemptNonce) ||
    !resources ||
    !["cancelled_after_sandbox_creation", "retained_after_sandbox_creation_failure"].includes(
      String(reason),
    ) ||
    !validTimestamp(value.recordedAt)
  ) {
    return null;
  }
  if (schemaVersion === RECORD_SCHEMA_VERSION && harnessPackage === undefined) return null;
  const sharedFields = {
    recordId: value.recordId,
    sandboxName: value.sandboxName,
    sandboxIdentityFingerprint: fingerprint,
    identityWasUnavailable: fingerprint === null,
    gatewayName: value.gatewayName,
    gatewayPort: value.gatewayPort,
    lifecycleGeneration: value.lifecycleGeneration,
    createAttemptNonce: value.createAttemptNonce,
    resources,
    reason: reason as RetainedSandboxRecoveryReason,
    recordedAt: value.recordedAt,
  };
  const record: RetainedSandboxRecoveryRecord =
    schemaVersion === LEGACY_RECORD_SCHEMA_VERSION
      ? {
          schemaVersion: LEGACY_RECORD_SCHEMA_VERSION,
          ...sharedFields,
        }
      : {
          schemaVersion: RECORD_SCHEMA_VERSION,
          ...sharedFields,
          harnessPackage: harnessPackage!,
        };
  return record.recordId === recoveryRecordId(record) ? record : null;
}
function loadState(filePath: string): RetainedSandboxRecoveryState {
  const value = readStateFile(filePath);
  if (!isObjectRecord(value) || value.schemaVersion !== STATE_SCHEMA_VERSION) {
    throw new Error("Retained sandbox recovery state has an unsupported schema.");
  }
  const unresolved = Array.isArray(value.unresolved) ? value.unresolved.map(parseRecord) : null;
  if (!unresolved || unresolved.includes(null)) {
    throw new Error("Retained sandbox recovery state is invalid; onboarding remains blocked.");
  }
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    unresolved: unresolved as RetainedSandboxRecoveryRecord[],
  };
}

function recoveryRecordId(
  input:
    | RecordRetainedSandboxRecoveryInput
    | LegacyRetainedSandboxRecoveryRecord
    | CurrentRetainedSandboxRecoveryRecord,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        input.gatewayName,
        input.gatewayPort,
        input.sandboxName,
        input.sandboxIdentityFingerprint,
        input.lifecycleGeneration,
        input.createAttemptNonce,
        ...("harnessPackage" in input ? [input.harnessPackage] : []),
      ]),
    )
    .digest("hex");
}

function assertRecordInput(input: RecordRetainedSandboxRecoveryInput): void {
  if (
    !validSandboxName(input.sandboxName) ||
    (input.sandboxIdentityFingerprint !== null &&
      !FINGERPRINT_PATTERN.test(input.sandboxIdentityFingerprint)) ||
    !validSafeEvidence(input.gatewayName) ||
    !validGatewayPort(input.gatewayPort) ||
    (input.lifecycleGeneration !== null && !validSafeEvidence(input.lifecycleGeneration)) ||
    parseNullableHarnessPackageIdentity(input.harnessPackage) === undefined ||
    !CREATE_ATTEMPT_NONCE_PATTERN.test(input.createAttemptNonce) ||
    !parseEvidence(input.resources)
  ) {
    throw new Error("Cannot persist invalid retained sandbox recovery evidence.");
  }
}

export function listRetainedSandboxRecoveryRecords(
  filePath: string,
): readonly RetainedSandboxRecoveryRecord[] {
  return loadState(filePath).unresolved;
}

export function recordRetainedSandboxRecovery(
  filePath: string,
  input: RecordRetainedSandboxRecoveryInput,
): RetainedSandboxRecoveryRecord {
  assertRecordInput(input);
  const normalizedInput: RecordRetainedSandboxRecoveryInput = {
    ...input,
    harnessPackage: parseNullableHarnessPackageIdentity(input.harnessPackage)!,
    createAttemptNonce: input.createAttemptNonce,
    resources: parseEvidence(input.resources)!,
  };
  const record: RetainedSandboxRecoveryRecord = {
    schemaVersion: RECORD_SCHEMA_VERSION,
    recordId: recoveryRecordId(normalizedInput),
    sandboxName: normalizedInput.sandboxName,
    sandboxIdentityFingerprint: normalizedInput.sandboxIdentityFingerprint,
    identityWasUnavailable: normalizedInput.sandboxIdentityFingerprint === null,
    gatewayName: normalizedInput.gatewayName,
    gatewayPort: normalizedInput.gatewayPort,
    lifecycleGeneration: normalizedInput.lifecycleGeneration,
    createAttemptNonce: normalizedInput.createAttemptNonce,
    harnessPackage: normalizedInput.harnessPackage,
    resources: normalizedInput.resources,
    reason: normalizedInput.reason,
    recordedAt: normalizedInput.recordedAt ?? new Date().toISOString(),
  };
  if (!validTimestamp(record.recordedAt)) {
    throw new Error("Cannot persist retained sandbox recovery with an invalid timestamp.");
  }
  const current = loadState(filePath);
  const next: RetainedSandboxRecoveryState = {
    ...current,
    unresolved: [
      ...current.unresolved.filter((candidate) => candidate.recordId !== record.recordId),
      record,
    ],
  };
  writeStateFile(filePath, next);
  const reread = loadState(filePath).unresolved.find(
    (candidate) => candidate.recordId === record.recordId,
  );
  if (!reread || !isDeepStrictEqual(reread, record)) {
    throw new Error("Retained sandbox recovery record did not survive durable readback.");
  }
  return reread;
}

function bindPackageToLegacyRecord(
  legacy: LegacyRetainedSandboxRecoveryRecord,
  harnessPackage: HarnessPackageIdentity | null,
): CurrentRetainedSandboxRecoveryRecord {
  const current: CurrentRetainedSandboxRecoveryRecord = {
    schemaVersion: RECORD_SCHEMA_VERSION,
    recordId: "",
    sandboxName: legacy.sandboxName,
    sandboxIdentityFingerprint: legacy.sandboxIdentityFingerprint,
    identityWasUnavailable: legacy.identityWasUnavailable,
    gatewayName: legacy.gatewayName,
    gatewayPort: legacy.gatewayPort,
    lifecycleGeneration: legacy.lifecycleGeneration,
    createAttemptNonce: legacy.createAttemptNonce,
    harnessPackage,
    resources: legacy.resources,
    reason: legacy.reason,
    recordedAt: legacy.recordedAt,
  };
  return { ...current, recordId: recoveryRecordId(current) };
}

/**
 * Bind one explicitly selected legacy record to package authority after its
 * owning state has been reconciled. This store does not choose that authority.
 */
export function reconcileRetainedRecoveryPackage(
  filePath: string,
  input: ReconcileRetainedPackageInput,
): ReconciledRetainedPackage {
  const expectedRecord = parseRecord(input.expectedRecord);
  const harnessPackage = parseNullableHarnessPackageIdentity(input.harnessPackage);
  if (!expectedRecord || harnessPackage === undefined) {
    throw new Error("Cannot reconcile invalid retained sandbox package authority.");
  }
  const current = loadState(filePath);
  const desiredRecord =
    expectedRecord.schemaVersion === LEGACY_RECORD_SCHEMA_VERSION
      ? bindPackageToLegacyRecord(expectedRecord, harnessPackage)
      : null;
  const selected = current.unresolved.find((record) => record.recordId === expectedRecord.recordId);
  if (!selected && desiredRecord) {
    const alreadyReconciled = current.unresolved.filter(
      (record) => record.recordId === desiredRecord.recordId,
    );
    if (
      alreadyReconciled.length === 1 &&
      alreadyReconciled[0]?.schemaVersion === RECORD_SCHEMA_VERSION &&
      isDeepStrictEqual(alreadyReconciled[0], desiredRecord)
    ) {
      return { status: "verified", record: alreadyReconciled[0] };
    }
  }
  if (
    !selected ||
    current.unresolved.filter((record) => record.recordId === expectedRecord.recordId).length !==
      1 ||
    !isDeepStrictEqual(selected, expectedRecord)
  ) {
    throw new Error("Retained sandbox recovery record changed before package reconciliation.");
  }
  if (selected.schemaVersion === RECORD_SCHEMA_VERSION) {
    if (!isDeepStrictEqual(selected.harnessPackage, harnessPackage)) {
      throw new Error("Retained sandbox package authority does not match its current record.");
    }
    return { status: "verified", record: selected };
  }
  const legacy = selected;
  const nextRecord = desiredRecord!;
  const collision = current.unresolved.find(
    (record) => record.recordId === nextRecord.recordId && record.recordId !== legacy.recordId,
  );
  if (collision && !isDeepStrictEqual(collision, nextRecord)) {
    throw new Error("Retained sandbox package reconciliation conflicts with another record.");
  }
  const next: RetainedSandboxRecoveryState = {
    ...current,
    unresolved: [
      ...current.unresolved.filter(
        (record) => record.recordId !== legacy.recordId && record.recordId !== nextRecord.recordId,
      ),
      nextRecord,
    ],
  };
  writeStateFile(filePath, next);
  const durable = loadState(filePath).unresolved;
  const reread = durable.find((record) => record.recordId === nextRecord.recordId);
  if (
    !reread ||
    reread.schemaVersion !== RECORD_SCHEMA_VERSION ||
    !isDeepStrictEqual(reread, nextRecord) ||
    durable.some((record) => record.recordId === legacy.recordId) ||
    durable.filter((record) => record.recordId === nextRecord.recordId).length !== 1
  ) {
    throw new Error("Retained sandbox package binding did not survive durable readback.");
  }
  return { status: "upgraded", record: reread };
}

function retainedSandboxRecoveryAuthorityMatchesState(
  state: RetainedSandboxRecoveryState,
  expected: RetainedSandboxRecoveryRecord,
): boolean {
  const recorded = state.unresolved.find(
    (candidate) => candidate.recordId === expected.recordId,
  );
  if (!recorded) return false;
  if (!isDeepStrictEqual(recorded, expected)) {
    throw new Error("Retained sandbox recovery authority changed before cleanup completed.");
  }
  return true;
}

/** Confirm that the exact cleanup authority is still present and unchanged. */
export function retainedSandboxRecoveryAuthorityIsCurrent(
  filePath: string,
  expected: RetainedSandboxRecoveryRecord,
): boolean {
  return retainedSandboxRecoveryAuthorityMatchesState(loadState(filePath), expected);
}

/** Retire only the unchanged record whose external resources were verified absent. */
export function resolveRetainedSandboxRecovery(
  filePath: string,
  expected: RetainedSandboxRecoveryRecord,
): boolean {
  const current = loadState(filePath);
  if (!retainedSandboxRecoveryAuthorityMatchesState(current, expected)) return false;
  writeStateFile(filePath, {
    ...current,
    unresolved: current.unresolved.filter((candidate) => candidate.recordId !== expected.recordId),
  });
  if (loadState(filePath).unresolved.some((candidate) => candidate.recordId === expected.recordId)) {
    throw new Error("Retained sandbox recovery record remained after verified cleanup.");
  }
  return true;
}
