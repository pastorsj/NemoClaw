// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { parseHarnessPackageManifest } from "./package-manifest";
import {
  parseBundledHarnessPackageSourceIdentity,
  type BundledHarnessPackageSourceIdentity,
} from "./package-receipt";
import {
  publishHarnessPackage,
  type HarnessPackageStoreDependencies,
  type InstalledHarnessPackage,
} from "./package-store";
import { validateHarnessPackageTree } from "./package-tree";
import type { HarnessPackageIdentity } from "./package-types";

export interface ReviewedHarnessPackageInstallSource {
  readonly packageRoot: string;
  readonly sourceIdentity: BundledHarnessPackageSourceIdentity;
}

export interface InstallHarnessPackageOptions {
  readonly storeRoot?: string;
  readonly dependencies?: HarnessPackageStoreDependencies;
}

/**
 * Install one reviewed data-only harness package without invoking package-owned code.
 * The package store owns staging, locking, publication, and cleanup.
 */
export function installHarnessPackage(
  source: ReviewedHarnessPackageInstallSource,
  options: InstallHarnessPackageOptions = {},
): InstalledHarnessPackage {
  const sourceIdentity = parseBundledHarnessPackageSourceIdentity(source.sourceIdentity);
  const parsedPackage = parseHarnessPackageManifest(source.packageRoot);
  const validatedTree = validateHarnessPackageTree(parsedPackage.packageRoot, {
    sourceTrust: "reviewed",
  });
  const expectedIdentity: HarnessPackageIdentity = Object.freeze({
    kind: parsedPackage.envelope.kind,
    id: parsedPackage.envelope.id,
    packageVersion: parsedPackage.envelope.packageVersion,
    contractVersion: parsedPackage.envelope.contractVersion,
    contentDigest: validatedTree.contentDigest,
  });
  return publishHarnessPackage({
    validatedTree,
    expectedIdentity,
    sourceIdentity,
    ...(options.storeRoot === undefined ? {} : { storeRoot: options.storeRoot }),
    ...(options.dependencies === undefined ? {} : { dependencies: options.dependencies }),
  });
}
