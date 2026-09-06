// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isDeepStrictEqual } from "node:util";

import {
  HARNESS_STARTUP_PROFILE_ADAPTER_CONTRACT,
  type HarnessInitialStartupProfileRequest,
  type HarnessInitialStartupProfileResult,
  type HarnessPrepareStartupProfileRequest,
  type HarnessPrepareStartupProfileResult,
  type HarnessReconcileStartupProfileRequest,
  type HarnessReconcileStartupProfileResult,
} from "./adapter/startup";
import {
  HarnessAdapterError,
  HarnessAdapterModuleMissingError,
  loadHarnessAdapter,
} from "./adapter/loader";
import { harnessPackageIdentitiesEqual } from "./package/identity";
import { readManagedImageDeclaration } from "./managed-image";
import { resolvePinnedHarnessPackage, type HarnessPackageStoreOptions } from "./package/store";
import type { HarnessPackageIdentity } from "./package/types";
import type { HarnessStartupEnvironmentInputDeclaration } from "@nvidia/nemoclaw-harness-contract";

export type {
  HarnessInitialStartupProfileRequest,
  HarnessInitialStartupProfileResult,
  HarnessPrepareStartupProfileRequest,
  HarnessPrepareStartupProfileResult,
  HarnessReconcileStartupProfileRequest,
  HarnessReconcileStartupProfileResult,
} from "./adapter/startup";

export interface HarnessStartupProfileAdapterHostModule {
  readonly startupProfileEnvironment: readonly HarnessStartupEnvironmentInputDeclaration[];
  prepareStartupProfile(
    request: HarnessPrepareStartupProfileRequest,
  ): HarnessPrepareStartupProfileResult;
  buildInitialStartupProfile(
    request: HarnessInitialStartupProfileRequest,
  ): HarnessInitialStartupProfileResult;
  reconcileStartupProfile(
    request: HarnessReconcileStartupProfileRequest,
  ): HarnessReconcileStartupProfileResult;
}

export class HarnessStartupModuleError extends Error {
  override readonly name = "HarnessStartupModuleError";

  constructor(
    message: string,
    readonly code: "missing-adapter" | "invalid-adapter" = "invalid-adapter",
    options: ErrorOptions = {},
  ) {
    super(message, options);
  }
}

function startupModuleFailure(error: unknown): never {
  if (error instanceof HarnessStartupModuleError) throw error;
  if (error instanceof HarnessAdapterError) {
    throw new HarnessStartupModuleError(
      error.message,
      error instanceof HarnessAdapterModuleMissingError ? "missing-adapter" : "invalid-adapter",
      { cause: error },
    );
  }
  throw new HarnessStartupModuleError(
    "Installed harness startup profile adapter failed",
    "invalid-adapter",
    { cause: error },
  );
}

function requireRequestAuthority(
  installedIdentity: HarnessPackageIdentity,
  request: Pick<HarnessInitialStartupProfileRequest, "packageId" | "harnessPackage">,
): void {
  if (
    request.packageId !== installedIdentity.id ||
    !harnessPackageIdentitiesEqual(installedIdentity, request.harnessPackage)
  ) {
    throw new HarnessStartupModuleError(
      "Startup profile request does not match its installed harness package identity",
    );
  }
}

function callStartupAdapter<Result>(operation: () => Result): Result {
  try {
    return operation();
  } catch (error) {
    startupModuleFailure(error);
  }
}

function requireDeclaredStartupEnvironment(
  declarations: readonly HarnessStartupEnvironmentInputDeclaration[],
  environment: Readonly<Record<string, string>>,
): void {
  const byName = new Map(declarations.map((declaration) => [declaration.name, declaration]));
  for (const [name, value] of Object.entries(environment)) {
    const declaration = byName.get(name);
    if (
      !declaration ||
      Buffer.byteLength(value, "utf8") > declaration.max_bytes ||
      (declaration.value_type === "positive-integer" &&
        (!/^[1-9][0-9]*$/u.test(value) ||
          !Number.isSafeInteger(Number(value)) ||
          Number(value) > 1_000_000_000))
    ) {
      throw new HarnessStartupModuleError(
        "Startup profile request contains an undeclared or oversized package environment input",
      );
    }
  }
}

/** Load package-owned durable startup-state behavior from one exact package receipt. */
export function loadHarnessStartupProfileAdapterHostModule(
  identity: HarnessPackageIdentity,
  options: HarnessPackageStoreOptions = {},
): HarnessStartupProfileAdapterHostModule {
  let startupProfileEnvironment: readonly HarnessStartupEnvironmentInputDeclaration[];
  let adapter: ReturnType<
    typeof loadHarnessAdapter<typeof HARNESS_STARTUP_PROFILE_ADAPTER_CONTRACT>
  >;
  try {
    const installed = resolvePinnedHarnessPackage(identity, options);
    const managedImage = readManagedImageDeclaration(installed.packageManifest.manifest);
    if (managedImage === null) {
      throw new HarnessStartupModuleError(
        "Installed harness package does not declare a managed startup image",
      );
    }
    startupProfileEnvironment = managedImage.startup_profile_environment ?? [];
    adapter = loadHarnessAdapter(identity, HARNESS_STARTUP_PROFILE_ADAPTER_CONTRACT, options);
  } catch (error) {
    startupModuleFailure(error);
  }

  return Object.freeze({
    startupProfileEnvironment,
    prepareStartupProfile(
      request: HarnessPrepareStartupProfileRequest,
    ): HarnessPrepareStartupProfileResult {
      requireRequestAuthority(identity, request);
      requireDeclaredStartupEnvironment(startupProfileEnvironment, request.input.environment);
      if (
        (request.phase === "initial" && request.previousDesiredState !== null) ||
        (request.phase === "rebuild" && request.previousDesiredState === null)
      ) {
        throw new HarnessStartupModuleError(
          "Startup profile preparation phase does not match its previous desired state",
        );
      }
      return callStartupAdapter(() => adapter.prepareProfile(request));
    },
    buildInitialStartupProfile(
      request: HarnessInitialStartupProfileRequest,
    ): HarnessInitialStartupProfileResult {
      requireRequestAuthority(identity, request);
      return callStartupAdapter(() => adapter.buildInitialProfile(request));
    },
    reconcileStartupProfile(
      request: HarnessReconcileStartupProfileRequest,
    ): HarnessReconcileStartupProfileResult {
      requireRequestAuthority(identity, request);
      const result = callStartupAdapter(() => adapter.reconcileProfile(request));
      const packageConfigChanged =
        result.kind === "package-config"
          ? !isDeepStrictEqual(result.packageConfig, request.currentPackageConfig)
          : null;
      if (result.kind === "package-config" && result.changed !== packageConfigChanged) {
        throw new HarnessStartupModuleError(
          "Installed harness startup profile adapter returned an inconsistent reconciliation",
        );
      }
      return result;
    },
  });
}
