// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isDeepStrictEqual } from "node:util";
import path from "node:path";

import {
  HARNESS_CONFIG_ADAPTER_CONTRACT,
  HARNESS_CONFIG_RESTORE_CONTRACT,
  type HarnessConfigRestoreRequest,
  type HarnessConfigRestoreResult,
  type HarnessInferenceConfigRequest,
  type HarnessInferenceConfigSupport,
  type HarnessInferenceConfigUpdatePlan,
  type HarnessInferenceConfigUpdateRequest,
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
import { readManagedImageDeclaration } from "./managed-image";
import type { HarnessPackageStoreOptions } from "./package/store";
import type { HarnessPackageIdentity } from "./package/types";
import { readObject, readString } from "./manifest-readers";
import type { ManifestRecord } from "./manifest-types";

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
  HarnessInferenceConfigPostCommit,
  HarnessInferenceConfigRequest,
  HarnessInferenceConfigSupport,
  HarnessInferenceConfigUpdatePlan,
  HarnessInferenceConfigUpdateRequest,
  HarnessInferenceApi,
  HarnessInferenceReasoning,
  HarnessInferenceRoute,
  HarnessSandboxReconcileDeclaration,
  HarnessSandboxReconcileRequest,
  HarnessSandboxReconcileResult,
  HarnessSandboxReconcileTrigger,
  HarnessConfigUrlPolicy,
  HarnessConfigUrlRequest,
  HarnessExitZeroCommand,
  HarnessManagedExtension,
  HarnessMutableConfigPlan,
  HarnessMutableConfigRequest,
} from "./adapter/config";

export interface HarnessConfigAdapterHostModule {
  describeInferenceConfig(request: HarnessInferenceConfigRequest): HarnessInferenceConfigSupport;
  prepareInferenceConfig(
    request: HarnessInferenceConfigUpdateRequest,
  ): HarnessInferenceConfigUpdatePlan;
  prepareConfigUpdate(request: HarnessConfigUpdateRequest): HarnessConfigUpdatePlan;
  classifyConfigUrl(request: HarnessConfigUrlRequest): HarnessConfigUrlPolicy;
  describeMutableConfig(request: HarnessMutableConfigRequest): HarnessMutableConfigPlan;
}

type DeclaredInferenceConfig =
  | {
      readonly support: "mutable";
      readonly providerApiOverrides: readonly {
        readonly provider: string;
        readonly api: "openai-completions" | "anthropic-messages" | "openai-responses";
      }[];
      readonly postCommit: {
        readonly configSync: "best-effort" | "required";
        readonly gatewayRestart: "not-required" | "when-api-changes";
        readonly sandboxReconcile:
          | { readonly kind: "not-required" }
          | {
              readonly kind: "command";
              readonly trigger: "after-config-sync" | "when-config-changes";
              readonly command: readonly string[];
              readonly timeoutSeconds: number;
            };
      };
    }
  | { readonly support: "unsupported"; readonly reason: string };

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

function readSandboxReconcileDeclaration(
  postCommit: ManifestRecord,
): Extract<DeclaredInferenceConfig, { support: "mutable" }>["postCommit"]["sandboxReconcile"] {
  const declaration = readObject(postCommit, "sandbox_reconcile");
  const kind = readString(declaration ?? {}, "kind");
  if (kind === "not-required") return Object.freeze({ kind });
  const trigger = readString(declaration ?? {}, "trigger");
  const rawCommand = declaration?.command;
  const timeoutSeconds = declaration?.timeout_seconds;
  if (
    kind !== "command" ||
    (trigger !== "after-config-sync" && trigger !== "when-config-changes") ||
    !Array.isArray(rawCommand) ||
    rawCommand.length < 1 ||
    rawCommand.length > 32 ||
    !rawCommand.every(
      (argument) =>
        typeof argument === "string" &&
        argument.length > 0 &&
        argument.length <= 4096 &&
        !/[\u0000\r\n]/u.test(argument),
    ) ||
    !path.posix.isAbsolute(rawCommand[0] as string) ||
    path.posix.normalize(rawCommand[0] as string) !== rawCommand[0] ||
    typeof timeoutSeconds !== "number" ||
    !Number.isInteger(timeoutSeconds) ||
    timeoutSeconds < 1 ||
    timeoutSeconds > 120
  ) {
    throw new HarnessConfigModuleError(
      "Installed harness package has an invalid sandbox reconciliation declaration",
    );
  }
  return Object.freeze({
    kind,
    trigger,
    command: Object.freeze([...rawCommand] as string[]),
    timeoutSeconds,
  });
}

function readInferenceConfigDeclaration(manifest: ManifestRecord): DeclaredInferenceConfig {
  const inference = readObject(manifest, "inference");
  const declaration = readObject(inference ?? {}, "config_update");
  const support = readString(declaration ?? {}, "support");
  if (support === "mutable") {
    const rawOverrides = declaration?.provider_api_overrides;
    const postCommit = readObject(declaration ?? {}, "post_commit");
    const configSync = readString(postCommit ?? {}, "config_sync");
    const gatewayRestart = readString(postCommit ?? {}, "gateway_restart");
    if (
      Array.isArray(rawOverrides) &&
      (configSync === "best-effort" || configSync === "required") &&
      (gatewayRestart === "not-required" || gatewayRestart === "when-api-changes")
    ) {
      const sandboxReconcile = readSandboxReconcileDeclaration(postCommit ?? {});
      if (sandboxReconcile.kind === "command") {
        let managedImage: ReturnType<typeof readManagedImageDeclaration>;
        try {
          managedImage = readManagedImageDeclaration(manifest);
        } catch (error) {
          throw new HarnessConfigModuleError(
            "Installed harness package declares sandbox reconciliation without a valid managed-image runtime identity",
            "invalid-adapter",
            { cause: error },
          );
        }
        if (managedImage === null) {
          throw new HarnessConfigModuleError(
            "Installed harness package declares sandbox reconciliation without a valid managed-image runtime identity",
          );
        }
      }
      const seenProviders = new Set<string>();
      const providerApiOverrides = rawOverrides.map((rawOverride) => {
        const override =
          typeof rawOverride === "object" &&
          rawOverride !== null &&
          !Array.isArray(rawOverride) &&
          !(rawOverride instanceof Date)
            ? (rawOverride as ManifestRecord)
            : null;
        const provider = readString(override ?? {}, "provider");
        const api = readString(override ?? {}, "api");
        if (
          !provider ||
          seenProviders.has(provider) ||
          (api !== "openai-completions" &&
            api !== "anthropic-messages" &&
            api !== "openai-responses")
        ) {
          throw new HarnessConfigModuleError(
            "Installed harness package has an invalid inference configuration declaration",
          );
        }
        seenProviders.add(provider);
        return Object.freeze({ provider, api });
      });
      return Object.freeze({
        support,
        providerApiOverrides: Object.freeze(providerApiOverrides),
        postCommit: Object.freeze({
          configSync,
          gatewayRestart,
          sandboxReconcile,
        }),
      });
    }
  }
  const reason = readString(declaration ?? {}, "reason")?.trim();
  if (support === "unsupported" && reason) {
    return Object.freeze({ support, reason });
  }
  throw new HarnessConfigModuleError(
    "Installed harness package has an invalid inference configuration declaration",
  );
}

function requireInferenceDeclarationAgreement<
  Result extends HarnessInferenceConfigSupport | HarnessInferenceConfigUpdatePlan,
>(declaration: DeclaredInferenceConfig, result: Result): Result {
  let agrees = false;
  if (declaration.support === "mutable" && result.kind === "mutable") {
    agrees = isDeepStrictEqual(result.providerApiOverrides, declaration.providerApiOverrides);
  } else if (declaration.support === "mutable" && result.kind === "mutation") {
    agrees = isDeepStrictEqual(declaration.postCommit, {
      configSync: result.postCommit.configSync,
      gatewayRestart: result.postCommit.gatewayRestart.kind,
      sandboxReconcile: result.postCommit.sandboxReconcile,
    });
  } else if (declaration.support === "unsupported" && result.kind === "unsupported") {
    agrees = isDeepStrictEqual(result.reason, declaration.reason);
  }
  if (!agrees) {
    throw new HarnessConfigModuleError(
      "Installed harness inference configuration adapter does not match its manifest declaration",
    );
  }
  return result;
}

/** Load configuration behavior from the exact package recorded for a sandbox. */
export function loadHarnessConfigAdapterHostModule(
  identity: HarnessPackageIdentity,
  options: HarnessPackageStoreOptions = {},
): HarnessConfigAdapterHostModule {
  let declaration: DeclaredInferenceConfig | null = null;
  let adapter: ReturnType<typeof loadHarnessAdapter<typeof HARNESS_CONFIG_ADAPTER_CONTRACT>>;
  try {
    adapter = loadHarnessAdapter(identity, HARNESS_CONFIG_ADAPTER_CONTRACT, {
      ...(options.storeRoot === undefined ? {} : { storeRoot: options.storeRoot }),
      validateManifest(manifest) {
        declaration = readInferenceConfigDeclaration(manifest);
      },
    });
    if (declaration === null) {
      throw new HarnessConfigModuleError(
        "Installed harness package has no inference configuration declaration",
      );
    }
  } catch (error) {
    configModuleFailure(error);
  }
  const inferenceDeclaration = declaration;
  return Object.freeze({
    describeInferenceConfig(request: HarnessInferenceConfigRequest): HarnessInferenceConfigSupport {
      return requireInferenceDeclarationAgreement(
        inferenceDeclaration,
        callConfigAdapter(() => adapter.describeInference(request)),
      );
    },
    prepareInferenceConfig(
      request: HarnessInferenceConfigUpdateRequest,
    ): HarnessInferenceConfigUpdatePlan {
      return requireInferenceDeclarationAgreement(
        inferenceDeclaration,
        callConfigAdapter(() => adapter.prepareInference(request)),
      );
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
