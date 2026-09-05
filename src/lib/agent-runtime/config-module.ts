// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  HARNESS_CONFIG_ADAPTER_CONTRACT,
  HARNESS_CONFIG_RESTORE_CONTRACT,
  type HarnessConfigRestoreRequest,
  type HarnessConfigRestoreResult,
  type HarnessInferenceConfigRequest,
  type HarnessInferenceConfigSupport,
  type HarnessConfigUpdatePlan,
  type HarnessConfigUpdateRequest,
  type HarnessConfigUrlPolicy,
  type HarnessConfigUrlRequest,
  type HarnessMutableConfigPlan,
  type HarnessMutableConfigRequest,
} from "./adapter/config";
import {
  HarnessAdapterError,
  HarnessAdapterModuleMissingError,
  loadHarnessAdapter,
} from "./adapter/loader";
import type { HarnessPackageStoreOptions } from "./package/store";
import type { HarnessPackageIdentity } from "./package/types";

export type {
  HarnessConfigCommand,
  HarnessConfigCommandSuccess,
  HarnessConfigRestoreRequest,
  HarnessConfigRestoreResult,
  HarnessConfigRestoreWritePlan,
  HarnessConfigTarget,
  HarnessConfigTransactionCommand,
  HarnessConfigUpdatePlan,
  HarnessConfigUpdateRequest,
  HarnessConfigUrlPolicy,
  HarnessConfigUrlRequest,
  HarnessExitZeroCommand,
  HarnessImagePluginInstall,
  HarnessMutableConfigPlan,
  HarnessMutableConfigRequest,
} from "./adapter/config";

export interface HarnessConfigAdapterHostModule {
  describeInferenceConfig(request: HarnessInferenceConfigRequest): HarnessInferenceConfigSupport;
  prepareConfigUpdate(request: HarnessConfigUpdateRequest): HarnessConfigUpdatePlan;
  classifyConfigUrl(request: HarnessConfigUrlRequest): HarnessConfigUrlPolicy;
  describeMutableConfig(request: HarnessMutableConfigRequest): HarnessMutableConfigPlan;
}

export interface HarnessConfigRestoreHostModule {
  mergeConfigState(request: HarnessConfigRestoreRequest): HarnessConfigRestoreResult;
}

export class HarnessConfigModuleError extends Error {
  override readonly name = "HarnessConfigModuleError";

  constructor(
    message: string,
    readonly code: "missing-adapter" | "invalid-adapter" = "invalid-adapter",
    options: ErrorOptions = {},
  ) {
    super(message, options);
  }
}

function configModuleFailure(error: unknown): never {
  if (error instanceof HarnessConfigModuleError) throw error;
  if (error instanceof HarnessAdapterError) {
    throw new HarnessConfigModuleError(
      error.message,
      error instanceof HarnessAdapterModuleMissingError ? "missing-adapter" : "invalid-adapter",
      { cause: error },
    );
  }
  throw new HarnessConfigModuleError(
    "Installed harness configuration adapter failed",
    "invalid-adapter",
    { cause: error },
  );
}

function callConfigAdapter<Result>(operation: () => Result): Result {
  try {
    return operation();
  } catch (error) {
    configModuleFailure(error);
  }
}

/** Load configuration behavior from the exact package recorded for a sandbox. */
export function loadHarnessConfigAdapterHostModule(
  identity: HarnessPackageIdentity,
  options: HarnessPackageStoreOptions = {},
): HarnessConfigAdapterHostModule {
  let adapter: ReturnType<typeof loadHarnessAdapter<typeof HARNESS_CONFIG_ADAPTER_CONTRACT>>;
  try {
    adapter = loadHarnessAdapter(identity, HARNESS_CONFIG_ADAPTER_CONTRACT, options);
  } catch (error) {
    configModuleFailure(error);
  }
  return Object.freeze({
    describeInferenceConfig(request: HarnessInferenceConfigRequest): HarnessInferenceConfigSupport {
      return callConfigAdapter(() => adapter.describeInference(request));
    },
    prepareConfigUpdate(request: HarnessConfigUpdateRequest): HarnessConfigUpdatePlan {
      return callConfigAdapter(() => adapter.prepareUpdate(request));
    },
    classifyConfigUrl(request: HarnessConfigUrlRequest): HarnessConfigUrlPolicy {
      return callConfigAdapter(() => adapter.classifyUrl(request));
    },
    describeMutableConfig(request: HarnessMutableConfigRequest): HarnessMutableConfigPlan {
      return callConfigAdapter(() => adapter.describeMutable(request));
    },
  });
}

/** Load package-native state merge grammar without granting host capabilities. */
export function loadHarnessConfigRestoreHostModule(
  identity: HarnessPackageIdentity,
  options: HarnessPackageStoreOptions = {},
): HarnessConfigRestoreHostModule {
  let adapter: ReturnType<typeof loadHarnessAdapter<typeof HARNESS_CONFIG_RESTORE_CONTRACT>>;
  try {
    adapter = loadHarnessAdapter(identity, HARNESS_CONFIG_RESTORE_CONTRACT, options);
  } catch (error) {
    configModuleFailure(error);
  }
  return Object.freeze({
    mergeConfigState(request: HarnessConfigRestoreRequest): HarnessConfigRestoreResult {
      return callConfigAdapter(() => adapter.mergeState(request));
    },
  });
}
