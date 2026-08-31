// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import { isCandidateAgent } from "../../agent/candidate.js";
import type { AgentDefinition, AgentStateFile } from "../../agent-runtime/manifest-types.js";
import { isObjectRecord } from "../../core/json-types.js";
import {
  harnessPackageIdentitiesEqual,
  inspectHarnessPackageState,
  parseHarnessPackageIdentity,
  type HarnessPackageIdentity,
} from "../../agent-runtime/package/identity.js";
import {
  hasCompleteOpenClawImagePluginProvenance,
  type OpenClawImagePluginInstall,
  parseOpenClawImagePluginInstalls,
} from "../openclaw-plugin-restore.js";
import {
  HERMES_PRESERVED_ENV_INVENTORY,
  type PreservedEnvFile,
  validatePreservedEnvFiles,
} from "../preserved-env/index.js";
import {
  cloneSandboxHostLocalInferenceProvenance,
  cloneSandboxHostLocalInferenceReceipt,
  requireSandboxHostLocalInferenceProvenance,
} from "../registry/host-local-inference.js";
import {
  cloneSandboxRuntimeSnapshot,
  type SandboxRuntimeSnapshot,
} from "../registry/runtime-snapshot.js";
import type {
  CustomPolicyEntry,
  SandboxEntry,
  SandboxHostLocalInferenceProvenance,
  SandboxWorkloadReceipt,
} from "../registry/types.js";
import { cloneSandboxWorkloadReceipt } from "../registry/workload.js";
import { normalizeCustomPolicyEntries } from "../registry-normalization.js";
import { hashSnapshotBackupContent } from "./content-digest.js";

const MANIFEST_VERSION = 2;
const CONTENT_SHA256_PATTERN = /^[0-9a-f]{64}$/u;

export interface RebuildManifest {
  version: number;
  sandboxName: string;
  timestamp: string;
  agentType: string;
  agentVersion: string | null;
  expectedVersion: string | null;
  /** Exact package authority for schema v2; null is reserved for qualified repository agents. */
  harnessPackage?: HarnessPackageIdentity | null;
  /** Fresh-image plugin baseline captured before user state was restored. */
  openclawImagePluginInstalls?: OpenClawImagePluginInstall[];
  /** The plugin baseline is authoritative and must be reconciled during recreation. */
  reconcileOpenClawImagePluginProvenance?: boolean;
  stateDirs: string[];
  /** Directories verified as safe to restore. Absent on older manifests. */
  backedUpDirs?: string[];
  /** Declared directories that could not be backed up. Absent on older manifests. */
  failedBackupDirs?: string[];
  /** True only when every declared directory and state file was captured. */
  backupComplete?: boolean;
  /** Publication-time digest of every restorable entry except this manifest. */
  backupContentSha256?: string;
  stateFiles?: StateFileSpec[];
  /** Single config/state directory. */
  dir: string;
  /** @deprecated Old field name for `dir` — retained for backward compatibility. */
  writableDir?: string;
  backupPath: string;
  blueprintDigest: string | null;
  policyPresets?: string[];
  /** Exact custom policy content needed to recreate gateway policy state. */
  customPolicies?: CustomPolicyEntry[];
  /** Allowlisted non-secret environment assignments captured for image recreation. */
  preservedEnv?: PreservedEnvFile[];
  /** Provider-neutral runtime and acceleration state for managed-image snapshots. */
  runtimeSnapshot?: SandboxRuntimeSnapshot;
  /** Exact immutable managed workload/profile authority associated with this snapshot. */
  workload?: SandboxWorkloadReceipt;
  /** Exact provider-neutral authority for out-of-sandbox inference. */
  hostLocalInferenceReceipt?: string;
  /** Explicit hidden-lifecycle provenance paired with the exact receipt. */
  hostLocalInferenceProvenance?: SandboxHostLocalInferenceProvenance;
  instances?: InstanceBackup[];
  /** Optional user-provided label for `snapshot restore <name>`. */
  name?: string;
}

/** Manifest enriched with its position-derived display version. */
export type SnapshotEntry = RebuildManifest & { snapshotVersion: number };

export interface InstanceBackup {
  instanceId: string;
  agentType: string;
  dataDir: string;
  stateDirs: string[];
  backedUpDirs: string[];
}

export type StateFileStrategy = "copy" | "sqlite_backup";

export interface StateFileSpec {
  path: string;
  strategy: StateFileStrategy;
}

export type RebuildManifestHarnessPackageInspection =
  | { readonly status: "legacy" }
  | { readonly status: "candidate"; readonly harnessPackage: null }
  | { readonly status: "package"; readonly harnessPackage: HarnessPackageIdentity }
  | { readonly status: "invalid" };

export type RebuildRecoveryManifestValidation =
  | { ok: true; manifest: RebuildManifest }
  | { ok: false; reason: string };

export type SnapshotBackupContentValidation =
  | { ok: true; contentSha256: string | null }
  | { ok: false; reason: string };

export type NormalizedBackupAgentAuthority =
  | {
      readonly ok: true;
      readonly agent: AgentDefinition;
      readonly agentName: string;
      readonly manifestVersion: 1 | 2;
      readonly harnessPackage?: HarnessPackageIdentity | null;
    }
  | { readonly ok: false; readonly error: string };

function resolveRebuildManifestDir(value: { dir?: unknown; writableDir?: unknown }): unknown {
  return value.dir === undefined ? value.writableDir : value.dir;
}

export interface ManifestPublishOps {
  write(filePath: string, contents: string, options: { mode: number; flag: "wx" }): void;
  rename(source: string, destination: string): void;
  remove(filePath: string, options: { force: true }): void;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

export function normalizeStateFilePath(filePath: string): string | null {
  if (!filePath || filePath.includes("\0") || path.isAbsolute(filePath)) return null;
  const normalized = path.posix.normalize(filePath.replace(/\\/g, "/"));
  if (normalized === "." || normalized.startsWith("../") || normalized === "..") return null;
  return normalized;
}

function isSafeStateDirPath(dirPath: string): boolean {
  if (!dirPath || dirPath.includes("\0") || path.isAbsolute(dirPath)) return false;
  const normalized = path.posix.normalize(dirPath.replace(/\\/g, "/"));
  return (
    normalized === dirPath &&
    normalized !== "." &&
    normalized !== ".." &&
    !normalized.startsWith("../")
  );
}

function isStateDirArray(value: unknown): value is string[] {
  return isStringArray(value) && value.every(isSafeStateDirPath);
}

function isBackedUpDirArray(value: unknown, stateDirs: string[]): value is string[] {
  const stateDirSet = new Set(stateDirs);
  return (
    isStringArray(value) &&
    value.every((dirName) => isSafeStateDirPath(dirName) && stateDirSet.has(dirName))
  );
}

function normalizeStateFileSpec(spec: AgentStateFile | StateFileSpec): StateFileSpec | null {
  const normalized = normalizeStateFilePath(spec.path);
  if (!normalized) return null;
  if (spec.strategy !== "copy" && spec.strategy !== "sqlite_backup") return null;
  return { path: normalized, strategy: spec.strategy };
}

export function normalizeStateFileSpecsPreservingDuplicates(
  specs: readonly (AgentStateFile | StateFileSpec)[],
): StateFileSpec[] {
  return specs.flatMap((spec) => {
    const normalized = normalizeStateFileSpec(spec);
    return normalized ? [normalized] : [];
  });
}

function isStateFileSpec(value: unknown): value is StateFileSpec {
  return (
    isObjectRecord(value) &&
    typeof value.path === "string" &&
    (value.strategy === "copy" || value.strategy === "sqlite_backup") &&
    normalizeStateFileSpec({ path: value.path, strategy: value.strategy }) !== null
  );
}

function isInstanceBackup(value: unknown): value is InstanceBackup {
  if (!isObjectRecord(value) || !isStateDirArray(value.stateDirs)) return false;
  return (
    typeof value.instanceId === "string" &&
    typeof value.agentType === "string" &&
    typeof value.dataDir === "string" &&
    isBackedUpDirArray(value.backedUpDirs, value.stateDirs)
  );
}

function isCustomPolicyEntryArray(value: unknown): value is CustomPolicyEntry[] {
  if (!Array.isArray(value)) return false;
  if (value.length === 0) return true;
  try {
    return normalizeCustomPolicyEntries(value) !== undefined;
  } catch {
    return false;
  }
}

function isRepositoryQualifiedManifestAgent(agentType: string): boolean {
  return agentType === "nemocua" || isCandidateAgent(agentType);
}

/** Classify package authority without treating schema omission as candidate null. */
export function inspectRebuildManifestHarnessPackage(
  manifest: Pick<RebuildManifest, "version" | "agentType" | "harnessPackage">,
): RebuildManifestHarnessPackageInspection {
  const hasHarnessPackage = Object.prototype.hasOwnProperty.call(manifest, "harnessPackage");
  if (manifest.version === 1) {
    return hasHarnessPackage ? { status: "invalid" } : { status: "legacy" };
  }
  if (manifest.version !== MANIFEST_VERSION || !hasHarnessPackage) {
    return { status: "invalid" };
  }
  if (manifest.harnessPackage === null) {
    return isRepositoryQualifiedManifestAgent(manifest.agentType)
      ? { status: "candidate", harnessPackage: null }
      : { status: "invalid" };
  }
  try {
    const harnessPackage = parseHarnessPackageIdentity(manifest.harnessPackage);
    return harnessPackage.id === manifest.agentType
      ? { status: "package", harnessPackage }
      : { status: "invalid" };
  } catch {
    return { status: "invalid" };
  }
}

export function hasAuthoritativeOpenClawImagePluginProvenance(value: {
  agentType?: unknown;
  dir?: unknown;
  writableDir?: unknown;
  openclawImagePluginInstalls?: unknown;
  reconcileOpenClawImagePluginProvenance?: unknown;
}): boolean {
  const dir = resolveRebuildManifestDir(value);
  return (
    value.agentType === "openclaw" &&
    typeof dir === "string" &&
    value.reconcileOpenClawImagePluginProvenance === true &&
    hasCompleteOpenClawImagePluginProvenance(value.openclawImagePluginInstalls, dir)
  );
}

function isRebuildManifest(value: unknown): value is RebuildManifest {
  if (!isObjectRecord(value) || !isStateDirArray(value.stateDirs)) return false;
  if (Object.prototype.hasOwnProperty.call(value, "harnessPackageMigration")) return false;
  const dir = resolveRebuildManifestDir(value);
  const runtimeSnapshot =
    value.runtimeSnapshot === undefined
      ? undefined
      : cloneSandboxRuntimeSnapshot(value.runtimeSnapshot);
  const workload =
    value.workload === undefined ? undefined : cloneSandboxWorkloadReceipt(value.workload as never);
  const hostLocalInferenceReceipt = cloneSandboxHostLocalInferenceReceipt(
    value.hostLocalInferenceReceipt as string | null | undefined,
  );
  const hostLocalInferenceProvenance = cloneSandboxHostLocalInferenceProvenance(
    value.hostLocalInferenceProvenance,
  );
  const harnessPackageState = inspectRebuildManifestHarnessPackage(
    value as unknown as Pick<RebuildManifest, "version" | "agentType" | "harnessPackage">,
  );
  const validHostLocalInferenceProvenance = (() => {
    if (value.hostLocalInferenceProvenance === undefined) return true;
    if (!hostLocalInferenceProvenance || typeof hostLocalInferenceReceipt !== "string") {
      return false;
    }
    try {
      requireSandboxHostLocalInferenceProvenance(
        hostLocalInferenceProvenance,
        hostLocalInferenceReceipt,
      );
      return true;
    } catch {
      return false;
    }
  })();
  return (
    (value.version === 1 || value.version === MANIFEST_VERSION) &&
    typeof value.sandboxName === "string" &&
    typeof value.timestamp === "string" &&
    typeof value.agentType === "string" &&
    harnessPackageState.status !== "invalid" &&
    (value.agentVersion === null || typeof value.agentVersion === "string") &&
    (value.expectedVersion === null || typeof value.expectedVersion === "string") &&
    (value.backedUpDirs === undefined || isBackedUpDirArray(value.backedUpDirs, value.stateDirs)) &&
    (value.failedBackupDirs === undefined ||
      isBackedUpDirArray(value.failedBackupDirs, value.stateDirs)) &&
    (value.backupComplete === undefined || typeof value.backupComplete === "boolean") &&
    (value.backupContentSha256 === undefined ||
      (typeof value.backupContentSha256 === "string" &&
        CONTENT_SHA256_PATTERN.test(value.backupContentSha256))) &&
    typeof dir === "string" &&
    (value.openclawImagePluginInstalls === undefined ||
      parseOpenClawImagePluginInstalls(value.openclawImagePluginInstalls, dir).ok) &&
    (value.reconcileOpenClawImagePluginProvenance === undefined ||
      typeof value.reconcileOpenClawImagePluginProvenance === "boolean") &&
    (value.reconcileOpenClawImagePluginProvenance !== true ||
      hasAuthoritativeOpenClawImagePluginProvenance(value)) &&
    typeof value.backupPath === "string" &&
    (value.stateFiles === undefined ||
      (Array.isArray(value.stateFiles) && value.stateFiles.every(isStateFileSpec))) &&
    (value.blueprintDigest === undefined ||
      value.blueprintDigest === null ||
      typeof value.blueprintDigest === "string") &&
    (value.policyPresets === undefined || isStringArray(value.policyPresets)) &&
    (value.customPolicies === undefined || isCustomPolicyEntryArray(value.customPolicies)) &&
    (value.preservedEnv === undefined ||
      (value.agentType === "hermes" &&
        validatePreservedEnvFiles(value.preservedEnv, HERMES_PRESERVED_ENV_INVENTORY))) &&
    (value.runtimeSnapshot === undefined || runtimeSnapshot !== undefined) &&
    (value.workload === undefined || workload !== undefined) &&
    (value.hostLocalInferenceReceipt === undefined ||
      (typeof hostLocalInferenceReceipt === "string" && hostLocalInferenceReceipt.length > 0)) &&
    validHostLocalInferenceProvenance &&
    (workload?.kind !== "managed-image" || runtimeSnapshot !== undefined) &&
    (value.instances === undefined ||
      (Array.isArray(value.instances) && value.instances.every(isInstanceBackup))) &&
    (value.name === undefined || typeof value.name === "string")
  );
}

export function normalizeBackupAgentAuthority(
  sandbox: SandboxEntry | null,
  options: {
    readonly agentDefinition?: AgentDefinition;
    readonly harnessPackage?: HarnessPackageIdentity | null;
  },
  loadLegacyAgent: (agentName: string) => AgentDefinition,
): NormalizedBackupAgentAuthority {
  const agentName = sandbox?.agent || "openclaw";
  const hasDefinition = options.agentDefinition !== undefined;
  const hasHarnessPackage = Object.prototype.hasOwnProperty.call(options, "harnessPackage");

  if (!hasDefinition) {
    if (hasHarnessPackage) {
      return {
        ok: false,
        error: "snapshot package authority requires its resolved agent definition",
      };
    }
    const recordedPackage = inspectHarnessPackageState(
      sandbox?.harnessPackage,
      sandbox?.harnessPackageMigration,
    );
    if (sandbox && recordedPackage.status === "invalid") {
      return {
        ok: false,
        error: "registered sandbox harness package authority is malformed",
      };
    }
    if (sandbox && !isRepositoryQualifiedManifestAgent(agentName)) {
      return {
        ok: false,
        error:
          "registered harness package snapshot requires its pinned agent definition and package identity",
      };
    }
    if (sandbox && recordedPackage.status !== "absent") {
      return {
        ok: false,
        error: "registered candidate sandbox must not carry harness package authority",
      };
    }
    return { ok: true, agent: loadLegacyAgent(agentName), agentName, manifestVersion: 1 };
  }

  const agent = options.agentDefinition as AgentDefinition;
  if (!hasHarnessPackage) {
    return {
      ok: false,
      error: "snapshot agent definition is missing explicit package authority",
    };
  }
  if (agent.name !== agentName) {
    return {
      ok: false,
      error: "snapshot agent definition does not match the registered sandbox agent",
    };
  }

  const recordedPackage = inspectHarnessPackageState(
    sandbox?.harnessPackage,
    sandbox?.harnessPackageMigration,
  );
  if (options.harnessPackage === null) {
    if (!isRepositoryQualifiedManifestAgent(agentName) || recordedPackage.status !== "absent") {
      return {
        ok: false,
        error: "explicit candidate package authority does not match the registered sandbox",
      };
    }
    return { ok: true, agent, agentName, manifestVersion: 2, harnessPackage: null };
  }

  let harnessPackage: HarnessPackageIdentity;
  try {
    harnessPackage = parseHarnessPackageIdentity(options.harnessPackage);
  } catch {
    return {
      ok: false,
      error: "snapshot harness package identity is malformed",
    };
  }
  if (
    harnessPackage.id !== agentName ||
    recordedPackage.status !== "valid" ||
    !harnessPackageIdentitiesEqual(recordedPackage.harnessPackage, harnessPackage)
  ) {
    return {
      ok: false,
      error: "snapshot harness package identity does not match the registered sandbox",
    };
  }
  return { ok: true, agent, agentName, manifestVersion: 2, harnessPackage };
}

export function normalizeSnapshotBackupAuthority(options: {
  readonly runtimeSnapshot?: SandboxRuntimeSnapshot;
  readonly workload?: SandboxWorkloadReceipt;
  readonly hostLocalInferenceReceipt?: string;
  readonly hostLocalInferenceProvenance?: SandboxHostLocalInferenceProvenance;
}): {
  readonly runtimeSnapshot?: SandboxRuntimeSnapshot;
  readonly workload?: SandboxWorkloadReceipt;
  readonly hostLocalInferenceReceipt?: string;
  readonly hostLocalInferenceProvenance?: SandboxHostLocalInferenceProvenance;
  readonly error?: string;
} {
  const runtimeSnapshot =
    options.runtimeSnapshot === undefined
      ? undefined
      : cloneSandboxRuntimeSnapshot(options.runtimeSnapshot);
  const workload =
    options.workload === undefined ? undefined : cloneSandboxWorkloadReceipt(options.workload);
  const hostLocalInferenceReceipt = cloneSandboxHostLocalInferenceReceipt(
    options.hostLocalInferenceReceipt,
  );
  const hostLocalInferenceProvenance = cloneSandboxHostLocalInferenceProvenance(
    options.hostLocalInferenceProvenance,
  );
  if (options.runtimeSnapshot !== undefined && runtimeSnapshot === undefined) {
    return { error: "snapshot runtime state is invalid or cannot be represented" };
  }
  if (options.workload !== undefined && workload === undefined) {
    return { error: "snapshot workload authority is invalid" };
  }
  if (
    options.hostLocalInferenceReceipt !== undefined &&
    typeof hostLocalInferenceReceipt !== "string"
  ) {
    return { error: "snapshot host-local inference authority is invalid" };
  }
  if (options.hostLocalInferenceProvenance !== undefined) {
    if (!hostLocalInferenceProvenance || typeof hostLocalInferenceReceipt !== "string") {
      return { error: "snapshot host-local inference provenance is invalid" };
    }
    try {
      requireSandboxHostLocalInferenceProvenance(
        hostLocalInferenceProvenance,
        hostLocalInferenceReceipt,
      );
    } catch {
      return { error: "snapshot host-local inference provenance is invalid" };
    }
  }
  if (workload?.kind === "managed-image" && runtimeSnapshot === undefined) {
    return { error: "managed snapshot is missing provider runtime state" };
  }
  return {
    ...(runtimeSnapshot === undefined ? {} : { runtimeSnapshot }),
    ...(workload === undefined ? {} : { workload }),
    ...(typeof hostLocalInferenceReceipt === "string" ? { hostLocalInferenceReceipt } : {}),
    ...(hostLocalInferenceProvenance ? { hostLocalInferenceProvenance } : {}),
  };
}

export function snapshotManifestAuthority(manifest: RebuildManifest): RebuildManifest {
  const normalized = {
    ...manifest,
    backupPath: path.resolve(manifest.backupPath),
  } as RebuildManifest & {
    snapshotVersion?: unknown;
  };
  delete normalized.snapshotVersion;
  return normalized;
}

const manifestPublishOps: ManifestPublishOps = {
  write: (filePath, contents, options) => writeFileSync(filePath, contents, options),
  rename: (source, destination) => renameSync(source, destination),
  remove: (filePath, options) => rmSync(filePath, options),
};

type ManifestFileStat = ReturnType<typeof fstatSync>;

function sameManifestFileStat(left: ManifestFileStat, right: ManifestFileStat): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

export function writeManifest(
  backupPath: string,
  manifest: RebuildManifest,
  ops: ManifestPublishOps = manifestPublishOps,
): void {
  const manifestPath = path.join(backupPath, "rebuild-manifest.json");
  const tempPath = path.join(backupPath, `.rebuild-manifest.json.tmp.${String(process.pid)}`);
  let published = false;
  try {
    ops.write(tempPath, JSON.stringify(manifest, null, 2), { mode: 0o600, flag: "wx" });
    ops.rename(tempPath, manifestPath);
    published = true;
  } finally {
    if (!published) {
      try {
        ops.remove(tempPath, { force: true });
      } catch {
        // Preserve the publish failure; a same-directory temp file is never a snapshot.
      }
    }
  }
}

export function readManifestPayload(backupPath: string): unknown | null {
  const manifestPath = path.join(backupPath, "rebuild-manifest.json");
  if (typeof constants.O_NOFOLLOW !== "number") return null;
  let descriptor: number | null = null;
  try {
    descriptor = openSync(
      manifestPath,
      constants.O_RDONLY |
        constants.O_NOFOLLOW |
        (typeof constants.O_NONBLOCK === "number" ? constants.O_NONBLOCK : 0),
    );
    const opened = fstatSync(descriptor);
    const namedBefore = lstatSync(manifestPath);
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      namedBefore.isSymbolicLink() ||
      !namedBefore.isFile() ||
      !sameManifestFileStat(opened, namedBefore)
    ) {
      return null;
    }
    const contents = readFileSync(descriptor, "utf-8");
    const after = fstatSync(descriptor);
    const namedAfter = lstatSync(manifestPath);
    if (!sameManifestFileStat(opened, after) || !sameManifestFileStat(opened, namedAfter)) {
      return null;
    }
    return JSON.parse(contents);
  } catch {
    return null;
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

export function hasInvalidMarkedOpenClawPluginProvenance(backupPath: string): boolean {
  const parsed = readManifestPayload(backupPath);
  return (
    isObjectRecord(parsed) &&
    parsed.reconcileOpenClawImagePluginProvenance === true &&
    !hasAuthoritativeOpenClawImagePluginProvenance(parsed)
  );
}

export function readManifest(backupPath: string): RebuildManifest | null {
  try {
    const parsed = readManifestPayload(backupPath);
    if (!isRebuildManifest(parsed)) return null;
    const manifest = parsed as RebuildManifest & { dir?: string; writableDir?: string };
    const dir = resolveRebuildManifestDir(manifest);
    if (typeof dir !== "string" || !dir) return null;
    const runtimeSnapshot =
      manifest.runtimeSnapshot === undefined
        ? undefined
        : cloneSandboxRuntimeSnapshot(manifest.runtimeSnapshot);
    const workload =
      manifest.workload === undefined ? undefined : cloneSandboxWorkloadReceipt(manifest.workload);
    const hostLocalInferenceReceipt = cloneSandboxHostLocalInferenceReceipt(
      manifest.hostLocalInferenceReceipt,
    );
    const hostLocalInferenceProvenance = cloneSandboxHostLocalInferenceProvenance(
      manifest.hostLocalInferenceProvenance,
    );
    const harnessPackageState = inspectRebuildManifestHarnessPackage(manifest);
    if (harnessPackageState.status === "invalid") return null;
    return {
      ...manifest,
      dir,
      stateFiles: normalizeStateFileSpecsPreservingDuplicates(manifest.stateFiles ?? []),
      blueprintDigest: manifest.blueprintDigest ?? null,
      ...(runtimeSnapshot === undefined ? {} : { runtimeSnapshot }),
      ...(workload === undefined ? {} : { workload }),
      ...(typeof hostLocalInferenceReceipt === "string" ? { hostLocalInferenceReceipt } : {}),
      ...(hostLocalInferenceProvenance ? { hostLocalInferenceProvenance } : {}),
      ...(harnessPackageState.status === "package"
        ? { harnessPackage: harnessPackageState.harnessPackage }
        : harnessPackageState.status === "candidate"
          ? { harnessPackage: null }
          : {}),
    };
  } catch {
    return null;
  }
}

/** Read one validated snapshot manifest without exposing the private publication helpers. */
export function readSandboxStateBackupManifest(
  backupPath: string,
): Readonly<RebuildManifest> | null {
  const manifest = readManifest(backupPath);
  return manifest ? Object.freeze(manifest) : null;
}

/** Verify that a published snapshot still has the selected manifest and its recorded payload. */
export function validateSnapshotBackupContent(
  manifest: RebuildManifest,
  options: { readonly requireV2Evidence?: boolean } = {},
): SnapshotBackupContentValidation {
  if (
    options.requireV2Evidence !== false &&
    manifest.version === MANIFEST_VERSION &&
    typeof manifest.backupContentSha256 !== "string"
  ) {
    return { ok: false, reason: "schema v2 backup manifest lacks content integrity evidence" };
  }
  let currentContentSha256: string | null = null;
  if (typeof manifest.backupContentSha256 === "string") {
    try {
      currentContentSha256 = hashSnapshotBackupContent(manifest.backupPath);
    } catch {
      return { ok: false, reason: "backup payload could not be verified safely" };
    }
    if (currentContentSha256 !== manifest.backupContentSha256) {
      return { ok: false, reason: "backup payload changed after publication" };
    }
  }
  const confirmedManifest = readManifest(manifest.backupPath);
  if (
    !confirmedManifest ||
    !isDeepStrictEqual(
      snapshotManifestAuthority(confirmedManifest),
      snapshotManifestAuthority(manifest),
    )
  ) {
    return { ok: false, reason: "persisted backup manifest changed during payload validation" };
  }
  return { ok: true, contentSha256: currentContentSha256 };
}

export function validateRebuildRecoveryManifestAtRoot(
  rebuildBackupsDir: string,
  sandboxName: string,
  owner:
    | string
    | null
    | undefined
    | Pick<SandboxEntry, "agent" | "harnessPackage" | "harnessPackageMigration">,
  candidate: RebuildManifest,
): RebuildRecoveryManifestValidation {
  const ownerEntry = typeof owner === "object" && owner !== null ? owner : null;
  const expectedAgent =
    String((ownerEntry ? ownerEntry.agent : owner) || "openclaw").trim() || "openclaw";
  const sandboxBackupRoot = path.resolve(rebuildBackupsDir, sandboxName);
  const expectedBackupPath = path.resolve(sandboxBackupRoot, candidate.timestamp);
  const candidateBackupPath = path.resolve(candidate.backupPath);

  if (
    candidateBackupPath !== expectedBackupPath ||
    path.dirname(candidateBackupPath) !== sandboxBackupRoot ||
    path.basename(candidateBackupPath) !== candidate.timestamp
  ) {
    return {
      ok: false,
      reason: `backup path does not match '${sandboxName}' and timestamp '${candidate.timestamp}'`,
    };
  }

  const persisted = readManifest(candidateBackupPath);
  if (!persisted) {
    return { ok: false, reason: "latest backup manifest is missing, malformed, or unsupported" };
  }
  if (persisted.sandboxName !== sandboxName) {
    return {
      ok: false,
      reason: `manifest sandbox '${persisted.sandboxName}' does not match '${sandboxName}'`,
    };
  }
  if (persisted.agentType !== expectedAgent) {
    return {
      ok: false,
      reason: `manifest agent '${persisted.agentType}' does not match registry agent '${expectedAgent}'`,
    };
  }
  if (
    persisted.timestamp !== candidate.timestamp ||
    path.resolve(persisted.backupPath) !== candidateBackupPath
  ) {
    return { ok: false, reason: "persisted backup identity changed during validation" };
  }
  if (
    !isDeepStrictEqual(snapshotManifestAuthority(persisted), snapshotManifestAuthority(candidate))
  ) {
    return { ok: false, reason: "persisted backup manifest changed during validation" };
  }
  if (persisted.backupComplete === false) {
    return { ok: false, reason: "backup manifest records an incomplete capture" };
  }
  if (persisted.version === 1 && (persisted.failedBackupDirs?.length ?? 0) > 0) {
    return {
      ok: false,
      reason: "legacy backup manifest records failed directory captures",
    };
  }
  if (persisted.version === MANIFEST_VERSION && persisted.backupComplete !== true) {
    return { ok: false, reason: "schema v2 backup manifest lacks completion evidence" };
  }
  const contentValidation = validateSnapshotBackupContent(persisted);
  if (!contentValidation.ok) return contentValidation;

  const manifestPackage = inspectRebuildManifestHarnessPackage(persisted);
  if (manifestPackage.status === "invalid") {
    return { ok: false, reason: "backup manifest package authority is invalid" };
  }
  if (!ownerEntry) {
    if (manifestPackage.status !== "legacy") {
      return {
        ok: false,
        reason: "package-bound backup recovery requires the owning sandbox registry entry",
      };
    }
    return { ok: true, manifest: persisted };
  }

  const ownerPackage = inspectHarnessPackageState(
    ownerEntry.harnessPackage,
    ownerEntry.harnessPackageMigration,
  );
  if (manifestPackage.status === "legacy") {
    return {
      ok: false,
      reason: "legacy backup manifest requires explicit package reconciliation before recovery",
    };
  }
  if (manifestPackage.status === "candidate") {
    if (ownerPackage.status !== "absent" || !isRepositoryQualifiedManifestAgent(expectedAgent)) {
      return {
        ok: false,
        reason: "candidate backup authority does not match the owning sandbox",
      };
    }
  } else if (
    ownerPackage.status !== "valid" ||
    !harnessPackageIdentitiesEqual(ownerPackage.harnessPackage, manifestPackage.harnessPackage)
  ) {
    return {
      ok: false,
      reason: "backup harness package does not match the owning sandbox",
    };
  }

  return { ok: true, manifest: persisted };
}
