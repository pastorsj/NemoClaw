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
const PACKAGE_VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

export interface PreparedHarnessPackageUpgrade {
  readonly packageRoot: string;
  readonly packageVersion: string;
  readonly sourcePackageVersion: string;
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

/**
 * Copy one validated artifact into run-owned state and change only its package
 * version. The public installer still validates every byte before publication.
 */
export function prepareHarnessPackageUpgrade(
  sourceRootValue: string,
  destinationRootValue: string,
  expectedId: string,
): PreparedHarnessPackageUpgrade {
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
  const sourcePackageVersion = sourceMetadata.packageVersion as string;
  const packageVersion = deriveHarnessLifecycleVersion(sourcePackageVersion);

  try {
    fs.cpSync(sourceRoot, destinationRoot, {
      errorOnExist: true,
      force: false,
      preserveTimestamps: true,
      recursive: true,
      verbatimSymlinks: true,
    });
    const copiedMetadata = readPackageMetadata(destinationRoot, expectedId);
    const copiedMetadataPath = path.join(destinationRoot, PACKAGE_METADATA_FILE);
    const copiedMetadataMode = fs.statSync(copiedMetadataPath).mode & 0o7777;
    try {
      fs.chmodSync(copiedMetadataPath, copiedMetadataMode | 0o200);
      fs.writeFileSync(
        copiedMetadataPath,
        `${JSON.stringify({ ...copiedMetadata, packageVersion }, null, 2)}\n`,
      );
    } finally {
      fs.chmodSync(copiedMetadataPath, copiedMetadataMode);
    }
    readPackageMetadata(destinationRoot, expectedId);
    return Object.freeze({ packageRoot: destinationRoot, packageVersion, sourcePackageVersion });
  } catch (error) {
    fs.rmSync(destinationRoot, { force: true, recursive: true });
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
