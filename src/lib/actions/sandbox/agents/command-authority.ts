// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { harnessPackageIdentitiesEqual } from "../../../agent-runtime/package/identity-validation";
import type { HarnessPackageIdentity } from "../../../agent-runtime/package/types";
import {
  type HarnessAgentRosterAdapterHostModule,
  loadHarnessAgentRosterAdapterHostModule,
} from "../../../agent-runtime/roster-module";
import {
  readRegisteredSandboxAuthority,
  resolvePackageBackedSandboxAgent,
  type RegisteredSandboxAuthority,
} from "../authority/package";
import { withSandboxMutationLock } from "../../../state/mutation-lock";
import { ensureLiveSandboxOrExit } from "../gateway-state";

export interface AgentRosterPackageAuthority {
  readonly kind: "package";
  readonly identity: HarnessPackageIdentity;
  readonly adapter: HarnessAgentRosterAdapterHostModule;
  readonly displayName: string;
}

export interface AgentRosterUnsupportedAuthority {
  readonly kind: "unsupported";
  readonly displayName: string;
  readonly reason: string;
}

export type AgentRosterCommandAuthority =
  | { readonly kind: "legacy" }
  | AgentRosterPackageAuthority
  | AgentRosterUnsupportedAuthority;

function hasNoPackageReceipt(entry: RegisteredSandboxAuthority): boolean {
  return (
    (entry.harnessPackage === undefined || entry.harnessPackage === null) &&
    (entry.harnessPackageMigration === undefined || entry.harnessPackageMigration === null)
  );
}

function authorityFailure(detail: string): never {
  throw new Error(`Cannot resolve the installed harness agent roster adapter: ${detail}`);
}

/** Resolve agent-roster ownership through an exact receipt, never through a package ID. */
export function resolveAgentRosterCommandAuthority(
  sandboxName: string,
): AgentRosterCommandAuthority {
  const entry = readRegisteredSandboxAuthority(sandboxName);
  if (!entry || hasNoPackageReceipt(entry)) return Object.freeze({ kind: "legacy" });

  try {
    const resolved = resolvePackageBackedSandboxAgent(entry);
    if (!resolved.harnessPackage) {
      return authorityFailure("the sandbox does not carry a complete harness package identity");
    }
    if (resolved.definition.agentRosterCapability?.support !== "managed") {
      const displayName = resolved.definition.displayName;
      return Object.freeze({
        kind: "unsupported",
        displayName,
        reason: `${displayName} does not declare managed agent roster support.`,
      });
    }
    return Object.freeze({
      kind: "package",
      identity: resolved.harnessPackage,
      adapter: loadHarnessAgentRosterAdapterHostModule(resolved.harnessPackage),
      displayName: resolved.definition.displayName,
    });
  } catch (error) {
    return authorityFailure(error instanceof Error ? error.message : String(error));
  }
}

/** Re-resolve package bytes at the last safe edge before a roster mutation. */
export function confirmAgentRosterCommandAuthority(
  sandboxName: string,
  expectedIdentity: HarnessPackageIdentity,
): HarnessAgentRosterAdapterHostModule {
  const current = resolveAgentRosterCommandAuthority(sandboxName);
  if (
    current.kind !== "package" ||
    !harnessPackageIdentitiesEqual(current.identity, expectedIdentity)
  ) {
    throw new Error(
      `Refusing agent roster mutation for sandbox '${sandboxName}': harness package authority changed`,
    );
  }
  return current.adapter;
}

/** Serialize a roster command with other mutations of the same sandbox. */
export function withAgentRosterCommandLock<T>(
  sandboxName: string,
  operation: () => Promise<T> | T,
): Promise<T> {
  return withSandboxMutationLock(sandboxName, operation);
}

/** Cross the OpenShell liveness boundary only after package capability resolution. */
export function ensureLiveAgentRosterSandbox(
  ...args: Parameters<typeof ensureLiveSandboxOrExit>
): ReturnType<typeof ensureLiveSandboxOrExit> {
  return ensureLiveSandboxOrExit(...args);
}
