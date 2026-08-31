// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { create as createTar } from "tar";
import type { PluginLogger } from "../index.js";
import { reserveSnapshotDir } from "../blueprint/snapshot-directory.js";
import {
  CREDENTIAL_SENSITIVE_BASENAMES,
  isSensitiveFile,
  stripCredentials,
} from "../security/credential-filter.js";
import {
  sanitizeMigrationDirectory,
  sanitizeOpenClawConfigFile,
} from "../security/snapshot-sanitizer.js";
import { isObjectRecord, type UnknownRecord } from "../shared/object-record.js";
import {
  decodeDescriptorSnapshotContent,
  inspectDescriptorSnapshotRoot,
  installDescriptorSnapshotFile,
  scanDescriptorSnapshot,
} from "#nemoclaw-shared/snapshot-sanitizer-boundary.cjs";
import {
  collectSymlinkPaths,
  isWithinRoot,
  normalizeHostPath,
  parseConfigDocumentText,
  resolveHostHome,
  resolveUserPath,
  type HostOpenClawState,
  type MigrationExternalRoot,
  type MigrationRootBinding,
} from "./host-state.js";

const SNAPSHOT_VERSION = 3;

export { detectHostOpenClaw } from "./host-state.js";
export type {
  HostOpenClawState,
  MigrationExternalRoot,
  MigrationRootBinding,
  MigrationRootKind,
} from "./host-state.js";

export interface SnapshotManifest {
  version: number;
  timestamp?: string;
  createdAt: string;
  homeDir: string;
  stateDir: string;
  configPath: string | null;
  hasExternalConfig: boolean;
  externalRoots: MigrationExternalRoot[];
  warnings: string[];
  blueprintDigest?: string | null;
}

export interface SnapshotBundle {
  snapshotDir: string;
  snapshotPath: string;
  preparedStateDir: string;
  archivesDir: string;
  manifest: SnapshotManifest;
  temporary: boolean;
}

type OpenClawConfigDocument = UnknownRecord;

function computeFileDigest(filePath: string): string {
  if (!existsSync(filePath)) {
    throw new Error(`Blueprint file not found: ${filePath}`);
  }
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

// ---------------------------------------------------------------------------

function copyDirectory(
  sourcePath: string,
  destinationPath: string,
  options?: { excludeSourcePaths?: ReadonlySet<string>; stripCredentials?: boolean },
): void {
  const excludedSourcePaths = new Set(
    [...(options?.excludeSourcePaths ?? [])].map((source) => normalizeHostPath(source)),
  );
  const shouldFilter = options?.stripCredentials === true || excludedSourcePaths.size > 0;
  cpSync(sourcePath, destinationPath, {
    recursive: true,
    filter: shouldFilter
      ? (source: string) =>
          !excludedSourcePaths.has(normalizeHostPath(source)) &&
          (!options?.stripCredentials || !isSensitiveFile(path.basename(source)))
      : undefined,
  });
}

function writeSnapshotManifest(snapshotDir: string, manifest: SnapshotManifest): void {
  writeFileSync(path.join(snapshotDir, "snapshot.json"), JSON.stringify(manifest, null, 2));
}

function isMigrationRootBinding(value: unknown): value is MigrationRootBinding {
  return isObjectRecord(value) && typeof value.configPath === "string";
}

function isMigrationExternalRoot(value: unknown): value is MigrationExternalRoot {
  return (
    isObjectRecord(value) &&
    typeof value.id === "string" &&
    (value.kind === "workspace" || value.kind === "agentDir" || value.kind === "skillsExtraDir") &&
    typeof value.label === "string" &&
    typeof value.sourcePath === "string" &&
    typeof value.snapshotRelativePath === "string" &&
    typeof value.sandboxPath === "string" &&
    Array.isArray(value.symlinkPaths) &&
    value.symlinkPaths.every((entry) => typeof entry === "string") &&
    Array.isArray(value.bindings) &&
    value.bindings.every((entry) => isMigrationRootBinding(entry))
  );
}

function isSnapshotManifest(value: unknown): value is SnapshotManifest {
  return (
    isObjectRecord(value) &&
    typeof value.version === "number" &&
    (value.timestamp === undefined || typeof value.timestamp === "string") &&
    typeof value.createdAt === "string" &&
    typeof value.homeDir === "string" &&
    typeof value.stateDir === "string" &&
    (value.configPath === null || typeof value.configPath === "string") &&
    typeof value.hasExternalConfig === "boolean" &&
    Array.isArray(value.externalRoots) &&
    value.externalRoots.every((entry) => isMigrationExternalRoot(entry)) &&
    Array.isArray(value.warnings) &&
    value.warnings.every((entry) => typeof entry === "string") &&
    (value.blueprintDigest === undefined ||
      value.blueprintDigest === null ||
      typeof value.blueprintDigest === "string")
  );
}

function readSnapshotManifest(snapshotDir: string): SnapshotManifest {
  const raw: unknown = JSON.parse(readFileSync(path.join(snapshotDir, "snapshot.json"), "utf-8"));
  if (!isSnapshotManifest(raw)) {
    throw new Error(`Invalid snapshot manifest at ${path.join(snapshotDir, "snapshot.json")}`);
  }
  return raw;
}

function resolveConfigSourcePath(manifest: SnapshotManifest, snapshotDir: string): string {
  if (manifest.hasExternalConfig) {
    return path.join(snapshotDir, "config", "openclaw.json");
  }
  return path.join(snapshotDir, "openclaw", "openclaw.json");
}

function loadCopiedConfigDocument(configPath: string): OpenClawConfigDocument {
  const root = inspectDescriptorSnapshotRoot(path.dirname(configPath));
  if (root === null) {
    throw new Error(`Failed to inspect copied OpenClaw config parent: ${configPath}`);
  }
  const scan = scanDescriptorSnapshot(
    root,
    CREDENTIAL_SENSITIVE_BASENAMES,
    path.basename(configPath),
  );
  const scanned = scan?.files[0];
  if (scan === null || scan.files.length !== 1 || scanned?.path !== path.basename(configPath)) {
    throw new Error(`Failed descriptor-bound scan of copied OpenClaw config: ${configPath}`);
  }
  const raw = decodeDescriptorSnapshotContent(scanned.content);
  if (raw === null) {
    throw new Error(`Failed canonical decoding of copied OpenClaw config: ${configPath}`);
  }
  return parseConfigDocumentText(raw, configPath);
}

const UNSAFE_PROPERTY_NAMES = new Set(["__proto__", "constructor", "prototype"]);

function isArrayIndexToken(token: string): boolean {
  return /^\d+$/.test(token);
}

function requireArray(value: unknown, configPath: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`Invalid config path segment in ${configPath}`);
  }
  return value;
}

function requireRecord(value: unknown, configPath: string): UnknownRecord {
  if (!isObjectRecord(value)) {
    throw new Error(`Invalid config path segment in ${configPath}`);
  }
  return value;
}

/** @visibleForTesting */
export function setConfigValue(document: UnknownRecord, configPath: string, value: string): void {
  const tokens = configPath.match(/[^.[\]]+/g);
  if (!tokens || tokens.length === 0) {
    throw new Error(`Invalid config path: ${configPath}`);
  }

  for (const token of tokens) {
    if (UNSAFE_PROPERTY_NAMES.has(token)) {
      throw new Error(`Unsafe config path segment '${token}' in ${configPath}`);
    }
  }

  let current: unknown = document;
  for (let index = 0; index < tokens.length - 1; index += 1) {
    const token = tokens[index];
    const nextToken = tokens[index + 1];
    if (!token || !nextToken) {
      throw new Error(`Invalid config path segment in ${configPath}`);
    }
    const isArrayIndex = isArrayIndexToken(token);

    if (isArrayIndex) {
      const array = requireArray(current, configPath);
      const arrayIndex = Number.parseInt(token, 10);
      if (array[arrayIndex] == null) {
        array[arrayIndex] = isArrayIndexToken(nextToken) ? [] : {};
      }
      current = array[arrayIndex];
      continue;
    }

    const record = requireRecord(current, configPath);
    if (!record[token] || typeof record[token] !== "object") {
      record[token] = isArrayIndexToken(nextToken) ? [] : {};
    }
    current = record[token];
  }

  const finalToken = tokens[tokens.length - 1];
  if (!finalToken) {
    throw new Error(`Missing final config path segment in ${configPath}`);
  }
  if (isArrayIndexToken(finalToken)) {
    const array = requireArray(current, configPath);
    array[Number.parseInt(finalToken, 10)] = value;
    return;
  }
  const record = requireRecord(current, configPath);
  record[finalToken] = value;
}

function prepareSandboxState(snapshotDir: string, manifest: SnapshotManifest): string {
  const preparedStateDir = path.join(snapshotDir, "sandbox-bundle", "openclaw");
  rmSync(preparedStateDir, { recursive: true, force: true });
  mkdirSync(path.dirname(preparedStateDir), { recursive: true });
  const snapshotStateDir = path.join(snapshotDir, "openclaw");
  copyDirectory(snapshotStateDir, preparedStateDir, {
    excludeSourcePaths: new Set([path.join(snapshotStateDir, "openclaw.json")]),
    stripCredentials: true,
  });

  const configSourcePath = resolveConfigSourcePath(manifest, snapshotDir);
  const config = manifest.configPath === null ? {} : loadCopiedConfigDocument(configSourcePath);

  for (const root of manifest.externalRoots) {
    for (const binding of root.bindings) {
      setConfigValue(config, binding.configPath, root.sandboxPath);
    }
  }

  // Strip gateway config (contains auth tokens) — sandbox entrypoint regenerates it
  delete config["gateway"];

  const configPath = path.join(preparedStateDir, "openclaw.json");
  const sanitizedConfig = stripCredentials(config);
  if (!isObjectRecord(sanitizedConfig)) {
    throw new Error(`Failed to sanitize prepared OpenClaw config in memory: ${configPath}`);
  }
  const preparedRoot = inspectDescriptorSnapshotRoot(preparedStateDir);
  if (
    preparedRoot === null ||
    !installDescriptorSnapshotFile(
      preparedRoot,
      path.basename(configPath),
      JSON.stringify(sanitizedConfig, null, 2),
    )
  ) {
    throw new Error(
      `Failed descriptor-bound installation of prepared OpenClaw config: ${configPath}`,
    );
  }

  // SECURITY: Strip all credentials from the bundle before it enters the sandbox.
  // Credentials must be injected at runtime via OpenShell's provider credential
  // mechanism, not baked into the sandbox filesystem where a compromised agent
  // can read them.
  if (!sanitizeOpenClawConfigFile(configPath)) {
    throw new Error(`Failed to sanitize prepared OpenClaw config: ${configPath}`);
  }

  return preparedStateDir;
}

export function createSnapshotBundle(
  hostState: HostOpenClawState,
  logger: PluginLogger,
  options: { persist: boolean; blueprintPath?: string },
): SnapshotBundle | null {
  if (!hostState.stateDir || !hostState.homeDir) {
    logger.error("Cannot snapshot host OpenClaw state: no state directory was resolved.");
    return null;
  }

  const snapshotsDir = path.join(
    hostState.homeDir,
    ".nemoclaw",
    options.persist ? "snapshots" : "staging",
  );
  // Empty until this operation owns a directory, so failure cleanup can never remove another one.
  let parentDir = "";

  try {
    parentDir = reserveSnapshotDir(snapshotsDir, Date.now());
    const timestamp = path.basename(parentDir);
    const snapshotStateDir = path.join(parentDir, "openclaw");
    copyDirectory(hostState.stateDir, snapshotStateDir, { stripCredentials: true });
    sanitizeMigrationDirectory(snapshotStateDir);
    if (
      hostState.configPath &&
      !hostState.hasExternalConfig &&
      existsSync(hostState.configPath) &&
      !existsSync(path.join(snapshotStateDir, "openclaw.json"))
    ) {
      throw new Error("Failed to sanitize the copied OpenClaw configuration.");
    }

    if (hostState.configPath && hostState.hasExternalConfig) {
      const configSnapshotDir = path.join(parentDir, "config");
      mkdirSync(configSnapshotDir, { recursive: true });
      const configSnapshotPath = path.join(configSnapshotDir, "openclaw.json");
      copyFileSync(hostState.configPath, configSnapshotPath);
      if (!sanitizeOpenClawConfigFile(configSnapshotPath)) {
        throw new Error("Failed to sanitize the copied external OpenClaw configuration.");
      }
    }

    const externalRoots: MigrationExternalRoot[] = [];
    for (const root of hostState.externalRoots) {
      const destination = path.join(parentDir, root.snapshotRelativePath);
      mkdirSync(path.dirname(destination), { recursive: true });
      copyDirectory(root.sourcePath, destination, { stripCredentials: true });
      sanitizeMigrationDirectory(destination);
      externalRoots.push({
        ...root,
        symlinkPaths: collectSymlinkPaths(root.sourcePath),
      });
    }

    const manifest: SnapshotManifest = {
      version: SNAPSHOT_VERSION,
      timestamp,
      createdAt: new Date().toISOString(),
      homeDir: hostState.homeDir,
      stateDir: hostState.stateDir,
      configPath: hostState.configPath,
      hasExternalConfig: hostState.hasExternalConfig,
      externalRoots,
      warnings: hostState.warnings,
    };

    if (options.blueprintPath !== undefined) {
      manifest.blueprintDigest = computeFileDigest(options.blueprintPath);
    }

    writeSnapshotManifest(parentDir, manifest);

    return {
      snapshotDir: parentDir,
      snapshotPath: path.join(parentDir, "snapshot.json"),
      preparedStateDir: prepareSandboxState(parentDir, manifest),
      archivesDir: path.join(parentDir, "sandbox-bundle", "archives"),
      manifest,
      temporary: !options.persist,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    let cleanupDetail = "";
    try {
      rmSync(parentDir, { recursive: true, force: true });
      if (existsSync(parentDir)) {
        cleanupDetail = " Incomplete snapshot cleanup did not remove the staging directory.";
      }
    } catch (cleanupError: unknown) {
      cleanupDetail = ` Incomplete snapshot cleanup failed: ${
        cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
      }`;
    }
    logger.error(`Snapshot failed: ${msg}.${cleanupDetail}`);
    return null;
  }
}

export function cleanupSnapshotBundle(bundle: SnapshotBundle): void {
  if (bundle.temporary) {
    rmSync(bundle.snapshotDir, { recursive: true, force: true });
  }
}

export async function createArchiveFromDirectory(
  sourceDir: string,
  archivePath: string,
): Promise<void> {
  mkdirSync(path.dirname(archivePath), { recursive: true });
  await createTar(
    {
      cwd: sourceDir,
      file: archivePath,
      portable: true,
      follow: false,
      noMtime: true,
    },
    ["."],
  );
}

export function loadSnapshotManifest(snapshotDir: string): SnapshotManifest {
  return readSnapshotManifest(snapshotDir);
}

export function restoreSnapshotToHost(
  snapshotDir: string,
  logger: PluginLogger,
  options?: { blueprintPath?: string },
): boolean {
  const manifest = readSnapshotManifest(snapshotDir);
  const snapshotStateDir = path.join(snapshotDir, "openclaw");
  if (!existsSync(snapshotStateDir)) {
    logger.error(`Snapshot directory not found: ${snapshotStateDir}`);
    return false;
  }

  // SECURITY (C-4): Validate that write targets are within a trusted root.
  // Use the host's actual home directory — NOT manifest.homeDir which is
  // attacker-controlled data from the snapshot JSON.
  const trustedRoot = resolveHostHome();

  // Validate manifest.homeDir itself is within trusted root
  if (typeof manifest.homeDir !== "string" || !isWithinRoot(manifest.homeDir, trustedRoot)) {
    logger.error(
      `Snapshot manifest homeDir is outside the trusted host root. ` +
        `Refusing to restore. homeDir=${manifest.homeDir}, trustedRoot=${trustedRoot}`,
    );
    return false;
  }

  // Validate stateDir type and containment
  if (typeof manifest.stateDir !== "string") {
    logger.error(`Snapshot manifest stateDir is not a string. Refusing to restore.`);
    return false;
  }

  // Support OPENCLAW_STATE_DIR env override: when set, require exact match
  const envStateDir = process.env.OPENCLAW_STATE_DIR?.trim();
  if (envStateDir) {
    const resolvedEnvStateDir = resolveUserPath(envStateDir);
    if (normalizeHostPath(manifest.stateDir) !== normalizeHostPath(resolvedEnvStateDir)) {
      logger.error(
        `Snapshot manifest stateDir does not match OPENCLAW_STATE_DIR. ` +
          `Refusing to restore. stateDir=${manifest.stateDir}, expected=${resolvedEnvStateDir}`,
      );
      return false;
    }
  } else if (!isWithinRoot(manifest.stateDir, trustedRoot)) {
    logger.error(
      `Snapshot manifest stateDir is outside the trusted host root. ` +
        `Refusing to restore. stateDir=${manifest.stateDir}, trustedRoot=${trustedRoot}`,
    );
    return false;
  }

  if (manifest.hasExternalConfig) {
    // Validate configPath type — fail closed when hasExternalConfig is true
    // but configPath is null/empty (partial restore would silently skip config).
    if (typeof manifest.configPath !== "string" || !manifest.configPath.trim()) {
      logger.error(
        `Snapshot manifest has hasExternalConfig=true but configPath is missing or empty. Refusing to restore.`,
      );
      return false;
    }

    // Support OPENCLAW_CONFIG_PATH env override: when set, require exact match
    const envConfigPath = process.env.OPENCLAW_CONFIG_PATH?.trim();
    if (envConfigPath) {
      const resolvedEnvConfigPath = resolveUserPath(envConfigPath);
      if (normalizeHostPath(manifest.configPath) !== normalizeHostPath(resolvedEnvConfigPath)) {
        logger.error(
          `Snapshot manifest configPath does not match OPENCLAW_CONFIG_PATH. ` +
            `Refusing to restore. configPath=${manifest.configPath}, expected=${resolvedEnvConfigPath}`,
        );
        return false;
      }
    } else if (!isWithinRoot(manifest.configPath, trustedRoot)) {
      logger.error(
        `Snapshot manifest configPath is outside the trusted host root. ` +
          `Refusing to restore. configPath=${manifest.configPath}, trustedRoot=${trustedRoot}`,
      );
      return false;
    }
  }

  // SECURITY: Validate blueprint digest when present in manifest
  if ("blueprintDigest" in manifest) {
    if (!manifest.blueprintDigest || typeof manifest.blueprintDigest !== "string") {
      logger.error("Snapshot manifest has empty or invalid blueprintDigest. Refusing to restore.");
      return false;
    }
    let currentDigest: string | null = null;
    try {
      currentDigest = options?.blueprintPath ? computeFileDigest(options.blueprintPath) : null;
    } catch (err: unknown) {
      logger.error(
        `Failed to read blueprint for digest verification: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return false;
    }
    if (!currentDigest) {
      logger.error(
        "Snapshot contains a blueprintDigest but no blueprint is available for verification. " +
          "Refusing to restore.",
      );
      return false;
    }
    if (currentDigest !== manifest.blueprintDigest) {
      logger.error(
        `Blueprint digest mismatch. Snapshot was created with digest=${manifest.blueprintDigest} ` +
          `but current blueprint has digest=${currentDigest}. Refusing to restore.`,
      );
      return false;
    }
  }

  try {
    if (existsSync(manifest.stateDir)) {
      const archiveName = `${manifest.stateDir}.nemoclaw-archived-${String(Date.now())}`;
      renameSync(manifest.stateDir, archiveName);
      logger.info(`Archived current state directory to ${archiveName}`);
    }

    mkdirSync(path.dirname(manifest.stateDir), { recursive: true });
    copyDirectory(snapshotStateDir, manifest.stateDir);

    if (manifest.hasExternalConfig && manifest.configPath) {
      const configSnapshotPath = path.join(snapshotDir, "config", "openclaw.json");
      mkdirSync(path.dirname(manifest.configPath), { recursive: true });
      copyFileSync(configSnapshotPath, manifest.configPath);
      chmodSync(manifest.configPath, 0o600);
      logger.info(`Restored external config to ${manifest.configPath}`);
    } else {
      const restoredBundledConfigPath = path.join(manifest.stateDir, "openclaw.json");
      if (existsSync(restoredBundledConfigPath)) {
        chmodSync(restoredBundledConfigPath, 0o600);
      }
    }

    logger.info("Host OpenClaw state restored.");
    return true;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`Restoration failed: ${msg}`);
    return false;
  }
}
