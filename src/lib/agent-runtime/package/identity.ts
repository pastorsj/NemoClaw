// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isPlainObject } from "../../core/json-types";
import { parseHarnessPackageIdentity as parseReceiptHarnessPackageIdentity } from "./receipt";
import type {
  HarnessPackageAuthority,
  HarnessPackageIdentity,
  HarnessPackageMigration,
} from "./types";

export type {
  HarnessPackageAuthority,
  HarnessPackageIdentity,
  HarnessPackageMigration,
} from "./types";
export { parseHarnessPackageId } from "./receipt";

const MIGRATION_FIELDS = new Set(["schemaVersion", "source", "legacyAgent", "migratedAt"]);
const STANDARD_LEGACY_AGENTS = new Set(["openclaw", "hermes", "langchain-deepagents-code"]);
const CANONICAL_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const UNSAFE_STRING_PATTERN = /[\p{Cc}\p{Cf}\p{Cs}]/u;

export type HarnessPackageStateInspection =
  | { readonly status: "absent" }
  | {
      readonly status: "valid";
      readonly harnessPackage: HarnessPackageIdentity;
      readonly harnessPackageMigration: HarnessPackageMigration | null;
    }
  | { readonly status: "invalid" };

interface ComparableHarnessPackageAuthority {
  readonly harnessPackage?: unknown;
  readonly harnessPackageMigration?: unknown;
}

function requireExactMigrationRecord(value: unknown): Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw new Error("Harness package migration must contain one JSON object");
  }
  const keys = Object.keys(value);
  if (keys.length !== MIGRATION_FIELDS.size || keys.some((key) => !MIGRATION_FIELDS.has(key))) {
    throw new Error("Harness package migration fields do not match schema version 1");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    keys.some((key) => descriptors[key]?.get !== undefined || descriptors[key]?.set !== undefined)
  ) {
    throw new Error("Harness package migration fields must contain data values");
  }
  return value;
}

function requireCanonicalTimestamp(value: unknown): string {
  if (
    typeof value !== "string" ||
    !CANONICAL_TIMESTAMP_PATTERN.test(value) ||
    UNSAFE_STRING_PATTERN.test(value)
  ) {
    throw new Error("Harness package migration migratedAt must be a canonical UTC timestamp");
  }
  let canonical: string;
  try {
    canonical = new Date(value).toISOString();
  } catch {
    throw new Error("Harness package migration migratedAt must be a canonical UTC timestamp");
  }
  if (canonical !== value) {
    throw new Error("Harness package migration migratedAt must be a canonical UTC timestamp");
  }
  return value;
}

function requireMigrationAgent(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !STANDARD_LEGACY_AGENTS.has(value)) {
    throw new Error("Harness package migration legacyAgent is not a standard canonical agent");
  }
  return value;
}

export function parseHarnessPackageIdentity(value: unknown): HarnessPackageIdentity {
  return Object.freeze(parseReceiptHarnessPackageIdentity(value));
}

export function serializeHarnessPackageIdentity(value: unknown): string {
  return JSON.stringify(parseHarnessPackageIdentity(value));
}

export function isHarnessPackageIdentity(value: unknown): value is HarnessPackageIdentity {
  try {
    parseHarnessPackageIdentity(value);
    return true;
  } catch {
    return false;
  }
}

export function harnessPackageIdentitiesEqual(leftValue: unknown, rightValue: unknown): boolean {
  const left = parseHarnessPackageIdentity(leftValue);
  const right = parseHarnessPackageIdentity(rightValue);
  return (
    left.kind === right.kind &&
    left.id === right.id &&
    left.packageVersion === right.packageVersion &&
    left.contentDigest === right.contentDigest
  );
}

/** Compare complete persisted package authority without collapsing omission into null. */
export function harnessPackageAuthoritiesEqual(
  left: ComparableHarnessPackageAuthority,
  right: ComparableHarnessPackageAuthority,
): boolean {
  const leftHasIdentity = Object.prototype.hasOwnProperty.call(left, "harnessPackage");
  const rightHasIdentity = Object.prototype.hasOwnProperty.call(right, "harnessPackage");
  const leftHasMigration = Object.prototype.hasOwnProperty.call(left, "harnessPackageMigration");
  const rightHasMigration = Object.prototype.hasOwnProperty.call(right, "harnessPackageMigration");
  if (leftHasIdentity !== rightHasIdentity || leftHasMigration !== rightHasMigration) return false;
  if (!leftHasIdentity && !leftHasMigration) return true;

  const leftState = inspectHarnessPackageState(left.harnessPackage, left.harnessPackageMigration);
  const rightState = inspectHarnessPackageState(
    right.harnessPackage,
    right.harnessPackageMigration,
  );
  if (leftState.status === "invalid" || rightState.status === "invalid") return false;
  if (leftState.status !== rightState.status) return false;
  if (leftState.status === "absent") {
    return (
      left.harnessPackage === right.harnessPackage &&
      left.harnessPackageMigration === right.harnessPackageMigration
    );
  }
  if (rightState.status !== "valid") return false;
  if (!harnessPackageIdentitiesEqual(leftState.harnessPackage, rightState.harnessPackage)) {
    return false;
  }
  const leftMigration = leftState.harnessPackageMigration;
  const rightMigration = rightState.harnessPackageMigration;
  return (
    leftMigration === rightMigration ||
    (leftMigration !== null &&
      rightMigration !== null &&
      leftMigration.schemaVersion === rightMigration.schemaVersion &&
      leftMigration.source === rightMigration.source &&
      leftMigration.legacyAgent === rightMigration.legacyAgent &&
      leftMigration.migratedAt === rightMigration.migratedAt)
  );
}

export function assertMatchingHarnessIdentity(leftValue: unknown, rightValue: unknown): void {
  if (!harnessPackageIdentitiesEqual(leftValue, rightValue)) {
    throw new Error("Harness package identities do not match");
  }
}

export function parseHarnessPackageMigration(
  value: unknown,
  identityValue: unknown,
): HarnessPackageMigration {
  const identity = parseHarnessPackageIdentity(identityValue);
  const record = requireExactMigrationRecord(value);
  if (record.schemaVersion !== 1 || record.source !== "legacy-current-bundle") {
    throw new Error("Harness package migration schema is unsupported");
  }
  const legacyAgent = requireMigrationAgent(record.legacyAgent);
  const expectedId = legacyAgent ?? "openclaw";
  if (identity.id !== expectedId) {
    throw new Error("Harness package migration does not match its package identity");
  }
  return Object.freeze({
    schemaVersion: 1,
    source: "legacy-current-bundle",
    legacyAgent,
    migratedAt: requireCanonicalTimestamp(record.migratedAt),
  });
}

export function serializeHarnessPackageMigration(value: unknown, identityValue: unknown): string {
  return JSON.stringify(parseHarnessPackageMigration(value, identityValue));
}

export function inspectHarnessPackageState(
  identityValue: unknown,
  migrationValue: unknown,
): HarnessPackageStateInspection {
  if (identityValue === undefined || identityValue === null) {
    return migrationValue === undefined || migrationValue === null
      ? { status: "absent" }
      : { status: "invalid" };
  }
  try {
    const harnessPackage = parseHarnessPackageIdentity(identityValue);
    const harnessPackageMigration =
      migrationValue === undefined || migrationValue === null
        ? null
        : parseHarnessPackageMigration(migrationValue, harnessPackage);
    return Object.freeze({ status: "valid", harnessPackage, harnessPackageMigration });
  } catch {
    return { status: "invalid" };
  }
}
