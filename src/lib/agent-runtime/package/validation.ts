// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";
import { buildAgentDefinition } from "../manifest-loader";
import type { ManifestRecord, ManifestValue } from "../manifest-types";
import type { AgentRuntimeKind } from "../runtime/manifest";
import { parseHarnessPackageManifest } from "./manifest";
import {
  assertTreeAuthority,
  getPackageTreeAuthority,
  validateHarnessPackageTree,
  type ValidatedHarnessPackageTree,
} from "./tree";
import type { HarnessPackageIdentity } from "./types";

const ALWAYS_REQUIRED_PACKAGE_ARTIFACTS = Object.freeze([
  "host/config-adapter.cts",
  "host/messaging-adapter.cts",
  "host/startup-adapter.cts",
]);

function isManifestRecord(value: ManifestValue | undefined): value is ManifestRecord {
  return (
    value !== null && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date)
  );
}

function manifestCapabilitySupport(value: ManifestValue | undefined): ManifestValue | undefined {
  return isManifestRecord(value) ? value.support : undefined;
}

function usesPackageConfigRestore(manifest: ManifestRecord): boolean {
  return (
    Array.isArray(manifest.state_files) &&
    manifest.state_files.some(
      (stateFile) =>
        isManifestRecord(stateFile) &&
        isManifestRecord(stateFile.restore) &&
        stateFile.restore.merge === "package-config",
    )
  );
}

/** List the fixed runtime artifacts required by one already-validated manifest. */
export function listRequiredHarnessPackageArtifacts(manifest: ManifestRecord): readonly string[] {
  const required = [...ALWAYS_REQUIRED_PACKAGE_ARTIFACTS];
  if (manifestCapabilitySupport(manifest.mcp) === "bridge") {
    required.push("host/mcp-adapter.cts");
  }
  if (manifestCapabilitySupport(manifest.agent_roster) === "managed") {
    required.push("host/agent-roster-adapter.cts");
  }
  if (isManifestRecord(manifest.sessions)) {
    required.push("host/session-adapter.cts");
  }
  if (manifestCapabilitySupport(manifest.provider_auth) === "managed") {
    required.push("host/provider-auth-adapter.cts");
  }
  if (manifestCapabilitySupport(manifest.provider_broker) === "managed") {
    required.push("host/provider-broker-adapter.cts", "host/provider-broker-control.cts");
  }
  if (usesPackageConfigRestore(manifest)) {
    required.push("host/restore-adapter.cts");
  }
  return Object.freeze(required);
}

/** Reject an incomplete built artifact without reading or executing package-owned code. */
export function assertRequiredHarnessPackageArtifacts(
  tree: ValidatedHarnessPackageTree,
  manifestPath: string,
  manifest: ManifestRecord,
): void {
  const authority = getPackageTreeAuthority(tree);
  assertTreeAuthority(authority);
  const entries = new Map(tree.entries.map((entry) => [entry.relativePath, entry]));
  const manifestDirectory = path.posix.dirname(manifestPath);
  for (const relativePath of listRequiredHarnessPackageArtifacts(manifest)) {
    const artifactPath =
      manifestDirectory === "." ? relativePath : path.posix.join(manifestDirectory, relativePath);
    const entry = entries.get(artifactPath);
    if (entry?.type !== "file" || entry.size === 0) {
      throw new Error(
        `Harness package requires a non-empty regular artifact '${relativePath}' for its declared capabilities`,
      );
    }
  }
  assertTreeAuthority(authority);
}

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
  assertRequiredHarnessPackageArtifacts(tree, parsed.envelope.manifest, parsed.manifest);
  const definition = buildAgentDefinition({
    manifest: parsed.manifest,
    manifestPath: parsed.manifestPath,
    packageRoot: parsed.packageRoot,
  });
  const identity: HarnessPackageIdentity = Object.freeze({
    kind: parsed.envelope.kind,
    id: parsed.envelope.id,
    packageVersion: parsed.envelope.packageVersion,
    contentDigest: tree.contentDigest,
  });

  if (definition.name !== identity.id || definition.packageRoot !== tree.rootDir) {
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
