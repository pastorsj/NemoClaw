// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { OpenShellRuntimeSelection } from "../../adapters/openshell/runtime-selection";
import {
  inspectHarnessPackageState,
  type HarnessPackageIdentity,
  type HarnessPackageMigration,
} from "../../agent-runtime/package/identity";
import {
  checkpointGatewayAuthority,
  gatewayOwnerFromCheckpoint,
} from "../../onboard/gateway-authority-checkpoint";
import { describeGatewayOwnerForError, sameGatewayOwner } from "../../onboard/gateway-ownership";
import {
  GatewayAuthorityError,
  gatewayAuthorityFailureLines,
  isManagedPackagedServiceMigration,
  resolveGatewayRebuildAuthority,
} from "../../onboard/gateway-teardown-authority";
import {
  observeSandboxOnGateway,
  observeSandboxPresenceOnGateway,
  type SandboxRecreateObserver,
  type SandboxRecreateTarget,
} from "../../onboard/sandbox-recreate-probe";
import {
  advanceSandboxRecreateTransaction,
  beginSandboxRecreateDelete,
  clearCompletedSandboxRecreateTransaction,
  fingerprintSandboxRecreateValue,
  ownSandboxRecreateTransaction,
  type SandboxRecreateSourcePresence,
  sandboxRecreatePhaseReached,
} from "../../onboard/sandbox-recreate-transaction";
import { isValidName } from "../../sandbox-name-contract";
import { decisionSelected } from "../../state/onboard-checkpoint-decision";
import {
  bindCheckpointHarnessPackageAuthority,
  deriveCheckpointFromSession,
} from "../../state/onboard-checkpoint-migrate";
import type {
  CheckpointGatewayAuthority,
  CheckpointSandboxRecreatePhase,
} from "../../state/onboard-checkpoint-types";
import * as onboardSession from "../../state/onboard-session";
import * as registry from "../../state/registry";
import { REBUILD_RECOVERY_MARKER_FILE } from "../../state/snapshot/content-digest";
import {
  inspectRebuildManifestHarnessPackage,
  clearRebuildPolicyHandoff,
  listBackups,
  type RebuildManifest,
  type SnapshotEntry,
  validateRebuildRecoveryManifest,
} from "../../state/sandbox";
import { rebuildPackageAuthorityMatches, type RebuildPackageAuthority } from "./rebuild/authority";
import type { RebuildRecreateOnboardOpts } from "./rebuild-gpu-opt-out";

export type { RebuildPackageAuthority } from "./rebuild/authority";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

type RebuildRecoveryBackupRecordV1 = {
  readonly schemaVersion: 1;
  readonly transactionId: string;
  readonly sandboxName: string;
  readonly backupTimestamp: string;
};

type RebuildRecoveryBackupRecordV2 = {
  readonly schemaVersion: 2;
  readonly transactionId: string;
  readonly sandboxName: string;
  readonly backupTimestamp: string;
  readonly gatewayName: string;
  readonly gatewayPort: number;
};

type RebuildRecoveryBackupRecordV3 = {
  readonly schemaVersion: 3;
  readonly transactionId: string;
  readonly sandboxName: string;
  readonly backupTimestamp: string;
  readonly gatewayName: string;
  readonly gatewayPort: number;
  readonly phase: "restore" | "cleanup";
};

type RebuildRecoveryBackupRecord =
  | RebuildRecoveryBackupRecordV1
  | RebuildRecoveryBackupRecordV2
  | RebuildRecoveryBackupRecordV3;

type RebuildRecoveryBackupIdentity = {
  readonly sandboxName: string;
  readonly agentName: string | null | undefined;
  readonly transactionId: string;
  readonly packageAuthority: RebuildPackageAuthority;
};

interface RebuildRecoveryBackupDeps {
  readonly listBackups?: typeof listBackups;
  readonly validateManifest?: typeof validateRebuildRecoveryManifest;
  readonly observePresence?: typeof observeSandboxPresenceOnGateway;
  readonly clearPolicyHandoff?: typeof clearRebuildPolicyHandoff;
}

function validateRecoveryIdentity(
  input: Pick<RebuildRecoveryBackupIdentity, "sandboxName" | "transactionId">,
): void {
  if (!isValidName(input.sandboxName)) {
    throw new Error("Rebuild recovery sandbox identity is invalid.");
  }
  if (!UUID_PATTERN.test(input.transactionId)) {
    throw new Error("Rebuild recovery transaction identity is invalid.");
  }
}

function recoveryPath(backupPath: string): string {
  return path.join(backupPath, REBUILD_RECOVERY_MARKER_FILE);
}

function invalidRecoveryRecordError(backupPath: string, detail: string, cause?: unknown): Error {
  return new Error(
    `Rebuild recovery marker at '${recoveryPath(backupPath)}' is invalid or unreadable (${detail}). ` +
      `Recovery remains at '${backupPath}'. Do not edit or remove the marker or retained policy handoff. ` +
      "Restore the marker's mode and ownership if those are the only damaged attributes, or restore the exact marker from a trusted backup, then rerun the same retirement command. " +
      "If no trusted marker is available, preserve the backup and ask a NemoClaw maintainer to inspect it.",
    { cause },
  );
}

function syncDirectory(directory: string): void {
  const descriptor = fs.openSync(directory, "r");
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function validatedRecoveryManifest(
  input: RebuildRecoveryBackupIdentity,
  manifest: RebuildManifest,
  deps: RebuildRecoveryBackupDeps,
): RebuildManifest {
  const owner =
    inspectRebuildManifestHarnessPackage(manifest).status === "legacy"
      ? input.agentName
      : {
          agent: input.agentName,
          ...(input.packageAuthority.harnessPackage
            ? { harnessPackage: input.packageAuthority.harnessPackage }
            : {}),
          ...(input.packageAuthority.harnessPackageMigration
            ? { harnessPackageMigration: input.packageAuthority.harnessPackageMigration }
            : {}),
        };
  const validation = (deps.validateManifest ?? validateRebuildRecoveryManifest)(
    input.sandboxName,
    owner,
    manifest,
  );
  if (!validation.ok) {
    throw new Error(`Rebuild recovery backup is invalid: ${validation.reason}.`);
  }
  return validation.manifest;
}

function parseRecoveryRecord(raw: string): RebuildRecoveryBackupRecord | null {
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    const expectedKeys =
      value?.schemaVersion === 3
        ? [
            "backupTimestamp",
            "gatewayName",
            "gatewayPort",
            "phase",
            "sandboxName",
            "schemaVersion",
            "transactionId",
          ]
        : value?.schemaVersion === 2
          ? [
              "backupTimestamp",
              "gatewayName",
              "gatewayPort",
              "sandboxName",
              "schemaVersion",
              "transactionId",
            ]
          : ["backupTimestamp", "sandboxName", "schemaVersion", "transactionId"];
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(expectedKeys) ||
      (value.schemaVersion !== 1 && value.schemaVersion !== 2 && value.schemaVersion !== 3) ||
      typeof value.transactionId !== "string" ||
      !UUID_PATTERN.test(value.transactionId) ||
      typeof value.sandboxName !== "string" ||
      !isValidName(value.sandboxName) ||
      typeof value.backupTimestamp !== "string" ||
      ((value.schemaVersion === 2 || value.schemaVersion === 3) &&
        (typeof value.gatewayName !== "string" ||
          !isValidName(value.gatewayName) ||
          !Number.isSafeInteger(value.gatewayPort) ||
          Number(value.gatewayPort) < 1 ||
          Number(value.gatewayPort) > 65_535)) ||
      (value.schemaVersion === 3 && value.phase !== "restore" && value.phase !== "cleanup")
    ) {
      return null;
    }
    return value as RebuildRecoveryBackupRecord;
  } catch {
    return null;
  }
}

function readRecoveryRecord(backupPath: string): RebuildRecoveryBackupRecord | null {
  const filePath = recoveryPath(backupPath);
  let descriptor: number;
  try {
    descriptor = fs.openSync(
      filePath,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    const code = (error as NodeJS.ErrnoException).code;
    throw invalidRecoveryRecordError(
      backupPath,
      code ? `open failed with ${code}` : "open failed",
      error,
    );
  }
  try {
    const before = fs.fstatSync(descriptor, { bigint: true });
    const uid = process.getuid?.();
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.nlink !== 1n ||
      (uid !== undefined && before.uid !== BigInt(uid)) ||
      (before.mode & 0o777n) !== 0o600n ||
      before.size < 1n ||
      before.size > 4096n
    ) {
      throw invalidRecoveryRecordError(backupPath, "file authority is invalid");
    }
    const raw = fs.readFileSync(descriptor, "utf8");
    const after = fs.fstatSync(descriptor, { bigint: true });
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs
    ) {
      throw invalidRecoveryRecordError(backupPath, "file changed while it was read");
    }
    const record = parseRecoveryRecord(raw);
    if (!record) {
      throw invalidRecoveryRecordError(backupPath, "content or schema is invalid");
    }
    return record;
  } finally {
    fs.closeSync(descriptor);
  }
}

function recoveryRecordMatches(
  record: RebuildRecoveryBackupRecord | null,
  input: RebuildRecoveryBackupIdentity,
  manifest: RebuildManifest,
): boolean {
  return (
    record?.transactionId === input.transactionId &&
    record.sandboxName === input.sandboxName &&
    record.backupTimestamp === manifest.timestamp
  );
}

function replaceRecoveryRecord(backupPath: string, record: RebuildRecoveryBackupRecordV3): void {
  const filePath = recoveryPath(backupPath);
  const temporaryPath = `${filePath}.tmp-${randomUUID()}`;
  let descriptor: number | null = null;
  try {
    descriptor = fs.openSync(
      temporaryPath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
      0o600,
    );
    fs.writeFileSync(descriptor, `${JSON.stringify(record)}\n`, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    fs.renameSync(temporaryPath, filePath);
    syncDirectory(backupPath);
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
    fs.rmSync(temporaryPath, { force: true });
  }
}

/** Bind one published backup to the active outer rebuild transaction. */
export function recordRebuildRecoveryBackup(
  input: RebuildRecoveryBackupIdentity &
    Pick<SandboxRecreateTarget, "gatewayName" | "gatewayPort"> & {
      readonly backupManifest: RebuildManifest;
    },
  deps: RebuildRecoveryBackupDeps = {},
): void {
  validateRecoveryIdentity(input);
  if (
    !isValidName(input.gatewayName) ||
    !Number.isSafeInteger(input.gatewayPort) ||
    input.gatewayPort < 1 ||
    input.gatewayPort > 65_535
  ) {
    throw new Error("Rebuild recovery gateway identity is invalid.");
  }
  const manifest = validatedRecoveryManifest(input, input.backupManifest, deps);
  const existing = readRecoveryRecord(manifest.backupPath);
  if (existing) {
    if (!recoveryRecordMatches(existing, input, manifest)) {
      throw new Error("Rebuild recovery backup already belongs to another transaction.");
    }
    return;
  }
  const record: RebuildRecoveryBackupRecord = {
    schemaVersion: 3,
    transactionId: input.transactionId,
    sandboxName: input.sandboxName,
    backupTimestamp: manifest.timestamp,
    gatewayName: input.gatewayName,
    gatewayPort: input.gatewayPort,
    phase: "restore",
  };
  const descriptor = fs.openSync(
    recoveryPath(manifest.backupPath),
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
    0o600,
  );
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(record)}\n`, "utf8");
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  syncDirectory(manifest.backupPath);
}

/** Report whether an exact recovery record has entered cleanup-only state. */
export function isRebuildRecoveryCleanupOnly(
  input: Omit<RebuildRecoveryBackupIdentity, "transactionId"> & {
    readonly transactionId?: string;
    readonly backupManifest: RebuildManifest;
  },
  deps: RebuildRecoveryBackupDeps = {},
): boolean {
  if (!isValidName(input.sandboxName)) {
    throw new Error("Rebuild recovery sandbox identity is invalid.");
  }
  const record = readRecoveryRecord(input.backupManifest.backupPath);
  if (!record) return false;
  const identity = {
    sandboxName: input.sandboxName,
    agentName: input.agentName,
    transactionId: input.transactionId ?? record.transactionId,
    packageAuthority: input.packageAuthority,
  };
  validateRecoveryIdentity(identity);
  const manifest = validatedRecoveryManifest(identity, input.backupManifest, deps);
  if (!recoveryRecordMatches(record, identity, manifest)) return false;
  return record?.schemaVersion === 3 && record.phase === "cleanup";
}

/** Persist cleanup-only state before removing the final handoff metadata. */
export function markRebuildRecoveryCleanupOnly(
  input: RebuildRecoveryBackupIdentity & { readonly backupManifest: RebuildManifest },
  deps: RebuildRecoveryBackupDeps = {},
): void {
  validateRecoveryIdentity(input);
  const manifest = validatedRecoveryManifest(input, input.backupManifest, deps);
  const record = readRecoveryRecord(manifest.backupPath);
  if (!record || !recoveryRecordMatches(record, input, manifest)) {
    throw new Error("Rebuild recovery backup record is missing or changed.");
  }
  if (record.schemaVersion === 1) {
    throw new Error("Rebuild recovery backup record lacks cleanup authority.");
  }
  if (record.schemaVersion === 3 && record.phase === "cleanup") return;
  replaceRecoveryRecord(manifest.backupPath, {
    ...record,
    schemaVersion: 3,
    phase: "cleanup",
  });
}

/** Find the exact backup bound to an interrupted replacement transaction. */
export function findRebuildRecoveryBackup(
  input: RebuildRecoveryBackupIdentity,
  deps: RebuildRecoveryBackupDeps = {},
): SnapshotEntry | null {
  validateRecoveryIdentity(input);
  for (const candidate of (deps.listBackups ?? listBackups)(input.sandboxName)) {
    const record = readRecoveryRecord(candidate.backupPath);
    if (record?.transactionId !== input.transactionId) continue;
    const manifest = validatedRecoveryManifest(input, candidate, deps);
    if (recoveryRecordMatches(record, input, manifest)) return candidate;
  }
  return null;
}

/** Retire the bounded recovery record after restore and post-restore succeed. */
export function clearRebuildRecoveryBackup(
  input: RebuildRecoveryBackupIdentity & {
    readonly backupManifest: RebuildManifest;
  },
  deps: RebuildRecoveryBackupDeps = {},
): void {
  validateRecoveryIdentity(input);
  const manifest = validatedRecoveryManifest(input, input.backupManifest, deps);
  if (!recoveryRecordMatches(readRecoveryRecord(manifest.backupPath), input, manifest)) {
    throw new Error("Rebuild recovery backup record is missing or changed.");
  }
  fs.unlinkSync(recoveryPath(manifest.backupPath));
  syncDirectory(manifest.backupPath);
}

export type RetiredRebuildRecovery = Readonly<{
  backupPath: string;
  gatewayName: string;
  transactionId: string;
}>;

function packageAuthorityFromRebuildManifest(manifest: RebuildManifest): RebuildPackageAuthority {
  const inspection = inspectRebuildManifestHarnessPackage(manifest);
  if (inspection.status === "invalid") {
    throw new Error("Rebuild recovery backup package authority is invalid.");
  }
  return {
    harnessPackage: inspection.status === "package" ? inspection.harnessPackage : null,
    // Backup manifests bind the installed package identity. A transient package
    // migration is registry state and is not part of the published backup.
    harnessPackageMigration: null,
  };
}

/**
 * Retire one credential-bearing rebuild handoff only after its recorded
 * gateway proves the old sandbox absent and the operator attests that required
 * data recovery is complete.
 */
export function retireRebuildRecoveryBackup(
  input: Readonly<{
    sandboxName: string;
    transactionId: string;
    confirmDataRecovered: boolean;
  }>,
  deps: RebuildRecoveryBackupDeps = {},
): RetiredRebuildRecovery {
  validateRecoveryIdentity(input);
  if (!input.confirmDataRecovered) {
    throw new Error(
      "Recovery retirement requires --yes to confirm that required data recovery is complete.",
    );
  }

  let selected:
    | {
        manifest: RebuildManifest;
        record: RebuildRecoveryBackupRecordV2 | RebuildRecoveryBackupRecordV3;
        identity: RebuildRecoveryBackupIdentity;
      }
    | undefined;
  for (const candidate of (deps.listBackups ?? listBackups)(input.sandboxName)) {
    const record = readRecoveryRecord(candidate.backupPath);
    if (record?.transactionId !== input.transactionId) continue;
    if (record.sandboxName !== input.sandboxName) {
      throw new Error(
        `Rebuild recovery identity does not match sandbox '${input.sandboxName}'. Recovery remains at '${candidate.backupPath}'.`,
      );
    }
    if (record.schemaVersion === 1) {
      throw new Error(
        `Rebuild recovery '${input.transactionId}' does not contain recorded gateway authority. Recovery remains at '${candidate.backupPath}'.`,
      );
    }
    const identity = {
      sandboxName: input.sandboxName,
      agentName: candidate.agentType,
      transactionId: input.transactionId,
      packageAuthority: packageAuthorityFromRebuildManifest(candidate),
    };
    const manifest = validatedRecoveryManifest(identity, candidate, deps);
    if (!recoveryRecordMatches(record, identity, manifest)) {
      throw new Error(
        `Rebuild recovery identity changed before retirement. Recovery remains at '${candidate.backupPath}'.`,
      );
    }
    selected = { manifest, record, identity };
    break;
  }
  if (!selected) {
    throw new Error(
      `No exact rebuild recovery record exists for sandbox '${input.sandboxName}' and transaction '${input.transactionId}'.`,
    );
  }

  const { manifest, record, identity } = selected;
  try {
    const presence = (deps.observePresence ?? observeSandboxPresenceOnGateway)({
      sandboxName: input.sandboxName,
      gatewayName: record.gatewayName,
    });
    if (presence !== "missing") {
      throw new Error(
        `OpenShell still reports sandbox '${input.sandboxName}' on recorded gateway '${record.gatewayName}'`,
      );
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Cannot retire rebuild recovery before confirmed sandbox deletion: ${detail}. Recovery remains at '${manifest.backupPath}'.`,
      { cause: error },
    );
  }

  if (!(deps.clearPolicyHandoff ?? clearRebuildPolicyHandoff)(manifest)) {
    throw new Error(
      `The retained rebuild policy handoff could not be removed. Recovery remains at '${manifest.backupPath}'.`,
    );
  }
  try {
    clearRebuildRecoveryBackup(
      {
        ...identity,
        backupManifest: manifest,
      },
      deps,
    );
  } catch (error) {
    throw new Error(
      `The rebuild recovery marker could not be removed. Recovery remains at '${manifest.backupPath}'.`,
      { cause: error },
    );
  }
  return {
    backupPath: manifest.backupPath,
    gatewayName: record.gatewayName,
    transactionId: input.transactionId,
  };
}

export type RebuildRecreateJournalTarget = SandboxRecreateTarget;

export type RebuildSandboxObserver = SandboxRecreateObserver;

export type RebuildRecreateSourcePresence = SandboxRecreateSourcePresence;

type RebuildFingerprintOptions = Pick<
  RebuildRecreateOnboardOpts,
  | "harnessPackage"
  | "agent"
  | "endpointSource"
  | "recreateProvider"
  | "recreateModel"
  | "recreatePreferredInferenceApi"
  | "fromDockerfile"
  | "sandboxGpu"
  | "sandboxGpuDevice"
  | "controlUiPort"
  | "hostMounts"
  | "targetGatewayName"
  | "targetGatewayPort"
  | "toolDisclosure"
  | "dcodeAutoApprovalMode"
  | "observabilityEnabled"
>;

function readRebuildPackageAuthority(entry: {
  readonly harnessPackage?: HarnessPackageIdentity | null;
  readonly harnessPackageMigration?: HarnessPackageMigration | null;
}): RebuildPackageAuthority {
  const state = inspectHarnessPackageState(entry.harnessPackage, entry.harnessPackageMigration);
  if (state.status === "invalid") {
    throw new Error("the source registry harness package authority is malformed");
  }
  return state.status === "valid"
    ? Object.freeze({
        harnessPackage: state.harnessPackage,
        harnessPackageMigration: state.harnessPackageMigration,
      })
    : Object.freeze({ harnessPackage: null, harnessPackageMigration: null });
}

function assertCurrentRebuildSessionPackageAuthority(expected: RebuildPackageAuthority): void {
  const current = onboardSession.loadSession();
  if (!current) {
    throw new Error("The rebuild Session disappeared while its replacement journal was active.");
  }
  const actual = readRebuildPackageAuthority(current);
  if (!rebuildPackageAuthorityMatches(actual, expected)) {
    throw new Error("The rebuild Session harness package authority changed.");
  }
}

/** Re-read the source owner before a rebuild crosses an independently resumable mutation. */
export function assertCurrentRebuildPackageAuthority(
  sandboxName: string,
  expected: RebuildPackageAuthority,
): registry.SandboxEntry {
  const current = registry.getSandbox(sandboxName);
  if (!current) {
    throw new Error(`Cannot rebuild '${sandboxName}': the source registry row disappeared.`);
  }
  const actual = readRebuildPackageAuthority(current);
  if (!rebuildPackageAuthorityMatches(actual, expected)) {
    throw new Error(`Cannot rebuild '${sandboxName}': source harness package authority changed.`);
  }
  return current;
}

export interface RebuildRecreateJournal {
  readonly id: string;
  readonly acceptedTarget: boolean;
  readonly sourceConfirmedAbsent: boolean;
  readonly gatewayAuthority: CheckpointGatewayAuthority;
  readonly targetGeneration: string;
  readonly targetIntentFingerprint: string;
  readonly harnessPackage: HarnessPackageIdentity | null;
  readonly runtimeSelection?: OpenShellRuntimeSelection;
  beginDelete(): RebuildRecreateSourcePresence;
  confirmDeleted(): void;
  completeAcceptedTarget(): void;
}

export function fingerprintRebuildRecreateTargetIntent(options: RebuildFingerprintOptions): string {
  const hostMounts = (options.hostMounts ?? []).map(
    ({ source, target, readOnly, sourceIdentity }) => ({
      source,
      target,
      readOnly,
      sourceIdentity: sourceIdentity
        ? { device: sourceIdentity.device, inode: sourceIdentity.inode }
        : null,
    }),
  );
  return fingerprintSandboxRecreateValue({
    version: 2,
    harnessPackage: options.harnessPackage,
    agent: options.agent ?? null,
    endpointSource: options.endpointSource ?? null,
    provider: options.recreateProvider,
    model: options.recreateModel,
    preferredInferenceApi: options.recreatePreferredInferenceApi,
    fromDockerfile: options.fromDockerfile,
    sandboxGpu: options.sandboxGpu,
    sandboxGpuDevice: options.sandboxGpuDevice,
    controlUiPort: options.controlUiPort,
    // Mount-free and mounted targets share the package-bound version-2 schema.
    // A previous journal did not bind package or mount source authority and
    // remains intentionally incompatible with this stronger fingerprint.
    ...(hostMounts.length > 0 ? { hostMounts } : {}),
    gatewayName: options.targetGatewayName,
    gatewayPort: options.targetGatewayPort,
    toolDisclosure: options.toolDisclosure,
    dcodeAutoApprovalMode: options.dcodeAutoApprovalMode,
    observabilityEnabled: options.observabilityEnabled,
  });
}

/** Exact pre-package rebuild fingerprint used only to resume an active v1 journal. */
export function fingerprintLegacyRebuildRecreateTargetIntent(
  options: RebuildFingerprintOptions,
): string {
  const hostMounts = (options.hostMounts ?? []).map(
    ({ source, target, readOnly, sourceIdentity }) => ({
      source,
      target,
      readOnly,
      sourceIdentity: sourceIdentity
        ? { device: sourceIdentity.device, inode: sourceIdentity.inode }
        : null,
    }),
  );
  return fingerprintSandboxRecreateValue({
    version: 1,
    agent: options.agent ?? null,
    endpointSource: options.endpointSource ?? null,
    provider: options.recreateProvider,
    model: options.recreateModel,
    preferredInferenceApi: options.recreatePreferredInferenceApi,
    fromDockerfile: options.fromDockerfile,
    sandboxGpu: options.sandboxGpu,
    sandboxGpuDevice: options.sandboxGpuDevice,
    controlUiPort: options.controlUiPort,
    ...(hostMounts.length > 0 ? { hostMounts } : {}),
    gatewayName: options.targetGatewayName,
    gatewayPort: options.targetGatewayPort,
    toolDisclosure: options.toolDisclosure,
    dcodeAutoApprovalMode: options.dcodeAutoApprovalMode,
    observabilityEnabled: options.observabilityEnabled,
  });
}

export const observeRebuildSandbox = observeSandboxOnGateway;

export interface OpenRebuildRecreateJournalInput {
  readonly target: RebuildRecreateJournalTarget;
  readonly expectedGatewayAuthority: CheckpointGatewayAuthority;
  readonly agentName: string;
  readonly targetIntentFingerprint: string;
  /** Exact v1 value admitted only while migrating an already-active journal. */
  readonly legacyTargetIntentFingerprint?: string;
  readonly packageAuthority: RebuildPackageAuthority;
  readonly log: (message: string) => void;
  readonly observe?: RebuildSandboxObserver;
  readonly runtimeSelection?: OpenShellRuntimeSelection;
  readonly resolveRuntimeSelection?: () => OpenShellRuntimeSelection;
  /**
   * Invoked with ready-to-print lines when gateway authority cannot be
   * revalidated, so the command layer can fail cleanly (#8103).
   */
  readonly onAuthorityRefusal?: (lines: readonly string[]) => void;
}

export function openRebuildRecreateJournal(
  input: OpenRebuildRecreateJournalInput,
): RebuildRecreateJournal {
  const { target, agentName, targetIntentFingerprint, log } = input;
  const observeTarget = (
    runtimeSelection = input.runtimeSelection,
  ): ReturnType<RebuildSandboxObserver> =>
    input.observe
      ? input.observe(target)
      : observeRebuildSandbox(target, undefined, runtimeSelection);
  const sourceEntry = assertCurrentRebuildPackageAuthority(
    target.sandboxName,
    input.packageAuthority,
  );
  if ((sourceEntry.agent ?? "openclaw") !== agentName) {
    throw new Error(
      `Cannot rebuild '${target.sandboxName}': source registry agent authority changed.`,
    );
  }
  // Authority revalidation runs before the destroy phase. Handing the refusal
  // to the caller lets rebuild report the migration and its remedy instead of
  // crashing with a Node stack trace (#8103). The dedicated rebuild resolver
  // permits its narrowly defined managed-service migration.
  let authority: ReturnType<typeof resolveGatewayRebuildAuthority>;
  try {
    authority = resolveGatewayRebuildAuthority({
      gatewayName: target.gatewayName,
      gatewayPort: target.gatewayPort,
    });
    const expectedAuthority = gatewayOwnerFromCheckpoint(input.expectedGatewayAuthority);
    if (
      !sameGatewayOwner(expectedAuthority, authority) &&
      !isManagedPackagedServiceMigration(expectedAuthority, authority)
    ) {
      throw new GatewayAuthorityError(
        "Gateway lifecycle authority changed after authoritative rebuild preflight " +
          `(${describeGatewayOwnerForError(expectedAuthority)} -> ${describeGatewayOwnerForError(authority)}). ` +
          "Retry the rebuild; the current run will not delete the source sandbox.",
      );
    }
  } catch (error) {
    if (!(error instanceof GatewayAuthorityError)) throw error;
    input.onAuthorityRefusal?.(gatewayAuthorityFailureLines(error, "sandbox rebuild"));
    throw error;
  }
  const gatewayAuthority = checkpointGatewayAuthority(authority);
  const openingSession = onboardSession.loadSession();
  if (!openingSession) {
    throw new Error(
      `Cannot journal sandbox '${target.sandboxName}' replacement without its rebuild Session.`,
    );
  }
  const openingCheckpoint = openingSession?.checkpoint ?? null;
  const openingTransaction = openingCheckpoint?.sandboxRecreate ?? null;
  const resumedTargetIntentFingerprint =
    openingTransaction?.version === 1 &&
    openingTransaction.targetIntentFingerprint === input.legacyTargetIntentFingerprint
      ? openingTransaction.targetIntentFingerprint
      : targetIntentFingerprint;
  const openingAuthorityFingerprint = fingerprintSandboxRecreateValue({
    agent: openingSession.agent,
    harnessPackage: openingSession.harnessPackage,
    harnessPackageMigration: openingSession.harnessPackageMigration,
    checkpoint: openingSession.checkpoint,
  });
  const bindResult = onboardSession.compareAndSwapSession(
    (current) =>
      current.sessionId === openingSession.sessionId &&
      fingerprintSandboxRecreateValue({
        agent: current.agent,
        harnessPackage: current.harnessPackage,
        harnessPackageMigration: current.harnessPackageMigration,
        checkpoint: current.checkpoint,
      }) === openingAuthorityFingerprint &&
      (assertCurrentRebuildPackageAuthority(target.sandboxName, input.packageAuthority).agent ??
        "openclaw") === agentName,
    (current) => {
      const bindingSourceEntry = assertCurrentRebuildPackageAuthority(
        target.sandboxName,
        input.packageAuthority,
      );
      const hasActiveTransaction = Boolean(current.checkpoint?.sandboxRecreate);
      current.agent = bindingSourceEntry.agent ?? null;
      current.harnessPackage = input.packageAuthority.harnessPackage
        ? structuredClone(input.packageAuthority.harnessPackage)
        : null;
      current.harnessPackageMigration = input.packageAuthority.harnessPackageMigration
        ? structuredClone(input.packageAuthority.harnessPackageMigration)
        : null;
      const checkpoint = hasActiveTransaction
        ? bindCheckpointHarnessPackageAuthority(
            current.checkpoint,
            input.packageAuthority.harnessPackage,
          )
        : deriveCheckpointFromSession(current);
      if (!checkpoint) {
        throw new Error(
          `Sandbox '${target.sandboxName}' replacement checkpoint could not be package-bound.`,
        );
      }
      current.checkpoint = checkpoint;
      return current;
    },
    `nemoclaw bind sandbox '${target.sandboxName}' rebuild package authority`,
  );
  if (bindResult === "busy") {
    throw new Error(
      `Cannot journal sandbox '${target.sandboxName}': another onboarding writer owns the session lock.`,
    );
  }
  if (bindResult !== "updated") {
    throw new Error(
      `Cannot journal sandbox '${target.sandboxName}': its rebuild Session authority changed.`,
    );
  }

  const runtimeSelection = input.resolveRuntimeSelection
    ? input.resolveRuntimeSelection()
    : input.runtimeSelection;
  const owned = ownSandboxRecreateTransaction({
    sessionStore: {
      loadSession: onboardSession.loadSession,
      updateSession: onboardSession.updateSession,
      compareAndSwapSession: onboardSession.compareAndSwapSession,
    },
    sandboxName: target.sandboxName,
    gatewayName: target.gatewayName,
    gatewayPort: target.gatewayPort,
    targetIntentFingerprint: resumedTargetIntentFingerprint,
    requireSourceEntry: true,
    readRegistryEntry: () => {
      const entry = assertCurrentRebuildPackageAuthority(
        target.sandboxName,
        input.packageAuthority,
      );
      if ((entry.agent ?? "openclaw") !== agentName) {
        throw new Error(
          `Cannot rebuild '${target.sandboxName}': source registry agent authority changed.`,
        );
      }
      return entry;
    },
    observe: () => observeTarget(runtimeSelection),
    decorateCheckpoint: (current, checkpoint, now) => ({
      ...checkpoint,
      machineState: current.machine.state,
      updatedAt: now,
      sandboxIdentity: decisionSelected({ name: target.sandboxName, agent: agentName }),
      gatewayAuthority: decisionSelected(gatewayAuthority),
    }),
  });
  const { session, transaction, recovery } = owned;
  if (owned.replacedTransactionId) {
    log(
      `Replaced void journal ${owned.replacedTransactionId} with ${transaction.id} for '${target.sandboxName}'; its source sandbox is registered and live`,
    );
    console.log(
      `  Replaced the void replacement journal for '${target.sandboxName}'; its source sandbox is registered and live.`,
    );
  }
  const acceptedTarget = recovery.action === "accept_target";
  log(
    `Journaled replacement ${transaction.id} for '${target.sandboxName}' on ${target.gatewayName}:${String(target.gatewayPort)} at phase '${transaction.phase}'`,
  );

  const openingSessionId = session.sessionId;
  let currentTransaction = transaction;
  let phase: CheckpointSandboxRecreatePhase = transaction.phase;
  const revalidateGatewayAuthority = (): void => {
    const currentAuthority = resolveGatewayRebuildAuthority({
      gatewayName: target.gatewayName,
      gatewayPort: target.gatewayPort,
    });
    if (!sameGatewayOwner(authority, currentAuthority)) {
      throw new GatewayAuthorityError(
        "Gateway lifecycle authority changed after the recreate journal was recorded " +
          `(${describeGatewayOwnerForError(authority)} -> ${describeGatewayOwnerForError(currentAuthority)}). ` +
          "Retry the rebuild; the current run will not delete the source sandbox.",
      );
    }
  };
  const advance = (next: CheckpointSandboxRecreatePhase): void => {
    onboardSession.updateSession((current) => {
      currentTransaction = advanceSandboxRecreateTransaction(current, transaction.id, next);
      phase = currentTransaction.phase;
      return current;
    });
  };

  return {
    id: transaction.id,
    acceptedTarget,
    sourceConfirmedAbsent: recovery.action === "continue_create",
    gatewayAuthority,
    targetGeneration: transaction.targetGeneration,
    targetIntentFingerprint: transaction.targetIntentFingerprint,
    harnessPackage:
      transaction.version === 2
        ? transaction.harnessPackage
        : input.packageAuthority.harnessPackage,
    ...(runtimeSelection ? { runtimeSelection } : {}),
    beginDelete: () => {
      const begun = beginSandboxRecreateDelete({
        sessionStore: {
          loadSession: onboardSession.loadSession,
          updateSession: onboardSession.updateSession,
          compareAndSwapSession: onboardSession.compareAndSwapSession,
        },
        openingSessionId,
        expectedTransaction: currentTransaction,
        targetIntentFingerprint: transaction.targetIntentFingerprint,
        revalidateGatewayAuthority,
        readRegistryEntry: () =>
          assertCurrentRebuildPackageAuthority(target.sandboxName, input.packageAuthority),
        observe: () => observeTarget(runtimeSelection),
      });
      currentTransaction = begun.transaction;
      phase = currentTransaction.phase;
      return begun.sourcePresence;
    },
    confirmDeleted: () => {
      if (observeTarget(runtimeSelection).state !== "missing") {
        throw new Error(
          `Cannot continue sandbox '${target.sandboxName}' replacement: OpenShell still reports the journaled source after delete.`,
        );
      }
      // The source row may already be absent here. The durable owner is now
      // the Session/checkpoint chain, including migration provenance.
      assertCurrentRebuildSessionPackageAuthority(input.packageAuthority);
      advance("deleted");
    },
    completeAcceptedTarget: () => {
      if (!acceptedTarget) {
        throw new Error(
          `Sandbox '${target.sandboxName}' replacement journal cannot be retired before its replacement is proven.`,
        );
      }
      assertCurrentRebuildPackageAuthority(target.sandboxName, input.packageAuthority);
      for (const next of ["registry_committing", "completed"] as const) {
        if (!sandboxRecreatePhaseReached(phase, next)) advance(next);
      }
      onboardSession.updateSession((current) => {
        clearCompletedSandboxRecreateTransaction(current, transaction.id);
        return current;
      });
    },
  };
}
