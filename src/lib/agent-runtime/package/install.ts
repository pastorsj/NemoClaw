// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { getBuildIdentity, type BuildIdentity } from "../../core/build-identity";
import { qualifyHarnessPackageAdapterInitialization } from "../adapter/qualification";
import { buildAgentDefinition } from "../manifest-loader";
import { assertHarnessPackageSupportsNemoClaw } from "./compatibility";
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
import { assertTreeAuthority, getPackageTreeAuthority, validateHarnessPackageTree } from "./tree";
import type { HarnessPackageIdentity } from "./types";
import { assertRequiredHarnessPackageArtifacts } from "./validation";

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
  readonly getBuildIdentity?: () => BuildIdentity;
}

/**
 * Install one validated harness package and initialize its fixed adapters in the bounded VM.
 * Adapter operations are not invoked. The package store owns staging, locking, publication,
 * activation, and cleanup.
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
  const runningBuildIdentity =
    options.getBuildIdentity?.() ??
    (sourceIdentity.kind === "bundled" ? sourceIdentity.nemoclawBuildIdentity : getBuildIdentity());
  const validatedTree = validateHarnessPackageTree(source.packageRoot, {
    sourceTrust: sourceIdentity.kind === "bundled" ? "reviewed" : "mutable",
  });
  assertTreeAuthority(getPackageTreeAuthority(validatedTree));
  const parsedPackage = parseHarnessPackageManifest(validatedTree.rootDir);
  assertRequiredHarnessPackageArtifacts(
    validatedTree,
    parsedPackage.envelope.manifest,
    parsedPackage.manifest,
  );
  assertHarnessPackageSupportsNemoClaw(parsedPackage.envelope, runningBuildIdentity);
  if (expectedId !== undefined && parsedPackage.envelope.id !== expectedId) {
    throw new Error("Harness package id does not match the requested installation id");
  }
  const definition = buildAgentDefinition({
    manifest: parsedPackage.manifest,
    manifestPath: parsedPackage.manifestPath,
    packageRoot: parsedPackage.packageRoot,
  });
  if (definition.name !== parsedPackage.envelope.id) {
    throw new Error("Harness package definition does not match its package identity");
  }
  assertTreeAuthority(getPackageTreeAuthority(validatedTree));
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
    qualifyAdapterInitialization: (installed) =>
      qualifyHarnessPackageAdapterInitialization(
        installed.identity,
        installed.packageManifest.manifest,
        {
          ...(options.storeRoot === undefined ? {} : { storeRoot: options.storeRoot }),
          getBuildIdentity: () => runningBuildIdentity,
        },
      ),
    ...(options.storeRoot === undefined ? {} : { storeRoot: options.storeRoot }),
    ...(options.dependencies === undefined ? {} : { dependencies: options.dependencies }),
    getBuildIdentity: () => runningBuildIdentity,
  });
}
