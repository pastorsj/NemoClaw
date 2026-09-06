// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import path from "node:path";
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
const ADAPTER_CHILD_TIMEOUT_MS = 1_000;
const ADAPTER_CHILD_MEMORY_MIB = 256;
const MAX_ADAPTER_SOURCE_BYTES = 2 * 1024 * 1024;
const MAX_ADAPTER_VALUE_BYTES = 64 * 1024 * 1024;
const MAX_ADAPTER_OPERATIONS = 32;
const MAX_ADAPTER_CHILD_INPUT_BYTES = 70 * 1024 * 1024;

export interface LoadHarnessAdapterOptions extends HarnessPackageStoreOptions {
  readonly validateManifest?: (manifest: ManifestRecord) => void;
}

/** Already-authorized adapter bytes that still cross the common child and schema boundary. */
export interface HarnessAdapterSource {
  readonly filename: string;
  readonly source: string;
}

interface HarnessAdapterRuntime {
  readonly source: string;
  readonly filename: string;
  readonly operations: readonly (readonly [string, string])[];
  readonly resultMaxBytes: number;
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

function adapterWorkerPath(): { readonly path: string; readonly stripTypes: boolean } {
  const sourceExecution = __filename.endsWith(".ts");
  return Object.freeze({
    path: path.join(__dirname, sourceExecution ? "worker.ts" : "worker.js"),
    stripTypes: sourceExecution,
  });
}

function runAdapterWorker(
  runtime: HarnessAdapterRuntime,
  operationName?: string,
  request?: unknown,
): string {
  const worker = adapterWorkerPath();
  const payload = JSON.stringify({
    source: runtime.source,
    filename: runtime.filename,
    operations: runtime.operations,
    ...(operationName === undefined ? {} : { operationName, request }),
    resultMaxBytes: runtime.resultMaxBytes,
  });
  if (Buffer.byteLength(payload, "utf8") > MAX_ADAPTER_CHILD_INPUT_BYTES) {
    throw adapterFailure("Installed harness adapter child input exceeds its boundary");
  }
  const result = spawnSync(
    process.execPath,
    [
      `--max-old-space-size=${String(ADAPTER_CHILD_MEMORY_MIB)}`,
      "--max-semi-space-size=8",
      ...(worker.stripTypes ? ["--experimental-strip-types", "--no-warnings"] : []),
      worker.path,
    ],
    {
      input: payload,
      encoding: "utf8",
      timeout: ADAPTER_CHILD_TIMEOUT_MS,
      maxBuffer: runtime.resultMaxBytes + 64 * 1024,
      env: { NODE_NO_WARNINGS: "1" },
      windowsHide: true,
    },
  );
  if (result.error || result.status !== 0 || result.signal || typeof result.stdout !== "string") {
    throw adapterFailure("Installed harness adapter child process failed");
  }
  return result.stdout;
}

function loadAdapterRuntime(
  source: string,
  filename: string,
  contract: HarnessAdapterContract<HarnessAdapterOperations>,
): HarnessAdapterRuntime {
  const runtime = Object.freeze({
    source,
    filename,
    operations: Object.freeze(
      Object.entries(contract.operations).map(([operationName, operation]) =>
        Object.freeze([operationName, operation.exportName] as const),
      ),
    ),
    resultMaxBytes: contract.resultMaxBytes,
  });
  try {
    readAdapterInitialization(runAdapterWorker(runtime), contract);
  } catch (error) {
    if (error instanceof HarnessAdapterError) throw error;
    throw adapterFailure(`Installed harness ${contract.displayName} could not be evaluated`);
  }
  return runtime;
}

function requireBoundedAdapterSource(
  source: HarnessAdapterSource,
  contract: HarnessAdapterContract<HarnessAdapterOperations>,
): HarnessAdapterSource {
  validateAdapterContract(contract);
  if (
    typeof source.filename !== "string" ||
    source.filename.length === 0 ||
    typeof source.source !== "string" ||
    Buffer.byteLength(source.source, "utf8") > contract.sourceMaxBytes
  ) {
    throw adapterFailure(`Installed harness ${contract.displayName} exceeds its read boundary`);
  }
  return Object.freeze({ filename: source.filename, source: source.source });
}

function validateAdapterContract(contract: HarnessAdapterContract<HarnessAdapterOperations>): void {
  if (
    !ADAPTER_MODULE_PATH_PATTERN.test(contract.modulePath) ||
    !Number.isSafeInteger(contract.sourceMaxBytes) ||
    contract.sourceMaxBytes <= 0 ||
    contract.sourceMaxBytes > MAX_ADAPTER_SOURCE_BYTES ||
    !Number.isSafeInteger(contract.requestMaxBytes) ||
    contract.requestMaxBytes <= 0 ||
    contract.requestMaxBytes > MAX_ADAPTER_VALUE_BYTES ||
    !Number.isSafeInteger(contract.resultMaxBytes) ||
    contract.resultMaxBytes <= 0 ||
    contract.resultMaxBytes > MAX_ADAPTER_VALUE_BYTES ||
    Object.keys(contract.operations).length === 0 ||
    Object.keys(contract.operations).length > MAX_ADAPTER_OPERATIONS
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

      let bridgeResult: unknown;
      try {
        bridgeResult = runAdapterWorker(runtime, operationName, preparedRequest);
      } catch {
        throw adapterFailure(
          `Installed harness ${contract.displayName} ${operation.exportName} failed`,
        );
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
 * A constrained core-owned child supplies the narrow JSON boundary. Candidate evaluation and
 * invocation never share the CLI process or receive host capabilities.
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

/** Load caller-authorized image-local bytes through the common constrained adapter boundary. */
export function loadHarnessAdapterFromSource<
  const Contract extends HarnessAdapterContract<HarnessAdapterOperations>,
>(source: HarnessAdapterSource, contract: Contract): LoadedHarnessAdapter<Contract> {
  const bounded = requireBoundedAdapterSource(source, contract);
  return buildLoadedOperations(
    loadAdapterRuntime(bounded.source, bounded.filename, contract),
    contract,
  );
}
