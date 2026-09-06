// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { validateHarnessManifest } from "@nvidia/nemoclaw-harness-contract/manifest-validator";
import { parseDocument } from "yaml";

import type { ManifestRecord, ManifestValue } from "./manifest-types";

export const HARNESS_MANIFEST_MAX_BYTES = 256 * 1024;

const MANIFEST_DATA_MAX_DEPTH = 64;
const MANIFEST_DATA_MAX_VALUES = 8192;
const UNSAFE_FIELD_NAME_PATTERN = /[\p{Cc}\p{Cf}\p{Cs}]/u;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isManifestScalar(value: unknown): value is ManifestValue {
  return (
    value === null ||
    value instanceof Date ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

function requireBoundedManifestRecord(value: unknown): ManifestRecord {
  if (!isPlainRecord(value)) {
    throw new Error("Harness agent manifest must contain one YAML mapping");
  }
  let valueCount = 0;
  const pending: Array<{ depth: number; value: unknown }> = [{ depth: 0, value }];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) break;
    valueCount += 1;
    if (valueCount > MANIFEST_DATA_MAX_VALUES || current.depth > MANIFEST_DATA_MAX_DEPTH) {
      throw new Error("Harness agent manifest exceeds its data boundary");
    }
    if (isManifestScalar(current.value)) continue;
    if (Array.isArray(current.value)) {
      for (const entry of current.value) {
        pending.push({ depth: current.depth + 1, value: entry });
      }
      continue;
    }
    if (!isPlainRecord(current.value)) {
      throw new Error("Harness agent manifest contains an unsupported YAML value");
    }
    for (const [key, entry] of Object.entries(current.value)) {
      if (UNSAFE_FIELD_NAME_PATTERN.test(key)) {
        throw new Error("Harness agent manifest contains an invalid field name");
      }
      pending.push({ depth: current.depth + 1, value: entry });
    }
  }
  return value as ManifestRecord;
}

/** Parse the bounded data document shared by source packages and installed receipts. */
export function parseHarnessManifestDocument(source: string): ManifestRecord {
  let document;
  try {
    document = parseDocument(source, { strict: true, uniqueKeys: true });
  } catch {
    throw new Error("Harness agent manifest must contain valid YAML");
  }
  if (document.errors.length > 0 || document.warnings.length > 0) {
    throw new Error("Harness agent manifest must contain valid YAML");
  }

  let value: unknown;
  try {
    value = document.toJS({ maxAliasCount: 0 });
  } catch {
    throw new Error("Harness agent manifest cannot use YAML aliases");
  }
  return requireBoundedManifestRecord(value);
}

/** Parse and semantically validate one source package manifest. */
export function parseValidatedHarnessManifestDocument(
  source: string,
  expectedHarnessId?: string,
): ManifestRecord {
  const manifest = parseHarnessManifestDocument(source);
  validateHarnessManifest(manifest, expectedHarnessId);
  return manifest;
}
