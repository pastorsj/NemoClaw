// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { HarnessPackageIdentity } from "./types";

const HARNESS_ID_MAX_LENGTH = 63;
const PACKAGE_VERSION_MAX_LENGTH = 128;
const HARNESS_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const PACKAGE_VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const SHA256_DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
const IDENTITY_FIELDS = new Set(["kind", "id", "packageVersion", "contentDigest"]);

function requireIdentityRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Harness package identity must contain one JSON object");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error("Harness package identity must contain one JSON object");
  }
  const keys = Object.keys(value);
  if (keys.length !== IDENTITY_FIELDS.size || keys.some((key) => !IDENTITY_FIELDS.has(key))) {
    throw new Error("Harness package identity fields do not match schema version 1");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    keys.some((key) => descriptors[key]?.get !== undefined || descriptors[key]?.set !== undefined)
  ) {
    throw new Error("Harness package identity fields must contain data values");
  }
  return value as Record<string, unknown>;
}

export function parseHarnessPackageId(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > HARNESS_ID_MAX_LENGTH ||
    !HARNESS_ID_PATTERN.test(value)
  ) {
    throw new Error("Harness package id must be a lowercase hyphen-separated identifier");
  }
  return value;
}

function requirePackageVersion(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > PACKAGE_VERSION_MAX_LENGTH ||
    !PACKAGE_VERSION_PATTERN.test(value)
  ) {
    throw new Error("Harness package packageVersion must be a canonical SemVer version");
  }
  return value;
}

export function parseHarnessPackageContentDigest(value: unknown): string {
  if (typeof value !== "string" || !SHA256_DIGEST_PATTERN.test(value)) {
    throw new Error("Harness package contentDigest must be a lowercase SHA-256 digest");
  }
  return value;
}

/** Validate the receipt identity without loading receipt serialization or YAML support. */
export function parseHarnessPackageIdentity(value: unknown): HarnessPackageIdentity {
  const record = requireIdentityRecord(value);
  if (record.kind !== "agent-runtime") {
    throw new Error("Harness package identity kind must be agent-runtime");
  }
  return {
    kind: "agent-runtime",
    id: parseHarnessPackageId(record.id),
    packageVersion: requirePackageVersion(record.packageVersion),
    contentDigest: parseHarnessPackageContentDigest(record.contentDigest),
  };
}
