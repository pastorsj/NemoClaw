// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { createAgentAliasMap } from "../../agent/aliases";
import { REPOSITORY_ROOT } from "../../core/repository-root";
import { readString } from "../manifest-readers";
import { buildAgentDefinition } from "../manifest-loader";
import { parseHarnessPackageManifest, type ParsedHarnessPackageManifest } from "./manifest";
import {
  listActiveHarnessPackageIds,
  readInstalledHarnessPackage,
  type InstalledHarnessPackage,
} from "./store";
import {
  assertTreeAuthority,
  getPackageTreeAuthority,
  validateHarnessPackageTree,
  type ValidatedHarnessPackageTree,
} from "./tree";
import type { HarnessPackageIdentity } from "./types";

const BUNDLED_PACKAGE_DIRECTORY_PREFIX = "nemoclaw-";

export interface HarnessPackageCatalogOptions {
  readonly bundledRoot?: string;
  readonly storeRoot?: string;
}

export interface AvailableHarnessPackageRecord {
  readonly state: "available";
  readonly id: string;
  readonly displayName: string;
  readonly description: string | null;
  readonly aliases: readonly string[];
  readonly aliasSummary: string | null;
  readonly isDefaultOnboardingChoice: boolean;
  readonly defaultSandboxName: string;
  readonly identity: HarnessPackageIdentity;
  readonly packageRoot: string;
}

export interface HealthyInstalledHarnessPackageRecord {
  readonly state: "installed";
  readonly id: string;
  readonly displayName: string;
  readonly description: string | null;
  readonly aliases: readonly string[];
  readonly aliasSummary: string | null;
  readonly isDefaultOnboardingChoice: boolean;
  readonly defaultSandboxName: string;
  readonly identity: HarnessPackageIdentity;
  readonly packageRoot: string;
  readonly matchesAvailableIdentity: boolean;
}

export interface DamagedInstalledHarnessPackageRecord {
  readonly state: "damaged";
  readonly id: string;
  readonly displayName: string;
  readonly description: string | null;
  readonly aliases: readonly string[];
  readonly aliasSummary: string | null;
  readonly isDefaultOnboardingChoice: boolean;
  readonly defaultSandboxName: string;
  readonly reason: "installed-package-integrity-failed";
}

export type InstalledHarnessPackageRecord =
  | HealthyInstalledHarnessPackageRecord
  | DamagedInstalledHarnessPackageRecord;

export interface HarnessPackageInventory {
  readonly available: readonly AvailableHarnessPackageRecord[];
  readonly installed: readonly InstalledHarnessPackageRecord[];
}

/** Closed installer action derived from reviewed catalogue and receipt-backed store state. */
export type HarnessPackageInstallPlan =
  | {
      readonly kind: "install-reviewed";
      readonly packageRecord: AvailableHarnessPackageRecord;
    }
  | {
      readonly kind: "keep-installed";
      readonly packageRecord: HealthyInstalledHarnessPackageRecord;
    };

export class HarnessPackageCatalogIntegrityError extends Error {
  override readonly name = "HarnessPackageCatalogIntegrityError";

  constructor(message = "Harness package catalogue integrity validation failed") {
    super(message);
  }
}

export class HarnessPackageUnavailableError extends Error {
  override readonly name = "HarnessPackageUnavailableError";

  constructor() {
    super("Harness package is not available from this NemoClaw build");
  }
}

export class DamagedInstalledHarnessPackageError extends Error {
  override readonly name = "DamagedInstalledHarnessPackageError";

  constructor() {
    super("Installed harness package failed integrity validation");
  }
}

interface ReadAvailableHarnessPackage {
  readonly record: AvailableHarnessPackageRecord;
  readonly manifestPath: string;
  readonly tree: ValidatedHarnessPackageTree;
}

/** Resolve the bundled artifact directory carried beside the compiled CLI. */
export function getBundledHarnessPackageRoot(): string {
  return path.join(REPOSITORY_ROOT, "dist", "harnesses");
}

function packageIdentity(
  packageManifest: ParsedHarnessPackageManifest,
  contentDigest: string,
): HarnessPackageIdentity {
  return Object.freeze({
    kind: packageManifest.envelope.kind,
    id: packageManifest.envelope.id,
    packageVersion: packageManifest.envelope.packageVersion,
    contentDigest,
  });
}

function manifestDescription(packageManifest: ParsedHarnessPackageManifest): string | null {
  return readString(packageManifest.manifest, "description") ?? null;
}

function identitiesMatch(left: HarnessPackageIdentity, right: HarnessPackageIdentity): boolean {
  return (
    left.kind === right.kind &&
    left.id === right.id &&
    left.packageVersion === right.packageVersion &&
    left.contentDigest === right.contentDigest
  );
}

interface HarnessPackageSelectionMetadata {
  readonly record: Pick<
    AvailableHarnessPackageRecord,
    "id" | "aliases" | "isDefaultOnboardingChoice"
  >;
}

function assertPackageSelections(
  packages: readonly HarnessPackageSelectionMetadata[],
  sourceLabel: "Bundled" | "Installed",
): void {
  try {
    createAgentAliasMap(
      packages.map(({ record }) => ({ name: record.id, aliases: record.aliases })),
    );
  } catch {
    throw new HarnessPackageCatalogIntegrityError(`${sourceLabel} harness aliases conflict`);
  }
  if (packages.filter(({ record }) => record.isDefaultOnboardingChoice).length > 1) {
    throw new HarnessPackageCatalogIntegrityError(
      `More than one ${sourceLabel.toLowerCase()} harness declares itself as the onboarding default`,
    );
  }
}

function assertPackageRoot(root: string): readonly fs.Dirent[] {
  let metadata: fs.Stats;
  try {
    metadata = fs.lstatSync(root);
  } catch {
    throw new HarnessPackageCatalogIntegrityError("Bundled harness package root is unavailable");
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new HarnessPackageCatalogIntegrityError("Bundled harness package root is invalid");
  }
  try {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  } catch {
    throw new HarnessPackageCatalogIntegrityError("Bundled harness package root is unreadable");
  }
}

function readAvailablePackage(packageRoot: string): ReadAvailableHarnessPackage {
  try {
    const tree = validateHarnessPackageTree(packageRoot, { sourceTrust: "reviewed" });
    const packageManifest = parseHarnessPackageManifest(packageRoot);
    const definition = buildAgentDefinition({
      manifest: packageManifest.manifest,
      manifestPath: packageManifest.manifestPath,
      packageRoot: packageManifest.packageRoot,
    });
    assertTreeAuthority(getPackageTreeAuthority(tree));
    return Object.freeze({
      record: Object.freeze({
        state: "available",
        id: packageManifest.envelope.id,
        displayName: packageManifest.envelope.displayName,
        description: manifestDescription(packageManifest),
        aliases: definition.agentAliases,
        aliasSummary: definition.agentAliasSummary,
        isDefaultOnboardingChoice: definition.isDefaultOnboardingChoice,
        defaultSandboxName: definition.defaultSandboxName,
        identity: packageIdentity(packageManifest, tree.contentDigest),
        packageRoot: packageManifest.packageRoot,
      }),
      manifestPath: packageManifest.envelope.manifest,
      tree,
    });
  } catch {
    throw new HarnessPackageCatalogIntegrityError("Bundled harness package is invalid");
  }
}

function listAvailableHarnessPackages(
  bundledRoot: string,
): readonly AvailableHarnessPackageRecord[] {
  const packagesById = new Map<string, ReadAvailableHarnessPackage>();
  for (const entry of assertPackageRoot(bundledRoot)) {
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new HarnessPackageCatalogIntegrityError(
        "Bundled harness package root contains an unexpected entry",
      );
    }
    const readPackage = readAvailablePackage(path.join(bundledRoot, entry.name));
    const available = readPackage.record;
    if (packagesById.has(available.id)) {
      throw new HarnessPackageCatalogIntegrityError(
        `Bundled harness id '${available.id}' is duplicated`,
      );
    }
    const expectedDirectory = `${BUNDLED_PACKAGE_DIRECTORY_PREFIX}${available.id}`;
    if (
      entry.name !== expectedDirectory ||
      path.basename(available.packageRoot) !== expectedDirectory ||
      available.packageRoot !== path.join(bundledRoot, expectedDirectory) ||
      readPackage.manifestPath !== "manifest.yaml"
    ) {
      throw new HarnessPackageCatalogIntegrityError(
        `Bundled harness '${available.id}' does not match the package contract`,
      );
    }
    packagesById.set(available.id, readPackage);
  }

  const readPackages = [...packagesById.values()];
  assertPackageSelections(readPackages, "Bundled");
  const available = readPackages
    .sort((left, right) => left.record.id.localeCompare(right.record.id))
    .map(({ record }) => record);
  try {
    for (const readPackage of packagesById.values()) {
      assertTreeAuthority(getPackageTreeAuthority(readPackage.tree));
    }
  } catch {
    throw new HarnessPackageCatalogIntegrityError(
      "Bundled harness package changed while reading the catalogue",
    );
  }
  return Object.freeze(available);
}

function healthyInstalledRecord(
  installed: InstalledHarnessPackage,
  available: AvailableHarnessPackageRecord | undefined,
): HealthyInstalledHarnessPackageRecord {
  const definition = buildAgentDefinition({
    manifest: installed.packageManifest.manifest,
    manifestPath: installed.packageManifest.manifestPath,
    packageRoot: installed.packageRoot,
  });
  if (definition.name !== installed.identity.id) {
    throw new HarnessPackageCatalogIntegrityError(
      "Installed harness package definition does not match its receipt",
    );
  }
  return Object.freeze({
    state: "installed",
    id: installed.identity.id,
    displayName: installed.packageManifest.envelope.displayName,
    description: manifestDescription(installed.packageManifest),
    aliases: definition.agentAliases,
    aliasSummary: definition.agentAliasSummary,
    isDefaultOnboardingChoice: definition.isDefaultOnboardingChoice,
    defaultSandboxName: definition.defaultSandboxName,
    identity: installed.identity,
    packageRoot: installed.packageRoot,
    matchesAvailableIdentity:
      available !== undefined && identitiesMatch(installed.identity, available.identity),
  });
}

function damagedInstalledRecord(
  id: string,
  available: AvailableHarnessPackageRecord | undefined,
): DamagedInstalledHarnessPackageRecord {
  return Object.freeze({
    state: "damaged",
    id,
    displayName: available?.displayName ?? id,
    description: available?.description ?? null,
    aliases: available?.aliases ?? Object.freeze([]),
    aliasSummary: available?.aliasSummary ?? null,
    isDefaultOnboardingChoice: available?.isDefaultOnboardingChoice ?? false,
    defaultSandboxName: available?.defaultSandboxName ?? id,
    reason: "installed-package-integrity-failed",
  });
}

function listInstalledHarnessPackages(
  available: readonly AvailableHarnessPackageRecord[],
  storeRoot: string | undefined,
): readonly InstalledHarnessPackageRecord[] {
  let activeIds: readonly string[];
  try {
    activeIds = listActiveHarnessPackageIds(storeRoot === undefined ? {} : { storeRoot });
  } catch {
    throw new HarnessPackageCatalogIntegrityError("Installed harness package index is invalid");
  }

  const availableById = new Map(available.map((record) => [record.id, record]));
  const installedRecords: InstalledHarnessPackageRecord[] = [];
  for (const id of activeIds) {
    const availableRecord = availableById.get(id);
    try {
      const installed = readInstalledHarnessPackage(
        id,
        storeRoot === undefined ? {} : { storeRoot },
      );
      installedRecords.push(
        installed === null
          ? damagedInstalledRecord(id, availableRecord)
          : healthyInstalledRecord(installed, availableRecord),
      );
    } catch {
      installedRecords.push(damagedInstalledRecord(id, availableRecord));
    }
  }
  assertPackageSelections(
    installedRecords
      .filter(
        (record): record is HealthyInstalledHarnessPackageRecord => record.state === "installed",
      )
      .map((record) => ({ record })),
    "Installed",
  );
  return Object.freeze(installedRecords);
}

/** Read the reviewed bundle and verified local store without mutating either one. */
export function listHarnessPackageInventory(
  options: HarnessPackageCatalogOptions = {},
): HarnessPackageInventory {
  const bundledRoot = path.resolve(options.bundledRoot ?? getBundledHarnessPackageRoot());
  const available = listAvailableHarnessPackages(bundledRoot);
  const installed = listInstalledHarnessPackages(available, options.storeRoot);
  return Object.freeze({ available, installed });
}

function resolveExactPackageId(
  selector: string,
  available: readonly Pick<AvailableHarnessPackageRecord, "id" | "aliases">[],
): string | null {
  const availableIds = new Set(available.map(({ id }) => id));
  if (availableIds.has(selector)) return selector;
  const aliasTarget = createAgentAliasMap(
    available.map(({ id, aliases }) => ({ name: id, aliases })),
  )[selector];
  return aliasTarget !== undefined && availableIds.has(aliasTarget) ? aliasTarget : null;
}

function installPlanTargets(inventory: HarnessPackageInventory): readonly {
  readonly name: string;
  readonly aliases: readonly string[];
}[] {
  const targets = new Map(
    inventory.available.map(({ id, aliases }) => [id, { name: id, aliases }] as const),
  );
  for (const installed of inventory.installed) {
    // A reviewed package owns the current aliases for an upgrade. An installed-only
    // package owns its aliases through the manifest pinned by its verified receipt.
    if (!targets.has(installed.id)) {
      targets.set(installed.id, {
        name: installed.id,
        aliases: installed.state === "installed" ? installed.aliases : Object.freeze([]),
      });
    }
  }
  return Object.freeze([...targets.values()]);
}

/**
 * Plan an explicit harness install without treating an already active external
 * package as though it must exist in NemoClaw's reviewed bundle.
 */
export function planHarnessPackageInstall(
  selector: string,
  options: HarnessPackageCatalogOptions = {},
): HarnessPackageInstallPlan {
  const inventory = listHarnessPackageInventory(options);
  const targets = installPlanTargets(inventory);
  const selectedId = resolveExactPackageId(
    selector,
    targets.map(({ name, aliases }) => ({ id: name, aliases })),
  );
  if (selectedId === null) throw new HarnessPackageUnavailableError();

  const installed = inventory.installed.find(({ id }) => id === selectedId);
  if (installed?.state === "damaged") throw new DamagedInstalledHarnessPackageError();

  const available = inventory.available.find(({ id }) => id === selectedId);
  if (available) return Object.freeze({ kind: "install-reviewed", packageRecord: available });
  if (installed?.state === "installed") {
    return Object.freeze({ kind: "keep-installed", packageRecord: installed });
  }

  // The selector was built from exactly these two inventories. Reaching this
  // branch means their immutable snapshot was internally inconsistent.
  throw new HarnessPackageCatalogIntegrityError(
    "Harness package disappeared from the install plan",
  );
}

/** Resolve only an exact reviewed ID or exact currently published alias for installation. */
export function resolveHarnessPackageInstallSelection(
  selector: string,
  options: HarnessPackageCatalogOptions = {},
): AvailableHarnessPackageRecord {
  const inventory = listHarnessPackageInventory(options);
  const availableById = new Map(inventory.available.map((record) => [record.id, record]));
  const selectedId = resolveExactPackageId(selector, inventory.available);
  if (selectedId === null) throw new HarnessPackageUnavailableError();
  if (
    inventory.installed.some((record) => record.id === selectedId && record.state === "damaged")
  ) {
    throw new DamagedInstalledHarnessPackageError();
  }
  const selected = availableById.get(selectedId);
  if (!selected) throw new HarnessPackageUnavailableError();
  return selected;
}
