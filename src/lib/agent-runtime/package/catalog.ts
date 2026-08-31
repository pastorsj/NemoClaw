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

function assertPackageSelections(packages: readonly ReadAvailableHarnessPackage[]): void {
  try {
    createAgentAliasMap(
      packages.map(({ record }) => ({ name: record.id, aliases: record.aliases })),
    );
  } catch {
    throw new HarnessPackageCatalogIntegrityError("Bundled harness aliases conflict");
  }
  if (packages.filter(({ record }) => record.isDefaultOnboardingChoice).length > 1) {
    throw new HarnessPackageCatalogIntegrityError(
      "More than one bundled harness declares itself as the onboarding default",
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
    const expectedManifest = `packages/${expectedDirectory}/manifest.yaml`;
    if (
      entry.name !== expectedDirectory ||
      path.basename(available.packageRoot) !== expectedDirectory ||
      available.packageRoot !== path.join(bundledRoot, expectedDirectory) ||
      readPackage.manifestPath !== expectedManifest
    ) {
      throw new HarnessPackageCatalogIntegrityError(
        `Bundled harness '${available.id}' does not match the package contract`,
      );
    }
    packagesById.set(available.id, readPackage);
  }

  const readPackages = [...packagesById.values()];
  assertPackageSelections(readPackages);
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
  available: AvailableHarnessPackageRecord,
): HealthyInstalledHarnessPackageRecord {
  return Object.freeze({
    state: "installed",
    id: installed.identity.id,
    displayName: installed.packageManifest.envelope.displayName,
    description: manifestDescription(installed.packageManifest),
    aliases: available.aliases,
    aliasSummary: available.aliasSummary,
    isDefaultOnboardingChoice: available.isDefaultOnboardingChoice,
    defaultSandboxName: available.defaultSandboxName,
    identity: installed.identity,
    packageRoot: installed.packageRoot,
    matchesAvailableIdentity: identitiesMatch(installed.identity, available.identity),
  });
}

function damagedInstalledRecord(
  available: AvailableHarnessPackageRecord,
): DamagedInstalledHarnessPackageRecord {
  return Object.freeze({
    state: "damaged",
    id: available.id,
    displayName: available.displayName,
    description: available.description,
    aliases: available.aliases,
    aliasSummary: available.aliasSummary,
    isDefaultOnboardingChoice: available.isDefaultOnboardingChoice,
    defaultSandboxName: available.defaultSandboxName,
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
  for (const id of activeIds) {
    if (!availableById.has(id)) {
      throw new HarnessPackageCatalogIntegrityError(`Installed harness '${id}' is not reviewed`);
    }
  }

  const activeIdSet = new Set(activeIds);
  const installedRecords: InstalledHarnessPackageRecord[] = [];
  for (const availableRecord of available) {
    if (!activeIdSet.has(availableRecord.id)) continue;
    try {
      const installed = readInstalledHarnessPackage(
        availableRecord.id,
        storeRoot === undefined ? {} : { storeRoot },
      );
      installedRecords.push(
        installed === null
          ? damagedInstalledRecord(availableRecord)
          : healthyInstalledRecord(installed, availableRecord),
      );
    } catch {
      installedRecords.push(damagedInstalledRecord(availableRecord));
    }
  }
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

function resolveExactAvailableId(
  selector: string,
  available: readonly AvailableHarnessPackageRecord[],
): string | null {
  const availableIds = new Set(available.map(({ id }) => id));
  if (availableIds.has(selector)) return selector;
  const aliasTarget = createAgentAliasMap(
    available.map(({ id, aliases }) => ({ name: id, aliases })),
  )[selector];
  return aliasTarget !== undefined && availableIds.has(aliasTarget) ? aliasTarget : null;
}

/** Resolve only an exact reviewed ID or exact currently published alias for installation. */
export function resolveHarnessPackageInstallSelection(
  selector: string,
  options: HarnessPackageCatalogOptions = {},
): AvailableHarnessPackageRecord {
  const inventory = listHarnessPackageInventory(options);
  const availableById = new Map(inventory.available.map((record) => [record.id, record]));
  const selectedId = resolveExactAvailableId(selector, inventory.available);
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
