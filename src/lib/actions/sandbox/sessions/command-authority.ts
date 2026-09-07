// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { harnessPackageIdentitiesEqual } from "../../../agent-runtime/package/identity-validation";
import type { HarnessPackageIdentity } from "../../../agent-runtime/package/types";
import {
  type HarnessSessionAdapterHostModule,
  loadHarnessSessionAdapterHostModule,
} from "../../../agent-runtime/session-module";
import { assertHermesPortableCommandUnavailable } from "../../../onboard/experimental/portable-agent-lifecycle";
import {
  readRegisteredSandboxAuthority,
  resolvePackageBackedSandboxAgent,
  type RegisteredSandboxAuthority,
} from "../authority/package";
import { withSandboxMutationLock } from "../../../state/mutation-lock";
import { ensureLiveSandboxOrExit } from "../gateway-state";

export interface SessionCommandAuthority {
  readonly identity: HarnessPackageIdentity;
  readonly adapter: HarnessSessionAdapterHostModule;
}

function sessionAuthorityFailure(detail: string): never {
  throw new Error(`Cannot resolve the installed harness session adapter: ${detail}`);
}

function hasNoPackageReceipt(entry: RegisteredSandboxAuthority): boolean {
  return (
    (entry.harnessPackage === undefined || entry.harnessPackage === null) &&
    (entry.harnessPackageMigration === undefined || entry.harnessPackageMigration === null)
  );
}

/** Resolve one session adapter through the exact package receipt recorded for a sandbox. */
export function resolveSessionCommandAuthority(
  sandboxName: string,
): SessionCommandAuthority | null {
  const entry = readRegisteredSandboxAuthority(sandboxName);
  // A missing row follows the historical no-receipt path. The legacy action
  // still performs its existing liveness/registry authority checks before it
  // can mutate anything.
  if (!entry) return null;
  if (hasNoPackageReceipt(entry)) return null;

  try {
    const resolved = resolvePackageBackedSandboxAgent(entry);
    if (!resolved.harnessPackage) {
      return sessionAuthorityFailure(
        "the sandbox does not carry a complete harness package identity",
      );
    }
    return Object.freeze({
      identity: resolved.harnessPackage,
      adapter: loadHarnessSessionAdapterHostModule(resolved.harnessPackage),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return sessionAuthorityFailure(detail);
  }
}

/** Re-resolve package bytes at the last safe edge before a session mutation. */
export function confirmSessionCommandAuthority(
  sandboxName: string,
  expectedIdentity: HarnessPackageIdentity,
): HarnessSessionAdapterHostModule {
  const current = resolveSessionCommandAuthority(sandboxName);
  if (current === null || !harnessPackageIdentitiesEqual(current.identity, expectedIdentity)) {
    throw new Error(
      `Refusing session mutation for sandbox '${sandboxName}': harness package authority changed`,
    );
  }
  return current.adapter;
}

/** Reject session commands owned by the separately qualified Portable product lane. */
export function assertSessionCommandAvailable(sandboxName: string, command: string): void {
  assertHermesPortableCommandUnavailable(sandboxName, command);
}

/** Serialize a session command with other mutations of the same sandbox. */
export function withSessionCommandLock<T>(
  sandboxName: string,
  operation: () => Promise<T> | T,
): Promise<T> {
  return withSandboxMutationLock(sandboxName, operation);
}

/** Prove the sandbox is reachable immediately before a supported session command runs. */
export function ensureLiveSessionSandbox(
  ...args: Parameters<typeof ensureLiveSandboxOrExit>
): ReturnType<typeof ensureLiveSandboxOrExit> {
  return ensureLiveSandboxOrExit(...args);
}
