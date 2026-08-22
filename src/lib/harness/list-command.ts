// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { type HarnessPackage, listHarnessPackages } from "./package-registry";

export type HarnessPackageListEntry = Pick<
  HarnessPackage,
  "id" | "packageName" | "version" | "source"
>;

export function renderHarnessPackageList(
  entries: readonly HarnessPackageListEntry[] = listHarnessPackages(),
): string {
  if (entries.length === 0) return "No harness packages are available.";

  const rows = entries.map((entry) => ({
    id: entry.id,
    package: `${entry.packageName}@${entry.version}`,
    source: entry.source,
  }));
  const idWidth = Math.max(...rows.map((row) => row.id.length));
  const packageWidth = Math.max(...rows.map((row) => row.package.length));

  return rows
    .map(
      (row) => `${row.id.padEnd(idWidth + 2)}${row.package.padEnd(packageWidth + 2)}${row.source}`,
    )
    .join("\n");
}

export function printHarnessPackageList(log: (message: string) => void = console.log): void {
  log(renderHarnessPackageList());
}
