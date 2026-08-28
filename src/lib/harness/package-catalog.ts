// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { AGENT_ALIASES } from "../agent/aliases";
import { readString } from "../agent/manifest-readers";
import { isCandidateAgent } from "../agent/candidate";
import { listBundledHarnessSources } from "./bundled-source";
import { parseHarnessPackageManifest, type ParsedHarnessPackageManifest } from "./package-manifest";
import {
  listActiveHarnessPackageIds,
  readInstalledHarnessPackage,
  type InstalledHarnessPackage,
} from "./package-store";
import {
  assertTreeAuthority,
  getPackageTreeAuthority,
  validateHarnessPackageTree,
  type ValidatedHarnessPackageTree,
} from "./package-tree";
import type { HarnessPackageIdentity } from "./package-types";

const NEMOCUA_CANDIDATE_ID = "nemocua";
const BUNDLED_PACKAGE_DIRECTORY_PREFIX = "nemoclaw-";
const ACCEPTED_BUNDLED_HARNESS_IDS = Object.freeze([
  "openclaw",
  "hermes",
  "langchain-deepagents-code",
] as const);

export interface HarnessPackageCatalogOptions {
  readonly bundledRoot?: string;
  readonly storeRoot?: string;
}

export interface AvailableHarnessPackageRecord {
  readonly state: "available";
  readonly id: string;
  readonly displayName: string;
  readonly description: string | null;
  readonly identity: HarnessPackageIdentity;
  readonly packageRoot: string;
}

export interface HealthyInstalledHarnessPackageRecord {
  readonly state: "installed";
  readonly id: string;
  readonly displayName: string;
  readonly description: string | null;
  readonly identity: HarnessPackageIdentity;
  readonly packageRoot: string;
  readonly matchesAvailableIdentity: boolean;
}

export interface DamagedInstalledHarnessPackageRecord {
  readonly state: "damaged";
  readonly id: string;
  readonly displayName: string;
  readonly description: string | null;
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
  return path.resolve(__dirname, "..", "..", "harnesses");
}

function packageIdentity(
  packageManifest: ParsedHarnessPackageManifest,
  contentDigest: string,
): HarnessPackageIdentity {
  return Object.freeze({
    kind: packageManifest.envelope.kind,
    id: packageManifest.envelope.id,
    packageVersion: packageManifest.envelope.packageVersion,
    contractVersion: packageManifest.envelope.contractVersion,
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
    left.contractVersion === right.contractVersion &&
    left.contentDigest === right.contentDigest
  );
}

function isCandidatePackageId(id: string): boolean {
  return isCandidateAgent(id) || id === NEMOCUA_CANDIDATE_ID;
}

function explicitAliasTarget(alias: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(AGENT_ALIASES, alias)
    ? AGENT_ALIASES[alias]
    : undefined;
}

function assertAliasAuthority(acceptedIds: ReadonlySet<string>): void {
  for (const [alias, target] of Object.entries(AGENT_ALIASES).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  )) {
    if (!acceptedIds.has(target)) {
      throw new HarnessPackageCatalogIntegrityError(
        `Public harness alias '${alias}' targets an unreviewed package`,
      );
    }
    if (acceptedIds.has(alias) && alias !== target) {
      throw new HarnessPackageCatalogIntegrityError(
        `Public harness alias '${alias}' conflicts with an accepted package id`,
      );
    }
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
    assertTreeAuthority(getPackageTreeAuthority(tree));
    return Object.freeze({
      record: Object.freeze({
        state: "available",
        id: packageManifest.envelope.id,
        displayName: packageManifest.envelope.displayName,
        description: manifestDescription(packageManifest),
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
  const declarations = listBundledHarnessSources();
  const acceptedIds: ReadonlySet<string> = new Set(declarations.map(({ id }) => id));
  if (
    declarations.length !== ACCEPTED_BUNDLED_HARNESS_IDS.length ||
    declarations.length !== acceptedIds.size ||
    declarations.some(({ id }, index) => id !== ACCEPTED_BUNDLED_HARNESS_IDS[index])
  ) {
    throw new HarnessPackageCatalogIntegrityError("Reviewed harness declarations are invalid");
  }
  assertAliasAuthority(acceptedIds);

  const packagesById = new Map<string, ReadAvailableHarnessPackage>();
  for (const entry of assertPackageRoot(bundledRoot)) {
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new HarnessPackageCatalogIntegrityError(
        "Bundled harness package root contains an unexpected entry",
      );
    }
    const readPackage = readAvailablePackage(path.join(bundledRoot, entry.name));
    const available = readPackage.record;
    if (isCandidatePackageId(available.id)) {
      throw new HarnessPackageCatalogIntegrityError(
        `Candidate harness '${available.id}' leaked into the bundled catalogue`,
      );
    }
    const aliasTarget = explicitAliasTarget(available.id);
    if (aliasTarget !== undefined && aliasTarget !== available.id) {
      throw new HarnessPackageCatalogIntegrityError(
        `Bundled harness id '${available.id}' conflicts with a public alias`,
      );
    }
    if (packagesById.has(available.id)) {
      throw new HarnessPackageCatalogIntegrityError(
        `Bundled harness id '${available.id}' is duplicated`,
      );
    }
    if (!acceptedIds.has(available.id)) {
      throw new HarnessPackageCatalogIntegrityError(
        `Bundled harness '${available.id}' is not reviewed`,
      );
    }
    packagesById.set(available.id, readPackage);
  }

  const available = declarations.map((declaration) => {
    const readPackage = packagesById.get(declaration.id);
    if (!readPackage) {
      throw new HarnessPackageCatalogIntegrityError(
        `Reviewed harness '${declaration.id}' is missing from the bundle`,
      );
    }
    const record = readPackage.record;
    const expectedDirectory = `${BUNDLED_PACKAGE_DIRECTORY_PREFIX}${declaration.id}`;
    if (
      path.basename(record.packageRoot) !== expectedDirectory ||
      record.displayName !== declaration.displayName ||
      record.identity.packageVersion !== declaration.packageVersion ||
      record.packageRoot !== path.join(bundledRoot, expectedDirectory) ||
      readPackage.manifestPath !== declaration.manifestPath
    ) {
      throw new HarnessPackageCatalogIntegrityError(
        `Reviewed harness '${declaration.id}' does not match its bundled declaration`,
      );
    }
    return record;
  });
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
    if (isCandidatePackageId(id)) {
      throw new HarnessPackageCatalogIntegrityError(
        `Candidate harness '${id}' leaked into the installed catalogue`,
      );
    }
    const aliasTarget = explicitAliasTarget(id);
    if (aliasTarget !== undefined && aliasTarget !== id) {
      throw new HarnessPackageCatalogIntegrityError(
        `Installed harness id '${id}' conflicts with a public alias`,
      );
    }
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
  availableIds: ReadonlySet<string>,
): string | null {
  if (availableIds.has(selector)) return selector;
  const aliasTarget = explicitAliasTarget(selector);
  return aliasTarget !== undefined && availableIds.has(aliasTarget) ? aliasTarget : null;
}

/** Resolve only an exact reviewed ID or exact currently published alias for installation. */
export function resolveHarnessPackageInstallSelection(
  selector: string,
  options: HarnessPackageCatalogOptions = {},
): AvailableHarnessPackageRecord {
  const inventory = listHarnessPackageInventory(options);
  const availableById = new Map(inventory.available.map((record) => [record.id, record]));
  const selectedId = resolveExactAvailableId(selector, new Set(availableById.keys()));
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
