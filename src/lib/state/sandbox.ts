// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Manifest-driven sandbox state backup and restore.
//
// Handles the sandbox→host direction for rebuild (reverse of migration-state.ts
// which handles host→sandbox for onboarding). Uses agent manifest state_dirs
// and configPaths to know what to back up, so it works for any agent type.
//
// Credentials are stripped from backups using shared credential-filter.ts.

import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  futimesSync,
  lstatSync,
  lutimesSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  readSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { spawnSync } from "child_process";

import {
  captureSandboxSshConfigCommand,
  resolveOpenshellSandboxSshHost,
} from "../adapters/openshell/client.js";
import { resolveOpenshell } from "../adapters/openshell/resolve.js";
import { OPENSHELL_PROBE_TIMEOUT_MS } from "../adapters/openshell/timeouts.js";
import type { AgentDefinition, AgentStateFile } from "../agent/defs.js";
import { loadAgent } from "../agent/defs.js";
import { GATEWAY_PORT } from "../core/ports.js";
import {
  BACKUP_FAILURE_ABSENT_AFTER_EXTRACTION,
  classifyFailedDirsFromTarStderr,
} from "../domain/backup-failure.js";
import { shellQuote } from "../runner.js";
import { createTempSshConfig } from "../sandbox/temp-ssh-config.js";
import {
  SnapshotSanitizerPrerequisiteError,
  sanitizeSnapshotDirectory,
} from "../security/snapshot-sanitizer.js";
import {
  buildRestoreCleanupCommand,
  buildRestoreTarArgs,
  isAllowedStateSymlink,
} from "./openclaw-managed-extensions.js";
import {
  discoverFreshOpenClawImagePluginInstalls,
  type OpenClawImagePluginInstall,
  parseOpenClawImagePluginInstalls,
  planOpenClawPluginRestore,
} from "./openclaw-plugin-restore.js";
import {
  extractPreservedEnvAssignments,
  HERMES_PRESERVED_ENV_INVENTORY,
  type PreservedEnvFile,
  type PreservedEnvInventory,
} from "./preserved-env/index.js";
import type { SandboxRuntimeSnapshot } from "./registry/runtime-snapshot.js";
import type {
  SandboxEntry,
  SandboxHostLocalInferenceProvenance,
  SandboxWorkloadReceipt,
} from "./registry/types.js";
import type { CustomPolicyEntry } from "./registry.js";
import * as registry from "./registry.js";
import { hashSnapshotBackupContent, hashSnapshotTree } from "./snapshot/content-digest.js";
import {
  hasInvalidMarkedOpenClawPluginProvenance,
  normalizeBackupAgentAuthority,
  normalizeSnapshotBackupAuthority,
  normalizeStateFilePath,
  normalizeStateFileSpecsPreservingDuplicates,
  readManifest,
  snapshotManifestAuthority,
  validateSnapshotBackupContent,
  validateRebuildRecoveryManifestAtRoot,
  writeManifest,
  type RebuildManifest,
  type RebuildRecoveryManifestValidation,
  type SnapshotEntry,
  type StateFileSpec,
} from "./snapshot/manifest.js";
import { isSshTransportFailure } from "./ssh-transport.js";
import { restoreStateFile } from "./state-file-restore.js";
import { nemoclawStateRoot } from "./state-root.js";
import { runTarListing, type TarArchiveSource } from "./tar-listing.js";

const HOME_DIR = path.resolve(process.env.HOME || os.homedir());
const REBUILD_BACKUPS_DIR = path.join(nemoclawStateRoot(HOME_DIR, GATEWAY_PORT), "rebuild-backups");
export const OPENCLAW_IMAGE_PLUGIN_PROVENANCE_RESTORE_ERROR =
  "custom-image OpenClaw plugin provenance is missing or invalid";
export const MANAGED_SNAPSHOT_RESTORE_AUTHORITY_ERROR =
  "managed snapshot restore requires exact content and runtime authority";
export const HOST_LOCAL_INFERENCE_SNAPSHOT_RESTORE_AUTHORITY_ERROR =
  "host-local inference snapshot restore requires exact content and runtime authority";
export const SCHEMA_V2_SNAPSHOT_RESTORE_AUTHORITY_ERROR =
  "schema v2 snapshot restore requires its pinned agent definition, exact content authority, and mutation fence";

export {
  hasAuthoritativeOpenClawImagePluginProvenance,
  inspectRebuildManifestHarnessPackage,
  readSandboxStateBackupManifest,
  snapshotManifestAuthority,
  validateSnapshotBackupContent,
} from "./snapshot/manifest.js";
export type {
  InstanceBackup,
  RebuildManifest,
  RebuildManifestHarnessPackageInspection,
  RebuildRecoveryManifestValidation,
  SnapshotEntry,
  StateFileSpec,
  StateFileStrategy,
} from "./snapshot/manifest.js";

/** Validate a recovery candidate against NemoClaw's configured backup root. */
export function validateRebuildRecoveryManifest(
  sandboxName: string,
  owner:
    | string
    | null
    | undefined
    | Pick<SandboxEntry, "agent" | "harnessPackage" | "harnessPackageMigration">,
  candidate: RebuildManifest,
): RebuildRecoveryManifestValidation {
  try {
    // Lexical containment is not enough when an ancestor below NemoClaw's
    // state root can redirect the candidate into another tree.
    rejectSymlinksOnPath(path.join(REBUILD_BACKUPS_DIR, sandboxName, candidate.timestamp));
  } catch {
    return {
      ok: false,
      reason: "backup path or one of its NemoClaw state ancestors is a symbolic link",
    };
  }
  return validateRebuildRecoveryManifestAtRoot(REBUILD_BACKUPS_DIR, sandboxName, owner, candidate);
}

// ── Types ──────────────────────────────────────────────────────────

export interface BackupOptions {
  name?: string | null;
  /** Definition resolved from the sandbox's durable package authority before backup mutation. */
  agentDefinition?: AgentDefinition;
  /** Exact package paired with agentDefinition; null is explicit candidate authority. */
  harnessPackage?: Exclude<RebuildManifest["harnessPackage"], undefined>;
  runtimeSnapshot?: SandboxRuntimeSnapshot;
  workload?: SandboxWorkloadReceipt;
  hostLocalInferenceReceipt?: string;
  hostLocalInferenceProvenance?: SandboxHostLocalInferenceProvenance;
  /**
   * Internal publication fence for provider-backed backups. The callback
   * runs after data capture and sanitization but before the manifest becomes
   * visible to restore and rebuild flows.
   */
  validateBeforePublish?: () => void;
  /**
   * Internal capture path for a declared state file that the sandbox-user SSH
   * transport cannot read. The caller must independently enforce path,
   * identity, and stable-read constraints before returning bytes.
   */
  captureStateFile?: StateFileCapture;
}

export interface StateFileCaptureRequest {
  sandboxName: string;
  dir: string;
  spec: StateFileSpec;
}

export type StateFileCaptureResult =
  | { outcome: "backed_up"; data: Buffer }
  | { outcome: "missing" }
  | { outcome: "failed"; error?: string; unreachable?: boolean };

export type StateFileCapture = (request: StateFileCaptureRequest) => StateFileCaptureResult | null;

export interface BackupResult {
  success: boolean;
  // Only set once the backup has been written to disk — absent on
  // precondition failures like an invalid --name.
  manifest?: RebuildManifest;
  backedUpDirs: string[];
  failedDirs: string[];
  // Per-dir failure cause for entries in failedDirs, keyed by dir name.
  // Distinguishes "permission denied" (tar could not read the content) from
  // "absent after extraction" (tar succeeded but the dir never materialized)
  // so operators can tell an ownership problem from a missing dir (#6455).
  // Dirs failed for other reasons may be absent from this map.
  failedDirReasons?: Record<string, string>;
  // Set when the failure is a precondition (e.g. duplicate --name) rather
  // than a mid-backup error. CLI surfaces this to the user verbatim.
  error?: string;
  backedUpFiles: string[];
  failedFiles: string[];
  // Set when a failure stems from an SSH transport failure against a running
  // sandbox (see isSshTransportFailure), as opposed to an audit rejection or
  // a partial tar read error.
  unreachable?: boolean;
}

export interface RestoreResult {
  success: boolean;
  restoredDirs: string[];
  failedDirs: string[];
  restoredFiles: string[];
  failedFiles: string[];
  /** A safe, user-actionable explanation for a restore precondition failure. */
  error?: string;
}

export interface SnapshotRestoreAuthority {
  readonly schemaVersion: 1;
  readonly backupPath: string;
  readonly contentSha256: string;
}

/** Private snapshot copy prepared before an operation can delete or create a sandbox. */
export interface PreparedSnapshotRestoreContent {
  readonly schemaVersion: 1;
  readonly selectedBackupPath: string;
  readonly stagedBackupPath: string;
  readonly authority: SnapshotRestoreAuthority;
  validate(): void;
  cleanup(): void;
}

export interface SnapshotRestoreOptions {
  /**
   * Exact agent definition selected from the sandbox's pinned harness package.
   * Managed restore callers provide this so the state layer never falls back
   * to the agent manifest in the current NemoClaw checkout.
   */
  readonly agentDefinition?: AgentDefinition;
  /**
   * Content identity captured from the selected manifest and every backup
   * payload. The state layer revalidates it after local staging and before
   * the first remote filesystem mutation.
   */
  readonly authority?: SnapshotRestoreAuthority;
  /** Operation-owned content prepared before an earlier destructive boundary. */
  readonly preparedContent?: PreparedSnapshotRestoreContent;
  /** Internal provider fence invoked at the same last-safe mutation edge. */
  readonly validateBeforeMutation?: () => void;
}

export interface RecreatedSandboxRestoreOptions extends SnapshotRestoreOptions {
  /** Agent in the newly created target image, not the backup manifest agent. */
  targetAgentType: string;
  /** Explicit capability for custom images whose config must be restored wholesale. */
  allowCustomImageWholeStateFileRestore?: true;
  /** Pre-captured baseline avoids a second remote read during onboarding finalization. */
  freshOpenClawImagePluginInstalls?: readonly OpenClawImagePluginInstall[];
}

interface InternalRestoreOptions {
  targetAgentType: string;
  agentDefinition?: AgentDefinition;
  allowCustomImageWholeStateFileRestore?: true;
  discoverFreshOpenClawImagePluginInstalls?: true;
  freshOpenClawImagePluginInstalls?: readonly OpenClawImagePluginInstall[];
  authority?: SnapshotRestoreAuthority;
  preparedContent?: PreparedSnapshotRestoreContent;
  validateBeforeMutation?: () => void;
}

export interface TarValidationResult {
  safe: boolean;
  entries: string[];
  violations: string[];
}

export interface SafeExtractResult {
  success: boolean;
  error?: string;
}

function cloneOpenClawImagePluginInstalls(
  installs: readonly OpenClawImagePluginInstall[],
): OpenClawImagePluginInstall[] {
  return installs.map((install) => ({
    ...install,
    ...(install.loadPaths !== undefined ? { loadPaths: [...install.loadPaths] } : {}),
  }));
}

// ── Safe tar extraction ──────────────────────────────────────────

/**
 * Normalize a host path for safe comparison.
 * Mirrors migration-state.ts normalizeHostPath().
 */
function normalizeHostPath(input: string): string {
  const resolved = path.resolve(input);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/**
 * Check whether candidatePath is within rootPath after normalization.
 * Mirrors migration-state.ts isWithinRoot().
 */
function isWithinRoot(candidatePath: string, rootPath: string): boolean {
  const candidate = normalizeHostPath(candidatePath);
  const root = normalizeHostPath(rootPath);
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Reject a path if it — or any ancestor up to $HOME — is a symlink.
 * Prevents an attacker from planting a symlink at the target path to
 * redirect reads or writes to an attacker-controlled directory.
 *
 * Mirrors the pattern from config-io.ts (PR #2290) and
 * nemoclaw/src/blueprint/snapshot.ts.
 */
function rejectSymlinksOnPath(targetPath: string): void {
  const home = HOME_DIR;
  const resolved = path.resolve(targetPath);

  const relToHome = path.relative(home, resolved);
  if (relToHome === "" || relToHome.startsWith("..") || path.isAbsolute(relToHome)) {
    return;
  }

  let current = resolved;
  while (current !== home && current !== path.dirname(current)) {
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) {
        const linkTarget = readlinkSync(current);
        throw new Error(
          `Refusing to operate on path: ${current} is a symbolic link ` +
            `(target: ${linkTarget}). This may indicate a symlink attack.`,
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    current = path.dirname(current);
  }
}

/**
 * List tar entries and validate every path is within targetDir.
 * Rejects absolute paths, path traversal (..), and null bytes.
 */
export function validateTarEntries(
  tarArchive: TarArchiveSource,
  targetDir: string,
): TarValidationResult {
  const entries: string[] = [];
  const listingFailure = runTarListing(tarArchive, ["-tf", "-"], "tar listing", (line) => {
    entries.push(line);
  });
  if (listingFailure) {
    return {
      safe: false,
      entries: [],
      violations: [listingFailure],
    };
  }

  const violations: string[] = [];

  for (const entry of entries) {
    // Reject null bytes (null byte injection)
    if (entry.includes("\0")) {
      violations.push(`null byte in entry: ${JSON.stringify(entry)}`);
      continue;
    }

    // Reject absolute paths
    if (entry.startsWith("/")) {
      violations.push(`absolute path: ${entry}`);
      continue;
    }

    // Resolve the entry relative to targetDir and check containment
    const resolved = path.resolve(targetDir, entry);
    if (!isWithinRoot(resolved, targetDir)) {
      violations.push(`path traversal: ${entry}`);
    }
  }

  return { safe: violations.length === 0, entries, violations };
}

/**
 * Walk a directory and return violations for any symlinks whose
 * resolved targets don't land within any of the allowed roots.
 *
 * `allowedRoots` always includes the extraction directory (the local host
 * path). Callers pass additional roots — notably `/sandbox` — to permit
 * legitimate intra-sandbox symlinks baked into the sandbox base image
 * (e.g. `/sandbox/.openclaw` → `/sandbox/.openclaw-data`). Those look
 * like "escapes" relative to the extraction temp dir on the host, but
 * are intra-sandbox once the backup is restored. See issue #2268.
 */
function auditExtractedSymlinks(dirPath: string, allowedRoots: string[]): string[] {
  const violations: string[] = [];
  if (!existsSync(dirPath)) return violations;

  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      try {
        const stat = lstatSync(fullPath);
        if (stat.isSymbolicLink()) {
          const linkTarget = readlinkSync(fullPath);

          // Allowed npm symlinks baked into managed or custom images. The
          // shared matcher checks both source shape and exact target so the
          // pre-backup and post-extraction audits enforce the same contract.
          // A recognized path with a tampered target falls through to the
          // normal containment check.
          const relFromDir = path.relative(dirPath, fullPath).split(path.sep).join("/");
          if (isAllowedStateSymlink(relFromDir, linkTarget)) {
            continue;
          }

          // Resolve relative to the symlink's containing directory (standard).
          const resolvedRelative = path.resolve(path.dirname(fullPath), linkTarget);

          // For absolute symlinks that point into the canonical sandbox data
          // directory (/sandbox/.openclaw-data/** or /sandbox/.hermes-data/**),
          // also check whether the target falls within the extraction root when
          // the leading /sandbox/ prefix is mapped onto the archive root. This
          // mirrors how the symlink resolves once the backup is restored inside
          // the sandbox container (where /sandbox/.openclaw-data/* exists).
          //
          // Only /sandbox/ prefixed targets receive this treatment so that
          // symlinks pointing to arbitrary absolute paths (e.g. /etc/passwd)
          // are still rejected. Fixes #2317.
          const SANDBOX_DATA_PREFIXES = ["/sandbox/.openclaw-data/", "/sandbox/.hermes-data/"];
          // Normalize the target first to collapse any .. traversal segments
          // (e.g. /sandbox/.openclaw-data/../../etc/passwd → /etc/passwd).
          // Only then check the prefix — this prevents a traversal bypass
          // where a crafted target starts with an allowed prefix but escapes it.
          const normalizedTarget = path.posix.normalize(linkTarget);
          const resolvedInArchive =
            path.isAbsolute(normalizedTarget) &&
            SANDBOX_DATA_PREFIXES.some((p) => normalizedTarget.startsWith(p))
              ? path.resolve(dirPath, normalizedTarget.replace(/^\//, ""))
              : null;

          const inAnyAllowedRoot =
            allowedRoots.some((root) => isWithinRoot(resolvedRelative, root)) ||
            (resolvedInArchive !== null && isWithinRoot(resolvedInArchive, dirPath));

          if (!inAnyAllowedRoot) {
            violations.push(
              `symlink escape: ${fullPath} -> ${linkTarget} (resolves to ${resolvedRelative})`,
            );
          }
        } else if (stat.isDirectory()) {
          walk(fullPath);
        }
      } catch {
        /* skip unreadable entries */
      }
    }
  };
  walk(dirPath);
  return violations;
}

/**
 * Detect hard-link entries in a tar archive using verbose listing.
 * Hard links are rejected entirely — sandbox state backups have no
 * legitimate reason to contain them, and they can be used to reference
 * files outside the extraction root.
 */
export function rejectHardLinks(tarArchive: TarArchiveSource): string[] {
  const violations: string[] = [];
  const listingFailure = runTarListing(tarArchive, ["-tvf", "-"], "tar verbose listing", (line) => {
    // Both GNU tar and bsdtar prefix hard-link entries with 'h' in verbose mode
    // and include " link to " in the line.
    if (line.startsWith("h") || / link to /.test(line)) {
      violations.push(`hard link: ${line.trim()}`);
    }
  });
  if (listingFailure) return [listingFailure];

  return violations;
}

/**
 * SECURITY: Validate tar contents, extract with safety flags, then
 * audit for symlink escapes. Nukes the extraction on any violation.
 */
export function safeTarExtract(tarArchive: TarArchiveSource, targetDir: string): SafeExtractResult {
  // Phase 1a: Validate entry paths before extraction
  const validation = validateTarEntries(tarArchive, targetDir);
  if (!validation.safe) {
    return {
      success: false,
      error: `tar entry validation failed: ${validation.violations.join("; ")}`,
    };
  }

  // Phase 1b: Reject hard links (not detectable via tar -tf, require verbose listing)
  const hardLinkViolations = rejectHardLinks(tarArchive);
  if (hardLinkViolations.length > 0) {
    return {
      success: false,
      error: `hard link rejected: ${hardLinkViolations.join("; ")}`,
    };
  }

  // Phase 2: Extract with --no-same-owner to prevent ownership manipulation
  let archiveFd: number | null = null;
  let extractResult: ReturnType<typeof spawnSync>;
  try {
    extractResult = Buffer.isBuffer(tarArchive)
      ? spawnSync("tar", ["-xf", "-", "--no-same-owner", "-C", targetDir], {
          input: tarArchive,
          stdio: ["pipe", "pipe", "pipe"],
          timeout: 60000,
        })
      : (() => {
          archiveFd = openSync(tarArchive.filePath, "r");
          return spawnSync("tar", ["-xf", "-", "--no-same-owner", "-C", targetDir], {
            stdio: [archiveFd, "pipe", "pipe"],
            timeout: 60000,
          });
        })();
  } finally {
    if (archiveFd !== null) closeSync(archiveFd);
  }

  if (extractResult.status !== 0) {
    return {
      success: false,
      error: `tar extraction failed (exit ${extractResult.status}): ${(extractResult.stderr?.toString() || "").substring(0, 200)}`,
    };
  }

  // Phase 3: Post-extraction symlink audit (symlink targets are not
  // visible in `tar -tf` output, so we must check after extraction).
  // Allow targets inside either the host extraction dir OR the canonical
  // sandbox root (/sandbox) — the latter covers legitimate intra-sandbox
  // symlinks baked into the base image (see #2268).
  const symlinkViolations = auditExtractedSymlinks(targetDir, [targetDir, "/sandbox"]);
  if (symlinkViolations.length > 0) {
    // Nuke the extraction — do not leave attacker-controlled symlinks on host
    try {
      rmSync(targetDir, { recursive: true, force: true });
      mkdirSync(targetDir, { recursive: true, mode: 0o700 });
    } catch {
      /* best effort cleanup */
    }
    return {
      success: false,
      error: `post-extraction symlink audit failed: ${symlinkViolations.join("; ")}`,
    };
  }

  return { success: true };
}

// ── Helpers ────────────────────────────────────────────────────────

export function getSshConfig(sandboxName: string): string | null {
  const openshellBinary = resolveOpenshell();
  if (!openshellBinary) return null;

  const result = captureSandboxSshConfigCommand(openshellBinary, sandboxName, {
    ignoreError: true,
    timeout: OPENSHELL_PROBE_TIMEOUT_MS,
  });
  if (result.status !== 0) return null;
  return result.output;
}

export function sshArgs(configFile: string, sandboxName: string): string[] {
  const sshHost = resolveOpenshellSandboxSshHost(sandboxName, readFileSync(configFile, "utf8"));
  if (sshHost === null) {
    throw new Error(
      `OpenShell SSH config does not declare an exact host alias for sandbox '${sandboxName}'`,
    );
  }
  return [
    "-F",
    configFile,
    "-o",
    "StrictHostKeyChecking=no",
    "-o",
    "UserKnownHostsFile=/dev/null",
    "-o",
    "ConnectTimeout=10",
    "-o",
    "LogLevel=ERROR",
    sshHost,
  ];
}

function computeBlueprintDigest(): string | null {
  // Look for blueprint.yaml relative to the agent-defs ROOT
  const candidates = [
    path.join(
      nemoclawStateRoot(process.env.HOME || "/tmp", GATEWAY_PORT),
      "blueprints",
      "0.1.0",
      "blueprint.yaml",
    ),
    path.join(__dirname, "..", "..", "nemoclaw-blueprint", "blueprint.yaml"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) {
      return createHash("sha256").update(readFileSync(p)).digest("hex");
    }
  }
  return null;
}

export interface BackupSanitizationOperations {
  sanitizeDirectory: (backupPath: string) => void;
  removeBackup: (backupPath: string) => void;
  backupExists: (backupPath: string) => boolean;
}

const DEFAULT_BACKUP_SANITIZATION_OPERATIONS: BackupSanitizationOperations = {
  sanitizeDirectory: sanitizeSnapshotDirectory,
  removeBackup: (backupPath) => rmSync(backupPath, { recursive: true, force: true }),
  backupExists: existsSync,
};

/** @visibleForTesting */
export function sanitizeBackupDirectory(
  dirPath: string,
  overrides: Partial<BackupSanitizationOperations> = {},
): void {
  const operations = { ...DEFAULT_BACKUP_SANITIZATION_OPERATIONS, ...overrides };

  try {
    operations.sanitizeDirectory(dirPath);
  } catch (error) {
    // sanitizeBackupDirectory replaces the message, so an unmet prerequisite
    // would otherwise survive only as `cause` and never reach the operator. (#8202)
    const prerequisite =
      error instanceof SnapshotSanitizerPrerequisiteError ? `${error.message}. ` : "";
    const validatedSnapshotPath =
      error instanceof SnapshotSanitizerPrerequisiteError ? error.snapshotPath : null;
    try {
      operations.removeBackup(dirPath);
    } catch (cleanupError) {
      const retainedPath =
        validatedSnapshotPath === null
          ? ""
          : `; the incomplete backup may remain at ${validatedSnapshotPath}`;
      throw new Error(
        `${prerequisite}Credential sanitization failed and backup cleanup failed${retainedPath}`,
        {
          cause: new AggregateError(
            [error, cleanupError],
            "Snapshot sanitization and backup cleanup both failed",
          ),
        },
      );
    }
    if (operations.backupExists(dirPath)) {
      const retainedPath = validatedSnapshotPath === null ? "" : ` at ${validatedSnapshotPath}`;
      throw new Error(
        `${prerequisite}Credential sanitization failed and the incomplete backup remains${retainedPath}`,
        { cause: error },
      );
    }
    throw new Error(
      `${prerequisite}Credential sanitization failed; removed the incomplete backup`,
      {
        cause: error,
      },
    );
  }
}

export interface IncompleteSnapshotRemoval {
  readonly removed: boolean;
  readonly error?: string;
}

export function removeIncompleteSnapshot(
  backupPath: string,
  overrides: Partial<Pick<BackupSanitizationOperations, "removeBackup" | "backupExists">> = {},
): IncompleteSnapshotRemoval {
  const operations = { ...DEFAULT_BACKUP_SANITIZATION_OPERATIONS, ...overrides };
  try {
    operations.removeBackup(backupPath);
  } catch (error) {
    return { removed: false, error: error instanceof Error ? error.message : String(error) };
  }
  if (operations.backupExists(backupPath)) {
    return { removed: false, error: "the snapshot directory still exists after removal" };
  }
  return { removed: true };
}

// ── Logging ────────────────────────────────────────────────────────

const _verbose = () => process.env.NEMOCLAW_REBUILD_VERBOSE === "1";

function _log(msg: string): void {
  if (_verbose()) console.error(`  [sandbox-state ${new Date().toISOString()}] ${msg}`);
}

// ── Naming / versioning helpers ────────────────────────────────────

const VERSION_SELECTOR_RE = /^v(\d+)$/i;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;
const SAFE_DYNAMIC_STATE_DIR_RE = /^[A-Za-z0-9._-]+$/;

export function validateSnapshotName(name: string): string | null {
  if (!NAME_RE.test(name)) {
    return (
      `Invalid snapshot name '${name}'. Use 1–63 chars from [A-Za-z0-9._-], ` +
      `starting with an alphanumeric.`
    );
  }
  if (VERSION_SELECTOR_RE.test(name)) {
    return (
      `Snapshot name '${name}' conflicts with the auto-assigned version format ` +
      `(v<N>). Pick a different name.`
    );
  }
  return null;
}

function isAllowedDiscoveredStateDir(
  candidate: string,
  exactDirectories: readonly string[],
  directoryPrefixes: readonly string[],
): boolean {
  if (exactDirectories.includes(candidate)) return true;
  return (
    SAFE_DYNAMIC_STATE_DIR_RE.test(candidate) &&
    directoryPrefixes.some((prefix) => candidate.startsWith(prefix))
  );
}

function hasStateDirectorySources(
  exactDirectories: readonly string[],
  directoryPrefixes: readonly string[],
): boolean {
  return exactDirectories.length > 0 || directoryPrefixes.length > 0;
}

function describeStateDirDiscoveryFailure(
  result: ReturnType<typeof spawnSync>,
  invalidDirectories: readonly string[],
): { log: string; unreachable: boolean; error?: string } | null {
  if (result.status !== 0) {
    return {
      log: `FAILED: SSH dir check exited ${String(result.status)} — cannot determine which dirs exist`,
      unreachable: isSshTransportFailure(result),
    };
  }
  if (invalidDirectories.length > 0) {
    return {
      log: `SECURITY: State directory discovery returned undeclared or unsafe entries: ${invalidDirectories.map((entry) => JSON.stringify(entry)).join(", ")}`,
      unreachable: false,
      error: "State directory discovery returned undeclared or unsafe entries",
    };
  }
  return null;
}

function existingBackupDirs(backupPath: string, dirNames: string[]): string[] {
  const existing: string[] = [];
  for (const dirName of dirNames) {
    try {
      if (lstatSync(path.join(backupPath, dirName)).isDirectory()) {
        existing.push(dirName);
      }
    } catch {
      /* missing, broken, or inaccessible backup entry */
    }
  }
  return existing;
}

function normalizeStateFileSpecs(
  specs: readonly (AgentStateFile | StateFileSpec)[],
): StateFileSpec[] {
  const normalized: StateFileSpec[] = [];
  const seen = new Set<string>();
  for (const next of normalizeStateFileSpecsPreservingDuplicates(specs)) {
    const key = `${next.strategy}:${next.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(next);
  }
  return normalized;
}

function stateFileRemotePath(dir: string, filePath: string): string {
  return `${dir.replace(/\/+$/, "")}/${filePath}`;
}

const SQLITE_BACKUP_PY = [
  "import sqlite3, sys",
  "src, dst = sys.argv[1], sys.argv[2]",
  "src_conn = sqlite3.connect('file:' + src + '?mode=ro', uri=True, timeout=30)",
  "dst_conn = sqlite3.connect(dst, timeout=30)",
  "try:",
  "    dst_conn.execute('PRAGMA busy_timeout=30000')",
  "    src_conn.backup(dst_conn)",
  "    ok = dst_conn.execute('PRAGMA quick_check').fetchone()[0]",
  "    if ok != 'ok':",
  "        raise SystemExit('sqlite quick_check failed: ' + str(ok))",
  "finally:",
  "    dst_conn.close()",
  "    src_conn.close()",
].join("\n");

export function buildStateFileBackupCommand(dir: string, spec: StateFileSpec): string {
  const remotePath = stateFileRemotePath(dir, spec.path);
  const quotedRemotePath = shellQuote(remotePath);
  if (spec.strategy === "sqlite_backup") {
    return [
      `src=${quotedRemotePath}`,
      '[ ! -e "$src" ] && exit 2',
      '[ -f "$src" ] && [ ! -L "$src" ] || { echo "unsafe sqlite state file: $src" >&2; exit 10; }',
      'hardlink_count="$(find "$src" -maxdepth 0 -type f -links +1 -print 2>/dev/null | wc -l | tr -d " ")"',
      '[ "${hardlink_count:-0}" = "0" ] || { echo "hard-linked sqlite state file rejected: $src" >&2; exit 11; }',
      'tmp="$(mktemp /tmp/nemoclaw-sqlite-backup.XXXXXX)"',
      "trap 'rm -f \"$tmp\"' EXIT",
      `/usr/bin/python3 -I -S -c ${shellQuote(SQLITE_BACKUP_PY)} "$src" "$tmp" && cat -- "$tmp"`,
    ].join("; ");
  }

  return [
    `src=${quotedRemotePath}`,
    '[ ! -e "$src" ] && exit 2',
    '[ -f "$src" ] && [ ! -L "$src" ] || { echo "unsafe state file: $src" >&2; exit 10; }',
    'hardlink_count="$(find "$src" -maxdepth 0 -type f -links +1 -print 2>/dev/null | wc -l | tr -d " ")"',
    '[ "${hardlink_count:-0}" = "0" ] || { echo "hard-linked state file rejected: $src" >&2; exit 11; }',
    'cat -- "$src"',
  ].join("; ");
}

type StateFileBackupOutcome = "backed_up" | "missing" | "failed";

interface StateFileBackupResult {
  outcome: StateFileBackupOutcome;
  // Set on "failed" when the SSH probe itself failed at the transport level
  // (exit 255, signal-killed, spawn error). The caller (backupSandboxState)
  // propagates this into BackupResult.unreachable so that
  // NEMOCLAW_SKIP_UNREACHABLE_SANDBOX_BACKUP=1 activates for state-file
  // failures too, not only the initial dir probe. See #6188.
  unreachable: boolean;
}

function capturePreservedEnvFile(
  configFile: string,
  sandboxName: string,
  dir: string,
  inventory: PreservedEnvInventory,
): { outcome: StateFileBackupOutcome; file?: PreservedEnvFile; unreachable: boolean } {
  const command = buildStateFileBackupCommand(dir, {
    path: inventory.path,
    strategy: "copy",
  });
  _log(`Capturing preserved environment assignments from ${inventory.path}`);
  const result = spawnSync("ssh", [...sshArgs(configFile, sandboxName), command], {
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30000,
    maxBuffer: 1024 * 1024,
  });
  if (result.status === 2) return { outcome: "missing", unreachable: false };
  if (result.status !== 0 || result.error || result.signal || !result.stdout) {
    const detail =
      (result.stderr?.toString() || "").trim() ||
      result.error?.message ||
      (result.signal ? `signal ${result.signal}` : `exit ${String(result.status)}`);
    _log(`FAILED: preserved environment capture ${inventory.path}: ${detail.substring(0, 200)}`);
    return { outcome: "failed", unreachable: isSshTransportFailure(result) };
  }
  try {
    const assignments = extractPreservedEnvAssignments(result.stdout.toString("utf8"), inventory);
    _log(
      `Captured ${assignments.length} preserved environment ${assignments.length === 1 ? "key" : "keys"} from ${inventory.path}`,
    );
    return {
      outcome: "backed_up",
      file: { path: inventory.path, assignments },
      unreachable: false,
    };
  } catch (error) {
    _log(
      `FAILED: preserved environment capture ${inventory.path}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return { outcome: "failed", unreachable: false };
  }
}

function capturePreservedEnvFiles(
  configFile: string,
  sandboxName: string,
  dir: string,
  inventories: readonly PreservedEnvInventory[],
): { files: PreservedEnvFile[]; failedPaths: string[]; unreachable: boolean } {
  const files: PreservedEnvFile[] = [];
  const failedPaths: string[] = [];
  let unreachable = false;
  for (const inventory of inventories) {
    const result = capturePreservedEnvFile(configFile, sandboxName, dir, inventory);
    if (result.outcome === "backed_up" && result.file) {
      files.push(result.file);
    } else if (result.outcome === "failed") {
      failedPaths.push(inventory.path);
      if (result.unreachable) unreachable = true;
    }
  }
  return { files, failedPaths, unreachable };
}

function captureAgentPreservedEnvFiles(
  agentName: string,
  configFile: string,
  sandboxName: string,
  dir: string,
  manifest: RebuildManifest,
  failedFiles: string[],
): boolean {
  if (agentName !== "hermes") return false;
  const preserved = capturePreservedEnvFiles(
    configFile,
    sandboxName,
    dir,
    HERMES_PRESERVED_ENV_INVENTORY,
  );
  manifest.preservedEnv = preserved.files;
  failedFiles.push(...preserved.failedPaths);
  return preserved.unreachable;
}

function backupStateFile(
  configFile: string,
  sandboxName: string,
  dir: string,
  spec: StateFileSpec,
  backupPath: string,
  captureFallback?: StateFileCapture,
): StateFileBackupResult {
  const command = buildStateFileBackupCommand(dir, spec);
  _log(`Backing up state file ${spec.path} (${spec.strategy})`);
  const result = spawnSync("ssh", [...sshArgs(configFile, sandboxName), command], {
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 120000,
    maxBuffer: 256 * 1024 * 1024,
  });

  if (result.status === 2) return { outcome: "missing", unreachable: false };
  const emptySqliteBackup = spec.strategy === "sqlite_backup" && result.stdout?.length === 0;
  let captured: StateFileCaptureResult | null = null;
  if (result.status === 1 && !result.error && !result.signal && captureFallback !== undefined) {
    try {
      captured = captureFallback({ sandboxName, dir, spec });
    } catch (error) {
      captured = {
        outcome: "failed",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
  if (captured?.outcome === "missing") return { outcome: "missing", unreachable: false };
  const capturedData = captured?.outcome === "backed_up" ? captured.data : null;
  if (
    (result.status !== 0 || result.error || result.signal || !result.stdout || emptySqliteBackup) &&
    capturedData === null
  ) {
    const detail =
      (captured?.outcome === "failed" ? captured.error : undefined) ||
      (result.stderr?.toString() || "").trim() ||
      result.error?.message ||
      (result.signal
        ? `signal ${result.signal}`
        : emptySqliteBackup
          ? "empty output"
          : `exit ${String(result.status)}`);
    _log(`FAILED: state file backup ${spec.path}: ${detail.substring(0, 200)}`);
    return {
      outcome: "failed",
      unreachable:
        (captured?.outcome === "failed" && captured.unreachable === true) ||
        isSshTransportFailure(result),
    };
  }

  const localPath = path.join(backupPath, spec.path);
  const parent = path.dirname(localPath);
  rejectSymlinksOnPath(parent);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  rejectSymlinksOnPath(localPath);
  writeFileSync(localPath, capturedData ?? result.stdout);
  chmodSync(localPath, 0o600);
  return { outcome: "backed_up", unreachable: false };
}

// ── Backup ─────────────────────────────────────────────────────────

/**
 * Back up all state directories from a running sandbox.
 * Uses the agent manifest to determine which directories contain state.
 */

export { buildStateFileRestoreCommand } from "./state-file-restore.js";
// isSshTransportFailure lives in ./ssh-transport now. Re-exported here for
// backwards compatibility with callers that used to import it from this
// module. Prefer importing directly from ./ssh-transport in new code.
export { isSshTransportFailure };

function validateSnapshotPublication(
  backupPath: string,
  validateBeforePublish: BackupOptions["validateBeforePublish"],
): string | null {
  if (!validateBeforePublish) return null;
  try {
    validateBeforePublish();
    return null;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    try {
      rmSync(backupPath, { recursive: true, force: true });
      return `Snapshot authority changed during backup: ${detail}`;
    } catch (cleanupError) {
      const cleanupDetail =
        cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      return (
        `Snapshot authority changed during backup: ${detail}. ` +
        `The unpublished backup at '${backupPath}' could not be removed: ${cleanupDetail}`
      );
    }
  }
}

function recordBackupContentIntegrity(
  backupPath: string,
  manifest: RebuildManifest,
): string | null {
  if (manifest.version !== 2) return null;
  try {
    manifest.backupContentSha256 = hashSnapshotBackupContent(backupPath);
    return null;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    try {
      rmSync(backupPath, { recursive: true, force: true });
      return `Snapshot content integrity publication failed: ${detail}`;
    } catch (cleanupError) {
      const cleanupDetail =
        cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      return (
        `Snapshot content integrity publication failed: ${detail}. ` +
        `The unpublished backup at '${backupPath}' could not be removed: ${cleanupDetail}`
      );
    }
  }
}

function resolveOpenClawBackupMetadata(
  agentName: string,
  sandbox: SandboxEntry | null,
  configDir: string,
): {
  readonly reconcileImagePluginProvenance: boolean;
  readonly pluginInstalls?: OpenClawImagePluginInstall[];
  readonly error?: string;
} {
  const reconcileImagePluginProvenance =
    agentName === "openclaw" && Boolean(sandbox?.fromDockerfile);
  if (
    agentName !== "openclaw" ||
    (!reconcileImagePluginProvenance && sandbox?.openclawImagePluginInstalls === undefined)
  ) {
    return { reconcileImagePluginProvenance };
  }
  const provenance = parseOpenClawImagePluginInstalls(
    sandbox?.openclawImagePluginInstalls,
    configDir,
  );
  if (!provenance.ok) {
    return {
      reconcileImagePluginProvenance,
      error: "registered OpenClaw image plugin provenance is missing or invalid",
    };
  }
  return {
    reconcileImagePluginProvenance,
    pluginInstalls: cloneOpenClawImagePluginInstalls(provenance.pluginInstalls),
  };
}

type PreBackupAuditEntry = readonly [type: string, absPath: string, linkTarget: string];

/** Parse NUL-delimited type, path, and link-target fields from the remote audit. */
function parsePreBackupAuditEntries(output: string): PreBackupAuditEntry[] | null {
  if (output.length === 0) return [];
  const fields = output.split("\0");
  if (fields.pop() !== "" || fields.length % 3 !== 0) return null;
  const entries: PreBackupAuditEntry[] = [];
  for (let index = 0; index < fields.length; index += 3) {
    entries.push([fields[index] ?? "", fields[index + 1] ?? "", fields[index + 2] ?? ""]);
  }
  return entries;
}

/** Classify one strictly framed pre-backup audit entry. */
function classifyPreBackupAuditEntry(
  [type, absPath, linkTarget]: PreBackupAuditEntry,
  dirPrefix: string,
): "whitelisted" | "hardLinked" | "violation" {
  const relPath = absPath.startsWith(dirPrefix) ? absPath.slice(dirPrefix.length) : absPath;
  if (type === "l" && isAllowedStateSymlink(relPath, linkTarget)) return "whitelisted";
  // The audit's `find` only emits regular files through its `-links +1`
  // branch, so a reported `f` row is a hard link. Recorded, not rejected —
  // see the rationale at the audit command (#9314).
  if (type === "f") return "hardLinked";
  return "violation";
}

export function backupSandboxState(sandboxName: string, options: BackupOptions = {}): BackupResult {
  const sb = registry.getSandbox(sandboxName);
  const agentAuthority = normalizeBackupAgentAuthority(sb, options, loadAgent);
  if (!agentAuthority.ok) {
    return {
      success: false,
      backedUpDirs: [],
      failedDirs: [],
      backedUpFiles: [],
      failedFiles: [],
      error: agentAuthority.error,
    };
  }
  const { agent, agentName } = agentAuthority;
  const dir = agent.configPaths.dir;
  const stateDirs = agent.backupStateDirs;
  const stateDirPrefixes = agent.backupStateDirPrefixes;
  const hasBackupDirectories = hasStateDirectorySources(stateDirs, stateDirPrefixes);
  const stateFiles = normalizeStateFileSpecs(agent.stateFiles);
  _log(
    `backupSandboxState: agent=${agentName}, dir=${dir}, stateDirs=[${stateDirs.join(",")}], stateDirPrefixes=[${stateDirPrefixes.join(",")}], stateFiles=[${stateFiles.map((f) => f.path).join(",")}]`,
  );

  const snapshotAuthority = normalizeSnapshotBackupAuthority(options);
  if (snapshotAuthority.error) {
    return {
      success: false,
      backedUpDirs: [],
      failedDirs: [],
      backedUpFiles: [],
      failedFiles: [],
      error: snapshotAuthority.error,
    };
  }

  const openClawMetadata = resolveOpenClawBackupMetadata(agentName, sb, dir);
  if (openClawMetadata.error) {
    return {
      success: false,
      backedUpDirs: [],
      failedDirs: [],
      backedUpFiles: [],
      failedFiles: [],
      error: openClawMetadata.error,
    };
  }

  // Validate user-supplied name and check for conflicts BEFORE creating any
  // files on disk.
  const existingBackups = listBackups(sandboxName);
  // Preserve empty strings so `--name ""` hits validateSnapshotName and fails
  // with a clear error instead of silently creating an unnamed snapshot.
  const providedName = options.name ?? null;
  if (providedName !== null) {
    const validationError = validateSnapshotName(providedName);
    if (validationError) {
      return {
        success: false,
        backedUpDirs: [],
        failedDirs: [],
        backedUpFiles: [],
        failedFiles: [],
        error: validationError,
      };
    }
    const conflict = existingBackups.find((b) => b.name === providedName);
    if (conflict) {
      return {
        success: false,
        backedUpDirs: [],
        failedDirs: [],
        backedUpFiles: [],
        failedFiles: [],
        error:
          `Snapshot name '${providedName}' already exists for '${sandboxName}' ` +
          `(at ${conflict.timestamp}). Pick a different name or delete the existing snapshot.`,
      };
    }
  }
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = path.join(REBUILD_BACKUPS_DIR, sandboxName, timestamp);
  if (existsSync(backupPath)) {
    return {
      success: false,
      backedUpDirs: [],
      failedDirs: [],
      backedUpFiles: [],
      failedFiles: [],
      error: `Snapshot path '${backupPath}' already exists; retry the backup.`,
    };
  }

  // SECURITY: Verify backup destination ancestors are not symlinks.
  // Without this check, an attacker who plants ~/.nemoclaw/rebuild-backups
  // as a symlink could redirect snapshot content to an arbitrary directory.
  rejectSymlinksOnPath(backupPath);

  mkdirSync(backupPath, { recursive: true, mode: 0o700 });
  // Re-check after creation to narrow the TOCTOU race window —
  // a symlink swapped in between the first check and mkdirSync is caught here.
  rejectSymlinksOnPath(backupPath);

  // Capture applied policy presets from the registry so they can be
  // re-applied after rebuild. Presets live in the gateway policy engine,
  // not on the sandbox filesystem, so they are lost on destroy/recreate.
  const policyPresets: string[] = sb?.policies && sb.policies.length > 0 ? [...sb.policies] : [];
  _log(`policyPresets from registry: [${policyPresets.join(",")}]`);
  // Custom presets (--from-file/--from-dir) also live only in the gateway policy
  // engine, so capture their full content for replay. Always record the field
  // (even empty) so restore can tell a zero-custom snapshot (reconcile, remove
  // any stale custom presets on the target) from a legacy snapshot (skip).
  const customPolicies: CustomPolicyEntry[] = sb?.customPolicies ? [...sb.customPolicies] : [];
  _log(`customPolicies from registry: [${customPolicies.map((c) => c.name).join(",")}]`);

  const manifest: RebuildManifest = {
    version: agentAuthority.manifestVersion,
    sandboxName,
    timestamp,
    agentType: agentName,
    agentVersion: sb?.agentVersion || null,
    expectedVersion: agent.expectedVersion,
    ...(agentAuthority.manifestVersion === 2
      ? { harnessPackage: agentAuthority.harnessPackage ?? null }
      : {}),
    ...(openClawMetadata.pluginInstalls !== undefined
      ? { openclawImagePluginInstalls: openClawMetadata.pluginInstalls }
      : {}),
    ...(openClawMetadata.reconcileImagePluginProvenance
      ? { reconcileOpenClawImagePluginProvenance: true }
      : {}),
    stateDirs,
    failedBackupDirs: [],
    backupComplete: false,
    stateFiles,
    dir,
    backupPath,
    blueprintDigest: computeBlueprintDigest(),
    policyPresets,
    customPolicies,
    ...(agentName === "hermes" ? { preservedEnv: [] } : {}),
    ...snapshotAuthority,
    ...(providedName !== null ? { name: providedName } : {}),
  };

  const backedUpDirs: string[] = [];
  const failedDirs: string[] = [];
  const failedDirReasons: Record<string, string> = {};
  const backedUpFiles: string[] = [];
  const failedFiles: string[] = [];
  let unreachable = false;

  if (!hasBackupDirectories && stateFiles.length === 0) {
    _log("WARNING: Agent manifest declares no state_dirs or state_files — nothing to back up");
    const publicationError = validateSnapshotPublication(backupPath, options.validateBeforePublish);
    if (publicationError) {
      return {
        success: false,
        backedUpDirs: [],
        failedDirs: [],
        backedUpFiles: [],
        failedFiles: [],
        error: publicationError,
      };
    }
    manifest.backupComplete = true;
    const integrityError = recordBackupContentIntegrity(backupPath, manifest);
    if (integrityError) {
      return {
        success: false,
        backedUpDirs: [],
        failedDirs: [],
        backedUpFiles: [],
        failedFiles: [],
        error: integrityError,
      };
    }
    const finalPublicationError = validateSnapshotPublication(
      backupPath,
      options.validateBeforePublish,
    );
    if (finalPublicationError) {
      return {
        success: false,
        backedUpDirs: [],
        failedDirs: [],
        backedUpFiles: [],
        failedFiles: [],
        error: finalPublicationError,
      };
    }
    writeManifest(backupPath, manifest);
    return { success: true, manifest, backedUpDirs, failedDirs, backedUpFiles, failedFiles };
  }

  // SSH+tar single-roundtrip download
  _log("Getting SSH config via openshell sandbox ssh-config");
  const sshConfig = getSshConfig(sandboxName);
  if (!sshConfig) {
    _log("FAILED: Could not get SSH config");
    // For a sandbox the registry reported as running, an unreachable
    // `openshell sandbox ssh-config` lookup is a transport-level failure —
    // treat it the same as the initial dir probe and propagate `unreachable`
    // so NEMOCLAW_SKIP_UNREACHABLE_SANDBOX_BACKUP=1 can activate. (#6188)
    return {
      success: false,
      manifest,
      backedUpDirs,
      failedDirs: [...stateDirs],
      backedUpFiles,
      failedFiles: stateFiles.map((f) => f.path),
      unreachable: true,
    };
  }
  _log(`SSH config obtained (${sshConfig.length} bytes)`);

  const tempSshConfig = createTempSshConfig(sshConfig, "nemoclaw-state-");
  const configFile = tempSshConfig.file;
  try {
    if (hasBackupDirectories) {
      // Build tar command that only includes existing directories.
      // First, check which declared state dirs actually exist in the sandbox,
      // then discover directories matching prefixes declared by the same agent
      // contract. Quote each literal prefix and leave only the appended `*`
      // unquoted for expansion. Reject non-canonical basenames in the sandbox
      // before emitting newline-delimited output, then independently validate
      // every result on the host.
      const discoveryCommands = [
        ...stateDirs.map(
          (d) => `[ -d ${shellQuote(`${dir}/${d}`)} ] && printf '%s\\n' ${shellQuote(d)}`,
        ),
        ...stateDirPrefixes.map(
          (prefix) =>
            `for d in ${shellQuote(`${dir}/${prefix}`)}*/; do [ -d "$d" ] || continue; d=\${d%/}; candidate=\${d##*/}; case "$candidate" in *[!A-Za-z0-9._-]*|'') exit 65 ;; esac; printf '%s\\n' "$candidate"; done`,
        ),
      ];
      // Exact directory probes are optional and return 1 when absent. End the
      // group with a successful no-op so an absent final declaration does not
      // turn ordinary discovery into a transport failure. An unsafe dynamic
      // basename still uses `exit 65`, which terminates the remote shell before
      // this no-op can run.
      const fullCheckCmd = `{ ${discoveryCommands.join("; ")}; :; } 2>/dev/null`;
      _log(`Checking existing dirs via SSH: ${fullCheckCmd.substring(0, 100)}...`);
      const existResult = spawnSync("ssh", [...sshArgs(configFile, sandboxName), fullCheckCmd], {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 30000,
      });
      _log(
        `Dir check: exit=${existResult.status}, stdout=${(existResult.stdout || "").trim().substring(0, 200)}, stderr=${(existResult.stderr || "").trim().substring(0, 200)}`,
      );
      const existingDirs = [
        ...new Set(
          (existResult.stdout || "")
            .trim()
            .split("\n")
            .filter((d) => d.length > 0),
        ),
      ];
      const invalidExistingDirs = existingDirs.filter(
        (candidate) => !isAllowedDiscoveredStateDir(candidate, stateDirs, stateDirPrefixes),
      );
      const discoveryFailure = describeStateDirDiscoveryFailure(existResult, invalidExistingDirs);
      if (discoveryFailure) {
        _log(discoveryFailure.log);
        return {
          success: false,
          unreachable: discoveryFailure.unreachable,
          manifest,
          backedUpDirs,
          failedDirs: [...stateDirs],
          backedUpFiles,
          failedFiles: stateFiles.map((f) => f.path),
          error: discoveryFailure.error,
        };
      }
      _log(
        `Existing dirs in sandbox: [${existingDirs.join(",")}] (${existingDirs.length}/${stateDirs.length})`,
      );

      if (existingDirs.length === 0) {
        _log("No state dirs found in sandbox (all empty)");
      } else {
        // NC-2227-04: Pre-backup audit — reject symlinks and special files
        // inside state dirs. A compromised agent could plant a symlink like
        // workspace/copy -> ../openclaw.json to exfiltrate config via backup.
        //
        // Multiply-linked regular files are collected for observability but do
        // not reject the backup (#9314). The archive command below uses
        // `--hard-dereference`, so every included path is stored and restored
        // as a plain regular file. It offers no exfiltration path the audit
        // could close, because an agent that can create a hard link inside a
        // state dir can equally `cp` the same bytes there, and a copy is an
        // ordinary regular file this audit never sees. Rejecting hard links
        // only broke legitimate installs: package managers hard-link from
        // their cache, so every Hermes sandbox that lazily installed a
        // dependency failed its pre-upgrade backup.
        //
        // The printf format emits NUL-delimited type, absolute-path, and
        // link-target fields. Linux filenames can contain tabs and newlines but
        // cannot contain NUL, so only NUL framing can preserve each entry.
        // Per-dir `find` invocations are joined with `;` (not `&&`) and each
        // is tolerant of its own exit code via `|| true`. The base image bakes
        // a few state subdirs as root-owned (e.g. `extensions/<plugin>`,
        // `agents/<id>`) and `find` walking those from the sandbox-user SSH
        // session exits 1 on permission denied. The audit's real signal is
        // stdout (the printf-emitted symlink/hardlink/special-file rows);
        // letting one perm-denied subdir abort the whole chain blocks legitimate
        // rebuilds.
        const auditCmd = existingDirs
          .map(
            (d) =>
              `{ find ${shellQuote(`${dir}/${d}`)} \\( -type l -o \\( -type f -a -links +1 \\) -o \\( ! -type f -a ! -type d \\) \\) -printf "%y\\0%p\\0%l\\0" 2>/dev/null || true; }`,
          )
          .join("; ");
        _log(`Pre-backup audit: checking for symlinks, hard links, and special files`);
        const auditResult = spawnSync("ssh", [...sshArgs(configFile, sandboxName), auditCmd], {
          encoding: "utf-8",
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 30000,
        });
        if (auditResult.status !== 0) {
          const stderr = (auditResult.stderr || "").trim();
          const detail =
            stderr || auditResult.error?.message || `exit ${String(auditResult.status)}`;
          _log(`FAILED: Pre-backup audit command failed — ${detail}`);
          return {
            success: false,
            unreachable: isSshTransportFailure(auditResult),
            manifest,
            backedUpDirs,
            failedDirs: [...existingDirs],
            backedUpFiles,
            failedFiles: stateFiles.map((f) => f.path),
            error: `Pre-backup audit failed: ${detail}`,
          };
        }
        const auditOutput = auditResult.stdout || "";
        const allEntries = parsePreBackupAuditEntries(auditOutput);
        if (allEntries === null) {
          _log("SECURITY: Pre-backup audit returned malformed NUL-delimited output");
          return {
            success: false,
            manifest,
            backedUpDirs,
            failedDirs: [...existingDirs],
            backedUpFiles,
            failedFiles: stateFiles.map((f) => f.path),
            error: "Pre-backup audit rejected malformed output",
          };
        }
        if (allEntries.length > 0) {
          const whitelisted: string[] = [];
          const hardLinked: string[] = [];
          const violations: string[] = [];
          const dirPrefix = `${dir}/`;
          const rows = { whitelisted, hardLinked, violation: violations };
          for (const entry of allEntries) {
            // JSON escapes embedded controls before the entry reaches logs or
            // the user-facing rejection detail.
            rows[classifyPreBackupAuditEntry(entry, dirPrefix)].push(JSON.stringify(entry));
          }
          if (whitelisted.length > 0) {
            _log(
              `Pre-backup audit whitelisted ${whitelisted.length} entries (image npm symlinks): ${whitelisted.slice(0, 5).join("; ")}`,
            );
          }
          if (hardLinked.length > 0) {
            _log(
              `Pre-backup audit accepted ${hardLinked.length} multiply-linked regular files (archived as plain files): ${hardLinked.slice(0, 5).join("; ")}`,
            );
          }
          if (violations.length > 0) {
            // Non-whitelisted symlinks / special files — reject
            _log(
              `SECURITY: Pre-backup audit found ${violations.length} unsafe entries: ${violations.slice(0, 5).join("; ")}`,
            );
            return {
              success: false,
              manifest,
              backedUpDirs,
              failedDirs: [...existingDirs],
              backedUpFiles,
              failedFiles: stateFiles.map((f) => f.path),
              error: `Pre-backup audit rejected: symlinks or special files found in state dirs: ${violations.slice(0, 3).join("; ")}`,
            };
          }
        }
        _log("Pre-backup audit passed — no unsafe symlinks or special files found");

        // Download via SSH+tar
        // NC-2227-04: Removed -h flag (was following symlinks). State dirs are
        // now agent-writable and co-located with config — a compromised agent
        // could create symlinks to exfiltrate config contents via backup.
        //
        // `--hard-dereference` archives each multiply-linked path as its own
        // regular file. Without it `tar` emits a hard-link record for the second
        // and later paths sharing an inode, and `safeTarExtract` rejects those
        // records — so a state dir holding two links to one inode would pass the
        // audit and then fail while unpacking (#9314). It also keeps the archive
        // self-describing: every entry restores as a plain file, matching what
        // the audit now accepts. Note this is about links *within* the archived
        // tree; a link whose other end lives outside it (a package manager
        // linking out of its cache) already archives as a plain file.
        const tarCmd = `tar --hard-dereference -cf - -C ${shellQuote(dir)} -- ${existingDirs.map(shellQuote).join(" ")}`;
        _log(`Downloading via SSH+tar: ${tarCmd}`);
        let downloadedTarDir: string | undefined;
        let downloadedTarPath: string;
        let downloadedTarFd: number;
        try {
          downloadedTarDir = mkdtempSync(path.join(os.tmpdir(), "nemoclaw-state-download-"));
          downloadedTarPath = path.join(downloadedTarDir, "archive.tar");
          downloadedTarFd = openSync(downloadedTarPath, "wx", 0o600);
        } catch (error) {
          if (downloadedTarDir) {
            rmSync(downloadedTarDir, { recursive: true, force: true });
          }
          const detail = error instanceof Error ? error.message : String(error);
          _log(`FAILED: Could not create local backup archive staging file — ${detail}`);
          return {
            success: false,
            manifest,
            backedUpDirs,
            failedDirs: [...existingDirs],
            backedUpFiles,
            failedFiles: stateFiles.map((f) => f.path),
            error: `Failed to create backup archive file: ${detail}`,
          };
        }
        let result: ReturnType<typeof spawnSync>;
        try {
          result = spawnSync("ssh", [...sshArgs(configFile, sandboxName), tarCmd], {
            stdio: ["ignore", downloadedTarFd, "pipe"],
            timeout: 120000,
            maxBuffer: 256 * 1024 * 1024,
          });
        } finally {
          closeSync(downloadedTarFd);
        }
        const downloadedBytes = statSync(downloadedTarPath).size;
        _log(
          `SSH+tar download: exit=${result.status}, stdout=${downloadedBytes} bytes, stderr=${(result.stderr?.toString() || "").substring(0, 200)}`,
        );
        if (isSshTransportFailure(result)) unreachable = true;

        // GNU tar exit codes: 0 = success, 1 = files changed during archive,
        // 2 = errors (e.g. permission denied) but archive still written to stdout.
        // Accept exit 0, 1, or 2 when stdout has data — extract what tar produced
        // and determine per-dir success from tar's reported read errors.
        const tarExitedWithData =
          downloadedBytes > 0 &&
          (result.status === 0 || result.status === 1 || result.status === 2);

        if (result.status !== 0 && downloadedBytes > 0) {
          _log(
            `tar exited ${result.status} but produced ${downloadedBytes} bytes — attempting partial extraction`,
          );
        }

        let extractResult: SafeExtractResult | null = null;
        try {
          if (tarExitedWithData) {
            // SECURITY: Validate tar entries, extract safely, audit symlinks.
            extractResult = safeTarExtract({ filePath: downloadedTarPath }, backupPath);
          }
        } finally {
          rmSync(downloadedTarDir, { recursive: true, force: true });
        }

        if (tarExitedWithData) {
          if (extractResult?.success) {
            const extractedDirs = new Set(existingBackupDirs(backupPath, existingDirs));
            if (result.status === 0) {
              for (const d of existingDirs) {
                if (extractedDirs.has(d)) {
                  backedUpDirs.push(d);
                } else {
                  _log(`Dir ${d} missing from clean tar extraction — marking failed`);
                  failedDirs.push(d);
                  failedDirReasons[d] = BACKUP_FAILURE_ABSENT_AFTER_EXTRACTION;
                }
              }
            } else {
              const tarFailedDirs = classifyFailedDirsFromTarStderr(
                result.stderr?.toString() || "",
                existingDirs,
              );
              if (tarFailedDirs.size === 0) {
                _log(
                  `tar exited ${result.status} without attributable failed dirs — marking all dirs failed`,
                );
                failedDirs.push(...existingDirs);
              } else {
                for (const d of existingDirs) {
                  const tarFailureReason = tarFailedDirs.get(d);
                  if (tarFailureReason !== undefined) {
                    _log(`Dir ${d} had tar read errors (${tarFailureReason}) — marking failed`);
                    failedDirs.push(d);
                    failedDirReasons[d] = tarFailureReason;
                  } else if (!extractedDirs.has(d)) {
                    _log(`Dir ${d} missing from partial tar extraction — marking failed`);
                    failedDirs.push(d);
                    failedDirReasons[d] = BACKUP_FAILURE_ABSENT_AFTER_EXTRACTION;
                  } else {
                    backedUpDirs.push(d);
                  }
                }
              }
            }
          } else if (extractResult) {
            _log(`SECURITY: tar extraction blocked: ${extractResult.error}`);
            failedDirs.push(...existingDirs);
          }
        } else {
          failedDirs.push(...existingDirs);
        }
      }
    }

    for (const spec of stateFiles) {
      const result = backupStateFile(
        configFile,
        sandboxName,
        dir,
        spec,
        backupPath,
        options.captureStateFile,
      );
      if (result.outcome === "backed_up") {
        backedUpFiles.push(spec.path);
      } else if (result.outcome === "failed") {
        failedFiles.push(spec.path);
        // Any transport-level failure at the state-file phase must promote to
        // the sandbox-level unreachable flag so the skip flag can activate
        // for state-file failures — not only the initial dir probe. (#6188)
        if (result.unreachable) unreachable = true;
      }
    }

    unreachable =
      captureAgentPreservedEnvFiles(
        agentName,
        configFile,
        sandboxName,
        dir,
        manifest,
        failedFiles,
      ) || unreachable;
  } finally {
    try {
      tempSshConfig.cleanup();
    } catch {
      /* ignore */
    }
  }

  // SECURITY: Strip credentials from the local backup
  sanitizeBackupDirectory(backupPath);

  // Record dynamically discovered directories in the manifest alongside the
  // exact declarations so restoreSandboxState() can find them in backupPath.
  // Preserve exact declaration order, followed by prefix-discovery order.
  const discoveredStateDirs = backedUpDirs.filter(
    (dirName) =>
      !stateDirs.includes(dirName) && stateDirPrefixes.some((prefix) => dirName.startsWith(prefix)),
  );
  if (discoveredStateDirs.length > 0) {
    manifest.stateDirs = [...stateDirs, ...discoveredStateDirs];
    _log(`Manifest stateDirs extended with prefix matches: [${discoveredStateDirs.join(",")}]`);
  }
  manifest.backedUpDirs = backedUpDirs;
  manifest.failedBackupDirs = failedDirs.filter((failedDir) =>
    manifest.stateDirs.includes(failedDir),
  );
  const backupComplete = failedDirs.length === 0 && failedFiles.length === 0;
  manifest.backupComplete = backupComplete;

  const publicationError = validateSnapshotPublication(backupPath, options.validateBeforePublish);
  if (publicationError) {
    return {
      success: false,
      backedUpDirs: [],
      failedDirs: [],
      backedUpFiles: [],
      failedFiles: [],
      error: publicationError,
    };
  }
  const integrityError = recordBackupContentIntegrity(backupPath, manifest);
  if (integrityError) {
    return {
      success: false,
      backedUpDirs: [],
      failedDirs: [],
      backedUpFiles: [],
      failedFiles: [],
      error: integrityError,
    };
  }
  const finalPublicationError = validateSnapshotPublication(
    backupPath,
    options.validateBeforePublish,
  );
  if (finalPublicationError) {
    return {
      success: false,
      backedUpDirs: [],
      failedDirs: [],
      backedUpFiles: [],
      failedFiles: [],
      error: finalPublicationError,
    };
  }
  writeManifest(backupPath, manifest);
  manifest.backupPath = backupPath;

  return {
    success: backupComplete,
    unreachable,
    manifest,
    backedUpDirs,
    failedDirs,
    ...(Object.keys(failedDirReasons).length > 0 ? { failedDirReasons } : {}),
    backedUpFiles,
    failedFiles,
  };
}

// ── Restore ────────────────────────────────────────────────────────

type SnapshotFileStat = NonNullable<ReturnType<typeof lstatSync>>;

function sameSnapshotFileStat(left: SnapshotFileStat, right: SnapshotFileStat): boolean {
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

function snapshotPermissionMode(stat: SnapshotFileStat): number {
  // Staging intentionally preserves only portable owner/group/other rwx bits.
  // Bind the digest to the same mode bits that the restore tar can apply.
  return Number(stat.mode) & 0o777;
}

function snapshotRestorableTime(stat: SnapshotFileStat): number {
  return Math.trunc(Number(stat.mtimeMs) / 1000);
}

function snapshotDirectoryOpenFlags(): number {
  if (typeof constants.O_NOFOLLOW !== "number" || typeof constants.O_DIRECTORY !== "number") {
    throw new Error("snapshot staging requires O_NOFOLLOW and O_DIRECTORY support");
  }
  return constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY;
}

function copyStableSnapshotFile(sourcePath: string, destinationPath: string, relativePath: string) {
  const sourceFlags =
    constants.O_RDONLY |
    constants.O_NOFOLLOW |
    (typeof constants.O_NONBLOCK === "number" ? constants.O_NONBLOCK : 0);
  const sourceDescriptor = openSync(sourcePath, sourceFlags);
  let destinationDescriptor: number | null = null;
  try {
    const before = fstatSync(sourceDescriptor);
    const namedBefore = lstatSync(sourcePath);
    if (
      !before.isFile() ||
      namedBefore.isSymbolicLink() ||
      !sameSnapshotFileStat(before, namedBefore)
    ) {
      throw new Error(`snapshot entry '${relativePath}' changed before it was staged`);
    }
    destinationDescriptor = openSync(
      destinationPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      snapshotPermissionMode(before),
    );
    const buffer = Buffer.allocUnsafe(64 * 1024);
    for (;;) {
      const bytesRead = readSync(sourceDescriptor, buffer, 0, buffer.byteLength, null);
      if (bytesRead === 0) break;
      let written = 0;
      while (written < bytesRead) {
        written += writeSync(destinationDescriptor, buffer, written, bytesRead - written, null);
      }
    }
    const after = fstatSync(sourceDescriptor);
    const namedAfter = lstatSync(sourcePath);
    if (!sameSnapshotFileStat(before, after) || !sameSnapshotFileStat(before, namedAfter)) {
      throw new Error(`snapshot entry '${relativePath}' changed while it was staged`);
    }
    futimesSync(
      destinationDescriptor,
      snapshotRestorableTime(before),
      snapshotRestorableTime(before),
    );
  } finally {
    if (destinationDescriptor !== null) closeSync(destinationDescriptor);
    closeSync(sourceDescriptor);
  }
}

function copyStableSnapshotDirectory(
  sourceDirectory: string,
  destinationDirectory: string,
  relativeDirectory = "",
): void {
  const directoryDescriptor = openSync(sourceDirectory, snapshotDirectoryOpenFlags());
  try {
    const openedDirectory = fstatSync(directoryDescriptor);
    const namedDirectory = lstatSync(sourceDirectory);
    if (
      !openedDirectory.isDirectory() ||
      namedDirectory.isSymbolicLink() ||
      !sameSnapshotFileStat(openedDirectory, namedDirectory)
    ) {
      throw new Error(
        `snapshot directory '${relativeDirectory || "."}' changed before it was staged`,
      );
    }
    const entries = readdirSync(sourceDirectory, { withFileTypes: true }).sort((left, right) =>
      left.name === right.name ? 0 : left.name < right.name ? -1 : 1,
    );
    for (const entry of entries) {
      const sourcePath = path.join(sourceDirectory, entry.name);
      const destinationPath = path.join(destinationDirectory, entry.name);
      const relativePath = path.posix.join(
        relativeDirectory.split(path.sep).join(path.posix.sep),
        entry.name,
      );
      const namedBefore = lstatSync(sourcePath);
      if (namedBefore.isDirectory()) {
        mkdirSync(destinationPath, { mode: 0o700 });
        copyStableSnapshotDirectory(sourcePath, destinationPath, relativePath);
        chmodSync(destinationPath, snapshotPermissionMode(namedBefore));
        utimesSync(
          destinationPath,
          snapshotRestorableTime(namedBefore),
          snapshotRestorableTime(namedBefore),
        );
        continue;
      }
      if (namedBefore.isSymbolicLink()) {
        const target = readlinkSync(sourcePath);
        const namedAfter = lstatSync(sourcePath);
        if (!sameSnapshotFileStat(namedBefore, namedAfter) || readlinkSync(sourcePath) !== target) {
          throw new Error(`snapshot symlink '${relativePath}' changed while it was staged`);
        }
        symlinkSync(target, destinationPath);
        lutimesSync(
          destinationPath,
          snapshotRestorableTime(namedBefore),
          snapshotRestorableTime(namedBefore),
        );
        continue;
      }
      if (!namedBefore.isFile()) {
        throw new Error(`snapshot contains unsupported entry '${relativePath}'`);
      }
      copyStableSnapshotFile(sourcePath, destinationPath, relativePath);
      chmodSync(destinationPath, snapshotPermissionMode(namedBefore));
    }
    const afterDirectory = fstatSync(directoryDescriptor);
    const namedAfterDirectory = lstatSync(sourceDirectory);
    if (
      !sameSnapshotFileStat(openedDirectory, afterDirectory) ||
      !sameSnapshotFileStat(openedDirectory, namedAfterDirectory)
    ) {
      throw new Error(
        `snapshot directory '${relativeDirectory || "."}' changed while it was staged`,
      );
    }
  } finally {
    closeSync(directoryDescriptor);
  }
}

interface StagedSnapshotRestoreTree {
  readonly backupPath: string;
  readonly contentSha256: string;
  cleanup(): void;
}

function removePrivateSnapshotStagingTree(stagingPath: string): void {
  const makeDirectoriesWritable = (directory: string): void => {
    let stat: SnapshotFileStat;
    try {
      stat = lstatSync(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) return;
    chmodSync(directory, 0o700);
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        makeDirectoriesWritable(path.join(directory, entry.name));
      }
    }
  };
  try {
    makeDirectoriesWritable(stagingPath);
  } finally {
    rmSync(stagingPath, { recursive: true, force: true });
  }
}

/**
 * Copy the selected tree into a private, operation-owned tree. Comparing the
 * complete copy with the selected digest
 * prevents a rename-and-return attack from feeding restore bytes from another
 * directory while the original path still passes the final authority check.
 */
function stageSnapshotRestoreTree(
  backupPath: string,
  authority: SnapshotRestoreAuthority,
): StagedSnapshotRestoreTree {
  const root = path.resolve(REBUILD_BACKUPS_DIR);
  const candidate = path.resolve(backupPath);
  if (candidate === root || !isWithinRoot(candidate, root) || candidate !== authority.backupPath) {
    throw new Error("selected snapshot path differs from its captured authority");
  }
  rejectSymlinksOnPath(candidate);

  let stagingPath: string | null = null;
  try {
    stagingPath = mkdtempSync(path.join(os.tmpdir(), "nemoclaw-snapshot-restore-"));
    chmodSync(stagingPath, 0o700);
    copyStableSnapshotDirectory(candidate, stagingPath);
    const contentSha256 = hashSnapshotTree(stagingPath);
    if (contentSha256 !== authority.contentSha256) {
      throw new Error("selected snapshot content changed while it was staged");
    }

    const ownedPath = stagingPath;
    stagingPath = null;
    return {
      backupPath: ownedPath,
      contentSha256,
      cleanup: () => removePrivateSnapshotStagingTree(ownedPath),
    };
  } finally {
    if (stagingPath !== null) removePrivateSnapshotStagingTree(stagingPath);
  }
}

function snapshotFileAncestors(backupPath: string, relativePath: string): SnapshotFileStat[] {
  const parts = relativePath.split("/");
  const ancestors: SnapshotFileStat[] = [];
  let current = backupPath;
  for (const part of parts.slice(0, -1)) {
    current = path.join(current, part);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`backup state file '${relativePath}' has an unsafe parent path`);
    }
    ancestors.push(stat);
  }
  return ancestors;
}

function readStableSnapshotStateFile(backupPath: string, relativePath: string): Buffer {
  if (typeof constants.O_NOFOLLOW !== "number") {
    throw new Error("snapshot state-file restore requires O_NOFOLLOW support");
  }
  const fullPath = path.join(backupPath, relativePath);
  const beforeAncestors = snapshotFileAncestors(backupPath, relativePath);
  const flags =
    constants.O_RDONLY |
    constants.O_NOFOLLOW |
    (typeof constants.O_NONBLOCK === "number" ? constants.O_NONBLOCK : 0);
  const descriptor = openSync(fullPath, flags);
  try {
    const before = fstatSync(descriptor);
    const namedBefore = lstatSync(fullPath);
    if (
      !before.isFile() ||
      namedBefore.isSymbolicLink() ||
      !namedBefore.isFile() ||
      before.nlink !== 1 ||
      !sameSnapshotFileStat(before, namedBefore)
    ) {
      throw new Error(`backup state file '${relativePath}' is not one stable regular file`);
    }
    const contents = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    const namedAfter = lstatSync(fullPath);
    const afterAncestors = snapshotFileAncestors(backupPath, relativePath);
    if (
      contents.byteLength !== after.size ||
      !sameSnapshotFileStat(before, after) ||
      !sameSnapshotFileStat(before, namedAfter) ||
      beforeAncestors.length !== afterAncestors.length ||
      beforeAncestors.some((ancestor, index) =>
        sameSnapshotFileStat(ancestor, afterAncestors[index]!) ? false : true,
      )
    ) {
      throw new Error(`backup state file '${relativePath}' changed while it was staged`);
    }
    return contents;
  } finally {
    closeSync(descriptor);
  }
}

/**
 * Bind a selected, validated manifest to all bytes that restore can consume.
 * Returns null for an unsafe path, malformed manifest, selection drift, or a
 * payload that changes while it is being hashed.
 */
export function captureSnapshotRestoreAuthority(
  backupPath: string,
  expectedManifest?: RebuildManifest,
): SnapshotRestoreAuthority | null {
  let descriptor: number | null = null;
  try {
    const root = path.resolve(REBUILD_BACKUPS_DIR);
    const candidate = path.resolve(backupPath);
    if (candidate === root || !isWithinRoot(candidate, root)) return null;
    rejectSymlinksOnPath(candidate);
    descriptor = openSync(candidate, snapshotDirectoryOpenFlags());
    const openedRoot = fstatSync(descriptor);
    const namedRoot = lstatSync(candidate);
    if (
      !openedRoot.isDirectory() ||
      namedRoot.isSymbolicLink() ||
      !sameSnapshotFileStat(openedRoot, namedRoot)
    ) {
      return null;
    }
    if (!lstatSync(path.join(candidate, "rebuild-manifest.json")).isFile()) return null;
    const manifest = readManifest(candidate);
    if (!manifest || path.resolve(manifest.backupPath) !== candidate) return null;
    if (
      expectedManifest &&
      !isDeepStrictEqual(
        snapshotManifestAuthority(manifest),
        snapshotManifestAuthority(expectedManifest),
      )
    ) {
      return null;
    }
    if (!validateSnapshotBackupContent(manifest, { requireV2Evidence: false }).ok) return null;
    const contentSha256 = hashSnapshotTree(candidate);
    const afterRoot = fstatSync(descriptor);
    const namedAfterRoot = lstatSync(candidate);
    if (
      !sameSnapshotFileStat(openedRoot, afterRoot) ||
      !sameSnapshotFileStat(openedRoot, namedAfterRoot)
    ) {
      return null;
    }
    return {
      schemaVersion: 1,
      backupPath: candidate,
      contentSha256,
    };
  } catch {
    return null;
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

/** Capture and privately stage the exact snapshot bytes before any destructive action. */
export function prepareSnapshotRestoreContent(
  backupPath: string,
  expectedManifest?: RebuildManifest,
): PreparedSnapshotRestoreContent | null {
  const authority = captureSnapshotRestoreAuthority(backupPath, expectedManifest);
  if (!authority) return null;
  let staged: StagedSnapshotRestoreTree;
  try {
    staged = stageSnapshotRestoreTree(backupPath, authority);
  } catch {
    return null;
  }
  let cleaned = false;
  const validate = (): void => {
    if (cleaned) throw new Error("operation-owned snapshot content has already been removed");
    if (authority.backupPath !== path.resolve(backupPath)) {
      throw new Error("operation-owned snapshot content no longer matches its selected path");
    }
    let currentContentSha256: string;
    try {
      currentContentSha256 = hashSnapshotTree(staged.backupPath);
    } catch {
      throw new Error("operation-owned snapshot content could not be verified safely");
    }
    if (currentContentSha256 !== authority.contentSha256) {
      throw new Error("operation-owned snapshot content changed before lifecycle mutation");
    }
  };
  return {
    schemaVersion: 1,
    selectedBackupPath: authority.backupPath,
    stagedBackupPath: staged.backupPath,
    authority,
    validate,
    cleanup: () => {
      if (cleaned) return;
      staged.cleanup();
      cleaned = true;
    },
  };
}

function validateSnapshotRestoreMutation(
  selectedBackupPath: string,
  stagedBackupPath: string,
  options: Pick<InternalRestoreOptions, "authority" | "preparedContent" | "validateBeforeMutation">,
): string | null {
  if (options.authority) {
    let stagedContentSha256: string;
    try {
      stagedContentSha256 = hashSnapshotTree(stagedBackupPath);
    } catch {
      return "Operation-owned snapshot content changed before filesystem mutation";
    }
    if (stagedContentSha256 !== options.authority.contentSha256) {
      return "Operation-owned snapshot content changed before filesystem mutation";
    }
    if (options.preparedContent) {
      if (
        options.preparedContent.selectedBackupPath !== selectedBackupPath ||
        options.preparedContent.stagedBackupPath !== stagedBackupPath ||
        !isDeepStrictEqual(options.preparedContent.authority, options.authority)
      ) {
        return "Operation-owned snapshot content does not match its prepared authority";
      }
    } else {
      const current = captureSnapshotRestoreAuthority(selectedBackupPath);
      if (
        !current ||
        current.backupPath !== options.authority.backupPath ||
        current.contentSha256 !== options.authority.contentSha256
      ) {
        return "Selected snapshot content changed before filesystem mutation";
      }
    }
  }
  try {
    options.validateBeforeMutation?.();
    return null;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return `Runtime authority changed before filesystem mutation: ${detail}`;
  }
}

/**
 * Restore state directories into a sandbox from a prior backup.
 */
export function restoreSandboxState(
  sandboxName: string,
  backupPath: string,
  options: SnapshotRestoreOptions = {},
): RestoreResult {
  const target = registry.getSandbox(sandboxName);
  if (!target) {
    return {
      success: false,
      restoredDirs: [],
      failedDirs: ["manifest"],
      restoredFiles: [],
      failedFiles: [],
      error: `Could not resolve target sandbox '${sandboxName}' for state restore`,
    };
  }
  return restoreSandboxStateInternal(sandboxName, backupPath, {
    targetAgentType: String(target.agent || "openclaw"),
    ...(options.agentDefinition ? { agentDefinition: options.agentDefinition } : {}),
    ...(target.fromDockerfile ? { allowCustomImageWholeStateFileRestore: true } : {}),
    ...(options.authority ? { authority: options.authority } : {}),
    ...(options.preparedContent ? { preparedContent: options.preparedContent } : {}),
    ...(options.validateBeforeMutation
      ? { validateBeforeMutation: options.validateBeforeMutation }
      : {}),
  });
}

export function restoreRecreatedSandboxState(
  sandboxName: string,
  backupPath: string,
  options: RecreatedSandboxRestoreOptions,
): RestoreResult {
  return restoreSandboxStateInternal(sandboxName, backupPath, {
    targetAgentType: options.targetAgentType,
    ...(options.agentDefinition ? { agentDefinition: options.agentDefinition } : {}),
    ...(options.allowCustomImageWholeStateFileRestore
      ? { allowCustomImageWholeStateFileRestore: true }
      : {}),
    ...(options.targetAgentType === "openclaw" &&
    options.freshOpenClawImagePluginInstalls === undefined
      ? { discoverFreshOpenClawImagePluginInstalls: true }
      : {}),
    freshOpenClawImagePluginInstalls: options.freshOpenClawImagePluginInstalls,
    ...(options.authority ? { authority: options.authority } : {}),
    ...(options.preparedContent ? { preparedContent: options.preparedContent } : {}),
    ...(options.validateBeforeMutation
      ? { validateBeforeMutation: options.validateBeforeMutation }
      : {}),
  });
}

function restoreSandboxStateInternal(
  sandboxName: string,
  backupPath: string,
  options: InternalRestoreOptions,
): RestoreResult {
  if (!options.authority || !options.validateBeforeMutation || !options.agentDefinition) {
    return restoreSandboxStateFromTrustedTree(sandboxName, backupPath, backupPath, options);
  }
  if (options.preparedContent) {
    if (
      options.preparedContent.selectedBackupPath !== path.resolve(backupPath) ||
      !isDeepStrictEqual(options.preparedContent.authority, options.authority)
    ) {
      return {
        success: false,
        restoredDirs: [],
        failedDirs: ["manifest"],
        restoredFiles: [],
        failedFiles: [],
        error: "Prepared snapshot content does not match the selected restore authority",
      };
    }
    return restoreSandboxStateFromTrustedTree(
      sandboxName,
      backupPath,
      options.preparedContent.stagedBackupPath,
      options,
    );
  }
  let staged: StagedSnapshotRestoreTree;
  try {
    staged = stageSnapshotRestoreTree(backupPath, options.authority);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      restoredDirs: [],
      failedDirs: ["manifest"],
      restoredFiles: [],
      failedFiles: [],
      error: `Could not stage selected snapshot safely: ${detail}`,
    };
  }
  try {
    return restoreSandboxStateFromTrustedTree(sandboxName, backupPath, staged.backupPath, options);
  } finally {
    staged.cleanup();
  }
}

function restoreSandboxStateFromTrustedTree(
  sandboxName: string,
  selectedBackupPath: string,
  backupPath: string,
  options: InternalRestoreOptions,
): RestoreResult {
  _log(`restoreSandboxState: sandbox=${sandboxName}, backupPath=${backupPath}`);
  const manifest = readManifest(backupPath);
  if (!manifest) {
    _log("FAILED: Could not read rebuild-manifest.json");
    const provenanceError = hasInvalidMarkedOpenClawPluginProvenance(backupPath)
      ? OPENCLAW_IMAGE_PLUGIN_PROVENANCE_RESTORE_ERROR
      : undefined;
    return {
      success: false,
      restoredDirs: [],
      failedDirs: ["manifest"],
      restoredFiles: [],
      failedFiles: [],
      ...(provenanceError ? { error: provenanceError } : {}),
    };
  }

  const dir = manifest.dir || manifest.writableDir;
  if (!dir) {
    _log("FAILED: manifest has no dir or writableDir");
    return {
      success: false,
      restoredDirs: [],
      failedDirs: ["manifest"],
      restoredFiles: [],
      failedFiles: [],
    };
  }
  const restoredDirs: string[] = [];
  const failedDirs: string[] = [];
  const restoredFiles: string[] = [];
  const failedFiles: string[] = [];

  // Find which verified backed-up directories actually exist locally.
  // Older manifests do not have backedUpDirs, so keep restoring stateDirs for
  // backward compatibility.
  const restorableStateDirs = manifest.backedUpDirs ?? manifest.stateDirs;
  const localDirs = existingBackupDirs(backupPath, restorableStateDirs);
  const stateFiles = normalizeStateFileSpecsPreservingDuplicates(manifest.stateFiles ?? []);
  const localFiles = stateFiles.filter((f) => existsSync(path.join(backupPath, f.path)));
  _log(
    `Local backup dirs: [${localDirs.join(",")}] (${localDirs.length}/${manifest.stateDirs.length})`,
  );
  _log(
    `Local backup files: [${localFiles.map((f) => f.path).join(",")}] (${localFiles.length}/${stateFiles.length})`,
  );

  const failRestoreContract = (error: string): RestoreResult => {
    _log(`FAILED: ${error}`);
    return {
      success: false,
      restoredDirs,
      failedDirs: [...localDirs],
      restoredFiles,
      failedFiles: localFiles.map((file) => file.path),
      error,
    };
  };
  if (!options.authority || !options.validateBeforeMutation) {
    if (manifest.workload?.kind === "managed-image") {
      return failRestoreContract(MANAGED_SNAPSHOT_RESTORE_AUTHORITY_ERROR);
    }
    if (typeof manifest.hostLocalInferenceReceipt === "string") {
      return failRestoreContract(HOST_LOCAL_INFERENCE_SNAPSHOT_RESTORE_AUTHORITY_ERROR);
    }
  }
  if (options.targetAgentType !== manifest.agentType) {
    return failRestoreContract(
      `Backup agent '${manifest.agentType}' does not match target agent '${options.targetAgentType}'`,
    );
  }
  if (
    manifest.version === 2 &&
    (!options.agentDefinition || !options.authority || !options.validateBeforeMutation)
  ) {
    return failRestoreContract(SCHEMA_V2_SNAPSHOT_RESTORE_AUTHORITY_ERROR);
  }
  let targetAgent: AgentDefinition;
  if (options.agentDefinition) {
    if (options.agentDefinition.name !== options.targetAgentType) {
      return failRestoreContract(
        `Pinned target agent definition '${options.agentDefinition.name}' does not match target agent '${options.targetAgentType}'`,
      );
    }
    targetAgent = options.agentDefinition;
  } else {
    // Authority-bearing restores are package-managed operations. Re-resolving
    // their definition from the ambient checkout could silently switch package
    // versions between selection and mutation.
    if (options.authority || options.validateBeforeMutation) {
      return failRestoreContract(
        `Managed state restore for '${options.targetAgentType}' requires its pinned agent definition`,
      );
    }
    try {
      targetAgent = loadAgent(options.targetAgentType);
    } catch {
      return failRestoreContract(
        `Could not load target agent manifest '${options.targetAgentType}' for state restore`,
      );
    }
  }
  const normalizedBackupDir = dir.replace(/\/+$/, "");
  const normalizedTargetDir = targetAgent.configPaths.dir.replace(/\/+$/, "");
  if (normalizedBackupDir !== normalizedTargetDir) {
    return failRestoreContract(
      `Backup state directory '${normalizedBackupDir}' does not match target directory '${normalizedTargetDir}'`,
    );
  }
  // The current target manifest remains authoritative for non-backup state,
  // including legacy snapshots whose embedded manifests still list it.
  const targetNonBackupDirs = targetAgent.nonBackupStateDirs;
  const targetNonBackupPrefixes = targetAgent.nonBackupStateDirPrefixes;
  const isTargetNonBackupDir = (dirName: string): boolean =>
    isAllowedDiscoveredStateDir(dirName, targetNonBackupDirs, targetNonBackupPrefixes);
  const targetBackupDirs = targetAgent.backupStateDirs;
  const targetBackupPrefixes = targetAgent.backupStateDirPrefixes;
  const isTargetBackupDir = (dirName: string): boolean =>
    !isTargetNonBackupDir(dirName) &&
    isAllowedDiscoveredStateDir(dirName, targetBackupDirs, targetBackupPrefixes);
  const undeclaredSnapshotDirs = manifest.stateDirs.filter(
    (dirName) => !isTargetBackupDir(dirName) && !isTargetNonBackupDir(dirName),
  );
  if (undeclaredSnapshotDirs.length > 0) {
    return failRestoreContract(
      `Backup state directories are not declared by target agent '${options.targetAgentType}': ${undeclaredSnapshotDirs.join(", ")}`,
    );
  }
  const skippedNonBackupDirs = localDirs.filter(isTargetNonBackupDir);
  if (skippedNonBackupDirs.length > 0) {
    _log(`Skipping non-backup state dirs from restore: [${skippedNonBackupDirs.join(",")}]`);
    for (const d of skippedNonBackupDirs) {
      localDirs.splice(localDirs.indexOf(d), 1);
    }
  }
  // Only manifests that distinguish failed backups from absent directories can
  // authorize cleanup without deleting data that a failed backup did not capture.
  // Older manifests leave this field absent, so preserve their historical restore behavior.
  const failedBackupDirs = new Set(manifest.failedBackupDirs ?? []);
  const localDirSet = new Set(localDirs);
  const staleContentDirs =
    manifest.failedBackupDirs === undefined
      ? []
      : manifest.stateDirs.filter(
          (stateDir) =>
            isTargetBackupDir(stateDir) &&
            !isTargetNonBackupDir(stateDir) &&
            !localDirSet.has(stateDir) &&
            !failedBackupDirs.has(stateDir),
        );
  const cleanupStateDirs = [...new Set([...localDirs, ...staleContentDirs])];
  const targetStateFiles = new Map<string, AgentStateFile>();
  for (const targetFile of targetAgent.stateFiles) {
    const normalized = normalizeStateFilePath(targetFile.path);
    if (!normalized || targetStateFiles.has(normalized)) {
      return failRestoreContract(
        `Target agent manifest '${options.targetAgentType}' has an invalid or duplicate state file declaration`,
      );
    }
    targetStateFiles.set(normalized, targetFile);
  }
  const seenBackupPaths = new Set<string>();
  for (const backupFile of stateFiles) {
    if (seenBackupPaths.has(backupFile.path)) {
      return failRestoreContract(`Backup manifest repeats state file '${backupFile.path}'`);
    }
    seenBackupPaths.add(backupFile.path);
    const targetFile = targetStateFiles.get(backupFile.path);
    if (!targetFile) {
      return failRestoreContract(
        `Backup state file '${backupFile.path}' is not declared by target agent '${options.targetAgentType}'`,
      );
    }
    if (targetFile.strategy !== backupFile.strategy) {
      return failRestoreContract(
        `Backup state file '${backupFile.path}' strategy '${backupFile.strategy}' does not match target strategy '${targetFile.strategy}'`,
      );
    }
  }

  let freshOpenClawImagePluginInstalls: readonly OpenClawImagePluginInstall[] | undefined;
  if (options.freshOpenClawImagePluginInstalls !== undefined) {
    const parsed = parseOpenClawImagePluginInstalls(
      options.freshOpenClawImagePluginInstalls,
      targetAgent.configPaths.dir,
    );
    if (!parsed.ok) {
      return {
        ...failRestoreContract(parsed.error),
        failedDirs: ["extensions"],
        failedFiles: [],
      };
    }
    freshOpenClawImagePluginInstalls = parsed.pluginInstalls;
  } else if (options.discoverFreshOpenClawImagePluginInstalls === true) {
    const discovery = discoverFreshOpenClawImagePluginInstalls(
      sandboxName,
      { getSshConfig, sshArgs },
      targetAgent.configPaths.dir,
    );
    if (!discovery.ok) {
      return {
        ...failRestoreContract(discovery.error),
        failedDirs: ["extensions"],
        failedFiles: [],
      };
    }
    freshOpenClawImagePluginInstalls = discovery.pluginInstalls;
  }

  if (cleanupStateDirs.length === 0 && localFiles.length === 0) {
    const mutationAuthorityError = validateSnapshotRestoreMutation(
      selectedBackupPath,
      backupPath,
      options,
    );
    if (mutationAuthorityError) {
      return failRestoreContract(mutationAuthorityError);
    }
    _log("No dirs or files to restore");
    return { success: true, restoredDirs, failedDirs, restoredFiles, failedFiles };
  }

  _log("Getting SSH config for restore");
  const sshConfig = getSshConfig(sandboxName);
  if (!sshConfig) {
    _log("FAILED: Could not get SSH config for restore");
    return {
      success: false,
      restoredDirs,
      failedDirs: [...cleanupStateDirs],
      restoredFiles,
      failedFiles: localFiles.map((f) => f.path),
    };
  }

  const tempSshConfig = createTempSshConfig(sshConfig, "nemoclaw-state-");
  const configFile = tempSshConfig.file;
  const previousOpenClawImagePluginInstalls =
    freshOpenClawImagePluginInstalls !== undefined
      ? manifest.openclawImagePluginInstalls
      : undefined;
  // Fresh provenance is still authoritative for preserving image-managed
  // extension directories during recreation. Config reconciliation, however,
  // needs a complete before/after pair. Legacy and stock-image backups do not
  // carry the previous baseline, so preserve their historical config-merge
  // behavior by passing neither side of the pair to openclaw.json restore.
  const configFreshOpenClawImagePluginInstalls =
    previousOpenClawImagePluginInstalls !== undefined
      ? freshOpenClawImagePluginInstalls
      : undefined;
  try {
    const pluginRestorePlan = planOpenClawPluginRestore({
      agentType: manifest.agentType,
      dir,
      localDirs: cleanupStateDirs,
      freshImagePluginInstalls: freshOpenClawImagePluginInstalls,
      previousImagePluginInstalls: previousOpenClawImagePluginInstalls,
    });
    if (!pluginRestorePlan.ok) {
      return {
        success: false,
        restoredDirs,
        failedDirs: [...cleanupStateDirs],
        restoredFiles,
        failedFiles: localFiles.map((f) => f.path),
        error:
          manifest.reconcileOpenClawImagePluginProvenance === true
            ? OPENCLAW_IMAGE_PLUGIN_PROVENANCE_RESTORE_ERROR
            : pluginRestorePlan.error,
      };
    }
    if (
      freshOpenClawImagePluginInstalls !== undefined &&
      pluginRestorePlan.preservedExtensionDirs.length > 0
    ) {
      _log(
        `Fresh image-managed OpenClaw extensions: [${pluginRestorePlan.freshExtensionDirs.join(",")}]`,
      );
      _log(
        `Previous image-managed OpenClaw extensions: [${pluginRestorePlan.previousExtensionDirs.join(",")}]`,
      );
    }

    let restoreTar: Buffer | undefined;
    if (localDirs.length > 0) {
      // Upload via tar pipe
      // NC-2227-04: Removed -h flag from restore as well — no symlink following.
      const tarResult = spawnSync(
        "tar",
        buildRestoreTarArgs(backupPath, localDirs, pluginRestorePlan.archiveExcludedExtensionDirs),
        {
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 60000,
          maxBuffer: 256 * 1024 * 1024,
        },
      );

      if (tarResult.status !== 0 || !tarResult.stdout) {
        return {
          success: false,
          restoredDirs,
          failedDirs: [...cleanupStateDirs],
          restoredFiles,
          failedFiles: localFiles.map((f) => f.path),
        };
      }
      restoreTar = tarResult.stdout;
    }

    // Stage every state-file payload before the final content and runtime
    // authority fence. Restore must consume only these operation-owned bytes;
    // reading backupPath after the fence would let a later local-file change
    // select different input after the target filesystem has begun mutating.
    let stagedStateFiles: ReadonlyMap<string, Buffer>;
    try {
      stagedStateFiles = new Map(
        localFiles.map(
          (spec) => [spec.path, readStableSnapshotStateFile(backupPath, spec.path)] as const,
        ),
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return failRestoreContract(`Could not stage backup state files safely: ${detail}`);
    }

    const mutationAuthorityError = validateSnapshotRestoreMutation(
      selectedBackupPath,
      backupPath,
      options,
    );
    if (mutationAuthorityError) {
      return failRestoreContract(mutationAuthorityError);
    }

    // Remove existing state dirs before extracting so stale files from later
    // snapshots don't persist after restoring an earlier one. OpenClaw's
    // image-managed extensions are preserved from the freshly built image and
    // excluded from the restore tar; only user/non-managed extension entries
    // are cleared and restored from the backup.
    if (cleanupStateDirs.length > 0) {
      const rmCmd = buildRestoreCleanupCommand(
        dir,
        localDirs,
        pluginRestorePlan.preservedExtensionDirs,
        new Set(pluginRestorePlan.requiredFreshExtensionDirs),
        staleContentDirs,
      );
      _log(`Cleaning target dirs before restore: ${rmCmd}`);
      const rmResult = spawnSync("ssh", [...sshArgs(configFile, sandboxName), rmCmd], {
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 30000,
      });
      if (rmResult.status !== 0 || rmResult.error || rmResult.signal) {
        const stderr = (rmResult.stderr?.toString() || "").trim();
        const detail =
          stderr ||
          rmResult.error?.message ||
          (rmResult.signal ? `signal ${rmResult.signal}` : `exit ${String(rmResult.status)}`);
        _log(`FAILED: pre-restore cleanup failed: ${detail.substring(0, 200)}`);
        return {
          success: false,
          restoredDirs,
          failedDirs: [...cleanupStateDirs],
          restoredFiles,
          failedFiles: localFiles.map((f) => f.path),
        };
      }
    }

    if (restoreTar !== undefined) {
      const extractCmd = `tar --no-same-owner -xf - -C ${shellQuote(dir)}`;
      const sshResult = spawnSync("ssh", [...sshArgs(configFile, sandboxName), extractCmd], {
        input: restoreTar,
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 120000,
      });

      if (sshResult.status === 0) {
        const restoredPaths = localDirs.map((d) => `${dir}/${d}`);

        // Best-effort only: OpenShell exec/SSH normally runs as the sandbox user,
        // which cannot chown even files it owns. The tar restore above runs as the
        // same user, so the real restore gate is whether the restored state dirs
        // are usable by that user.
        const chownCmd = `chown -R sandbox:sandbox -- ${restoredPaths.map(shellQuote).join(" ")} 2>/dev/null || true`;
        _log(`Best-effort ownership repair: ${chownCmd}`);
        const chownResult = spawnSync("ssh", [...sshArgs(configFile, sandboxName), chownCmd], {
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 30000,
        });
        if (chownResult.error || chownResult.signal) {
          const detail =
            chownResult.error?.message ||
            (chownResult.signal ? `signal ${chownResult.signal}` : "unknown error");
          _log(
            `WARNING: post-restore ownership repair did not complete: ${detail.substring(0, 200)}`,
          );
        }

        const usabilityCmd = restoredPaths
          .map(
            (p) =>
              `[ -d ${shellQuote(p)} ] && [ ! -L ${shellQuote(p)} ] && [ -r ${shellQuote(p)} ] && [ -w ${shellQuote(p)} ]`,
          )
          .join(" && ");
        _log(`Verifying restored state usability: ${usabilityCmd}`);
        const usabilityResult = spawnSync(
          "ssh",
          [...sshArgs(configFile, sandboxName), usabilityCmd],
          {
            stdio: ["ignore", "pipe", "pipe"],
            timeout: 30000,
          },
        );
        if (usabilityResult.status === 0 && !usabilityResult.error && !usabilityResult.signal) {
          restoredDirs.push(...localDirs);
        } else {
          const stderr = (usabilityResult.stderr?.toString() || "").trim();
          const detail =
            stderr ||
            usabilityResult.error?.message ||
            (usabilityResult.signal
              ? `signal ${usabilityResult.signal}`
              : `exit ${String(usabilityResult.status)}`);
          _log(`FAILED: restored state usability check failed: ${detail.substring(0, 200)}`);
          failedDirs.push(...localDirs);
        }
      } else {
        failedDirs.push(...localDirs);
      }
    }

    for (const spec of localFiles) {
      const targetStateFile = targetStateFiles.get(spec.path);
      if (!targetStateFile) throw new Error(`Validated target state file missing: ${spec.path}`);
      const backupContents = stagedStateFiles.get(spec.path);
      if (!backupContents) throw new Error(`Staged state file missing: ${spec.path}`);
      if (
        restoreStateFile(
          sshArgs(configFile, sandboxName),
          dir,
          spec,
          backupContents,
          targetStateFile.restore,
          options.allowCustomImageWholeStateFileRestore === true,
          _log,
          configFreshOpenClawImagePluginInstalls,
          previousOpenClawImagePluginInstalls,
        )
      ) {
        restoredFiles.push(spec.path);
      } else {
        failedFiles.push(spec.path);
      }
    }
  } finally {
    try {
      tempSshConfig.cleanup();
    } catch {
      /* ignore */
    }
  }

  return {
    success: failedDirs.length === 0 && failedFiles.length === 0,
    restoredDirs,
    failedDirs,
    restoredFiles,
    failedFiles,
  };
}

// ── Manifest ───────────────────────────────────────────────────────

export const __test = { writeManifest, readManifest };

// ── Listing ────────────────────────────────────────────────────────

/**
 * Remove one completed rebuild backup without allowing a caller-controlled
 * path to escape the sandbox's timestamped backup directory.
 */
export function removeSandboxStateBackup(sandboxName: string, backupPath: string): boolean {
  const rebuildBackupsRoot = path.resolve(REBUILD_BACKUPS_DIR);
  const sandboxBackupRoot = path.resolve(rebuildBackupsRoot, sandboxName);
  const candidateBackupPath = path.resolve(backupPath);

  if (
    sandboxBackupRoot === rebuildBackupsRoot ||
    !isWithinRoot(sandboxBackupRoot, rebuildBackupsRoot) ||
    normalizeHostPath(path.dirname(candidateBackupPath)) !== normalizeHostPath(sandboxBackupRoot)
  ) {
    return false;
  }

  try {
    rejectSymlinksOnPath(candidateBackupPath);
    rmSync(candidateBackupPath, { recursive: true, force: true });
    return !existsSync(candidateBackupPath);
  } catch {
    return false;
  }
}

/**
 * Confirm that a registry entry carries positive NemoClaw-managed image
 * provenance. Managed images built by current releases receive a non-empty
 * `nemoclawVersion` fingerprint, while custom images do not.
 *
 * `agentVersion` is not provenance: a live version probe can populate it for a
 * legacy custom image, and backup then copies that value into the manifest.
 * Pre-fingerprint entries therefore fail closed instead of inferring image
 * ownership from matching agent versions.
 */
export function hasPositiveManagedImageEvidence(
  sandbox: Pick<registry.SandboxEntry, "nemoclawVersion">,
): boolean {
  return typeof sandbox.nemoclawVersion === "string" && sandbox.nemoclawVersion.trim().length > 0;
}

/**
 * Decide whether prepared recovery may recreate a sandbox with NemoClaw's
 * managed image. Any recorded custom `--from` image fails closed. Otherwise,
 * current rows must carry a managed-image fingerprint and a pre-fingerprint
 * row may proceed only with per-row operator authorization.
 */
export function isManagedImageRecoveryAllowed(
  sandbox: Pick<registry.SandboxEntry, "nemoclawVersion" | "fromDockerfile">,
  allowLegacyManagedImageRecovery: boolean,
): boolean {
  const hasNoCustomImageEvidence =
    sandbox.fromDockerfile === undefined || sandbox.fromDockerfile === null;
  return (
    hasNoCustomImageEvidence &&
    (hasPositiveManagedImageEvidence(sandbox) || allowLegacyManagedImageRecovery)
  );
}

/**
 * List available backups for a sandbox, newest first, each enriched with a
 * virtual `snapshotVersion` number.
 *
 * Version numbers are position-based (v1 = oldest by timestamp, vN = newest)
 * and computed fresh on every call — they are NOT persisted, so deleting a
 * snapshot will re-number everything newer than it.
 */
export function listBackups(sandboxName: string): SnapshotEntry[] {
  const dir = path.join(REBUILD_BACKUPS_DIR, sandboxName);
  if (!existsSync(dir)) return [];

  const rawEntries = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory());

  const manifests: RebuildManifest[] = [];
  for (const entry of rawEntries) {
    const m = readManifest(path.join(dir, entry.name));
    if (m) manifests.push(m);
  }

  // Assign version numbers by timestamp-ascending position (v1 = oldest).
  const asc = [...manifests].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const numbered: SnapshotEntry[] = asc.map((m, i) => ({
    ...m,
    snapshotVersion: i + 1,
  }));

  // Return newest-first for display.
  return numbered.reverse();
}

/**
 * Get the most recent backup for a sandbox, or null.
 */
export function getLatestBackup(sandboxName: string): SnapshotEntry | null {
  const backups = listBackups(sandboxName);
  return backups[0] || null;
}

export interface SnapshotMatchResult {
  match: SnapshotEntry | null;
}

/**
 * Resolve a user-supplied snapshot selector to a single backup.
 *
 * Selector precedence:
 *   1. `v<N>` — exact (virtual) snapshotVersion match (case-insensitive)
 *   2. exact user-assigned name match
 *   3. exact timestamp match
 */
export function findBackup(sandboxName: string, selector: string): SnapshotMatchResult {
  const backups = listBackups(sandboxName);

  const versionMatch = VERSION_SELECTOR_RE.exec(selector);
  if (versionMatch) {
    const wanted = Number.parseInt(versionMatch[1], 10);
    const hit = backups.find((b) => b.snapshotVersion === wanted);
    return { match: hit ?? null };
  }

  const byName = backups.find((b) => b.name === selector);
  if (byName) return { match: byName };

  const byExactTimestamp = backups.find((b) => b.timestamp === selector);
  if (byExactTimestamp) return { match: byExactTimestamp };

  return { match: null };
}

// ── CLI argv parser ────────────────────────────────────────────────
//
// Argument parser for `nemoclaw <name> snapshot restore [selector] [--to <dst>]`.
export interface RestoreArgs {
  ok: true;
  targetSandbox: string;
  selector: string | null;
}

export interface RestoreArgsError {
  ok: false;
  error: string;
}

export type RestoreArgsResult = RestoreArgs | RestoreArgsError;

export function parseRestoreArgs(
  sandboxName: string,
  subArgs: readonly string[],
): RestoreArgsResult {
  const positional: string[] = [];
  let targetSandbox = sandboxName;
  for (let i = 1; i < subArgs.length; i++) {
    const token = subArgs[i];
    if (token === "--to") {
      const value = subArgs[i + 1];
      if (!value || value.startsWith("--")) {
        return { ok: false, error: "--to requires a target sandbox name." };
      }
      targetSandbox = value;
      i++;
    } else {
      positional.push(token);
    }
  }
  return {
    ok: true,
    targetSandbox,
    selector: positional[0] ?? null,
  };
}
