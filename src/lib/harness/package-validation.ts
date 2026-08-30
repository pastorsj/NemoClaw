// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { buildAgentDefinition } from "../agent/definition-loader";
import { AGENT_ALIASES } from "../agent/aliases";
import type { AgentRuntimeKind } from "../agent/runtime-manifest";
import { parseHarnessPackageManifest } from "./package-manifest";
import {
  assertTreeAuthority,
  getPackageTreeAuthority,
  validateHarnessPackageTree,
} from "./package-tree";
import type { HarnessPackageIdentity } from "./package-types";

export interface HarnessPackageValidationReport {
  readonly schemaVersion: 1;
  readonly valid: true;
  readonly identity: HarnessPackageIdentity;
  readonly displayName: string;
  readonly manifest: string;
  readonly runtimeKind: AgentRuntimeKind;
  readonly entryCount: number;
  readonly totalBytes: number;
}

/** Validate one built agent runtime package without installing it or running package code. */
export function validateHarnessPackage(artifactDirectory: string): HarnessPackageValidationReport {
  const tree = validateHarnessPackageTree(artifactDirectory);
  const parsed = parseHarnessPackageManifest(tree.rootDir);
  const definition = buildAgentDefinition({
    manifest: parsed.manifest,
    manifestPath: parsed.manifestPath,
    packageRoot: parsed.packageRoot,
  });
  const identity: HarnessPackageIdentity = Object.freeze({
    kind: parsed.envelope.kind,
    id: parsed.envelope.id,
    packageVersion: parsed.envelope.packageVersion,
    contractVersion: parsed.envelope.contractVersion,
    contentDigest: tree.contentDigest,
  });

  const aliasTarget = AGENT_ALIASES[identity.id];
  if (
    (aliasTarget !== undefined && aliasTarget !== identity.id) ||
    definition.name !== identity.id ||
    definition.packageRoot !== tree.rootDir
  ) {
    throw new Error(
      "Agent runtime package definition does not match its validated package identity",
    );
  }

  const report = Object.freeze({
    schemaVersion: 1 as const,
    valid: true as const,
    identity,
    displayName: parsed.envelope.displayName,
    manifest: parsed.envelope.manifest,
    runtimeKind: definition.runtime?.kind ?? "gateway",
    entryCount: tree.entryCount,
    totalBytes: tree.totalBytes,
  });

  // This must remain the last package read. It rejects artifacts changed during validation.
  assertTreeAuthority(getPackageTreeAuthority(tree));
  return report;
}
