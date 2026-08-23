// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  loadHarnessCommonJsModule,
  resolveHarnessPackage,
} from "../../../harness/commonjs-runtime";
import {
  requireExactRuntimeKeys,
  requireRuntimeBoolean,
  requireRuntimeCommand,
  requireRuntimeRecord,
  requireRuntimeText,
} from "./mcp-bridge-runtime-validation";

export type OpenClawMcpRuntimeEntry = Readonly<{
  server: string;
  url: string;
  headers: Record<string, string>;
}>;

export type OpenClawMcpRuntime = Readonly<{
  DEFAULT_OPENCLAW_CONFIG_DIR: string;
  MCPORTER_VERSION: string;
  OPENCLAW_MCPORTER_ROOT: string;
  buildInspectCommand(
    entry: OpenClawMcpRuntimeEntry,
    failOnMismatch: boolean,
    root?: string,
  ): string;
  buildRegisterCommand(
    entry: OpenClawMcpRuntimeEntry,
    replaceExisting?: boolean,
    root?: string,
  ): string;
  buildRemoveCommand(entry: OpenClawMcpRuntimeEntry, force?: boolean, root?: string): string;
  mcporterHeaderMatcherSource(): string;
  mcporterHeadersMatchExpected(actual: unknown, expected: Record<string, string>): boolean;
  mcporterAvailabilityProbe(sandboxName: string): { command: string; failureMessage: string };
  openClawMcporterRoot(configDir?: string): string;
}>;

const RUNTIME_OWNER = "OpenClaw harness MCP adapter";

let cachedRuntime: {
  selectionKey: string;
  packageRoot: string;
  module: OpenClawMcpRuntime;
} | null = null;

function createValidatedRuntime(runtime: OpenClawMcpRuntime): OpenClawMcpRuntime {
  const defaultConfigDir = requireRuntimeText(
    runtime.DEFAULT_OPENCLAW_CONFIG_DIR,
    RUNTIME_OWNER,
    "default config directory",
  );
  const mcporterVersion = requireRuntimeText(
    runtime.MCPORTER_VERSION,
    RUNTIME_OWNER,
    "mcporter version",
    { maxLength: 128 },
  );
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(mcporterVersion)) {
    throw new Error(`${RUNTIME_OWNER} returned an invalid mcporter version.`);
  }
  const defaultMcporterRoot = requireRuntimeText(
    runtime.OPENCLAW_MCPORTER_ROOT,
    RUNTIME_OWNER,
    "default mcporter root",
  );
  return Object.freeze({
    DEFAULT_OPENCLAW_CONFIG_DIR: defaultConfigDir,
    MCPORTER_VERSION: mcporterVersion,
    OPENCLAW_MCPORTER_ROOT: defaultMcporterRoot,
    buildInspectCommand(entry, failOnMismatch, root) {
      return requireRuntimeCommand(
        runtime.buildInspectCommand(entry, failOnMismatch, root),
        RUNTIME_OWNER,
        "inspect command",
      );
    },
    buildRegisterCommand(entry, replaceExisting, root) {
      return requireRuntimeCommand(
        runtime.buildRegisterCommand(entry, replaceExisting, root),
        RUNTIME_OWNER,
        "register command",
      );
    },
    buildRemoveCommand(entry, force, root) {
      return requireRuntimeCommand(
        runtime.buildRemoveCommand(entry, force, root),
        RUNTIME_OWNER,
        "remove command",
      );
    },
    mcporterHeaderMatcherSource() {
      return requireRuntimeCommand(
        runtime.mcporterHeaderMatcherSource(),
        RUNTIME_OWNER,
        "header matcher source",
      );
    },
    mcporterHeadersMatchExpected(actual, expected) {
      return requireRuntimeBoolean(
        runtime.mcporterHeadersMatchExpected(actual, expected),
        RUNTIME_OWNER,
        "header comparison result",
      );
    },
    mcporterAvailabilityProbe(sandboxName) {
      const value = requireRuntimeRecord(
        runtime.mcporterAvailabilityProbe(sandboxName),
        RUNTIME_OWNER,
        "availability probe",
      );
      requireExactRuntimeKeys(
        value,
        ["command", "failureMessage"],
        RUNTIME_OWNER,
        "availability probe",
      );
      return Object.freeze({
        command: requireRuntimeText(value.command, RUNTIME_OWNER, "availability probe command", {
          maxLength: 8192,
        }),
        failureMessage: requireRuntimeText(
          value.failureMessage,
          RUNTIME_OWNER,
          "availability probe failure message",
          { maxLength: 8192 },
        ),
      });
    },
    openClawMcporterRoot(configDir) {
      return requireRuntimeText(
        runtime.openClawMcporterRoot(configDir),
        RUNTIME_OWNER,
        "mcporter root",
      );
    },
  });
}

export function loadOpenClawMcpRuntime(): OpenClawMcpRuntime {
  const selectionKey = process.env.HOME?.trim() || "<default-home>";
  // A command captures verified helper bytes once. Harness installation takes effect in the next process.
  if (cachedRuntime?.selectionKey === selectionKey) return cachedRuntime.module;
  const harnessPackage = resolveHarnessPackage("openclaw");
  if (!harnessPackage) throw new Error("OpenClaw harness package is unavailable.");
  const loaded = loadHarnessCommonJsModule(harnessPackage, "mcp-adapter.cts", 128 * 1024);
  const runtime = loaded.exports as Partial<OpenClawMcpRuntime>;
  if (
    typeof runtime.DEFAULT_OPENCLAW_CONFIG_DIR !== "string" ||
    typeof runtime.MCPORTER_VERSION !== "string" ||
    typeof runtime.OPENCLAW_MCPORTER_ROOT !== "string" ||
    typeof runtime.buildInspectCommand !== "function" ||
    typeof runtime.buildRegisterCommand !== "function" ||
    typeof runtime.buildRemoveCommand !== "function" ||
    typeof runtime.mcporterHeaderMatcherSource !== "function" ||
    typeof runtime.mcporterHeadersMatchExpected !== "function" ||
    typeof runtime.mcporterAvailabilityProbe !== "function" ||
    typeof runtime.openClawMcporterRoot !== "function"
  ) {
    throw new Error("OpenClaw harness MCP adapter has an invalid contract.");
  }
  cachedRuntime = {
    selectionKey,
    packageRoot: harnessPackage.rootDir,
    module: createValidatedRuntime(runtime as OpenClawMcpRuntime),
  };
  return cachedRuntime.module;
}
