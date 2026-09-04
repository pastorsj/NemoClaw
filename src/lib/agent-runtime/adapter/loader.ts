// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";
import vm from "node:vm";
import { TextDecoder } from "node:util";

import { readString } from "../manifest-readers";
import type { ManifestRecord } from "../manifest-types";
import { resolvePinnedHarnessPackage, type HarnessPackageStoreOptions } from "../package/store";
import {
  assertTreeAuthority,
  getPackageTreeAuthority,
  readVerifiedFile,
  validateHarnessPackageTree,
} from "../package/tree";
import type { HarnessPackageIdentity } from "../package/types";
import type {
  HarnessAdapterContract,
  HarnessAdapterOperations,
  LoadedHarnessAdapter,
} from "./contract";
import { HarnessAdapterSchemaError, prepareHarnessAdapterValue } from "./schema";

const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const ADAPTER_MODULE_PATH_PATTERN = /^host\/[a-z][a-z0-9-]*-adapter\.cts$/u;
const ADAPTER_EVALUATION_TIMEOUT_MS = 500;
const ADAPTER_REQUEST_SLOT = "__nemoclawAdapterRequestJson";
const ADAPTER_BRIDGE_NAME = "__nemoclawInvokeAdapter";

export interface LoadHarnessAdapterOptions extends HarnessPackageStoreOptions {
  readonly validateManifest?: (manifest: ManifestRecord) => void;
}

interface HarnessAdapterRuntime {
  readonly context: vm.Context;
  readonly invocationScripts: Readonly<Record<string, vm.Script>>;
}

export class HarnessAdapterError extends Error {
  override readonly name: string = "HarnessAdapterError";

  constructor(message: string, options: ErrorOptions = {}) {
    super(message, options);
  }
}

/** Identifies the only compatibility-safe absence: a package predates a fixed adapter module. */
export class HarnessAdapterModuleMissingError extends HarnessAdapterError {
  override readonly name = "HarnessAdapterModuleMissingError";

  constructor(readonly modulePath: string) {
    super(`Installed harness package does not contain ${modulePath}`);
  }
}

function adapterFailure(message: string, cause?: unknown): HarnessAdapterError {
  return new HarnessAdapterError(message, cause === undefined ? {} : { cause });
}

function decodeAdapterModule(source: Buffer, displayName: string): string {
  try {
    return UTF8_DECODER.decode(source);
  } catch (error) {
    throw adapterFailure(`Installed harness ${displayName} must contain valid UTF-8`, error);
  }
}

function buildAdapterRuntimeSource(
  source: string,
  filename: string,
  contract: HarnessAdapterContract<HarnessAdapterOperations>,
): string {
  const operations = Object.entries(contract.operations).map(
    ([operationName, operation]) => [operationName, operation.exportName] as const,
  );
  return `
"use strict";
(() => {
  const arrayIsArray = Array.isArray;
  const jsonParse = JSON.parse;
  const jsonStringify = JSON.stringify;
  const objectCreate = Object.create;
  const objectDefineProperty = Object.defineProperty;
  const objectFreeze = Object.freeze;
  const objectIsFrozen = Object.isFrozen;
  const objectValues = Object.values;
  const reflectApply = Reflect.apply;
  const objectToString = Object.prototype.toString;
  const promiseConstructor = Promise;
  const operationEntries = ${JSON.stringify(operations)};
  const moduleRecord = objectCreate(null);
  const initialExports = objectCreate(null);
  moduleRecord.exports = initialExports;
  const unavailableRequire = (specifier) => {
    const error = new Error("Harness adapter imports are unavailable");
    error.code = "NEMOCLAW_ADAPTER_IMPORT_UNAVAILABLE";
    error.specifier = String(specifier);
    throw error;
  };

  try {
    (function (exports, require, module, __filename, __dirname) {
      "use strict";
${source}
    })(initialExports, unavailableRequire, moduleRecord, ${JSON.stringify(filename)}, ${JSON.stringify(path.dirname(filename))});
  } catch (error) {
    return error && error.code === "NEMOCLAW_ADAPTER_IMPORT_UNAVAILABLE"
      ? "error:import"
      : "error:evaluation";
  }

  const moduleExports = moduleRecord.exports;
  if (moduleExports === null || typeof moduleExports !== "object" || arrayIsArray(moduleExports)) {
    return "error:exports";
  }

  const builders = objectCreate(null);
  try {
    for (let index = 0; index < operationEntries.length; index += 1) {
      const operationName = operationEntries[index][0];
      const exportName = operationEntries[index][1];
      const builder = moduleExports[exportName];
      if (typeof builder !== "function") return "error:missing:" + String(index);
      builders[operationName] = builder;
    }
  } catch {
    return "error:evaluation";
  }
  objectFreeze(builders);

  const freezeJson = (value) => {
    if (value === null || typeof value !== "object" || objectIsFrozen(value)) return value;
    for (const entry of objectValues(value)) freezeJson(entry);
    return objectFreeze(value);
  };

  const invokeAdapter = (operationName, requestJson) => {
    try {
      const request = freezeJson(jsonParse(requestJson));
      const result = builders[operationName](request);
      if (
        result instanceof promiseConstructor ||
        (result !== null &&
          (typeof result === "object" || typeof result === "function") &&
          (reflectApply(objectToString, result, []) === "[object Promise]" ||
            typeof result.then === "function"))
      ) {
        return "error:async";
      }
      const resultJson = jsonStringify(result);
      if (typeof resultJson !== "string") return "error:serialization";
      if (resultJson.length > ${String(contract.resultMaxBytes)}) return "error:oversized";
      return "ok:" + resultJson;
    } catch {
      return "error:operation";
    }
  };

  objectDefineProperty(globalThis, ${JSON.stringify(ADAPTER_BRIDGE_NAME)}, {
    value: invokeAdapter,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return "ready";
})()
`;
}

function readAdapterInitialization(
  result: unknown,
  contract: HarnessAdapterContract<HarnessAdapterOperations>,
): void {
  if (result === "ready") return;
  if (result === "error:import") {
    throw adapterFailure(
      `Installed harness ${contract.displayName} must be self-contained; imports are unavailable`,
    );
  }
  if (result === "error:exports") {
    throw adapterFailure(`Installed harness ${contract.displayName} must export one module object`);
  }
  if (typeof result === "string" && result.startsWith("error:missing:")) {
    const missingIndex = Number(result.slice("error:missing:".length));
    const operation = Object.values(contract.operations)[missingIndex];
    if (operation) {
      throw adapterFailure(
        `Installed harness ${contract.displayName} must export ${operation.exportName}`,
      );
    }
  }
  throw adapterFailure(`Installed harness ${contract.displayName} could not be evaluated`);
}

function loadAdapterRuntime(
  source: string,
  filename: string,
  contract: HarnessAdapterContract<HarnessAdapterOperations>,
): HarnessAdapterRuntime {
  const context = vm.createContext(Object.create(null), {
    codeGeneration: { strings: false, wasm: false },
    microtaskMode: "afterEvaluate",
  });
  try {
    const initialization = new vm.Script(buildAdapterRuntimeSource(source, filename, contract), {
      filename,
    }).runInContext(context, {
      timeout: ADAPTER_EVALUATION_TIMEOUT_MS,
      displayErrors: false,
    });
    readAdapterInitialization(initialization, contract);
  } catch (error) {
    if (error instanceof HarnessAdapterError) throw error;
    throw adapterFailure(`Installed harness ${contract.displayName} could not be evaluated`);
  }

  const invocationScripts: Record<string, vm.Script> = Object.create(null) as Record<
    string,
    vm.Script
  >;
  for (const operationName of Object.keys(contract.operations)) {
    invocationScripts[operationName] = new vm.Script(
      `globalThis[${JSON.stringify(ADAPTER_BRIDGE_NAME)}](${JSON.stringify(operationName)}, globalThis[${JSON.stringify(ADAPTER_REQUEST_SLOT)}])`,
      { filename: `${filename}#${operationName}` },
    );
  }
  return Object.freeze({ context, invocationScripts: Object.freeze(invocationScripts) });
}

function validateAdapterContract(contract: HarnessAdapterContract<HarnessAdapterOperations>): void {
  if (
    !ADAPTER_MODULE_PATH_PATTERN.test(contract.modulePath) ||
    !Number.isSafeInteger(contract.sourceMaxBytes) ||
    contract.sourceMaxBytes <= 0 ||
    !Number.isSafeInteger(contract.requestMaxBytes) ||
    contract.requestMaxBytes <= 0 ||
    !Number.isSafeInteger(contract.resultMaxBytes) ||
    contract.resultMaxBytes <= 0 ||
    Object.keys(contract.operations).length === 0
  ) {
    throw adapterFailure("Harness adapter contract is invalid");
  }
}

function readReceiptBoundAdapterModule(
  identity: HarnessPackageIdentity,
  contract: HarnessAdapterContract<HarnessAdapterOperations>,
  options: LoadHarnessAdapterOptions,
): { readonly filename: string; readonly source: string } {
  try {
    validateAdapterContract(contract);
    const installed = resolvePinnedHarnessPackage(
      identity,
      options.storeRoot === undefined ? {} : { storeRoot: options.storeRoot },
    );
    const manifestName = readString(installed.packageManifest.manifest, "name");
    if (manifestName !== installed.identity.id) {
      throw adapterFailure("Installed harness package manifest does not match its receipt");
    }
    try {
      prepareHarnessAdapterValue({
        value: installed.packageManifest.manifest,
        schema: contract.manifestSchema,
        maxBytes: contract.requestMaxBytes,
        label: `Installed harness package manifest for ${contract.displayName}`,
      });
    } catch (error) {
      if (error instanceof HarnessAdapterSchemaError) {
        throw adapterFailure(
          `Installed harness package manifest does not declare ${contract.displayName}`,
          error,
        );
      }
      throw error;
    }
    options.validateManifest?.(installed.packageManifest.manifest);

    const tree = validateHarnessPackageTree(installed.packageRoot, { sourceTrust: "mutable" });
    if (tree.contentDigest !== installed.identity.contentDigest) {
      throw new Error("installed package tree does not match its receipt");
    }
    const authority = getPackageTreeAuthority(tree);
    const moduleRelativePath = path.posix.join(
      path.posix.dirname(installed.packageManifest.envelope.manifest),
      contract.modulePath,
    );
    const moduleEntry = authority.entries.find(
      (entry) => entry.relativePath === moduleRelativePath,
    );
    if (!moduleEntry || moduleEntry.type !== "file") {
      throw new HarnessAdapterModuleMissingError(contract.modulePath);
    }
    if (moduleEntry.stat.size > BigInt(contract.sourceMaxBytes)) {
      throw adapterFailure(`Installed harness ${contract.displayName} exceeds its read boundary`);
    }
    const source = readVerifiedFile(moduleEntry, contract.sourceMaxBytes);
    assertTreeAuthority(authority);
    return Object.freeze({
      filename: moduleEntry.absolutePath,
      source: decodeAdapterModule(source, contract.displayName),
    });
  } catch (error) {
    if (error instanceof HarnessAdapterError) throw error;
    throw adapterFailure(
      `Installed harness package failed ${contract.displayName} integrity validation`,
      error,
    );
  }
}

function buildLoadedOperations<Contract extends HarnessAdapterContract<HarnessAdapterOperations>>(
  runtime: HarnessAdapterRuntime,
  contract: Contract,
): LoadedHarnessAdapter<Contract> {
  const loaded: Record<string, (request: unknown) => unknown> = Object.create(null) as Record<
    string,
    (request: unknown) => unknown
  >;
  for (const [operationName, operation] of Object.entries(contract.operations)) {
    loaded[operationName] = (request: unknown): unknown => {
      let preparedRequest: unknown;
      try {
        preparedRequest = prepareHarnessAdapterValue({
          value: request,
          schema: operation.requestSchema,
          maxBytes: contract.requestMaxBytes,
          label: `Installed harness ${contract.displayName} ${operation.exportName} request`,
        });
      } catch (error) {
        if (error instanceof HarnessAdapterSchemaError) {
          throw adapterFailure(error.message, error);
        }
        throw error;
      }

      const requestJson = JSON.stringify(preparedRequest);
      let bridgeResult: unknown;
      try {
        Object.defineProperty(runtime.context, ADAPTER_REQUEST_SLOT, {
          value: requestJson,
          enumerable: false,
          configurable: true,
          writable: false,
        });
        bridgeResult = runtime.invocationScripts[operationName]?.runInContext(runtime.context, {
          timeout: ADAPTER_EVALUATION_TIMEOUT_MS,
          displayErrors: false,
        });
      } catch {
        throw adapterFailure(
          `Installed harness ${contract.displayName} ${operation.exportName} failed`,
        );
      } finally {
        Reflect.deleteProperty(runtime.context, ADAPTER_REQUEST_SLOT);
      }

      if (typeof bridgeResult !== "string" || !bridgeResult.startsWith("ok:")) {
        throw adapterFailure(
          `Installed harness ${contract.displayName} ${operation.exportName} failed`,
        );
      }
      const resultJson = bridgeResult.slice("ok:".length);
      if (Buffer.byteLength(resultJson, "utf8") > contract.resultMaxBytes) {
        throw adapterFailure(
          `Installed harness ${contract.displayName} ${operation.exportName} returned an invalid ${operation.resultDescription}`,
        );
      }

      let result: unknown;
      try {
        result = JSON.parse(resultJson) as unknown;
      } catch {
        throw adapterFailure(
          `Installed harness ${contract.displayName} ${operation.exportName} returned an invalid ${operation.resultDescription}`,
        );
      }

      try {
        return prepareHarnessAdapterValue({
          value: result,
          schema: operation.resultSchema,
          maxBytes: contract.resultMaxBytes,
          label: `Installed harness ${contract.displayName} ${operation.exportName} returned an invalid ${operation.resultDescription}`,
        });
      } catch (error) {
        if (error instanceof HarnessAdapterSchemaError) {
          throw adapterFailure(error.message, error);
        }
        throw error;
      }
    };
  }
  return Object.freeze(loaded) as LoadedHarnessAdapter<Contract>;
}

/**
 * Load fixed operations from an exact installed package without passing host capabilities.
 *
 * The VM supplies a narrow JSON boundary and execution timeout. It is defense in depth for an
 * integrity-verified package, not a sandbox for hostile code.
 */
export function loadHarnessAdapter<
  const Contract extends HarnessAdapterContract<HarnessAdapterOperations>,
>(
  identity: HarnessPackageIdentity,
  contract: Contract,
  options: LoadHarnessAdapterOptions = {},
): LoadedHarnessAdapter<Contract> {
  const loaded = readReceiptBoundAdapterModule(identity, contract, options);
  return buildLoadedOperations(
    loadAdapterRuntime(loaded.source, loaded.filename, contract),
    contract,
  );
}
