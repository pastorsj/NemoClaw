// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isDeepStrictEqual } from "node:util";

import { isCandidateAgent } from "../../../agent/candidate";
import {
  harnessPackageIdentitiesEqual,
  inspectHarnessPackageState,
  type HarnessPackageIdentity,
  type HarnessPackageMigration,
} from "../../../harness/package-identity";
import {
  normalizeSandboxAgentName,
  resolveSandboxAgent,
  type ResolvedSandboxAgent,
} from "../../../onboard/sandbox-agent";
import {
  hasInvalidSessionHarnessPackage,
  loadSession,
  type Session,
} from "../../../state/onboard-session";
import type { SandboxEntry } from "../../../state/registry";

export interface RebuildPackageAuthority {
  readonly harnessPackage: HarnessPackageIdentity | null;
  readonly harnessPackageMigration: HarnessPackageMigration | null;
}

type RebuildAgentAuthorityOwner = {
  readonly agent?: string | null;
  readonly harnessPackage?: unknown;
  readonly harnessPackageMigration?: unknown;
};

type RecreatedRebuildSession = Pick<
  Session,
  "agent" | "harnessPackage" | "harnessPackageMigration" | "sandboxName"
>;

export type PinnedRebuildAgentAuthorityIssue =
  | "recorded-agent"
  | "invalid-package"
  | "package-mismatch"
  | "standard-package-required";

export function rebuildPackageIdentityMatches(
  left: HarnessPackageIdentity | null,
  right: HarnessPackageIdentity | null,
): boolean {
  return left === null
    ? right === null
    : right !== null && harnessPackageIdentitiesEqual(left, right);
}

export function rebuildPackageAuthorityMatches(
  owner: RebuildAgentAuthorityOwner,
  expected: RebuildPackageAuthority,
): boolean {
  const inspected = inspectHarnessPackageState(owner.harnessPackage, owner.harnessPackageMigration);
  if (inspected.status === "invalid") return false;
  if (inspected.status === "absent") {
    return expected.harnessPackage === null && expected.harnessPackageMigration === null;
  }
  return (
    rebuildPackageIdentityMatches(inspected.harnessPackage, expected.harnessPackage) &&
    isDeepStrictEqual(inspected.harnessPackageMigration, expected.harnessPackageMigration)
  );
}

/** Check one durable owner against the definition and package pinned at rebuild preflight. */
export function checkPinnedAgentAuthority(
  owner: RebuildAgentAuthorityOwner,
  authority: ResolvedSandboxAgent,
): PinnedRebuildAgentAuthorityIssue | null {
  const recordedAgent = owner.agent ?? null;
  const effectiveAgentId = normalizeSandboxAgentName(recordedAgent);
  if (
    authority.recordedAgent !== recordedAgent ||
    authority.effectiveAgentId !== effectiveAgentId ||
    authority.definition.name !== effectiveAgentId ||
    typeof authority.definition.packageRoot !== "string" ||
    authority.definition.packageRoot.trim().length === 0
  ) {
    return "recorded-agent";
  }

  const packageState = inspectHarnessPackageState(
    owner.harnessPackage,
    owner.harnessPackageMigration,
  );
  if (packageState.status === "invalid") return "invalid-package";
  if (!rebuildPackageAuthorityMatches(owner, authority)) return "package-mismatch";

  const usesRepositoryAuthority =
    effectiveAgentId === "nemocua" || isCandidateAgent(effectiveAgentId);
  if (usesRepositoryAuthority) {
    return packageState.status === "absent" &&
      authority.harnessPackage === null &&
      authority.harnessPackageMigration === null
      ? null
      : "package-mismatch";
  }
  if (packageState.status !== "valid") return "standard-package-required";
  return packageState.harnessPackage.id === effectiveAgentId &&
    packageState.harnessPackage.id === authority.definition.name
    ? null
    : "package-mismatch";
}

export function rebuildAgentAuthoritiesMatch(
  actual: ResolvedSandboxAgent,
  expected: ResolvedSandboxAgent,
): boolean {
  return (
    actual.recordedAgent === expected.recordedAgent &&
    actual.effectiveAgentId === expected.effectiveAgentId &&
    actual.definition.name === expected.definition.name &&
    actual.definition.packageRoot === expected.definition.packageRoot &&
    isDeepStrictEqual(actual.definition, expected.definition) &&
    isDeepStrictEqual(actual.harnessPackage, expected.harnessPackage) &&
    isDeepStrictEqual(actual.harnessPackageMigration, expected.harnessPackageMigration)
  );
}

/** Verify both recreated durable owners and the package or repository object they retain. */
export function verifyRecreatedAgentAuthority(
  sandboxName: string,
  pinnedAuthority: ResolvedSandboxAgent,
  recreatedEntry: SandboxEntry | null,
  recreatedSession: RecreatedRebuildSession | null,
): string | null {
  if (!recreatedEntry || recreatedEntry.name !== sandboxName) {
    return "the recreated registry row is missing or belongs to another sandbox";
  }
  if (!recreatedSession || recreatedSession.sandboxName !== sandboxName) {
    return "the recreated onboard Session is missing or belongs to another sandbox";
  }
  // Session normalization retains malformed package state out of band. That
  // marker must be checked before a package-free candidate can be accepted.
  if (hasInvalidSessionHarnessPackage(recreatedSession)) {
    return "the recreated onboard Session contains invalid harness package authority";
  }
  if (
    checkPinnedAgentAuthority(recreatedEntry, pinnedAuthority) !== null ||
    checkPinnedAgentAuthority(recreatedSession, pinnedAuthority) !== null
  ) {
    return "the recreated registry and Session authority do not match the pinned rebuild target";
  }

  let currentAuthority: ResolvedSandboxAgent;
  try {
    // Both durable owners were proven equal above, so one resolution validates
    // their shared retained package object or qualified repository definition.
    currentAuthority = resolveSandboxAgent(recreatedEntry);
  } catch {
    return "the recreated agent package receipt or repository definition could not be verified";
  }

  return rebuildAgentAuthoritiesMatch(currentAuthority, pinnedAuthority)
    ? null
    : "the recreated registry and Session authority do not match the pinned rebuild target";
}

/** Load the current Session and verify it with a registry row read by the caller. */
export function verifyCurrentAgentAuthority(
  sandboxName: string,
  pinnedAuthority: ResolvedSandboxAgent,
  recreatedEntry: SandboxEntry | null,
): string | null {
  let recreatedSession: ReturnType<typeof loadSession>;
  try {
    recreatedSession = loadSession();
  } catch {
    return "the recreated onboard Session could not be read";
  }
  return verifyRecreatedAgentAuthority(
    sandboxName,
    pinnedAuthority,
    recreatedEntry,
    recreatedSession,
  );
}
