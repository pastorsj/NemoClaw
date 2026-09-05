// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { TextDecoder } from "node:util";
import { parseDocument } from "yaml";
import { getBuildIdentity, type BuildIdentity, validateBuildIdentity } from "../../core/version";
import type { HarnessPackageIdentity } from "./types";
import {
  parseHarnessPackageContentDigest,
  parseHarnessPackageId,
  parseHarnessPackageIdentity,
} from "./identity-validation";

export {
  parseHarnessPackageContentDigest,
  parseHarnessPackageId,
  parseHarnessPackageIdentity,
} from "./identity-validation";

export const HARNESS_PACKAGE_RECEIPT_MAX_BYTES = 16 * 1024;
export const HARNESS_PACKAGE_POINTER_MAX_BYTES = 4 * 1024;

const CANONICAL_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const UNSAFE_STRING_PATTERN = /[\p{Cc}\p{Cf}\p{Cs}]/u;
const RECEIPT_FIELDS = new Set(["schemaVersion", "identity", "sourceIdentity", "installedAt"]);
const BUNDLED_SOURCE_IDENTITY_FIELDS = new Set(["kind", "nemoclawBuildIdentity"]);
const LOCAL_SOURCE_IDENTITY_FIELDS = new Set(["kind"]);
const BUILD_IDENTITY_FIELDS = new Set(["nemoclawVersion", "sourceRevision"]);
const POINTER_FIELDS = new Set(["schemaVersion", "id", "contentDigest"]);
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export interface BundledHarnessPackageSourceIdentity {
  readonly kind: "bundled";
  readonly nemoclawBuildIdentity: BuildIdentity;
}

export interface LocalHarnessPackageSourceIdentity {
  readonly kind: "local";
}

export type HarnessPackageSourceIdentity =
  | BundledHarnessPackageSourceIdentity
  | LocalHarnessPackageSourceIdentity;

/** Bind bundled package installation provenance to the exact running NemoClaw build. */
export function getBundledHarnessPackageSourceIdentity(options: {
  readonly rootDir: string;
}): BundledHarnessPackageSourceIdentity {
  return Object.freeze({
    kind: "bundled",
    nemoclawBuildIdentity: getBuildIdentity(options),
  });
}

export interface HarnessPackageReceipt {
  readonly schemaVersion: 1;
  readonly identity: HarnessPackageIdentity;
  readonly sourceIdentity: HarnessPackageSourceIdentity;
  readonly installedAt: string;
}

export interface HarnessPackageActivePointer {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly contentDigest: string;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireExactRecord(
  value: unknown,
  fields: ReadonlySet<string>,
  label: string,
): Record<string, unknown> {
  if (!isPlainRecord(value)) {
    throw new Error(`${label} must contain one JSON object`);
  }
  const keys = Object.keys(value);
  if (keys.length !== fields.size || keys.some((key) => !fields.has(key))) {
    throw new Error(`${label} fields do not match schema version 1`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    keys.some((key) => descriptors[key]?.get !== undefined || descriptors[key]?.set !== undefined)
  ) {
    throw new Error(`${label} fields must contain data values`);
  }
  return value;
}

function requireCanonicalTimestamp(value: unknown): string {
  if (
    typeof value !== "string" ||
    !CANONICAL_TIMESTAMP_PATTERN.test(value) ||
    UNSAFE_STRING_PATTERN.test(value)
  ) {
    throw new Error("Harness package installedAt must be a canonical UTC timestamp");
  }
  let canonical: string;
  try {
    canonical = new Date(value).toISOString();
  } catch {
    throw new Error("Harness package installedAt must be a canonical UTC timestamp");
  }
  if (canonical !== value) {
    throw new Error("Harness package installedAt must be a canonical UTC timestamp");
  }
  return value;
}

function decodeBoundedJson(source: string | Uint8Array, maxBytes: number, label: string): string {
  if (typeof source === "string") {
    if (Buffer.byteLength(source, "utf8") > maxBytes) {
      throw new Error(`${label} exceeds its JSON boundary`);
    }
    if (source.startsWith("\uFEFF")) {
      throw new Error(`${label} must contain valid UTF-8 JSON`);
    }
    return source;
  }
  if (!(source instanceof Uint8Array) || source.byteLength > maxBytes) {
    throw new Error(`${label} exceeds its JSON boundary`);
  }
  let decoded: string;
  try {
    decoded = UTF8_DECODER.decode(source);
  } catch {
    throw new Error(`${label} must contain valid UTF-8 JSON`);
  }
  if (decoded.startsWith("\uFEFF")) {
    throw new Error(`${label} must contain valid UTF-8 JSON`);
  }
  return decoded;
}

function parseStrictJson(source: string | Uint8Array, maxBytes: number, label: string): unknown {
  const decoded = decodeBoundedJson(source, maxBytes, label);
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    throw new Error(`${label} must contain valid JSON`);
  }
  const document = parseDocument(decoded, { schema: "json", strict: true, uniqueKeys: true });
  if (document.errors.length > 0 || document.warnings.length > 0) {
    throw new Error(`${label} must not contain duplicate fields`);
  }
  return parsed;
}

export function parseBundledHarnessPackageSourceIdentity(
  value: unknown,
): BundledHarnessPackageSourceIdentity {
  const record = requireExactRecord(
    value,
    BUNDLED_SOURCE_IDENTITY_FIELDS,
    "Harness package source identity",
  );
  if (record.kind !== "bundled") {
    throw new Error("Harness package source identity kind must be bundled");
  }
  const buildRecord = requireExactRecord(
    record.nemoclawBuildIdentity,
    BUILD_IDENTITY_FIELDS,
    "NemoClaw build identity",
  );
  const nemoclawBuildIdentity = validateBuildIdentity({
    nemoclawVersion: buildRecord.nemoclawVersion as string,
    sourceRevision: buildRecord.sourceRevision as string,
  });
  return { kind: "bundled", nemoclawBuildIdentity };
}

export function parseLocalHarnessPackageSourceIdentity(
  value: unknown,
): LocalHarnessPackageSourceIdentity {
  const record = requireExactRecord(
    value,
    LOCAL_SOURCE_IDENTITY_FIELDS,
    "Harness package source identity",
  );
  if (record.kind !== "local") {
    throw new Error("Harness package source identity kind must be local");
  }
  return { kind: "local" };
}

/** Parse only the fixed provenance forms that NemoClaw knows how to establish. */
export function parseHarnessPackageSourceIdentity(value: unknown): HarnessPackageSourceIdentity {
  if (!isPlainRecord(value)) {
    throw new Error("Harness package source identity must contain one JSON object");
  }
  const kind = Object.getOwnPropertyDescriptor(value, "kind");
  if (!kind || kind.get !== undefined || kind.set !== undefined) {
    throw new Error("Harness package source identity fields must contain data values");
  }
  if (kind.value === "bundled") return parseBundledHarnessPackageSourceIdentity(value);
  if (kind.value === "local") return parseLocalHarnessPackageSourceIdentity(value);
  throw new Error("Harness package source identity kind is invalid");
}

function requireHarnessPackageReceipt(value: unknown): HarnessPackageReceipt {
  const record = requireExactRecord(value, RECEIPT_FIELDS, "Harness package receipt");
  if (record.schemaVersion !== 1) {
    throw new Error("Harness package receipt schemaVersion must be 1");
  }
  return {
    schemaVersion: 1,
    identity: parseHarnessPackageIdentity(record.identity),
    sourceIdentity: parseHarnessPackageSourceIdentity(record.sourceIdentity),
    installedAt: requireCanonicalTimestamp(record.installedAt),
  };
}

function requireHarnessPackageActivePointer(value: unknown): HarnessPackageActivePointer {
  const record = requireExactRecord(value, POINTER_FIELDS, "Harness package active pointer");
  if (record.schemaVersion !== 1) {
    throw new Error("Harness package active pointer schemaVersion must be 1");
  }
  return {
    schemaVersion: 1,
    id: parseHarnessPackageId(record.id),
    contentDigest: parseHarnessPackageContentDigest(record.contentDigest),
  };
}

export function parseHarnessPackageReceipt(source: string | Uint8Array): HarnessPackageReceipt {
  return requireHarnessPackageReceipt(
    parseStrictJson(source, HARNESS_PACKAGE_RECEIPT_MAX_BYTES, "Harness package receipt"),
  );
}

export function parseHarnessPackageActivePointer(
  source: string | Uint8Array,
): HarnessPackageActivePointer {
  return requireHarnessPackageActivePointer(
    parseStrictJson(source, HARNESS_PACKAGE_POINTER_MAX_BYTES, "Harness package active pointer"),
  );
}

export function serializeHarnessPackageReceipt(value: unknown): string {
  return `${JSON.stringify(requireHarnessPackageReceipt(value), null, 2)}\n`;
}

export function serializeHarnessPackageActivePointer(value: unknown): string {
  return `${JSON.stringify(requireHarnessPackageActivePointer(value), null, 2)}\n`;
}

export function assertHarnessPackageReceiptMatchesPointer(
  receiptValue: unknown,
  pointerValue: unknown,
): void {
  const receipt = requireHarnessPackageReceipt(receiptValue);
  const pointer = requireHarnessPackageActivePointer(pointerValue);
  if (
    receipt.identity.id !== pointer.id ||
    receipt.identity.contentDigest !== pointer.contentDigest
  ) {
    throw new Error("Harness package receipt does not match its active pointer");
  }
}
