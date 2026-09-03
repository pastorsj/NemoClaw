// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { loadHarnessAdapter, HarnessAdapterError } from "./adapter/loader";
import {
  HARNESS_MCP_ADAPTER_CONTRACT,
  type HarnessMcpAdapterCommand,
  type HarnessMcpAdapterEntry,
  type HarnessMcpRegistrationRequest,
  type HarnessMcpRemovalRequest,
} from "./adapter/mcp";
import { readMcpCapability } from "./manifest-readers";
import type { HarnessPackageStoreOptions } from "./package/store";
import type { HarnessPackageIdentity } from "./package/types";

export type {
  HarnessMcpAdapterCommand,
  HarnessMcpAdapterEntry,
  HarnessMcpRegistrationRequest,
  HarnessMcpRemovalRequest,
} from "./adapter/mcp";

export interface HarnessMcpAdapterHostModule {
  buildMcpRegistrationCommand(request: HarnessMcpRegistrationRequest): HarnessMcpAdapterCommand;
  buildMcpRemovalCommand(request: HarnessMcpRemovalRequest): HarnessMcpAdapterCommand;
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
    buildMcpRegistrationCommand(request: HarnessMcpRegistrationRequest): HarnessMcpAdapterCommand {
      return callMcpAdapter(() => adapter.register(request));
    },
    buildMcpRemovalCommand(request: HarnessMcpRemovalRequest): HarnessMcpAdapterCommand {
      return callMcpAdapter(() => adapter.remove(request));
    },
  });
}
