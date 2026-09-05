// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { loadHarnessAdapter, HarnessAdapterError } from "./adapter/loader";
import {
  HARNESS_MCP_ADAPTER_CONTRACT,
  type HarnessMcpCapabilityProbe,
  type HarnessMcpCapabilityRequest,
  type HarnessMcpInspectionRequest,
  type HarnessMcpRegistrationRequest,
  type HarnessMcpRegistrationPlan,
  type HarnessMcpRemovalRequest,
  type HarnessMcpRemovalPlan,
  type HarnessMcpRuntimeIntentRequest,
  type HarnessMcpRuntimePlan,
  type HarnessMcpRuntimeRequest,
  type HarnessMcpSnapshotRestorePlan,
  type HarnessMcpSnapshotRestoreRequest,
} from "./adapter/mcp";
import { readMcpCapability } from "./manifest-readers";
import type { HarnessPackageStoreOptions } from "./package/store";
import type { HarnessPackageIdentity } from "./package/types";

export type {
  HarnessMcpAdapterCommand,
  HarnessMcpAdapterEntry,
  HarnessMcpCapabilityProbe,
  HarnessMcpCapabilityRequest,
  HarnessMcpCredentialConvergence,
  HarnessMcpExecutionPlan,
  HarnessMcpExecutionSuccess,
  HarnessMcpInspectionRequest,
  HarnessMcpRegistrationRequest,
  HarnessMcpRegistrationPlan,
  HarnessMcpRegistrationVerification,
  HarnessMcpRemovalRequest,
  HarnessMcpRemovalOutcome,
  HarnessMcpRemovalPlan,
  HarnessMcpRuntimeIntentRequest,
  HarnessMcpRuntimePlan,
  HarnessMcpRuntimeRequest,
  HarnessMcpSnapshotApplicability,
  HarnessMcpSnapshotRestorePlan,
  HarnessMcpSnapshotRestoreRequest,
} from "./adapter/mcp";

export interface HarnessMcpAdapterHostModule {
  buildMcpRegistrationPlan(request: HarnessMcpRegistrationRequest): HarnessMcpRegistrationPlan;
  buildMcpRemovalPlan(request: HarnessMcpRemovalRequest): HarnessMcpRemovalPlan;
  buildMcpInspectionCommand(request: HarnessMcpInspectionRequest): string;
  describeMcpMutationCapability(request: HarnessMcpCapabilityRequest): HarnessMcpCapabilityProbe;
  describeMcpTeardownCapability(request: HarnessMcpCapabilityRequest): HarnessMcpCapabilityProbe;
  describeMcpRuntimeIntentVerification(
    request: HarnessMcpRuntimeIntentRequest,
  ): HarnessMcpCapabilityProbe;
  buildMcpRuntimePlan(request: HarnessMcpRuntimeRequest): HarnessMcpRuntimePlan;
  buildMcpSnapshotRestorePlan(
    request: HarnessMcpSnapshotRestoreRequest,
  ): HarnessMcpSnapshotRestorePlan;
}

export interface LoadHarnessMcpAdapterHostModuleOptions extends HarnessPackageStoreOptions {
  readonly expectedAdapter?: string;
}

/** Compatibility error for callers of the original MCP-specific host-module API. */
export class HarnessPackageHostModuleError extends Error {
  override readonly name = "HarnessPackageHostModuleError";

  constructor(message: string, options: ErrorOptions = {}) {
    super(message, options);
  }
}

function throwCompatibilityError(error: unknown): never {
  if (error instanceof HarnessPackageHostModuleError) throw error;
  if (error instanceof HarnessAdapterError) {
    throw new HarnessPackageHostModuleError(error.message, { cause: error });
  }
  throw new HarnessPackageHostModuleError(
    "Installed harness package failed MCP adapter integrity validation",
    { cause: error },
  );
}

function callMcpAdapter<Result>(operation: () => Result): Result {
  try {
    return operation();
  } catch (error) {
    throwCompatibilityError(error);
  }
}

/**
 * Load the MCP capability through the generic adapter boundary.
 *
 * This wrapper preserves the established API while future capabilities use the same typed loader.
 */
export function loadHarnessMcpAdapterHostModule(
  identity: HarnessPackageIdentity,
  options: LoadHarnessMcpAdapterHostModuleOptions = {},
): HarnessMcpAdapterHostModule {
  let adapter: ReturnType<typeof loadHarnessAdapter<typeof HARNESS_MCP_ADAPTER_CONTRACT>>;
  try {
    adapter = loadHarnessAdapter(identity, HARNESS_MCP_ADAPTER_CONTRACT, {
      ...(options.storeRoot === undefined ? {} : { storeRoot: options.storeRoot }),
      validateManifest(manifest) {
        const mcpCapability = readMcpCapability(manifest);
        if (
          mcpCapability.support !== "bridge" ||
          !mcpCapability.adapter ||
          (options.expectedAdapter !== undefined &&
            mcpCapability.adapter !== options.expectedAdapter)
        ) {
          throw new HarnessAdapterError(
            "Installed harness package manifest does not match the requested MCP adapter",
          );
        }
      },
    });
  } catch (error) {
    throwCompatibilityError(error);
  }

  return Object.freeze({
    buildMcpRegistrationPlan(request: HarnessMcpRegistrationRequest): HarnessMcpRegistrationPlan {
      return callMcpAdapter(() => adapter.register(request));
    },
    buildMcpRemovalPlan(request: HarnessMcpRemovalRequest): HarnessMcpRemovalPlan {
      return callMcpAdapter(() => adapter.remove(request));
    },
    buildMcpInspectionCommand(request: HarnessMcpInspectionRequest): string {
      return callMcpAdapter(() => adapter.inspect(request));
    },
    describeMcpMutationCapability(request: HarnessMcpCapabilityRequest): HarnessMcpCapabilityProbe {
      return callMcpAdapter(() => adapter.mutationCapability(request));
    },
    describeMcpTeardownCapability(request: HarnessMcpCapabilityRequest): HarnessMcpCapabilityProbe {
      return callMcpAdapter(() => adapter.teardownCapability(request));
    },
    describeMcpRuntimeIntentVerification(
      request: HarnessMcpRuntimeIntentRequest,
    ): HarnessMcpCapabilityProbe {
      return callMcpAdapter(() => adapter.verifyRuntimeIntent(request));
    },
    buildMcpRuntimePlan(request: HarnessMcpRuntimeRequest): HarnessMcpRuntimePlan {
      return callMcpAdapter(() => adapter.runtime(request));
    },
    buildMcpSnapshotRestorePlan(
      request: HarnessMcpSnapshotRestoreRequest,
    ): HarnessMcpSnapshotRestorePlan {
      return callMcpAdapter(() => adapter.snapshotRestore(request));
    },
  });
}
