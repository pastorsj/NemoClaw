// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";
import vm from "node:vm";
import { TextDecoder } from "node:util";

import { readMcpCapability, readString } from "./manifest-readers";
import { resolvePinnedHarnessPackage, type HarnessPackageStoreOptions } from "./package/store";
import {
  assertTreeAuthority,
  getPackageTreeAuthority,
  readVerifiedFile,
  validateHarnessPackageTree,
} from "./package/tree";
import type { HarnessPackageIdentity } from "./package/types";

const MCP_ADAPTER_HOST_MODULE = "host/mcp-adapter.cts";
const MCP_ADAPTER_HOST_MODULE_MAX_BYTES = 512 * 1024;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export interface HarnessMcpAdapterEntry {
  readonly server: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
}

export interface HarnessMcpRegistrationRequest {
  readonly entry: HarnessMcpAdapterEntry;
  readonly managedEntries: readonly HarnessMcpAdapterEntry[];
  readonly replaceExisting: boolean;
  readonly teardownRollback: boolean;
  readonly configRoot: string | null;
}

export interface HarnessMcpRemovalRequest {
  readonly entry: HarnessMcpAdapterEntry;
  readonly force: boolean;
  readonly adaptiveTeardown: boolean;
  readonly configRoot: string | null;
}

export type HarnessMcpAdapterCommand = string | readonly string[];

export interface HarnessMcpAdapterHostModule {
  buildMcpRegistrationCommand(request: HarnessMcpRegistrationRequest): HarnessMcpAdapterCommand;
  buildMcpRemovalCommand(request: HarnessMcpRemovalRequest): HarnessMcpAdapterCommand;
}

export interface LoadHarnessMcpAdapterHostModuleOptions extends HarnessPackageStoreOptions {
  readonly expectedAdapter?: string;
}

interface RawHarnessMcpAdapterHostModule {
  readonly buildMcpRegistrationCommand?: unknown;
  readonly buildMcpRemovalCommand?: unknown;
}

export class HarnessPackageHostModuleError extends Error {
  override readonly name = "HarnessPackageHostModuleError";

  constructor(message: string, options: ErrorOptions = {}) {
    super(message, options);
  }
}

function hostModuleFailure(message: string, cause?: unknown): HarnessPackageHostModuleError {
  return new HarnessPackageHostModuleError(message, cause === undefined ? {} : { cause });
}

function decodeHostModule(source: Buffer): string {
  try {
    return UTF8_DECODER.decode(source);
  } catch (error) {
    throw hostModuleFailure("Installed harness MCP adapter must contain valid UTF-8", error);
  }
}

function loadModuleExports(source: string, filename: string): RawHarnessMcpAdapterHostModule {
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
        throw hostModuleFailure(
          `Installed harness MCP adapter must be self-contained; import '${String(specifier)}' is unavailable`,
        );
      },
      moduleRecord,
      filename,
      path.dirname(filename),
    );
  } catch (error) {
    if (error instanceof HarnessPackageHostModuleError) throw error;
    throw hostModuleFailure("Installed harness MCP adapter could not be evaluated", error);
  }
  if (
    moduleRecord.exports === null ||
    typeof moduleRecord.exports !== "object" ||
    Array.isArray(moduleRecord.exports)
  ) {
    throw hostModuleFailure("Installed harness MCP adapter must export one module object");
  }
  return moduleRecord.exports as RawHarnessMcpAdapterHostModule;
}

function requireBuilder(
  moduleExports: RawHarnessMcpAdapterHostModule,
  name: keyof RawHarnessMcpAdapterHostModule,
): (request: unknown) => unknown {
  const builder = moduleExports[name];
  if (typeof builder !== "function") {
    throw hostModuleFailure(`Installed harness MCP adapter must export ${name}`);
  }
  return builder as (request: unknown) => unknown;
}

function cloneEntry(entry: HarnessMcpAdapterEntry): HarnessMcpAdapterEntry {
  return Object.freeze({
    server: entry.server,
    url: entry.url,
    headers: Object.freeze({ ...entry.headers }),
  });
}

function cloneRegistrationRequest(
  request: HarnessMcpRegistrationRequest,
): HarnessMcpRegistrationRequest {
  return Object.freeze({
    entry: cloneEntry(request.entry),
    managedEntries: Object.freeze(request.managedEntries.map(cloneEntry)),
    replaceExisting: request.replaceExisting,
    teardownRollback: request.teardownRollback,
    configRoot: request.configRoot,
  });
}

function cloneRemovalRequest(request: HarnessMcpRemovalRequest): HarnessMcpRemovalRequest {
  return Object.freeze({
    entry: cloneEntry(request.entry),
    force: request.force,
    adaptiveTeardown: request.adaptiveTeardown,
    configRoot: request.configRoot,
  });
}

function requireCommand(value: unknown, builder: string): HarnessMcpAdapterCommand {
  if (typeof value === "string" && value.trim().length > 0) return value;
  if (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((argument) => typeof argument === "string" && argument.length > 0)
  ) {
    return Object.freeze([...value]);
  }
  throw hostModuleFailure(`Installed harness MCP adapter ${builder} returned an invalid command`);
}

function readReceiptBoundHostModule(
  identity: HarnessPackageIdentity,
  options: LoadHarnessMcpAdapterHostModuleOptions,
): { readonly filename: string; readonly source: string } {
  let installed;
  try {
    installed = resolvePinnedHarnessPackage(
      identity,
      options.storeRoot === undefined ? {} : { storeRoot: options.storeRoot },
    );
    const manifestName = readString(installed.packageManifest.manifest, "name");
    const mcpCapability = readMcpCapability(installed.packageManifest.manifest);
    if (
      manifestName !== installed.identity.id ||
      mcpCapability.support !== "bridge" ||
      !mcpCapability.adapter ||
      (options.expectedAdapter !== undefined && mcpCapability.adapter !== options.expectedAdapter)
    ) {
      throw hostModuleFailure(
        "Installed harness package manifest does not match the requested MCP adapter",
      );
    }
    const tree = validateHarnessPackageTree(installed.packageRoot, { sourceTrust: "mutable" });
    if (tree.contentDigest !== installed.identity.contentDigest) {
      throw new Error("installed package tree does not match its receipt");
    }
    const authority = getPackageTreeAuthority(tree);
    const moduleRelativePath = path.posix.join(
      path.posix.dirname(installed.packageManifest.envelope.manifest),
      MCP_ADAPTER_HOST_MODULE,
    );
    const moduleEntry = authority.entries.find(
      (entry) => entry.relativePath === moduleRelativePath,
    );
    if (!moduleEntry || moduleEntry.type !== "file") {
      throw hostModuleFailure("Installed harness package does not contain host/mcp-adapter.cts");
    }
    if (moduleEntry.stat.size > BigInt(MCP_ADAPTER_HOST_MODULE_MAX_BYTES)) {
      throw hostModuleFailure("Installed harness MCP adapter exceeds its read boundary");
    }
    const source = readVerifiedFile(moduleEntry, MCP_ADAPTER_HOST_MODULE_MAX_BYTES);
    assertTreeAuthority(authority);
    return Object.freeze({
      filename: moduleEntry.absolutePath,
      source: decodeHostModule(source),
    });
  } catch (error) {
    if (error instanceof HarnessPackageHostModuleError) throw error;
    throw hostModuleFailure(
      "Installed harness package failed MCP adapter integrity validation",
      error,
    );
  }
}

/** Load the fixed MCP adapter module from an exact installed package receipt. */
export function loadHarnessMcpAdapterHostModule(
  identity: HarnessPackageIdentity,
  options: LoadHarnessMcpAdapterHostModuleOptions = {},
): HarnessMcpAdapterHostModule {
  const loaded = readReceiptBoundHostModule(identity, options);
  const moduleExports = loadModuleExports(loaded.source, loaded.filename);
  const buildRegistration = requireBuilder(moduleExports, "buildMcpRegistrationCommand");
  const buildRemoval = requireBuilder(moduleExports, "buildMcpRemovalCommand");
  return Object.freeze({
    buildMcpRegistrationCommand(request: HarnessMcpRegistrationRequest): HarnessMcpAdapterCommand {
      return requireCommand(
        buildRegistration(cloneRegistrationRequest(request)),
        "buildMcpRegistrationCommand",
      );
    },
    buildMcpRemovalCommand(request: HarnessMcpRemovalRequest): HarnessMcpAdapterCommand {
      return requireCommand(buildRemoval(cloneRemovalRequest(request)), "buildMcpRemovalCommand");
    },
  });
}
