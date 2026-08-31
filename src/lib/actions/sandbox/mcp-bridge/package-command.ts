// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { AgentMcpAdapter } from "../../../agent/defs";
import {
  loadHarnessMcpAdapterHostModule,
  type HarnessMcpAdapterCommand,
  type HarnessMcpAdapterEntry,
} from "../../../agent-runtime/host-module";
import { entryHeaders } from "../mcp-bridge-adapter-status";
import type { McpAttachedCredentialRevision } from "../mcp-bridge-provider-readiness";
import { getSandboxHarnessPackage } from "../mcp-bridge-state";
import { McpBridgeError } from "./error";

interface InstalledMcpEntry {
  readonly server: string;
  readonly agent: string;
  readonly url: string;
  readonly env: readonly string[];
}

interface InstalledMcpRegistrationOptions {
  readonly managedEntries?: readonly InstalledMcpEntry[];
  readonly replaceExisting?: boolean;
  readonly teardownRollback?: boolean;
  readonly credentialRevision?: McpAttachedCredentialRevision;
  readonly configRoot?: string;
}

interface InstalledMcpRemovalOptions {
  readonly force?: boolean;
  readonly adaptiveTeardown?: boolean;
  readonly configRoot?: string;
}

function installedMcpAdapter(
  sandboxName: string,
  adapter: AgentMcpAdapter,
  entry: InstalledMcpEntry,
) {
  const harnessPackage = getSandboxHarnessPackage(sandboxName);
  if (!harnessPackage) return null;
  if (harnessPackage.id !== entry.agent) {
    throw new McpBridgeError(
      `Installed MCP adapter '${adapter}' for sandbox '${sandboxName}' does not match its package agent.`,
    );
  }
  try {
    return loadHarnessMcpAdapterHostModule(harnessPackage, {
      expectedAdapter: adapter,
    });
  } catch (error) {
    throw new McpBridgeError(
      `Installed MCP adapter '${adapter}' for sandbox '${sandboxName}' failed package validation: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function packageEntry(
  entry: InstalledMcpEntry,
  credentialRevision?: McpAttachedCredentialRevision,
): HarnessMcpAdapterEntry {
  return Object.freeze({
    server: entry.server,
    url: entry.url,
    headers: Object.freeze(entryHeaders(entry, credentialRevision)),
  });
}

export function buildInstalledMcpRegistrationCommand(
  sandboxName: string,
  adapter: AgentMcpAdapter,
  entry: InstalledMcpEntry,
  options: InstalledMcpRegistrationOptions = {},
): HarnessMcpAdapterCommand | null {
  const installed = installedMcpAdapter(sandboxName, adapter, entry);
  if (!installed) return null;
  const managedEntries = options.managedEntries ?? [entry];
  try {
    return installed.buildMcpRegistrationCommand({
      entry: packageEntry(entry, options.credentialRevision),
      managedEntries: managedEntries.map((managedEntry) =>
        packageEntry(
          managedEntry,
          managedEntry.server === entry.server ? options.credentialRevision : undefined,
        ),
      ),
      replaceExisting: options.replaceExisting === true,
      teardownRollback: options.teardownRollback === true,
      configRoot: options.configRoot ?? null,
    });
  } catch (error) {
    throw new McpBridgeError(
      `Installed MCP adapter '${adapter}' could not build its registration command: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function buildInstalledMcpRemovalCommand(
  sandboxName: string,
  adapter: AgentMcpAdapter,
  entry: InstalledMcpEntry,
  options: InstalledMcpRemovalOptions = {},
): HarnessMcpAdapterCommand | null {
  const installed = installedMcpAdapter(sandboxName, adapter, entry);
  if (!installed) return null;
  try {
    return installed.buildMcpRemovalCommand({
      entry: packageEntry(entry),
      force: options.force === true,
      adaptiveTeardown: options.adaptiveTeardown === true,
      configRoot: options.configRoot ?? null,
    });
  } catch (error) {
    throw new McpBridgeError(
      `Installed MCP adapter '${adapter}' could not build its removal command: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function requireMcpShellCommand(command: HarnessMcpAdapterCommand): string {
  if (typeof command === "string") return command;
  throw new McpBridgeError(
    "Installed MCP adapter returned argv where a shell command is required.",
  );
}

export function requireMcpArgvCommand(command: HarnessMcpAdapterCommand): readonly string[] {
  if (Array.isArray(command)) return command;
  throw new McpBridgeError(
    "Installed MCP adapter returned a shell command where argv is required.",
  );
}
