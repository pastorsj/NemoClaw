// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  HarnessAdapterError,
  HarnessAdapterModuleMissingError,
  loadHarnessAdapter,
} from "./adapter/loader";
import {
  HARNESS_SESSION_ADAPTER_CONTRACT,
  type HarnessSessionExportIndexOutput,
  type HarnessSessionExportIndexRequest,
  type HarnessSessionExportPlan,
  type HarnessSessionExportPlanRequest,
  type HarnessSessionListOutput,
  type HarnessSessionListOutputRequest,
  type HarnessSessionListPlan,
  type HarnessSessionListPlanRequest,
  type HarnessSessionMutationOutput,
  type HarnessSessionMutationOutputRequest,
  type HarnessSessionMutationPlan,
  type HarnessSessionMutationPlanRequest,
} from "./adapter/session";
import { readObject, readStringArray } from "./manifest-readers";
import type { HarnessPackageStoreOptions } from "./package/store";
import type { HarnessPackageIdentity } from "./package/types";

export type {
  HarnessSessionExportIndexOutput,
  HarnessSessionExportIndexRequest,
  HarnessSessionExportPlan,
  HarnessSessionExportPlanRequest,
  HarnessSessionListOutput,
  HarnessSessionListOutputRequest,
  HarnessSessionListPlan,
  HarnessSessionListPlanRequest,
  HarnessSessionMutationOutput,
  HarnessSessionMutationOutputRequest,
  HarnessSessionMutationPlan,
  HarnessSessionMutationPlanRequest,
} from "./adapter/session";

export interface HarnessSessionAdapterHostModule {
  buildSessionListPlan(request: HarnessSessionListPlanRequest): HarnessSessionListPlan;
  interpretSessionListOutput(request: HarnessSessionListOutputRequest): HarnessSessionListOutput;
  buildSessionMutationPlan(request: HarnessSessionMutationPlanRequest): HarnessSessionMutationPlan;
  interpretSessionMutationOutput(
    request: HarnessSessionMutationOutputRequest,
  ): HarnessSessionMutationOutput;
  buildSessionExportPlan(request: HarnessSessionExportPlanRequest): HarnessSessionExportPlan;
  interpretSessionExportIndex(
    request: HarnessSessionExportIndexRequest,
  ): HarnessSessionExportIndexOutput;
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

function validateDeclaredOperationSupport<Plan extends { readonly kind: string }>(
  operation: "list" | "delete" | "reset" | "export",
  declaredOperations: ReadonlySet<string>,
  plan: Plan,
): Plan {
  if (declaredOperations.has(operation) === (plan.kind === "unsupported")) {
    throw new HarnessSessionModuleError(
      `Installed harness session adapter does not match its declared ${operation} capability`,
    );
  }
  return plan;
}

/** Load session behavior from the package identity recorded for one sandbox. */
export function loadHarnessSessionAdapterHostModule(
  identity: HarnessPackageIdentity,
  options: HarnessPackageStoreOptions = {},
): HarnessSessionAdapterHostModule {
  let declaredOperations: ReadonlySet<string> = new Set();
  let adapter: ReturnType<typeof loadHarnessAdapter<typeof HARNESS_SESSION_ADAPTER_CONTRACT>>;
  try {
    adapter = loadHarnessAdapter(identity, HARNESS_SESSION_ADAPTER_CONTRACT, {
      ...(options.storeRoot === undefined ? {} : { storeRoot: options.storeRoot }),
      validateManifest(manifest) {
        const sessions = readObject(manifest, "sessions");
        declaredOperations = new Set(readStringArray(sessions ?? {}, "operations") ?? []);
      },
    });
  } catch (error) {
    sessionModuleFailure(error);
  }

  return Object.freeze({
    buildSessionListPlan(request: HarnessSessionListPlanRequest): HarnessSessionListPlan {
      const plan = callSessionAdapter(() => adapter.buildListPlan(request));
      return validateDeclaredOperationSupport("list", declaredOperations, plan);
    },
    interpretSessionListOutput(request: HarnessSessionListOutputRequest): HarnessSessionListOutput {
      return callSessionAdapter(() => adapter.interpretListOutput(request));
    },
    buildSessionMutationPlan(
      request: HarnessSessionMutationPlanRequest,
    ): HarnessSessionMutationPlan {
      const plan = callSessionAdapter(() => adapter.buildMutationPlan(request));
      return validateDeclaredOperationSupport(request.operation, declaredOperations, plan);
    },
    interpretSessionMutationOutput(
      request: HarnessSessionMutationOutputRequest,
    ): HarnessSessionMutationOutput {
      const result = callSessionAdapter(() => adapter.interpretMutationOutput(request));
      if (result.kind === "completed" && result.operation !== request.request.operation) {
        throw new HarnessSessionModuleError(
          "Installed harness session adapter returned a result for the wrong mutation operation",
        );
      }
      return result;
    },
    buildSessionExportPlan(request: HarnessSessionExportPlanRequest): HarnessSessionExportPlan {
      const plan = callSessionAdapter(() => adapter.buildExportPlan(request));
      return validateDeclaredOperationSupport("export", declaredOperations, plan);
    },
    interpretSessionExportIndex(
      request: HarnessSessionExportIndexRequest,
    ): HarnessSessionExportIndexOutput {
      return callSessionAdapter(() => adapter.interpretExportIndex(request));
    },
  });
}
