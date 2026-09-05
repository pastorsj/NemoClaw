// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { parseHarnessPackageId } from "../../agent-runtime/package/receipt";
import {
  readInstalledHarnessPackage,
  type InstalledHarnessPackage,
} from "../../agent-runtime/package/store";
import type { HarnessPackageIdentity } from "../../agent-runtime/package/types";

export type HarnessPackageRemovalInspection = Readonly<
  | {
      status: "inactive";
      id: string;
    }
  | {
      status: "indeterminate";
      id: string;
      reason: "complete-owner-scan-unavailable";
      activeIdentity: HarnessPackageIdentity;
    }
>;

export interface InactiveHarnessPackageRemovalResult {
  readonly schemaVersion: 1;
  readonly state: "already-inactive";
  readonly id: string;
}

export class HarnessPackageRemovalBlockedError extends Error {
  override readonly name = "HarnessPackageRemovalBlockedError";
  readonly inspection: Extract<HarnessPackageRemovalInspection, { status: "indeterminate" }>;

  constructor(inspection: Extract<HarnessPackageRemovalInspection, { status: "indeterminate" }>) {
    super(
      `Cannot remove active harness package '${inspection.id}': NemoClaw cannot yet prove every durable owner is clear. The active pointer and immutable package history were left unchanged.`,
    );
    this.inspection = inspection;
  }
}

export interface RemoveHarnessPackageDependencies {
  readonly readInstalledHarnessPackage: (
    id: string,
    options: { readonly storeRoot?: string },
  ) => InstalledHarnessPackage | null;
}

const DEFAULT_DEPENDENCIES: RemoveHarnessPackageDependencies = Object.freeze({
  readInstalledHarnessPackage,
});

/**
 * Fail closed until every durable owner can be enumerated under one mutation
 * fence. An inactive package needs no store mutation and is safe to report.
 */
export function removeHarnessPackage(
  idValue: unknown,
  options: { readonly storeRoot?: string } = {},
  dependencyOverrides: Partial<RemoveHarnessPackageDependencies> = {},
): InactiveHarnessPackageRemovalResult {
  const id = parseHarnessPackageId(idValue);
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...dependencyOverrides };
  const installed = dependencies.readInstalledHarnessPackage(id, options);
  if (installed === null) {
    return Object.freeze({ schemaVersion: 1, state: "already-inactive", id });
  }
  throw new HarnessPackageRemovalBlockedError(
    Object.freeze({
      status: "indeterminate",
      id,
      reason: "complete-owner-scan-unavailable",
      activeIdentity: installed.identity,
    }),
  );
}
