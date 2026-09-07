// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isDeepStrictEqual } from "node:util";

import type { SandboxEntry } from "../state/registry";
import {
  inspectGatewayCredentialOnlyProviderBinding,
  type GatewayCredentialOnlyProviderInspection,
} from "../onboard/gateway-provider-metadata";
import { deleteProviderWithRecovery } from "../onboard/sandbox-provider-cleanup";
import {
  parseSandboxProviderBrokerOwnership,
  type SandboxProviderBrokerOwnership,
} from "../state/registry/provider-broker";
import {
  buildHarnessProviderBrokerPlan,
  runHarnessProviderBrokerController,
} from "./provider-broker";
import type { HarnessPackageStoreOptions } from "./package/pinned";

type RunOpenshell = (
  args: string[],
  options?: Record<string, unknown>,
) => {
  status: number | null;
  stdout?: string | Buffer | null;
  stderr?: string | Buffer | null;
  error?: unknown;
  signal?: unknown;
};

export interface PreparedProviderBrokerCleanup {
  readonly sandboxName: string;
  readonly ownership: SandboxProviderBrokerOwnership;
  readonly providerState: GatewayCredentialOnlyProviderInspection;
}

export interface ProviderBrokerCleanupDeps extends HarnessPackageStoreOptions {
  readonly runOpenshell: RunOpenshell;
  readonly getSandbox: (sandboxName: string) => SandboxEntry | null;
  readonly inspectProvider?: typeof inspectGatewayCredentialOnlyProviderBinding;
  readonly runController?: typeof runHarnessProviderBrokerController;
  readonly deleteProvider?: typeof deleteProviderWithRecovery;
}

function requireCurrentOwnership(
  prepared: PreparedProviderBrokerCleanup,
  deps: ProviderBrokerCleanupDeps,
): SandboxProviderBrokerOwnership {
  const current = deps.getSandbox(prepared.sandboxName);
  if (!current?.harnessPackage || !current.providerBroker) {
    throw new Error("Provider-broker cleanup authority is no longer present.");
  }
  const ownership = parseSandboxProviderBrokerOwnership(
    current.providerBroker,
    current.harnessPackage,
  );
  if (!isDeepStrictEqual(ownership, prepared.ownership)) {
    throw new Error("Provider-broker cleanup authority changed during teardown.");
  }
  const plan = buildHarnessProviderBrokerPlan(
    ownership.harnessPackage,
    { operation: "teardown-broker", sandboxName: prepared.sandboxName },
    deps,
  );
  if (plan.kind !== "managed" || plan.providerName !== ownership.providerName) {
    throw new Error("Provider-broker package authority drifted during teardown.");
  }
  return ownership;
}

function inspectExactProvider(
  ownership: SandboxProviderBrokerOwnership,
  deps: ProviderBrokerCleanupDeps,
): GatewayCredentialOnlyProviderInspection {
  return (deps.inspectProvider ?? inspectGatewayCredentialOnlyProviderBinding)(
    {
      name: ownership.providerName,
      type: ownership.providerType,
      credentialKey: ownership.credentialEnv,
    },
    deps.runOpenshell,
  );
}

function requireSafeInspection(
  inspection: GatewayCredentialOnlyProviderInspection,
): GatewayCredentialOnlyProviderInspection {
  if (inspection.kind === "collision" || inspection.kind === "indeterminate") {
    throw new Error("Exact provider-broker ownership could not be proven.");
  }
  return inspection;
}

/** Capture exact receipt and provider authority before the sandbox is deleted. */
export function prepareProviderBrokerCleanup(
  sandboxName: string,
  sandbox: SandboxEntry | null,
  deps: ProviderBrokerCleanupDeps,
): PreparedProviderBrokerCleanup | null {
  // No-receipt rows remain on their existing compatibility cleanup path. A
  // receipt row without ownership never guesses a provider from a harness ID.
  if (!sandbox?.harnessPackage || !sandbox.providerBroker) return null;
  const ownership = parseSandboxProviderBrokerOwnership(
    sandbox.providerBroker,
    sandbox.harnessPackage,
  );
  const plan = buildHarnessProviderBrokerPlan(
    ownership.harnessPackage,
    { operation: "teardown-broker", sandboxName },
    deps,
  );
  if (plan.kind !== "managed" || plan.providerName !== ownership.providerName) {
    throw new Error("Provider-broker ownership does not match its package receipt.");
  }
  return Object.freeze({
    sandboxName,
    ownership,
    providerState: requireSafeInspection(inspectExactProvider(ownership, deps)),
  });
}

/** Remove only the exact provider and package controller state captured pre-delete. */
export function removePreparedProviderBroker(
  prepared: PreparedProviderBrokerCleanup,
  deps: ProviderBrokerCleanupDeps,
): void {
  let ownership = requireCurrentOwnership(prepared, deps);
  let inspection = requireSafeInspection(inspectExactProvider(ownership, deps));
  if (inspection.kind === "exact") {
    ownership = requireCurrentOwnership(prepared, deps);
    deps.runOpenshell(
      ["sandbox", "provider", "detach", prepared.sandboxName, ownership.providerName],
      { ignoreError: true, suppressOutput: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    ownership = requireCurrentOwnership(prepared, deps);
    inspection = requireSafeInspection(inspectExactProvider(ownership, deps));
    if (inspection.kind === "exact") {
      const deleted = (deps.deleteProvider ?? deleteProviderWithRecovery)(ownership.providerName, {
        runOpenshell: deps.runOpenshell,
        allowedSandboxes: [prepared.sandboxName],
      });
      if (!deleted.ok) throw new Error("Exact provider-broker deletion failed.");
      ownership = requireCurrentOwnership(prepared, deps);
      if (requireSafeInspection(inspectExactProvider(ownership, deps)).kind !== "missing") {
        throw new Error("Provider-broker deletion was not confirmed.");
      }
    }
  }
  ownership = requireCurrentOwnership(prepared, deps);
  const result = (deps.runController ?? runHarnessProviderBrokerController)(
    ownership.harnessPackage,
    { operation: "teardown-broker", sandboxName: prepared.sandboxName },
    deps,
  );
  if (
    !result.ok ||
    result.teardownComplete !== true ||
    result.providerName !== ownership.providerName
  ) {
    throw new Error("Provider-broker host teardown was not confirmed.");
  }
}
