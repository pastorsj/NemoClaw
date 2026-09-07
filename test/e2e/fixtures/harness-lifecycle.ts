// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import type { ShellProbeResult } from "./shell-probe.ts";
import {
  harnessPackageIdentitiesEqual,
  parseHarnessPackageIdentity,
  type HarnessPackageIdentity,
} from "./harness-package.ts";

const PACKAGE_METADATA_FILE = "nemoclaw-package.json";
const PACKAGE_METADATA_MAX_BYTES = 16 * 1024;
const PACKAGE_VERSION_MAX_BYTES = 128;
const PACKAGE_DOCKERFILE = "Dockerfile";
const PACKAGE_DOCKERFILE_MAX_BYTES = 4 * 1024 * 1024;
const PACKAGE_REVISION_MARKER_FILE = "e2e-lifecycle-revision.txt";
const HARNESS_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const PACKAGE_VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

export const HARNESS_LIFECYCLE_REVISION_MARKER_PATH =
  "/usr/local/share/nemoclaw/e2e-lifecycle-revision";

export interface PreparedHarnessPackageRevision {
  readonly packageRoot: string;
  readonly packageVersion: string;
  readonly revisionMarker: string;
  readonly sourcePackageVersion: string;
}

export type PreparedHarnessPackageUpgrade = PreparedHarnessPackageRevision;

export interface PreparedHarnessPackageLifecycle {
  readonly source: PreparedHarnessPackageRevision;
  readonly upgrade: PreparedHarnessPackageUpgrade;
}

/** Require an install to publish a new revision for the same package id. */
export function requireHarnessPackageUpgrade(
  source: HarnessPackageIdentity,
  upgrade: HarnessPackageIdentity,
  expectedVersion?: string,
): HarnessPackageIdentity {
  if (
    source.id !== upgrade.id ||
    source.kind !== upgrade.kind ||
    source.packageVersion === upgrade.packageVersion ||
    source.contentDigest === upgrade.contentDigest ||
    (expectedVersion !== undefined && upgrade.packageVersion !== expectedVersion)
  ) {
    throw new Error("Harness package upgrade did not publish a distinct package revision");
  }
  return upgrade;
}

function plainRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must contain one object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must contain one plain object`);
  }
  return value as Record<string, unknown>;
}

function readPackageMetadata(packageRoot: string, expectedId: string): Record<string, unknown> {
  const metadataPath = path.join(packageRoot, PACKAGE_METADATA_FILE);
  const metadata = fs.lstatSync(metadataPath);
  if (
    metadata.isSymbolicLink() ||
    !metadata.isFile() ||
    metadata.size === 0 ||
    metadata.size > PACKAGE_METADATA_MAX_BYTES
  ) {
    throw new Error("Harness lifecycle package metadata must be a bounded regular file");
  }
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
  } catch {
    throw new Error("Harness lifecycle package metadata must contain valid JSON");
  }
  const record = plainRecord(value, "Harness lifecycle package metadata");
  if (
    record.schemaVersion !== 1 ||
    record.kind !== "agent-runtime" ||
    record.id !== expectedId ||
    !HARNESS_ID_PATTERN.test(expectedId) ||
    typeof record.packageVersion !== "string" ||
    !PACKAGE_VERSION_PATTERN.test(record.packageVersion)
  ) {
    throw new Error("Harness lifecycle package metadata identity is invalid");
  }
  return record;
}

/** Create a greater, test-only SemVer without assuming a package's current version. */
export function deriveHarnessLifecycleVersion(sourceVersion: string): string {
  const match = PACKAGE_VERSION_PATTERN.exec(sourceVersion);
  if (!match) throw new Error("Harness lifecycle source version must be canonical SemVer");
  const sourceCore = [match[1]!, match[2]!, match[3]!] as const;
  const candidates = [
    [sourceCore[0], sourceCore[1], (BigInt(sourceCore[2]) + 1n).toString()],
    [sourceCore[0], (BigInt(sourceCore[1]) + 1n).toString(), "0"],
    [(BigInt(sourceCore[0]) + 1n).toString(), "0", "0"],
  ];
  for (const core of candidates) {
    const candidate = `${core.join(".")}-e2e.lifecycle`;
    if (
      Buffer.byteLength(candidate, "utf8") <= PACKAGE_VERSION_MAX_BYTES &&
      PACKAGE_VERSION_PATTERN.test(candidate)
    ) {
      return candidate;
    }
  }
  throw new Error("Harness lifecycle source version cannot produce a bounded test version");
}

function packageSourceDirectory(
  packageRoot: string,
  metadata: Record<string, unknown>,
  expectedId: string,
): string {
  const manifest = metadata.manifest;
  const nestedManifest = `packages/nemoclaw-${expectedId}/manifest.yaml`;
  if (manifest !== "manifest.yaml" && manifest !== nestedManifest) {
    throw new Error("Harness lifecycle package manifest path is invalid");
  }
  const directory = path.dirname(path.resolve(packageRoot, manifest));
  if (directory !== packageRoot && !directory.startsWith(`${packageRoot}${path.sep}`)) {
    throw new Error("Harness lifecycle package manifest escapes its artifact");
  }
  return directory;
}

function requirePackageDockerfile(packageRoot: string, expectedId: string): string {
  const packageMetadata = readPackageMetadata(packageRoot, expectedId);
  const dockerfilePath = path.join(
    packageSourceDirectory(packageRoot, packageMetadata, expectedId),
    PACKAGE_DOCKERFILE,
  );
  const metadata = fs.lstatSync(dockerfilePath);
  if (
    metadata.isSymbolicLink() ||
    !metadata.isFile() ||
    metadata.size === 0 ||
    metadata.size > PACKAGE_DOCKERFILE_MAX_BYTES
  ) {
    throw new Error("Harness lifecycle Dockerfile must be a bounded regular file");
  }
  const source = fs.readFileSync(dockerfilePath, "utf8");
  if (
    source.includes(PACKAGE_REVISION_MARKER_FILE) ||
    source.includes(HARNESS_LIFECYCLE_REVISION_MARKER_PATH)
  ) {
    throw new Error("Harness lifecycle Dockerfile already owns the test revision marker");
  }
  return source;
}

function writePreservingMode(file: string, source: string): void {
  const mode = fs.statSync(file).mode & 0o7777;
  try {
    fs.chmodSync(file, mode | 0o200);
    fs.writeFileSync(file, source, "utf8");
  } finally {
    fs.chmodSync(file, mode);
  }
}

function writeLifecycleRevisionMarker(
  packageRoot: string,
  expectedId: string,
  revisionMarker: string,
): void {
  const metadata = readPackageMetadata(packageRoot, expectedId);
  const packageDirectory = packageSourceDirectory(packageRoot, metadata, expectedId);
  const rootMode = fs.statSync(packageDirectory).mode & 0o7777;
  const markerPath = path.join(packageDirectory, PACKAGE_REVISION_MARKER_FILE);
  try {
    fs.chmodSync(packageDirectory, rootMode | 0o200);
    fs.writeFileSync(markerPath, `${revisionMarker}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o444,
    });
    fs.chmodSync(markerPath, 0o444);
  } finally {
    fs.chmodSync(packageDirectory, rootMode);
  }

  const dockerfilePath = path.join(packageDirectory, PACKAGE_DOCKERFILE);
  const dockerfile = requirePackageDockerfile(packageRoot, expectedId);
  const separator = dockerfile.endsWith("\n") ? "" : "\n";
  writePreservingMode(
    dockerfilePath,
    `${dockerfile}${separator}\n# Test-only marker proving which immutable harness package built this image.\nCOPY packages/nemoclaw-${expectedId}/${PACKAGE_REVISION_MARKER_FILE} ${HARNESS_LIFECYCLE_REVISION_MARKER_PATH}\n`,
  );
}

function makeDirectoriesOwnerWritable(root: string): void {
  let metadata: fs.Stats;
  try {
    metadata = fs.lstatSync(root);
  } catch {
    return;
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) return;
  fs.chmodSync(root, (metadata.mode & 0o7777) | 0o700);
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      makeDirectoriesOwnerWritable(path.join(root, entry.name));
    }
  }
}

function removePreparedPackage(root: string): void {
  makeDirectoriesOwnerWritable(root);
  fs.rmSync(root, { force: true, recursive: true });
}

function prepareHarnessPackageRevision(
  sourceRootValue: string,
  destinationRootValue: string,
  expectedId: string,
  revision: "source" | "upgrade",
): PreparedHarnessPackageRevision {
  const sourceRoot = path.resolve(sourceRootValue);
  const destinationRoot = path.resolve(destinationRootValue);
  if (sourceRoot !== sourceRootValue || destinationRoot !== destinationRootValue) {
    throw new Error("Harness lifecycle package paths must be canonical absolute paths");
  }
  const source = fs.lstatSync(sourceRoot);
  if (source.isSymbolicLink() || !source.isDirectory()) {
    throw new Error("Harness lifecycle source must be a directory without symbolic links");
  }
  if (fs.existsSync(destinationRoot)) {
    throw new Error("Harness lifecycle destination must be absent");
  }
  const relativeDestination = path.relative(sourceRoot, destinationRoot);
  if (
    !relativeDestination ||
    (!relativeDestination.startsWith("..") && !path.isAbsolute(relativeDestination))
  ) {
    throw new Error("Harness lifecycle destination must be outside the source artifact");
  }
  const sourceMetadata = readPackageMetadata(sourceRoot, expectedId);
  requirePackageDockerfile(sourceRoot, expectedId);
  const sourcePackageVersion = sourceMetadata.packageVersion as string;
  const packageVersion =
    revision === "upgrade"
      ? deriveHarnessLifecycleVersion(sourcePackageVersion)
      : sourcePackageVersion;
  const revisionMarker = `${revision}:${packageVersion}`;

  try {
    fs.cpSync(sourceRoot, destinationRoot, {
      errorOnExist: true,
      force: false,
      preserveTimestamps: true,
      recursive: true,
      verbatimSymlinks: true,
    });
    if (revision === "upgrade") {
      const copiedMetadata = readPackageMetadata(destinationRoot, expectedId);
      const copiedMetadataPath = path.join(destinationRoot, PACKAGE_METADATA_FILE);
      writePreservingMode(
        copiedMetadataPath,
        `${JSON.stringify({ ...copiedMetadata, packageVersion }, null, 2)}\n`,
      );
    }
    writeLifecycleRevisionMarker(destinationRoot, expectedId, revisionMarker);
    readPackageMetadata(destinationRoot, expectedId);
    return Object.freeze({
      packageRoot: destinationRoot,
      packageVersion,
      revisionMarker,
      sourcePackageVersion,
    });
  } catch (error) {
    removePreparedPackage(destinationRoot);
    throw error;
  }
}

/**
 * Copy one validated artifact into run-owned state and change only its package
 * version and fixture-only image marker. The public installer still validates
 * every byte before publication.
 */
export function prepareHarnessPackageUpgrade(
  sourceRootValue: string,
  destinationRootValue: string,
  expectedId: string,
): PreparedHarnessPackageUpgrade {
  return prepareHarnessPackageRevision(
    sourceRootValue,
    destinationRootValue,
    expectedId,
    "upgrade",
  );
}

/** Prepare explicit old/new package-visible revisions for the generic lifecycle journey. */
export function prepareHarnessPackageLifecycle(
  sourceRootValue: string,
  destinationRootValue: string,
  expectedId: string,
): PreparedHarnessPackageLifecycle {
  const sourceRoot = path.resolve(sourceRootValue);
  const destinationRoot = path.resolve(destinationRootValue);
  if (sourceRoot !== sourceRootValue || destinationRoot !== destinationRootValue) {
    throw new Error("Harness lifecycle package paths must be canonical absolute paths");
  }
  if (fs.existsSync(destinationRoot)) {
    throw new Error("Harness lifecycle destination must be absent");
  }
  const relativeDestination = path.relative(sourceRoot, destinationRoot);
  if (
    !relativeDestination ||
    (!relativeDestination.startsWith("..") && !path.isAbsolute(relativeDestination))
  ) {
    throw new Error("Harness lifecycle destination must be outside the source artifact");
  }

  try {
    fs.mkdirSync(destinationRoot, { mode: 0o700 });
    const source = prepareHarnessPackageRevision(
      sourceRoot,
      path.join(destinationRoot, "source"),
      expectedId,
      "source",
    );
    const upgrade = prepareHarnessPackageRevision(
      sourceRoot,
      path.join(destinationRoot, "upgrade"),
      expectedId,
      "upgrade",
    );
    return Object.freeze({ source, upgrade });
  } catch (error) {
    removePreparedPackage(destinationRoot);
    throw error;
  }
}

function parseSuccessfulJson(result: ShellProbeResult, label: string): Record<string, unknown> {
  if (result.exitCode !== 0 || result.timedOut || result.signal !== null) {
    throw new Error(`${label} failed through the public NemoClaw CLI`);
  }
  let value: unknown;
  try {
    value = JSON.parse(result.stdout);
  } catch {
    throw new Error(`${label} must return machine-readable JSON`);
  }
  return plainRecord(value, label);
}

/** Require the public activation result to select one expected immutable receipt. */
export function requireHarnessPackageActivation(
  result: ShellProbeResult,
  expected: HarnessPackageIdentity,
): HarnessPackageIdentity {
  const value = parseSuccessfulJson(result, "Harness package activation");
  const keys = Object.keys(value).sort();
  const identity = parseHarnessPackageIdentity(value.identity);
  if (
    JSON.stringify(keys) !== JSON.stringify(["identity", "schemaVersion", "state"]) ||
    value.schemaVersion !== 1 ||
    value.state !== "active" ||
    !harnessPackageIdentitiesEqual(identity, expected)
  ) {
    throw new Error("Harness package activation returned an unexpected receipt");
  }
  return identity;
}

/** Require the public removal result to deactivate one expected immutable receipt. */
export function requireHarnessPackageDeactivation(
  result: ShellProbeResult,
  expected: HarnessPackageIdentity,
): HarnessPackageIdentity {
  const value = parseSuccessfulJson(result, "Harness package removal");
  const keys = Object.keys(value).sort();
  const identity = parseHarnessPackageIdentity(value.identity);
  if (
    JSON.stringify(keys) !== JSON.stringify(["identity", "schemaVersion", "state"]) ||
    value.schemaVersion !== 1 ||
    value.state !== "deactivated" ||
    !harnessPackageIdentitiesEqual(identity, expected)
  ) {
    throw new Error("Harness package removal returned an unexpected receipt");
  }
  return identity;
}
