// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  loadHarnessCommonJsModule,
  resolveHarnessPackage,
} from "../../../harness/commonjs-runtime";
import {
  requireExactRuntimeKeys,
  requireRuntimeArgv,
  requireRuntimeCommand,
  requireRuntimeRecord,
  requireRuntimeStringArray,
  requireRuntimeText,
} from "./mcp-bridge-runtime-validation";

export type HermesMcpRuntimeEntry = Readonly<{
  server: string;
  url: string;
  headers: Record<string, string>;
}>;

export type HermesMcpRuntime = Readonly<{
  HERMES_MCP_TRANSACTION_HELPER: string;
  buildInspectCommand(payload: string): string[];
  buildIntentPayload(
    entries: readonly HermesMcpRuntimeEntry[],
    managedServerNames: readonly string[],
  ): { present: Record<string, Record<string, unknown>>; absent: string[] };
  buildProbeCommand(): string[];
  buildRegisterCommand(entry: HermesMcpRuntimeEntry, replaceExisting?: boolean): string[];
  buildRemoveCommand(entry: HermesMcpRuntimeEntry, force?: boolean): string[];
  buildStatusCommand(entry: HermesMcpRuntimeEntry): string;
  managedServerConfig(entry: HermesMcpRuntimeEntry): Record<string, unknown>;
}>;

const RUNTIME_OWNER = "Hermes harness MCP adapter";

let cachedRuntime: {
  selectionKey: string;
  packageRoot: string;
  module: HermesMcpRuntime;
} | null = null;

function requireHeaders(
  value: unknown,
  expected: Record<string, string>,
  label: string,
): Readonly<Record<string, string>> {
  const record = requireRuntimeRecord(value, RUNTIME_OWNER, label);
  requireExactRuntimeKeys(record, Object.keys(expected), RUNTIME_OWNER, label);
  for (const [name, expectedValue] of Object.entries(expected)) {
    if (record[name] !== expectedValue)
      throw new Error(`${RUNTIME_OWNER} returned invalid ${label}.`);
  }
  return Object.freeze({ ...expected });
}

function requireManagedServerConfig(
  value: unknown,
  entry: HermesMcpRuntimeEntry,
): Record<string, unknown> {
  const config = requireRuntimeRecord(value, RUNTIME_OWNER, "managed server config");
  const hasHeaders = Object.keys(entry.headers).length > 0;
  requireExactRuntimeKeys(
    config,
    ["url", "enabled", "timeout", "connect_timeout", "tools", ...(hasHeaders ? ["headers"] : [])],
    RUNTIME_OWNER,
    "managed server config",
  );
  const tools = requireRuntimeRecord(config.tools, RUNTIME_OWNER, "managed server tools");
  requireExactRuntimeKeys(tools, ["resources", "prompts"], RUNTIME_OWNER, "managed server tools");
  if (
    config.url !== entry.url ||
    config.enabled !== true ||
    config.timeout !== 120 ||
    config.connect_timeout !== 60 ||
    tools.resources !== true ||
    tools.prompts !== true
  ) {
    throw new Error(`${RUNTIME_OWNER} returned an invalid managed server config.`);
  }
  const validated: Record<string, unknown> = {
    url: entry.url,
    enabled: true,
    timeout: 120,
    connect_timeout: 60,
    tools: Object.freeze({ resources: true, prompts: true }),
  };
  if (hasHeaders) {
    validated.headers = requireHeaders(
      config.headers,
      entry.headers,
      "managed server config headers",
    );
  }
  return Object.freeze(validated);
}

function requireIntentPayload(
  value: unknown,
  entries: readonly HermesMcpRuntimeEntry[],
  managedServerNames: readonly string[],
): { present: Record<string, Record<string, unknown>>; absent: string[] } {
  const payload = requireRuntimeRecord(value, RUNTIME_OWNER, "intent payload");
  requireExactRuntimeKeys(payload, ["present", "absent"], RUNTIME_OWNER, "intent payload");
  const present = requireRuntimeRecord(payload.present, RUNTIME_OWNER, "intent present map");
  const entriesByName = new Map(entries.map((entry) => [entry.server, entry]));
  requireExactRuntimeKeys(present, [...entriesByName.keys()], RUNTIME_OWNER, "intent present map");
  const validatedPresent: Record<string, Record<string, unknown>> = {};
  for (const [server, entry] of [...entriesByName.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    validatedPresent[server] = requireManagedServerConfig(present[server], entry);
  }
  const absent = requireRuntimeStringArray(
    payload.absent,
    RUNTIME_OWNER,
    "intent absent list",
    256,
    true,
  );
  const expectedAbsent = [...new Set(managedServerNames)]
    .filter((name) => !entriesByName.has(name))
    .sort();
  if (
    absent.length !== expectedAbsent.length ||
    absent.some((name, index) => name !== expectedAbsent[index])
  ) {
    throw new Error(`${RUNTIME_OWNER} returned an invalid intent absent list.`);
  }
  return Object.freeze({
    present: Object.freeze(validatedPresent),
    absent: Object.freeze([...absent]) as string[],
  });
}

function createValidatedRuntime(runtime: HermesMcpRuntime): HermesMcpRuntime {
  const transactionHelper = requireRuntimeText(
    runtime.HERMES_MCP_TRANSACTION_HELPER,
    RUNTIME_OWNER,
    "transaction helper path",
  );
  return Object.freeze({
    HERMES_MCP_TRANSACTION_HELPER: transactionHelper,
    buildInspectCommand(payload) {
      return requireRuntimeArgv(
        runtime.buildInspectCommand(payload),
        RUNTIME_OWNER,
        "inspect command",
      );
    },
    buildIntentPayload(entries, managedServerNames) {
      return requireIntentPayload(
        runtime.buildIntentPayload(entries, managedServerNames),
        entries,
        managedServerNames,
      );
    },
    buildProbeCommand() {
      return requireRuntimeArgv(runtime.buildProbeCommand(), RUNTIME_OWNER, "probe command");
    },
    buildRegisterCommand(entry, replaceExisting) {
      return requireRuntimeArgv(
        runtime.buildRegisterCommand(entry, replaceExisting),
        RUNTIME_OWNER,
        "register command",
      );
    },
    buildRemoveCommand(entry, force) {
      return requireRuntimeArgv(
        runtime.buildRemoveCommand(entry, force),
        RUNTIME_OWNER,
        "remove command",
      );
    },
    buildStatusCommand(entry) {
      return requireRuntimeCommand(
        runtime.buildStatusCommand(entry),
        RUNTIME_OWNER,
        "status command",
      );
    },
    managedServerConfig(entry) {
      return requireManagedServerConfig(runtime.managedServerConfig(entry), entry);
    },
  });
}

export function loadHermesMcpRuntime(): HermesMcpRuntime {
  const selectionKey = process.env.HOME?.trim() || "<default-home>";
  // A command captures verified helper bytes once. Harness installation takes effect in the next process.
  if (cachedRuntime?.selectionKey === selectionKey) return cachedRuntime.module;
  const harnessPackage = resolveHarnessPackage("hermes");
  if (!harnessPackage) throw new Error("Hermes harness package is unavailable.");
  const loaded = loadHarnessCommonJsModule(harnessPackage, "config/mcp-adapter.cts", 64 * 1024);
  const runtime = loaded.exports as Partial<HermesMcpRuntime>;
  if (
    typeof runtime.HERMES_MCP_TRANSACTION_HELPER !== "string" ||
    typeof runtime.buildInspectCommand !== "function" ||
    typeof runtime.buildIntentPayload !== "function" ||
    typeof runtime.buildProbeCommand !== "function" ||
    typeof runtime.buildRegisterCommand !== "function" ||
    typeof runtime.buildRemoveCommand !== "function" ||
    typeof runtime.buildStatusCommand !== "function" ||
    typeof runtime.managedServerConfig !== "function"
  ) {
    throw new Error("Hermes harness MCP adapter has an invalid contract.");
  }
  cachedRuntime = {
    selectionKey,
    packageRoot: harnessPackage.rootDir,
    module: createValidatedRuntime(runtime as HermesMcpRuntime),
  };
  return cachedRuntime.module;
}
