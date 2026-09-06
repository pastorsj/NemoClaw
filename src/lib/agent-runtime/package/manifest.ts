// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { TextDecoder } from "node:util";
import { parseDocument } from "yaml";
import { validateHarnessManifest } from "@nvidia/nemoclaw-harness-contract/manifest-validator";
import { openRegularFileNoFollow } from "../../adapters/fs/regular-file.ts";
import { HARNESS_MANIFEST_MAX_BYTES, parseHarnessManifestDocument } from "../manifest-document.ts";
import type { ManifestRecord } from "../manifest-types";
import { readString } from "../manifest-readers.ts";
import type { HarnessPackageEnvelope } from "./types";

export const HARNESS_PACKAGE_METADATA_FILE = "nemoclaw-package.json";
export const HARNESS_PACKAGE_METADATA_MAX_BYTES = 64 * 1024;
export const HARNESS_PACKAGE_MANIFEST_MAX_BYTES = HARNESS_MANIFEST_MAX_BYTES;

const HARNESS_ID_MAX_LENGTH = 63;
const DISPLAY_NAME_MAX_LENGTH = 128;
const DISPLAY_NAME_MAX_BYTES = 512;
const PACKAGE_VERSION_MAX_LENGTH = 128;
const NEMOCLAW_VERSION_MAX_LENGTH = 128;
const MANIFEST_PATH_MAX_BYTES = 512;
const MANIFEST_PATH_MAX_DEPTH = 32;
const HARNESS_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const UNSAFE_METADATA_TEXT_PATTERN = /[\p{Cc}\p{Cf}\p{Cs}]/u;
const WINDOWS_ABSOLUTE_PATH_PATTERN = /^[A-Za-z]:/u;
const WINDOWS_RESERVED_PATH_PATTERN = /^(?:aux|con|nul|prn|com[1-9]|lpt[1-9])(?:\..*)?$/iu;
const WINDOWS_RESERVED_CHARACTER_PATTERN = /[<>:"|?*]/u;
const ENVELOPE_FIELDS = new Set([
  "schemaVersion",
  "kind",
  "id",
  "displayName",
  "packageVersion",
  "minimumNemoClawVersion",
  "maximumNemoClawVersionExclusive",
  "manifest",
]);
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

export interface ParsedHarnessPackageManifest {
  readonly packageRoot: string;
  readonly metadataPath: string;
  readonly manifestPath: string;
  readonly envelope: HarnessPackageEnvelope;
  readonly manifest: ManifestRecord;
}

interface DirectoryAuthority {
  readonly target: string;
  readonly device: bigint;
  readonly inode: bigint;
  readonly mode: bigint;
  readonly links: bigint;
  readonly owner: bigint;
  readonly group: bigint;
  readonly size: bigint;
  readonly modifiedAt: bigint;
  readonly changedAt: bigint;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function captureDirectoryAuthority(target: string, label: string): DirectoryAuthority {
  let stats: fs.BigIntStats;
  try {
    stats = fs.lstatSync(target, { bigint: true });
  } catch {
    throw new Error(`${label} is invalid`);
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`${label} is invalid`);
  }
  return {
    target,
    device: stats.dev,
    inode: stats.ino,
    mode: stats.mode,
    links: stats.nlink,
    owner: stats.uid,
    group: stats.gid,
    size: stats.size,
    modifiedAt: stats.mtimeNs,
    changedAt: stats.ctimeNs,
  };
}

function assertDirectoryAuthority(authority: DirectoryAuthority, label: string): void {
  let current: DirectoryAuthority;
  try {
    current = captureDirectoryAuthority(authority.target, label);
  } catch {
    throw new Error(`${label} changed while reading`);
  }
  if (
    current.device !== authority.device ||
    current.inode !== authority.inode ||
    current.mode !== authority.mode ||
    current.links !== authority.links ||
    current.owner !== authority.owner ||
    current.group !== authority.group ||
    current.size !== authority.size ||
    current.modifiedAt !== authority.modifiedAt ||
    current.changedAt !== authority.changedAt
  ) {
    throw new Error(`${label} changed while reading`);
  }
}

function assertDirectoryChain(authorities: readonly DirectoryAuthority[]): void {
  for (const authority of authorities) {
    assertDirectoryAuthority(authority, "Harness package manifest directory authority");
  }
}

function captureManifestDirectoryChain(
  rootAuthority: DirectoryAuthority,
  manifest: string,
): DirectoryAuthority[] {
  const authorities = [rootAuthority];
  let currentPath = rootAuthority.target;
  for (const segment of manifest.split("/").slice(0, -1)) {
    assertDirectoryChain(authorities);
    currentPath = path.join(currentPath, segment);
    const authority = captureDirectoryAuthority(
      currentPath,
      "Harness package manifest directory authority",
    );
    assertDirectoryChain(authorities);
    authorities.push(authority);
  }
  return authorities;
}

function readBoundedUtf8(target: string, label: string, maxBytes: number): string {
  let opened: ReturnType<typeof openRegularFileNoFollow>;
  try {
    opened = openRegularFileNoFollow(target);
  } catch {
    throw new Error(`${label} must be one regular file`);
  }

  let bytes: Buffer;
  try {
    bytes = opened.readBytes(maxBytes);
  } catch {
    throw new Error(`${label} exceeds its read boundary or changed while reading`);
  } finally {
    opened.close();
  }

  try {
    return UTF8_DECODER.decode(bytes);
  } catch {
    throw new Error(`${label} must contain valid UTF-8`);
  }
}

function requireExactEnvelopeRecord(value: unknown): Record<string, unknown> {
  if (!isPlainRecord(value)) {
    throw new Error("Harness package metadata must contain one JSON object");
  }
  const keys = Object.keys(value);
  if (keys.length !== ENVELOPE_FIELDS.size || keys.some((key) => !ENVELOPE_FIELDS.has(key))) {
    throw new Error("Harness package metadata fields do not match schema version 1");
  }
  return value;
}

function requireHarnessId(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > HARNESS_ID_MAX_LENGTH ||
    !HARNESS_ID_PATTERN.test(value)
  ) {
    throw new Error("Harness package id must be a lowercase hyphen-separated identifier");
  }
  return value;
}

function requireDisplayName(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Array.from(value).length > DISPLAY_NAME_MAX_LENGTH ||
    Buffer.byteLength(value, "utf8") > DISPLAY_NAME_MAX_BYTES ||
    value !== value.trim() ||
    UNSAFE_METADATA_TEXT_PATTERN.test(value)
  ) {
    throw new Error("Harness package displayName must be bounded text without control characters");
  }
  return value;
}

function requirePackageVersion(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > PACKAGE_VERSION_MAX_LENGTH ||
    !SEMVER_PATTERN.test(value)
  ) {
    throw new Error("Harness package packageVersion must be a canonical SemVer version");
  }
  return value;
}

function requireMinimumNemoClawVersion(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > NEMOCLAW_VERSION_MAX_LENGTH ||
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(value)
  ) {
    throw new Error("Harness package minimumNemoClawVersion must be one exact x.y.z version");
  }
  return value;
}

function requireMaximumNemoClawVersionExclusive(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > NEMOCLAW_VERSION_MAX_LENGTH ||
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(value)
  ) {
    throw new Error(
      "Harness package maximumNemoClawVersionExclusive must be one exact x.y.z version",
    );
  }
  return value;
}

function compareExactCoreVersions(left: string, right: string): number {
  const leftParts = left.split(".").map(BigInt);
  const rightParts = right.split(".").map(BigInt);
  for (let index = 0; index < leftParts.length; index += 1) {
    if (leftParts[index] === rightParts[index]) continue;
    return leftParts[index] < rightParts[index] ? -1 : 1;
  }
  return 0;
}

function requireManifestPath(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > MANIFEST_PATH_MAX_BYTES ||
    value !== value.normalize("NFC") ||
    UNSAFE_METADATA_TEXT_PATTERN.test(value) ||
    value.includes("\\") ||
    path.posix.isAbsolute(value) ||
    WINDOWS_ABSOLUTE_PATH_PATTERN.test(value)
  ) {
    throw new Error("Harness package manifest must be a canonical relative path");
  }
  const segments = value.split("/");
  if (
    segments.length > MANIFEST_PATH_MAX_DEPTH ||
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === "." ||
        segment === ".." ||
        Buffer.byteLength(segment, "utf8") > 255 ||
        segment.startsWith(" ") ||
        segment.endsWith(" ") ||
        segment.endsWith(".") ||
        WINDOWS_RESERVED_CHARACTER_PATTERN.test(segment) ||
        WINDOWS_RESERVED_PATH_PATTERN.test(segment),
    ) ||
    path.posix.normalize(value) !== value
  ) {
    throw new Error("Harness package manifest must be a canonical relative path");
  }
  return value;
}

function parseEnvelope(source: string): HarnessPackageEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new Error("Harness package metadata must contain valid JSON");
  }
  const jsonDocument = parseDocument(source, { schema: "json", strict: true, uniqueKeys: true });
  if (jsonDocument.errors.length > 0 || jsonDocument.warnings.length > 0) {
    throw new Error("Harness package metadata must not contain duplicate fields");
  }
  const value = requireExactEnvelopeRecord(parsed);
  if (value.schemaVersion !== 1) {
    throw new Error("Harness package schemaVersion must be 1");
  }
  if (value.kind !== "agent-runtime") {
    throw new Error("Harness package kind must be agent-runtime");
  }
  const minimumNemoClawVersion = requireMinimumNemoClawVersion(value.minimumNemoClawVersion);
  const maximumNemoClawVersionExclusive = requireMaximumNemoClawVersionExclusive(
    value.maximumNemoClawVersionExclusive,
  );
  if (compareExactCoreVersions(maximumNemoClawVersionExclusive, minimumNemoClawVersion) <= 0) {
    throw new Error(
      "Harness package maximumNemoClawVersionExclusive must be greater than minimumNemoClawVersion",
    );
  }
  return {
    schemaVersion: 1,
    kind: "agent-runtime",
    id: requireHarnessId(value.id),
    displayName: requireDisplayName(value.displayName),
    packageVersion: requirePackageVersion(value.packageVersion),
    minimumNemoClawVersion,
    maximumNemoClawVersionExclusive,
    manifest: requireManifestPath(value.manifest),
  };
}

export function parseHarnessPackageManifest(packageRoot: string): ParsedHarnessPackageManifest {
  const resolvedRoot = path.resolve(packageRoot);
  const rootAuthority = captureDirectoryAuthority(resolvedRoot, "Harness package root authority");
  const metadataPath = path.join(resolvedRoot, HARNESS_PACKAGE_METADATA_FILE);
  const envelope = parseEnvelope(
    readBoundedUtf8(metadataPath, "Harness package metadata", HARNESS_PACKAGE_METADATA_MAX_BYTES),
  );
  assertDirectoryAuthority(rootAuthority, "Harness package root authority");
  const directoryAuthorities = captureManifestDirectoryChain(rootAuthority, envelope.manifest);
  const manifestPath = path.join(resolvedRoot, ...envelope.manifest.split("/"));
  const manifest = parseHarnessManifestDocument(
    readBoundedUtf8(manifestPath, "Harness agent manifest", HARNESS_PACKAGE_MANIFEST_MAX_BYTES),
  );
  assertDirectoryChain(directoryAuthorities);
  const manifestId = readString(manifest, "name");
  if (manifestId !== envelope.id) {
    throw new Error("Harness agent manifest name must match the package id");
  }
  validateHarnessManifest(manifest, envelope.id);
  assertDirectoryChain(directoryAuthorities);
  return { packageRoot: resolvedRoot, metadataPath, manifestPath, envelope, manifest };
}
