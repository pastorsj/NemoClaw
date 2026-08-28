// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { buildAvailabilityProbeEnv } from "./availability-env.ts";
import type { HostCliClient } from "./clients/host.ts";
import type { ShellProbeResult } from "./shell-probe.ts";

const STANDARD_HARNESS_IDS = new Set(["openclaw", "hermes", "langchain-deepagents-code"] as const);
const HARNESS_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const PACKAGE_VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const SHA256_DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
const UNSAFE_TEXT_PATTERN = /[\p{Cc}\p{Cf}\p{Cs}]/u;
const TOP_LEVEL_FIELDS = new Set(["schemaVersion", "installed", "available"]);
const INSTALLED_FIELDS = new Set(["id", "displayName", "health", "identity"]);
const AVAILABLE_FIELDS = new Set(["displayName", "identity", "installationState"]);
const IDENTITY_FIELDS = new Set([
  "kind",
  "id",
  "packageVersion",
  "contractVersion",
  "contentDigest",
]);
const INSTALLATION_STATES = new Set(["not-installed", "active", "different", "damaged"]);
const INSTALL_TIMEOUT_MS = 5 * 60_000;
const LIST_TIMEOUT_MS = 30_000;

export type StandardHarnessId = "openclaw" | "hermes" | "langchain-deepagents-code";

export interface HarnessPackageIdentity {
  readonly kind: "agent-runtime";
  readonly id: string;
  readonly packageVersion: string;
  readonly contractVersion: 1;
  readonly contentDigest: string;
}

export interface HarnessPackageEvidence {
  readonly identity: HarnessPackageIdentity;
  readonly installResult: ShellProbeResult;
  readonly inventoryResult: ShellProbeResult;
}

export interface HarnessInventoryEvidence {
  readonly identity: HarnessPackageIdentity;
  readonly inventoryResult: ShellProbeResult;
}

interface InstalledInventoryRow {
  readonly id: string;
  readonly health: "healthy" | "damaged";
  readonly identity: HarnessPackageIdentity | null;
}

interface AvailableInventoryRow {
  readonly identity: HarnessPackageIdentity;
  readonly installationState: "not-installed" | "active" | "different" | "damaged";
}

interface HarnessInventory {
  readonly installed: readonly InstalledInventoryRow[];
  readonly available: readonly AvailableInventoryRow[];
}

function requireExactRecord(
  value: unknown,
  fields: ReadonlySet<string>,
  label: string,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must contain one object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must contain one plain object`);
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== fields.size || keys.some((key) => !fields.has(key))) {
    throw new Error(`${label} fields do not match schema version 1`);
  }
  return record;
}

function requireHarnessId(value: unknown): string {
  if (typeof value !== "string" || value.length > 63 || !HARNESS_ID_PATTERN.test(value)) {
    throw new Error("Harness package id must be a canonical identifier");
  }
  return value;
}

function requireStandardHarnessId(value: unknown): StandardHarnessId {
  const id = requireHarnessId(value);
  if (!STANDARD_HARNESS_IDS.has(id as StandardHarnessId)) {
    throw new Error("Harness package selection must use a canonical standard id");
  }
  return id as StandardHarnessId;
}

function requireDisplayName(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Array.from(value).length > 128 ||
    UNSAFE_TEXT_PATTERN.test(value)
  ) {
    throw new Error("Harness package displayName must contain bounded safe text");
  }
  return value;
}

function requirePackageVersion(value: unknown): string {
  if (typeof value !== "string" || value.length > 128 || !PACKAGE_VERSION_PATTERN.test(value)) {
    throw new Error("Harness package packageVersion must be canonical SemVer");
  }
  return value;
}

/** Parse the closed identity object without importing product CLI source. */
export function parseHarnessPackageIdentity(value: unknown): HarnessPackageIdentity {
  const record = requireExactRecord(value, IDENTITY_FIELDS, "Harness package identity");
  if (record.kind !== "agent-runtime") {
    throw new Error("Harness package identity kind must be agent-runtime");
  }
  if (record.contractVersion !== 1) {
    throw new Error("Harness package identity contractVersion must be 1");
  }
  if (
    typeof record.contentDigest !== "string" ||
    !SHA256_DIGEST_PATTERN.test(record.contentDigest)
  ) {
    throw new Error("Harness package contentDigest must be a lowercase SHA-256 digest");
  }
  return Object.freeze({
    kind: "agent-runtime",
    id: requireHarnessId(record.id),
    packageVersion: requirePackageVersion(record.packageVersion),
    contractVersion: 1,
    contentDigest: record.contentDigest,
  });
}

export function harnessPackageIdentitiesEqual(
  left: HarnessPackageIdentity,
  right: HarnessPackageIdentity,
): boolean {
  return (
    left.kind === right.kind &&
    left.id === right.id &&
    left.packageVersion === right.packageVersion &&
    left.contractVersion === right.contractVersion &&
    left.contentDigest === right.contentDigest
  );
}

function parseInstalledRow(value: unknown): InstalledInventoryRow {
  const record = requireExactRecord(value, INSTALLED_FIELDS, "Harness installed inventory row");
  const id = requireHarnessId(record.id);
  requireDisplayName(record.displayName);
  if (record.health === "damaged") {
    if (record.identity !== null) {
      throw new Error("Damaged harness inventory row must not claim an identity");
    }
    return Object.freeze({ id, health: "damaged", identity: null });
  }
  if (record.health !== "healthy") {
    throw new Error("Harness installed inventory health is invalid");
  }
  const identity = parseHarnessPackageIdentity(record.identity);
  if (identity.id !== id) {
    throw new Error("Harness installed inventory identity does not match its row");
  }
  return Object.freeze({ id, health: "healthy", identity });
}

function parseAvailableRow(value: unknown): AvailableInventoryRow {
  const record = requireExactRecord(value, AVAILABLE_FIELDS, "Harness available inventory row");
  requireDisplayName(record.displayName);
  if (!INSTALLATION_STATES.has(record.installationState as string)) {
    throw new Error("Harness available inventory installation state is invalid");
  }
  return Object.freeze({
    identity: parseHarnessPackageIdentity(record.identity),
    installationState: record.installationState as AvailableInventoryRow["installationState"],
  });
}

function rejectDuplicateIds(rows: readonly string[], label: string): void {
  if (new Set(rows).size !== rows.length) {
    throw new Error(`${label} contains a duplicate id`);
  }
}

function parseHarnessInventory(source: string): HarnessInventory {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw new Error("Harness inventory must contain machine-readable JSON");
  }
  const record = requireExactRecord(value, TOP_LEVEL_FIELDS, "Harness inventory");
  if (record.schemaVersion !== 1) {
    throw new Error("Harness inventory schemaVersion must be 1");
  }
  if (!Array.isArray(record.installed) || !Array.isArray(record.available)) {
    throw new Error("Harness inventory installed and available fields must be arrays");
  }
  const installed = Object.freeze(record.installed.map(parseInstalledRow));
  const available = Object.freeze(record.available.map(parseAvailableRow));
  rejectDuplicateIds(
    installed.map((row) => row.id),
    "Harness installed inventory",
  );
  rejectDuplicateIds(
    available.map((row) => row.identity.id),
    "Harness available inventory",
  );
  return Object.freeze({ installed, available });
}

function selectInstalledIdentity(
  source: string,
  selectedId: StandardHarnessId,
): HarnessPackageIdentity {
  const inventory = parseHarnessInventory(source);
  const installed = inventory.installed.filter((row) => row.id === selectedId);
  if (installed.length !== 1 || installed[0]?.health !== "healthy" || !installed[0].identity) {
    throw new Error("Harness inventory does not contain one healthy selected package");
  }
  const available = inventory.available.filter((row) => row.identity.id === selectedId);
  if (
    available.length !== 1 ||
    available[0]?.installationState !== "active" ||
    !harnessPackageIdentitiesEqual(installed[0].identity, available[0].identity)
  ) {
    throw new Error("Harness inventory does not confirm the selected package as active");
  }
  return installed[0].identity;
}

function requireCommandSuccess(result: ShellProbeResult, operation: "install" | "inventory"): void {
  if (result.exitCode !== 0 || result.timedOut || result.signal !== null) {
    throw new Error(`Harness package ${operation} failed through the public NemoClaw CLI`);
  }
}

/** Re-list one installed package through the public machine-output boundary. */
export async function readInstalledHarnessPackage(
  host: HostCliClient,
  selectedId: StandardHarnessId,
): Promise<HarnessInventoryEvidence> {
  const id = requireStandardHarnessId(selectedId);
  const inventoryResult = await host.nemoclaw(["harness", "list", "--json"], {
    artifactName: `harness-list-${id}`,
    env: buildAvailabilityProbeEnv(),
    timeoutMs: LIST_TIMEOUT_MS,
  });
  requireCommandSuccess(inventoryResult, "inventory");
  return Object.freeze({
    identity: selectInstalledIdentity(inventoryResult.stdout, id),
    inventoryResult,
  });
}

/** Install one reviewed standard package, then prove its receipt-backed inventory identity. */
export async function installHarnessPackage(
  host: HostCliClient,
  selectedId: StandardHarnessId,
): Promise<HarnessPackageEvidence> {
  const id = requireStandardHarnessId(selectedId);
  const installResult = await host.nemoclaw(["harness", "install", id], {
    artifactName: `harness-install-${id}`,
    env: buildAvailabilityProbeEnv(),
    timeoutMs: INSTALL_TIMEOUT_MS,
  });
  requireCommandSuccess(installResult, "install");
  const inventory = await readInstalledHarnessPackage(host, id);
  return Object.freeze({
    identity: inventory.identity,
    installResult,
    inventoryResult: inventory.inventoryResult,
  });
}
