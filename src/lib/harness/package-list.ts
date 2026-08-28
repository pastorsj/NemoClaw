// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  listHarnessPackageInventory,
  type HarnessPackageInventory,
  type InstalledHarnessPackageRecord,
} from "./package-catalog";
import { AGENT_ALIASES } from "../agent/aliases";
import { parseHarnessPackageIdentity } from "./package-identity";
import { parseHarnessPackageId } from "./package-receipt";
import type { HarnessPackageIdentity } from "./package-types";

const DISPLAY_NAME_MAX_LENGTH = 128;
const TERMINAL_ESCAPE_PATTERN =
  /\u001B(?:\[[0-?]*[ -/]*[@-~]|\][\s\S]*?(?:\u0007|\u001B\\|$)|[@-_])/gu;
const UNSAFE_TEXT_PATTERN = /[\p{Cc}\p{Cf}\p{Cs}]/gu;
const TOP_LEVEL_FIELDS = new Set(["schemaVersion", "installed", "available"]);
const INSTALLED_FIELDS = new Set(["id", "displayName", "health", "identity"]);
const AVAILABLE_FIELDS = new Set(["displayName", "identity", "installationState"]);
const AVAILABLE_INSTALLATION_STATES = new Set(["not-installed", "active", "different", "damaged"]);

export type HarnessPackageHealth = "healthy" | "damaged";
export type HarnessAvailableInstallationState =
  | "not-installed"
  | "active"
  | "different"
  | "damaged";

export interface HarnessInstalledInventoryRow {
  readonly id: string;
  readonly displayName: string;
  readonly health: HarnessPackageHealth;
  /** Damaged store state cannot provide a receipt-verified installed identity. */
  readonly identity: HarnessPackageIdentity | null;
}

export interface HarnessAvailableInventoryRow {
  readonly displayName: string;
  readonly identity: HarnessPackageIdentity;
  readonly installationState: HarnessAvailableInstallationState;
}

export interface HarnessInventoryView {
  readonly schemaVersion: 1;
  readonly installed: readonly HarnessInstalledInventoryRow[];
  readonly available: readonly HarnessAvailableInventoryRow[];
}

export interface HarnessInventoryViewDependencies {
  readonly listHarnessPackageInventory: () => HarnessPackageInventory;
}

const PRODUCTION_INVENTORY_DEPENDENCIES: HarnessInventoryViewDependencies = Object.freeze({
  listHarnessPackageInventory,
});

function requireExactRecord(
  value: unknown,
  fields: ReadonlySet<string>,
  label: string,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must contain one object`);
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== fields.size || keys.some((key) => !fields.has(key))) {
    throw new Error(`${label} fields do not match schema version 1`);
  }
  return record;
}

function sanitizeDisplayName(value: string): string {
  const filtered = value
    .replace(TERMINAL_ESCAPE_PATTERN, "")
    .replace(UNSAFE_TEXT_PATTERN, " ")
    .replace(/\s+/gu, " ")
    .trim();
  const bounded = Array.from(filtered).slice(0, DISPLAY_NAME_MAX_LENGTH).join("");
  return bounded || "Unnamed harness";
}

function requireDisplayName(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Array.from(value).length > DISPLAY_NAME_MAX_LENGTH ||
    sanitizeDisplayName(value) !== value
  ) {
    throw new Error("Harness inventory displayName must be bounded text without terminal controls");
  }
  return value;
}

function exactIdentity(identity: HarnessPackageIdentity): HarnessPackageIdentity {
  return Object.freeze(parseHarnessPackageIdentity(identity));
}

function canonicalHarnessId(value: unknown): string {
  const id = parseHarnessPackageId(value);
  const aliasTarget = AGENT_ALIASES[id];
  if (aliasTarget !== undefined && aliasTarget !== id) {
    throw new Error("Harness inventory id must not use an agent alias");
  }
  return id;
}

function installedRow(record: InstalledHarnessPackageRecord): HarnessInstalledInventoryRow {
  const id = canonicalHarnessId(record.id);
  const displayName = sanitizeDisplayName(record.displayName);
  if (record.state === "damaged") {
    return Object.freeze({ id, displayName, health: "damaged", identity: null });
  }
  const identity = exactIdentity(record.identity);
  if (identity.id !== id) {
    throw new Error("Installed harness inventory identity does not match its catalogue id");
  }
  return Object.freeze({ id, displayName, health: "healthy", identity });
}

function availableInstallationState(
  installed: InstalledHarnessPackageRecord | undefined,
): HarnessAvailableInstallationState {
  if (installed === undefined) return "not-installed";
  if (installed.state === "damaged") return "damaged";
  return installed.matchesAvailableIdentity ? "active" : "different";
}

/** Read the catalogue once and project only stable, path-free inventory facts. */
export function createHarnessInventoryView(
  dependencies: HarnessInventoryViewDependencies = PRODUCTION_INVENTORY_DEPENDENCIES,
): HarnessInventoryView {
  const inventory = dependencies.listHarnessPackageInventory();
  const installedById = new Map<string, InstalledHarnessPackageRecord>();
  for (const record of inventory.installed) {
    const id = canonicalHarnessId(record.id);
    if (installedById.has(id))
      throw new Error("Harness inventory contains a duplicate installed id");
    installedById.set(id, record);
  }

  const availableIds = new Set<string>();
  const available = inventory.available
    .map((record): HarnessAvailableInventoryRow => {
      const identity = exactIdentity(record.identity);
      const id = canonicalHarnessId(record.id);
      if (identity.id !== id) {
        throw new Error("Available harness inventory identity does not match its catalogue id");
      }
      if (availableIds.has(id))
        throw new Error("Harness inventory contains a duplicate available id");
      availableIds.add(id);
      return Object.freeze({
        displayName: sanitizeDisplayName(record.displayName),
        identity,
        installationState: availableInstallationState(installedById.get(id)),
      });
    })
    .sort((left, right) => left.identity.id.localeCompare(right.identity.id));

  const installed = inventory.installed
    .map(installedRow)
    .sort((left, right) => left.id.localeCompare(right.id));
  if (installed.some(({ id }) => !availableIds.has(id))) {
    throw new Error("Installed harness inventory contains an unreviewed id");
  }

  return Object.freeze({
    schemaVersion: 1,
    installed: Object.freeze(installed),
    available: Object.freeze(available),
  });
}

function identityText(identity: HarnessPackageIdentity): string {
  return [
    `adapter ${identity.packageVersion}`,
    `contract ${identity.contractVersion}`,
    `digest ${identity.contentDigest.slice(0, 12)}…`,
  ].join(" | ");
}

function availableStateText(state: HarnessAvailableInstallationState): string {
  if (state === "active") return "exact bundled identity is active";
  if (state === "different") return "installed identity differs";
  if (state === "damaged") return "installed package is damaged";
  return "not installed";
}

/** Render the human inventory without exposing package or receipt paths. */
export function renderHarnessInventoryText(view: HarnessInventoryView): string {
  const installedRows = view.installed.map((row) =>
    row.identity === null
      ? `  ${row.id} | ${row.displayName} | damaged; installed identity could not be verified`
      : `  ${row.id} | ${row.displayName} | ${identityText(row.identity)} | health ${row.health}`,
  );
  const availableRows = view.available.map(
    (row) =>
      `  ${row.identity.id} | ${row.displayName} | ${identityText(row.identity)} | ${availableStateText(row.installationState)}`,
  );
  return [
    "Installed",
    ...(installedRows.length === 0 ? ["  No harnesses are installed."] : installedRows),
    "",
    "Available",
    ...(availableRows.length === 0
      ? ["  No reviewed harness packages are available."]
      : availableRows),
  ].join("\n");
}

/** Serialize the same closed inventory model used by the human renderer. */
export function renderHarnessInventoryJson(view: HarnessInventoryView): string {
  return `${JSON.stringify(view, null, 2)}\n`;
}

function parseInstalledRow(value: unknown): HarnessInstalledInventoryRow {
  const record = requireExactRecord(value, INSTALLED_FIELDS, "Harness installed inventory row");
  const id = canonicalHarnessId(record.id);
  const displayName = requireDisplayName(record.displayName);
  if (record.health === "damaged") {
    if (record.identity !== null) {
      throw new Error("Damaged harness inventory rows must not claim an installed identity");
    }
    return Object.freeze({ id, displayName, health: "damaged", identity: null });
  }
  if (record.health !== "healthy") throw new Error("Harness inventory health state is invalid");
  const identity = exactIdentity(record.identity as HarnessPackageIdentity);
  if (identity.id !== id) {
    throw new Error("Installed harness inventory identity does not match its row id");
  }
  return Object.freeze({ id, displayName, health: "healthy", identity });
}

function parseAvailableRow(value: unknown): HarnessAvailableInventoryRow {
  const record = requireExactRecord(value, AVAILABLE_FIELDS, "Harness available inventory row");
  if (!AVAILABLE_INSTALLATION_STATES.has(record.installationState as string)) {
    throw new Error("Harness available installation state is invalid");
  }
  return Object.freeze({
    displayName: requireDisplayName(record.displayName),
    identity: exactIdentity(record.identity as HarnessPackageIdentity),
    installationState: record.installationState as HarnessAvailableInstallationState,
  });
}

/** Parse machine output and reject every field outside schema version 1. */
export function parseHarnessInventoryJson(source: string): HarnessInventoryView {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw new Error("Harness inventory must contain valid JSON");
  }
  const record = requireExactRecord(value, TOP_LEVEL_FIELDS, "Harness inventory");
  if (record.schemaVersion !== 1) throw new Error("Harness inventory schemaVersion must be 1");
  if (!Array.isArray(record.installed) || !Array.isArray(record.available)) {
    throw new Error("Harness inventory installed and available fields must be arrays");
  }
  return Object.freeze({
    schemaVersion: 1,
    installed: Object.freeze(record.installed.map(parseInstalledRow)),
    available: Object.freeze(record.available.map(parseAvailableRow)),
  });
}
