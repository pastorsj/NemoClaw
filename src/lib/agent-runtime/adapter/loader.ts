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
  HarnessAdapterOperation,
  HarnessAdapterOperations,
  LoadedHarnessAdapter,
} from "./contract";
import { HarnessAdapterSchemaError, prepareHarnessAdapterValue } from "./schema";

const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const ADAPTER_MODULE_PATH_PATTERN = /^host\/[a-z][a-z0-9-]*-adapter\.cts$/u;

export interface LoadHarnessAdapterOptions extends HarnessPackageStoreOptions {
  readonly validateManifest?: (manifest: ManifestRecord) => void;
}

type RawHarnessAdapterModule = Readonly<Record<string, unknown>>;

export class HarnessAdapterError extends Error {
  override readonly name = "HarnessAdapterError";

  constructor(message: string, options: ErrorOptions = {}) {
    super(message, options);
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

function loadModuleExports(
  source: string,
  filename: string,
  displayName: string,
): RawHarnessAdapterModule {
  const moduleRecord: { exports: unknown } = { exports: {} };
  const initialExports = moduleRecord.exports;
  const context = vm.createContext(Object.create(null), {
    codeGeneration: { strings: false, wasm: false },
  });
  try {
    const execute = vm.compileFunction(
      source,
      ["exports", "require", "module", "__filename", "__dirname"],
      { filename, parsingContext: context },
    );
    execute(
      initialExports,
      (specifier: unknown): never => {
        throw adapterFailure(
          `Installed harness ${displayName} must be self-contained; import '${String(specifier)}' is unavailable`,
        );
      },
      moduleRecord,
      filename,
      path.dirname(filename),
    );
  } catch (error) {
    if (error instanceof HarnessAdapterError) throw error;
    throw adapterFailure(`Installed harness ${displayName} could not be evaluated`, error);
  }
  if (
    moduleRecord.exports === null ||
    typeof moduleRecord.exports !== "object" ||
    Array.isArray(moduleRecord.exports)
  ) {
    throw adapterFailure(`Installed harness ${displayName} must export one module object`);
  }
  return moduleRecord.exports as RawHarnessAdapterModule;
}

function requireOperationBuilder(
  moduleExports: RawHarnessAdapterModule,
  operation: HarnessAdapterOperation<unknown, unknown>,
  displayName: string,
): (request: unknown) => unknown {
  const builder = moduleExports[operation.exportName];
  if (typeof builder !== "function") {
    throw adapterFailure(`Installed harness ${displayName} must export ${operation.exportName}`);
  }
  return builder as (request: unknown) => unknown;
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
      throw adapterFailure(`Installed harness package does not contain ${contract.modulePath}`);
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
  moduleExports: RawHarnessAdapterModule,
  contract: Contract,
): LoadedHarnessAdapter<Contract> {
  const loaded: Record<string, (request: unknown) => unknown> = Object.create(null) as Record<
    string,
    (request: unknown) => unknown
  >;
  for (const [operationName, operation] of Object.entries(contract.operations)) {
    const builder = requireOperationBuilder(moduleExports, operation, contract.displayName);
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

      let result: unknown;
      try {
        result = builder(preparedRequest);
      } catch (error) {
        if (error instanceof HarnessAdapterError) throw error;
        throw adapterFailure(
          `Installed harness ${contract.displayName} ${operation.exportName} failed`,
          error,
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

/** Load fixed operations from an exact installed package without granting host capabilities. */
export function loadHarnessAdapter<
  const Contract extends HarnessAdapterContract<HarnessAdapterOperations>,
>(
  identity: HarnessPackageIdentity,
  contract: Contract,
  options: LoadHarnessAdapterOptions = {},
): LoadedHarnessAdapter<Contract> {
  const loaded = readReceiptBoundAdapterModule(identity, contract, options);
  return buildLoadedOperations(
    loadModuleExports(loaded.source, loaded.filename, contract.displayName),
    contract,
  );
}
