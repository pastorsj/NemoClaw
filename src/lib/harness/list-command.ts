// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  type HarnessPackage,
  listBundledHarnessPackages,
  listInstalledHarnessPackages,
} from "./package-registry";

export type HarnessPackageListEntry = Pick<
  HarnessPackage,
  "id" | "packageName" | "version" | "source"
>;

export interface HarnessPackageList {
  readonly installed: readonly HarnessPackageListEntry[];
  readonly available: readonly HarnessPackageListEntry[];
}

function toListEntry(harnessPackage: HarnessPackage): HarnessPackageListEntry {
  const { id, packageName, version, source } = harnessPackage;
  return { id, packageName, version, source };
}

function sortByHarnessId(entries: readonly HarnessPackageListEntry[]): HarnessPackageListEntry[] {
  return [...entries].sort((left, right) => left.id.localeCompare(right.id));
}

/** Separate installed packages from bundled packages that can still be installed. */
export function buildHarnessPackageList(
  installedPackages: readonly HarnessPackage[] = listInstalledHarnessPackages(),
  bundledPackages: readonly HarnessPackage[] = listBundledHarnessPackages(),
): HarnessPackageList {
  const installed = sortByHarnessId(installedPackages.map(toListEntry));
  const installedIds = new Set(installed.map((entry) => entry.id));
  const available = sortByHarnessId(
    bundledPackages
      .filter((harnessPackage) => !installedIds.has(harnessPackage.id))
      .map(toListEntry),
  );
  return { installed, available };
}

function renderPackageRows(
  entries: readonly HarnessPackageListEntry[],
  idWidth: number,
  packageWidth: number,
): string[] {
  return entries.map((entry) => {
    const packageIdentity = `${entry.packageName}@${entry.version}`;
    return `  ${entry.id.padEnd(idWidth + 2)}${packageIdentity.padEnd(packageWidth + 2)}${entry.source}`;
  });
}

export function renderHarnessPackageList(
  packageList: HarnessPackageList = buildHarnessPackageList(),
): string {
  const entries = [...packageList.installed, ...packageList.available];
  const idWidth = Math.max(0, ...entries.map((entry) => entry.id.length));
  const packageWidth = Math.max(
    0,
    ...entries.map((entry) => `${entry.packageName}@${entry.version}`.length),
  );
  return [
    "Installed agent runtime packages:",
    ...(packageList.installed.length === 0
      ? ["  No agent runtime packages are installed."]
      : renderPackageRows(packageList.installed, idWidth, packageWidth)),
    "",
    "Available agent runtime packages:",
    ...(packageList.available.length === 0
      ? ["  No bundled agent runtime packages are available to install."]
      : renderPackageRows(packageList.available, idWidth, packageWidth)),
  ].join("\n");
}

export function printHarnessPackageList(
  log: (message: string) => void = console.log,
  packageList: HarnessPackageList = buildHarnessPackageList(),
): void {
  log(renderHarnessPackageList(packageList));
}
