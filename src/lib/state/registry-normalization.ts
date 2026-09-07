// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  harnessPackageIdentitiesEqual,
  parseHarnessPackageIdentity,
  parseHarnessPackageMigration,
  type HarnessPackageIdentity,
  type HarnessPackageMigration,
} from "../agent-runtime/package/identity";
import { isObjectRecord } from "../core/json-types";
import { isDeferredN1xManagedVllmAcceptanceRoute } from "../domain/sandbox/n1x-managed-vllm-rebuild";
import { normalizePendingSandboxCreateIdentity } from "./registry/pending-create-identity";
import type { SandboxEntry } from "./registry/types";

export { normalizePendingSandboxCreateIdentity };
export { parseSandboxProviderBrokerOwnership } from "./registry/provider-broker";

const SHA256_DIGEST_PATTERN = /^[a-f0-9]{64}$/;

/** Validate the optional N1x preview receipt against the route that owns it. */
export function hasValidN1xPreviewAcceptance(entry: SandboxEntry): boolean {
  const value = entry.deferredN1xManagedVllmAccepted;
  return value === undefined || (value === true && isDeferredN1xManagedVllmAcceptanceRoute(entry));
}

const POLICY_SHADOW_FIELDS = [
  "baselineExclusions",
  "baselineExclusionTransition",
  "customPolicies",
  "policies",
  "policyAuthority",
  "policyCreationReceipt",
  "pendingPolicyVerification",
  "policyHash",
  "policyPresetsFinalized",
  "policyTier",
  "policyVersion",
  "observedPolicyAuthority",
] as const;

export interface NormalizedSandboxHarnessPackageAuthority {
  readonly harnessPackage?: HarnessPackageIdentity;
  readonly harnessPackageMigration?: HarnessPackageMigration;
}

/** Keep only one canonical digest for pending snapshot-clone source authority. */
export function normalizeSnapshotSourceRegistryFingerprint(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string" && SHA256_DIGEST_PATTERN.test(value)) return value;
  throw new Error(
    "Sandbox registry contains an invalid snapshot source fingerprint; repair the registry before continuing",
  );
}

/** Clone exact package authority while preserving legacy and candidate absence. */
export function normalizeSandboxHarnessPackageAuthority(
  entry: Pick<SandboxEntry, "harnessPackage" | "harnessPackageMigration">,
): NormalizedSandboxHarnessPackageAuthority {
  if (entry.harnessPackage === undefined && entry.harnessPackageMigration === undefined) return {};
  try {
    const harnessPackage = parseHarnessPackageIdentity(entry.harnessPackage);
    const harnessPackageMigration =
      entry.harnessPackageMigration === undefined
        ? undefined
        : parseHarnessPackageMigration(entry.harnessPackageMigration, harnessPackage);
    return {
      harnessPackage,
      ...(harnessPackageMigration ? { harnessPackageMigration } : {}),
    };
  } catch {
    throw new Error(
      "Sandbox registry contains invalid harness package authority; repair the registry before continuing",
    );
  }
}

/** Remove legacy policy shadow state without interpreting or replaying it. */
export function normalizeSandboxPolicyAttribution(entry: SandboxEntry): SandboxEntry {
  const packageAuthority = normalizeSandboxHarnessPackageAuthority(entry);
  const result = { ...entry, ...packageAuthority } as SandboxEntry & Record<string, unknown>;
  for (const field of POLICY_SHADOW_FIELDS) delete result[field];
  if (result.pendingCreateIdentity !== undefined) {
    const pendingCreateIdentity = normalizePendingSandboxCreateIdentity(
      result.pendingCreateIdentity,
    );
    const pendingHarnessPackage = pendingCreateIdentity?.harnessPackage;
    const ownerHarnessPackage = packageAuthority.harnessPackage;
    const pendingHarnessPackageMatchesOwner =
      pendingHarnessPackage === undefined && ownerHarnessPackage === undefined
        ? true
        : pendingHarnessPackage !== undefined && ownerHarnessPackage !== undefined
          ? harnessPackageIdentitiesEqual(pendingHarnessPackage, ownerHarnessPackage)
          : false;
    if (!pendingHarnessPackageMatchesOwner) {
      throw new Error(
        "Sandbox registry pending create identity does not match its harness package authority",
      );
    }
    result.pendingCreateIdentity = pendingCreateIdentity;
  }
  return result;
}

export function parseSandboxRegistryEntries(value: unknown): Array<[string, SandboxEntry]> {
  const sandboxes = isObjectRecord(value) ? value : {};
  return Object.entries(sandboxes).filter((entry): entry is [string, SandboxEntry] =>
    isSandboxEntryLike(entry[0], entry[1]),
  );
}

function isSandboxEntryLike(name: string, entry: unknown): entry is SandboxEntry {
  return (
    isObjectRecord(entry) &&
    typeof entry.name === "string" &&
    entry.name === name &&
    entry.name.trim().length > 0
  );
}

export function retainedDefaultSandbox(
  defaultSandbox: string | null,
  sandboxes: Record<string, SandboxEntry>,
): string | null {
  if (defaultSandbox === null) return null;
  if (!Object.prototype.hasOwnProperty.call(sandboxes, defaultSandbox)) return null;
  const entry = sandboxes[defaultSandbox];
  if (!entry || entry.pendingRouteReservation === true) return null;
  return defaultSandbox;
}
