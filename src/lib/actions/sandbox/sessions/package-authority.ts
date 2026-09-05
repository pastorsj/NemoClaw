// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { harnessPackageIdentitiesEqual } from "../../../agent-runtime/package/identity";
import type { HarnessPackageIdentity } from "../../../agent-runtime/package/types";
import {
  type HarnessSessionAdapterHostModule,
  loadHarnessSessionAdapterHostModule,
} from "../../../agent-runtime/session-module";
import { resolvePackageBackedSandboxAgent } from "../../../onboard/package/package-authority";
import * as registry from "../../../state/registry";

export interface SessionPackageAuthority {
  readonly identity: HarnessPackageIdentity;
  readonly adapter: HarnessSessionAdapterHostModule;
}

function sessionAuthorityFailure(detail: string): never {
  throw new Error(`Cannot resolve the installed harness session adapter: ${detail}`);
}

function hasNoPackageReceipt(entry: NonNullable<ReturnType<typeof registry.getSandbox>>): boolean {
  return (
    (entry.harnessPackage === undefined || entry.harnessPackage === null) &&
    (entry.harnessPackageMigration === undefined || entry.harnessPackageMigration === null)
  );
}

/** Resolve one session adapter through the exact package receipt recorded for a sandbox. */
export function resolveSessionPackageAuthority(
  sandboxName: string,
): SessionPackageAuthority | null {
  const entry = registry.getSandbox(sandboxName);
  // A missing row follows the historical no-receipt path. The legacy action
  // still performs its existing liveness/registry authority checks before it
  // can mutate anything.
  if (!entry) return null;
  if (hasNoPackageReceipt(entry)) return null;

  try {
    const resolved = resolvePackageBackedSandboxAgent(entry);
    if (!resolved.harnessPackage) {
      return sessionAuthorityFailure("the sandbox does not carry a complete harness package identity");
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
export function confirmSessionPackageAuthority(
  sandboxName: string,
  expectedIdentity: HarnessPackageIdentity,
): HarnessSessionAdapterHostModule {
  const current = resolveSessionPackageAuthority(sandboxName);
  if (
    current === null ||
    !harnessPackageIdentitiesEqual(current.identity, expectedIdentity)
  ) {
    throw new Error(
      `Refusing session mutation for sandbox '${sandboxName}': harness package authority changed`,
    );
  }
  return current.adapter;
}
