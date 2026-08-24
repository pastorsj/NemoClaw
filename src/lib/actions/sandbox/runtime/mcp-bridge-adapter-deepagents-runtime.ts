// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  loadHarnessCommonJsModule,
  resolveHarnessPackage,
} from "../../../harness/commonjs-runtime";
import type { AdapterRemovalOutcome } from "../mcp-bridge-adapter-inspection";
import {
  requireExactRuntimeKeys,
  requireRuntimeBoolean,
  requireRuntimeCommand,
  requireRuntimeRecord,
  requireRuntimeStringArray,
  requireRuntimeText,
} from "./mcp-bridge-runtime-validation";

export type DeepAgentsMcpRuntimeEntry = Readonly<{
  server: string;
  url: string;
  headers: Record<string, string>;
}>;

export type DeepAgentsMcpRuntime = Readonly<{
  DEEPAGENTS_LEGACY_CONFIG_HELPERS: readonly string[];
  DEEPAGENTS_LEGACY_MCP_CONFIG_PATH: string;
  DEEPAGENTS_MANAGED_PROJECTION_HELPERS: readonly string[];
  DEEPAGENTS_MANAGED_PROJECTION_MUTATION_HELPERS: readonly string[];
  DEEPAGENTS_MANAGED_PROJECTION_READ_HELPERS: readonly string[];
  DEEPAGENTS_MCP_CONFIG_PATH: string;
  DEEPAGENTS_MCP_MAX_SERVERS: number;
  DEEPAGENTS_STRICT_JSON_HELPERS: readonly string[];
  buildRegisterCommand(
    entry: DeepAgentsMcpRuntimeEntry,
    replaceExisting?: boolean,
    managedEntries?: readonly DeepAgentsMcpRuntimeEntry[],
    teardownRollback?: boolean,
  ): string;
  buildRemoveCommand(
    entry: DeepAgentsMcpRuntimeEntry,
    force?: boolean,
    adaptiveTeardown?: boolean,
  ): string;
  buildRollbackRegisterCommand(
    entry: DeepAgentsMcpRuntimeEntry,
    expectedServers: Record<string, Record<string, unknown>>,
  ): string;
  buildStatusCommand(entry: DeepAgentsMcpRuntimeEntry): string;
  getMutationCapability(sandboxName: string): {
    command: string;
    marker: string;
    failureMessage: string;
  };
  hasRollbackRestoredMarker(output: string): boolean;
  managedServerConfig(entry: DeepAgentsMcpRuntimeEntry): Record<string, unknown>;
  parseRemovalOutcome(output: string): AdapterRemovalOutcome;
}>;

const RUNTIME_OWNER = "Deep Agents Code harness MCP adapter";

let cachedRuntime: {
  selectionKey: string;
  packageRoot: string;
  module: DeepAgentsMcpRuntime;
} | null = null;

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function requireManagedServerConfig(
  value: unknown,
  entry: DeepAgentsMcpRuntimeEntry,
): Record<string, unknown> {
  const config = requireRuntimeRecord(value, RUNTIME_OWNER, "managed server config");
  const hasHeaders = Object.keys(entry.headers).length > 0;
  requireExactRuntimeKeys(
    config,
    ["type", "url", ...(hasHeaders ? ["headers"] : [])],
    RUNTIME_OWNER,
    "managed server config",
  );
  if (config.type !== "http" || config.url !== entry.url) {
    throw new Error(`${RUNTIME_OWNER} returned an invalid managed server config.`);
  }
  const validated: Record<string, unknown> = { type: "http", url: entry.url };
  if (hasHeaders) {
    const headers = requireRuntimeRecord(
      config.headers,
      RUNTIME_OWNER,
      "managed server config headers",
    );
    requireExactRuntimeKeys(
      headers,
      Object.keys(entry.headers),
      RUNTIME_OWNER,
      "managed server config headers",
    );
    for (const [name, expected] of Object.entries(entry.headers)) {
      if (headers[name] !== expected) {
        throw new Error(`${RUNTIME_OWNER} returned invalid managed server config headers.`);
      }
    }
    validated.headers = Object.freeze({ ...entry.headers });
  }
  return Object.freeze(validated);
}

function requireCapability(value: unknown): {
  command: string;
  marker: string;
  failureMessage: string;
} {
  const capability = requireRuntimeRecord(value, RUNTIME_OWNER, "mutation capability");
  requireExactRuntimeKeys(
    capability,
    ["command", "marker", "failureMessage"],
    RUNTIME_OWNER,
    "mutation capability",
  );
  const command = requireRuntimeText(
    capability.command,
    RUNTIME_OWNER,
    "mutation capability command",
    { maxLength: 8192 },
  );
  const marker = requireRuntimeText(
    capability.marker,
    RUNTIME_OWNER,
    "mutation capability marker",
    { maxLength: 256 },
  );
  if (!/^NEMOCLAW_[A-Z0-9_]{1,128}=[A-Za-z0-9._:-]{1,128}$/u.test(marker)) {
    throw new Error(`${RUNTIME_OWNER} returned an invalid mutation capability marker.`);
  }
  const failureMessage = requireRuntimeText(
    capability.failureMessage,
    RUNTIME_OWNER,
    "mutation capability failure message",
    { maxLength: 8192 },
  );
  return Object.freeze({ command, marker, failureMessage });
}

function createValidatedRuntime(runtime: DeepAgentsMcpRuntime): DeepAgentsMcpRuntime {
  const strictJsonHelpers = requireRuntimeStringArray(
    runtime.DEEPAGENTS_STRICT_JSON_HELPERS,
    RUNTIME_OWNER,
    "strict JSON helpers",
    64,
  );
  const projectionReadHelpers = requireRuntimeStringArray(
    runtime.DEEPAGENTS_MANAGED_PROJECTION_READ_HELPERS,
    RUNTIME_OWNER,
    "managed projection read helpers",
    256,
  );
  const projectionMutationHelpers = requireRuntimeStringArray(
    runtime.DEEPAGENTS_MANAGED_PROJECTION_MUTATION_HELPERS,
    RUNTIME_OWNER,
    "managed projection mutation helpers",
    256,
  );
  const projectionHelpers = requireRuntimeStringArray(
    runtime.DEEPAGENTS_MANAGED_PROJECTION_HELPERS,
    RUNTIME_OWNER,
    "managed projection helpers",
    512,
  );
  const expectedProjectionHelpers = [...projectionReadHelpers, ...projectionMutationHelpers];
  if (
    projectionHelpers.length !== expectedProjectionHelpers.length ||
    projectionHelpers.some((line, index) => line !== expectedProjectionHelpers[index])
  ) {
    throw new Error(`${RUNTIME_OWNER} returned invalid managed projection helpers.`);
  }
  const legacyHelpers = requireRuntimeStringArray(
    runtime.DEEPAGENTS_LEGACY_CONFIG_HELPERS,
    RUNTIME_OWNER,
    "legacy config helpers",
    256,
  );
  const managedPath = requireRuntimeText(
    runtime.DEEPAGENTS_MCP_CONFIG_PATH,
    RUNTIME_OWNER,
    "managed config path",
  );
  const legacyPath = requireRuntimeText(
    runtime.DEEPAGENTS_LEGACY_MCP_CONFIG_PATH,
    RUNTIME_OWNER,
    "legacy config path",
  );
  const maxServers = runtime.DEEPAGENTS_MCP_MAX_SERVERS;
  if (!Number.isSafeInteger(maxServers) || maxServers < 1 || maxServers > 1024) {
    throw new Error(`${RUNTIME_OWNER} returned an invalid maximum server count.`);
  }
  return Object.freeze({
    DEEPAGENTS_LEGACY_CONFIG_HELPERS: legacyHelpers,
    DEEPAGENTS_LEGACY_MCP_CONFIG_PATH: legacyPath,
    DEEPAGENTS_MANAGED_PROJECTION_HELPERS: projectionHelpers,
    DEEPAGENTS_MANAGED_PROJECTION_MUTATION_HELPERS: projectionMutationHelpers,
    DEEPAGENTS_MANAGED_PROJECTION_READ_HELPERS: projectionReadHelpers,
    DEEPAGENTS_MCP_CONFIG_PATH: managedPath,
    DEEPAGENTS_MCP_MAX_SERVERS: maxServers,
    DEEPAGENTS_STRICT_JSON_HELPERS: strictJsonHelpers,
    buildRegisterCommand(entry, replaceExisting, managedEntries, teardownRollback) {
      return requireRuntimeCommand(
        runtime.buildRegisterCommand(entry, replaceExisting, managedEntries, teardownRollback),
        RUNTIME_OWNER,
        "register command",
      );
    },
    buildRemoveCommand(entry, force, adaptiveTeardown) {
      return requireRuntimeCommand(
        runtime.buildRemoveCommand(entry, force, adaptiveTeardown),
        RUNTIME_OWNER,
        "remove command",
      );
    },
    buildRollbackRegisterCommand(entry, expectedServers) {
      return requireRuntimeCommand(
        runtime.buildRollbackRegisterCommand(entry, expectedServers),
        RUNTIME_OWNER,
        "rollback register command",
      );
    },
    buildStatusCommand(entry) {
      return requireRuntimeCommand(
        runtime.buildStatusCommand(entry),
        RUNTIME_OWNER,
        "status command",
      );
    },
    getMutationCapability(sandboxName) {
      return requireCapability(runtime.getMutationCapability(sandboxName));
    },
    hasRollbackRestoredMarker(output) {
      return requireRuntimeBoolean(
        runtime.hasRollbackRestoredMarker(output),
        RUNTIME_OWNER,
        "rollback marker result",
      );
    },
    managedServerConfig(entry) {
      return requireManagedServerConfig(runtime.managedServerConfig(entry), entry);
    },
    parseRemovalOutcome(output) {
      const outcome: unknown = runtime.parseRemovalOutcome(output);
      if (outcome !== "removed" && outcome !== "absent" && outcome !== "unowned") {
        throw new Error(`${RUNTIME_OWNER} returned an invalid removal outcome.`);
      }
      return outcome;
    },
  });
}

export function loadDeepAgentsMcpRuntime(): DeepAgentsMcpRuntime {
  const selectionKey = process.env.HOME?.trim() || "<default-home>";
  // A command captures verified helper bytes once. Harness installation takes effect in the next process.
  if (cachedRuntime?.selectionKey === selectionKey) return cachedRuntime.module;
  const harnessPackage = resolveHarnessPackage("langchain-deepagents-code");
  if (!harnessPackage) throw new Error("Deep Agents Code harness package is unavailable.");
  const loaded = loadHarnessCommonJsModule(harnessPackage, "host/mcp-adapter.cts", 128 * 1024);
  const runtime = loaded.exports as Partial<DeepAgentsMcpRuntime>;
  if (
    !isStringArray(runtime.DEEPAGENTS_LEGACY_CONFIG_HELPERS) ||
    typeof runtime.DEEPAGENTS_LEGACY_MCP_CONFIG_PATH !== "string" ||
    !isStringArray(runtime.DEEPAGENTS_MANAGED_PROJECTION_HELPERS) ||
    !isStringArray(runtime.DEEPAGENTS_MANAGED_PROJECTION_MUTATION_HELPERS) ||
    !isStringArray(runtime.DEEPAGENTS_MANAGED_PROJECTION_READ_HELPERS) ||
    typeof runtime.DEEPAGENTS_MCP_CONFIG_PATH !== "string" ||
    typeof runtime.DEEPAGENTS_MCP_MAX_SERVERS !== "number" ||
    !isStringArray(runtime.DEEPAGENTS_STRICT_JSON_HELPERS) ||
    typeof runtime.buildRegisterCommand !== "function" ||
    typeof runtime.buildRemoveCommand !== "function" ||
    typeof runtime.buildRollbackRegisterCommand !== "function" ||
    typeof runtime.buildStatusCommand !== "function" ||
    typeof runtime.getMutationCapability !== "function" ||
    typeof runtime.hasRollbackRestoredMarker !== "function" ||
    typeof runtime.managedServerConfig !== "function" ||
    typeof runtime.parseRemovalOutcome !== "function"
  ) {
    throw new Error("Deep Agents Code harness MCP adapter has an invalid contract.");
  }
  cachedRuntime = {
    selectionKey,
    packageRoot: harnessPackage.rootDir,
    module: createValidatedRuntime(runtime as DeepAgentsMcpRuntime),
  };
  return cachedRuntime.module;
}
