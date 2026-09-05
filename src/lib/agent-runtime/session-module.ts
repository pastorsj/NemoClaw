// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  HarnessAdapterError,
  HarnessAdapterModuleMissingError,
  loadHarnessAdapter,
} from "./adapter/loader";
import {
  HARNESS_SESSION_ADAPTER_CONTRACT,
  type HarnessSessionListOutput,
  type HarnessSessionListOutputRequest,
  type HarnessSessionListPlan,
  type HarnessSessionListPlanRequest,
} from "./adapter/session";
import { readObject, readStringArray } from "./manifest-readers";
import type { HarnessPackageStoreOptions } from "./package/store";
import type { HarnessPackageIdentity } from "./package/types";

export type {
  HarnessSessionListOutput,
  HarnessSessionListOutputRequest,
  HarnessSessionListPlan,
  HarnessSessionListPlanRequest,
} from "./adapter/session";

export interface HarnessSessionAdapterHostModule {
  buildSessionListPlan(request: HarnessSessionListPlanRequest): HarnessSessionListPlan;
  interpretSessionListOutput(request: HarnessSessionListOutputRequest): HarnessSessionListOutput;
}

export class HarnessSessionModuleError extends Error {
  override readonly name = "HarnessSessionModuleError";

  constructor(
    message: string,
    readonly code: "missing-adapter" | "invalid-adapter" = "invalid-adapter",
    options: ErrorOptions = {},
  ) {
    super(message, options);
  }
}

function sessionModuleFailure(error: unknown): never {
  if (error instanceof HarnessSessionModuleError) throw error;
  if (error instanceof HarnessAdapterError) {
    throw new HarnessSessionModuleError(
      error.message,
      error instanceof HarnessAdapterModuleMissingError ? "missing-adapter" : "invalid-adapter",
      { cause: error },
    );
  }
  throw new HarnessSessionModuleError(
    "Installed harness session adapter failed",
    "invalid-adapter",
    {
      cause: error,
    },
  );
}

function callSessionAdapter<Result>(operation: () => Result): Result {
  try {
    return operation();
  } catch (error) {
    sessionModuleFailure(error);
  }
}

function validateDeclaredListSupport(
  supportsList: boolean,
  plan: HarnessSessionListPlan,
): HarnessSessionListPlan {
  if (supportsList === (plan.kind === "unsupported")) {
    throw new HarnessSessionModuleError(
      "Installed harness session adapter does not match its declared list capability",
    );
  }
  return plan;
}

/** Load session behavior from the package identity recorded for one sandbox. */
export function loadHarnessSessionAdapterHostModule(
  identity: HarnessPackageIdentity,
  options: HarnessPackageStoreOptions = {},
): HarnessSessionAdapterHostModule {
  let supportsList = false;
  let adapter: ReturnType<typeof loadHarnessAdapter<typeof HARNESS_SESSION_ADAPTER_CONTRACT>>;
  try {
    adapter = loadHarnessAdapter(identity, HARNESS_SESSION_ADAPTER_CONTRACT, {
      ...(options.storeRoot === undefined ? {} : { storeRoot: options.storeRoot }),
      validateManifest(manifest) {
        const sessions = readObject(manifest, "sessions");
        supportsList = readStringArray(sessions ?? {}, "operations")?.includes("list") === true;
      },
    });
  } catch (error) {
    sessionModuleFailure(error);
  }

  return Object.freeze({
    buildSessionListPlan(request: HarnessSessionListPlanRequest): HarnessSessionListPlan {
      const plan = callSessionAdapter(() => adapter.buildListPlan(request));
      return validateDeclaredListSupport(supportsList, plan);
    },
    interpretSessionListOutput(request: HarnessSessionListOutputRequest): HarnessSessionListOutput {
      return callSessionAdapter(() => adapter.interpretListOutput(request));
    },
  });
}
