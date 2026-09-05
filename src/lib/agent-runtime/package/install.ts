// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { buildAgentDefinition } from "../manifest-loader";
import { parseHarnessPackageManifest } from "./manifest";
import {
  parseHarnessPackageId,
  parseHarnessPackageSourceIdentity,
  type BundledHarnessPackageSourceIdentity,
  type LocalHarnessPackageSourceIdentity,
} from "./receipt";
import {
  publishHarnessPackage,
  type HarnessPackageStoreDependencies,
  type InstalledHarnessPackage,
} from "./store";
import { validateHarnessPackageTree } from "./tree";
import type { HarnessPackageIdentity } from "./types";

export interface ReviewedHarnessPackageInstallSource {
  readonly packageRoot: string;
  readonly sourceIdentity: BundledHarnessPackageSourceIdentity;
  readonly expectedId?: string;
}

export interface LocalHarnessPackageInstallSource {
  readonly packageRoot: string;
  readonly sourceIdentity: LocalHarnessPackageSourceIdentity;
  readonly expectedId: string;
}

export type HarnessPackageInstallSource =
  | ReviewedHarnessPackageInstallSource
  | LocalHarnessPackageInstallSource;

export interface InstallHarnessPackageOptions {
  readonly storeRoot?: string;
  readonly dependencies?: HarnessPackageStoreDependencies;
}

/**
 * Install one validated data-only harness package without invoking package-owned code.
 * The package store owns staging, locking, publication, and cleanup.
 */
export function installHarnessPackage(
  source: HarnessPackageInstallSource,
  options: InstallHarnessPackageOptions = {},
): InstalledHarnessPackage {
  const sourceIdentity = parseHarnessPackageSourceIdentity(source.sourceIdentity);
  if (sourceIdentity.kind === "local" && source.expectedId === undefined) {
    throw new Error("Local harness package installation requires an expected package id");
  }
  const expectedId =
    source.expectedId === undefined ? undefined : parseHarnessPackageId(source.expectedId);
  const parsedPackage = parseHarnessPackageManifest(source.packageRoot);
  if (expectedId !== undefined && parsedPackage.envelope.id !== expectedId) {
    throw new Error("Harness package id does not match the requested installation id");
  }
  const validatedTree = validateHarnessPackageTree(parsedPackage.packageRoot, {
    sourceTrust: sourceIdentity.kind === "bundled" ? "reviewed" : "mutable",
  });
  const definition = buildAgentDefinition({
    manifest: parsedPackage.manifest,
    manifestPath: parsedPackage.manifestPath,
    packageRoot: parsedPackage.packageRoot,
  });
  if (definition.name !== parsedPackage.envelope.id) {
    throw new Error("Harness package definition does not match its package identity");
  }
  const expectedIdentity: HarnessPackageIdentity = Object.freeze({
    kind: parsedPackage.envelope.kind,
    id: parsedPackage.envelope.id,
    packageVersion: parsedPackage.envelope.packageVersion,
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
