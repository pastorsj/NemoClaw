// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { AgentMcpAdapter } from "../../../agent/defs";
import {
  loadHarnessMcpAdapterHostModule,
  type HarnessMcpAdapterEntry,
  type HarnessMcpCapabilityProbe,
  type HarnessMcpRegistrationPlan,
  type HarnessMcpRemovalPlan,
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
  readonly configDirectory?: string;
}

interface InstalledMcpRemovalOptions {
  readonly force?: boolean;
  readonly adaptiveTeardown?: boolean;
  readonly configDirectory?: string;
}

interface InstalledMcpInspectionOptions {
  readonly failOnMismatch?: boolean;
  readonly credentialRevision?: McpAttachedCredentialRevision;
  readonly configDirectory?: string;
}

function installedMcpAdapter(sandboxName: string, adapter: AgentMcpAdapter, agentName: string) {
  const harnessPackage = getSandboxHarnessPackage(sandboxName);
  if (!harnessPackage) return null;
  if (harnessPackage.id !== agentName) {
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

export function buildInstalledMcpRegistrationPlan(
  sandboxName: string,
  adapter: AgentMcpAdapter,
  entry: InstalledMcpEntry,
  options: InstalledMcpRegistrationOptions = {},
): HarnessMcpRegistrationPlan | null {
  const installed = installedMcpAdapter(sandboxName, adapter, entry.agent);
  if (!installed) return null;
  const managedEntries = options.managedEntries ?? [entry];
  try {
    return installed.buildMcpRegistrationPlan({
      entry: packageEntry(entry, options.credentialRevision),
      managedEntries: managedEntries.map((managedEntry) =>
        packageEntry(
          managedEntry,
          managedEntry.server === entry.server ? options.credentialRevision : undefined,
        ),
      ),
      replaceExisting: options.replaceExisting === true,
      teardownRollback: options.teardownRollback === true,
      configDirectory: options.configDirectory ?? null,
    });
  } catch (error) {
    throw new McpBridgeError(
      `Installed MCP adapter '${adapter}' could not build its registration plan: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function buildInstalledMcpRemovalPlan(
  sandboxName: string,
  adapter: AgentMcpAdapter,
  entry: InstalledMcpEntry,
  options: InstalledMcpRemovalOptions = {},
): HarnessMcpRemovalPlan | null {
  const installed = installedMcpAdapter(sandboxName, adapter, entry.agent);
  if (!installed) return null;
  try {
    return installed.buildMcpRemovalPlan({
      entry: packageEntry(entry),
      force: options.force === true,
      adaptiveTeardown: options.adaptiveTeardown === true,
      configDirectory: options.configDirectory ?? null,
    });
  } catch (error) {
    throw new McpBridgeError(
      `Installed MCP adapter '${adapter}' could not build its removal plan: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function buildInstalledMcpInspectionCommand(
  sandboxName: string,
  adapter: AgentMcpAdapter,
  entry: InstalledMcpEntry,
  options: InstalledMcpInspectionOptions = {},
): string | null {
  const installed = installedMcpAdapter(sandboxName, adapter, entry.agent);
  if (!installed) return null;
  try {
    return installed.buildMcpInspectionCommand({
      entry: packageEntry(entry, options.credentialRevision),
      failOnMismatch: options.failOnMismatch === true,
      configDirectory: options.configDirectory ?? null,
    });
  } catch (error) {
    throw new McpBridgeError(
      `Installed MCP adapter '${adapter}' could not build its inspection command: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function describeInstalledMcpMutationCapability(
  sandboxName: string,
  adapter: AgentMcpAdapter,
  agentName: string,
): HarnessMcpCapabilityProbe | null {
  const installed = installedMcpAdapter(sandboxName, adapter, agentName);
  if (!installed) return null;
  try {
    return installed.describeMcpMutationCapability({ sandboxName });
  } catch (error) {
    throw new McpBridgeError(
      `Installed MCP adapter '${adapter}' could not describe its mutation capability: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function describeInstalledMcpTeardownCapability(
  sandboxName: string,
  adapter: AgentMcpAdapter,
  agentName: string,
): HarnessMcpCapabilityProbe | null {
  const installed = installedMcpAdapter(sandboxName, adapter, agentName);
  if (!installed) return null;
  try {
    return installed.describeMcpTeardownCapability({ sandboxName });
  } catch (error) {
    throw new McpBridgeError(
      `Installed MCP adapter '${adapter}' could not describe its teardown capability: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function describeInstalledMcpRuntimeIntentVerification(
  sandboxName: string,
  adapter: AgentMcpAdapter,
  agentName: string,
  entries: readonly InstalledMcpEntry[],
  managedServerNames: readonly string[],
  credentialRevisions?: ReadonlyMap<string, McpAttachedCredentialRevision>,
): HarnessMcpCapabilityProbe | null {
  const installed = installedMcpAdapter(sandboxName, adapter, agentName);
  if (!installed) return null;
  try {
    return installed.describeMcpRuntimeIntentVerification({
      entries: entries.map((entry) => packageEntry(entry, credentialRevisions?.get(entry.server))),
      managedServerNames: [...managedServerNames],
    });
  } catch (error) {
    throw new McpBridgeError(
      `Installed MCP adapter '${adapter}' could not describe its runtime intent verification: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function buildInstalledMcpRuntimeCommand(
  sandboxName: string,
  adapter: AgentMcpAdapter,
  agentName: string,
  command: readonly string[],
): readonly string[] | null {
  const installed = installedMcpAdapter(sandboxName, adapter, agentName);
  if (!installed) return null;
  try {
    return installed.buildMcpRuntimeCommand({ command });
  } catch (error) {
    throw new McpBridgeError(
      `Installed MCP adapter '${adapter}' could not build its runtime command: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
