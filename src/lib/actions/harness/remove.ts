// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { parseHarnessPackageId } from "../../agent-runtime/package/receipt";
import { deactivateHarnessPackage } from "../../agent-runtime/package/store";
import type { HarnessPackageIdentity } from "../../agent-runtime/package/types";

export interface InactiveHarnessPackageRemovalResult {
  readonly schemaVersion: 1;
  readonly state: "already-inactive";
  readonly id: string;
}

export interface DeactivatedHarnessPackageRemovalResult {
  readonly schemaVersion: 1;
  readonly state: "deactivated";
  readonly identity: HarnessPackageIdentity;
}

export type HarnessPackageRemovalResult =
  | InactiveHarnessPackageRemovalResult
  | DeactivatedHarnessPackageRemovalResult;

export interface RemoveHarnessPackageDependencies {
  readonly deactivateHarnessPackage: (
    id: string,
    options: {
      readonly storeRoot?: string;
      readonly expectedIdentity?: HarnessPackageIdentity;
    },
  ) => { readonly state: "deactivated"; readonly identity: HarnessPackageIdentity } | null;
}

const DEFAULT_DEPENDENCIES: RemoveHarnessPackageDependencies = Object.freeze({
  deactivateHarnessPackage,
});

/**
 * Deactivate a package for future selection. Immutable history is deliberately
 * retained, so existing sandboxes and explicit rollback keep exact authority.
 */
export function removeHarnessPackage(
  idValue: unknown,
  options: {
    readonly storeRoot?: string;
    readonly expectedIdentity?: HarnessPackageIdentity;
  } = {},
  dependencyOverrides: Partial<RemoveHarnessPackageDependencies> = {},
): HarnessPackageRemovalResult {
  const id = parseHarnessPackageId(idValue);
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...dependencyOverrides };
  const deactivated = dependencies.deactivateHarnessPackage(id, options);
  if (deactivated === null) {
    return Object.freeze({ schemaVersion: 1, state: "already-inactive", id });
  }
  return Object.freeze({
    schemaVersion: 1,
    state: "deactivated",
    identity: deactivated.identity,
  });
}
