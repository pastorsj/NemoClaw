// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { getSandbox, type McpBridgeEntry } from "../../state/registry";
import { runDeepAgentsAdapterCommand } from "./mcp-bridge-adapter-deepagents-command";
import { inspectDeepAgentsAdapterRegistration } from "./mcp-bridge-adapter-deepagents-inspection";
import { loadDeepAgentsMcpRuntime } from "./runtime/mcp-bridge-adapter-deepagents-runtime";
import { entryHeaders } from "./mcp-bridge-adapter-status";
import { McpBridgeError } from "./mcp-bridge-contracts";

export function buildDeepAgentsMcpRegisterCommand(
  entry: McpBridgeEntry,
  replaceExisting = false,
  managedEntries: readonly McpBridgeEntry[] = [entry],
  teardownRollback = false,
): string {
  const runtimeEntry = (candidate: McpBridgeEntry) => ({
    server: candidate.server,
    url: candidate.url,
    headers: entryHeaders(candidate),
  });
  try {
    return loadDeepAgentsMcpRuntime().buildRegisterCommand(
      runtimeEntry(entry),
      replaceExisting,
      managedEntries.map(runtimeEntry),
      teardownRollback,
    );
  } catch (error) {
    throw new McpBridgeError(error instanceof Error ? error.message : String(error));
  }
}

function registryOwnedDeepAgentsEntries(
  sandboxName: string,
  entry: McpBridgeEntry,
): McpBridgeEntry[] {
  const entries = new Map<string, McpBridgeEntry>();
  const bridges = getSandbox(sandboxName)?.mcp?.bridges ?? {};
  for (const bridge of Object.values(bridges)) entries.set(bridge.server, bridge);
  entries.set(entry.server, entry);
  return [...entries.values()];
}

function verifyDeepAgentsAdapterRegistration(sandboxName: string, entry: McpBridgeEntry): void {
  const inspection = inspectDeepAgentsAdapterRegistration(sandboxName, entry);
  if (inspection.state === "registered") return;
  const detail = inspection.state === "error" ? inspection.detail : inspection.state;
  throw new McpBridgeError(
    `deepagents-config config verification failed after adding '${entry.server}': ${detail}.`,
  );
}

export function registerDeepAgentsAdapter(
  sandboxName: string,
  entry: McpBridgeEntry,
  envValues: Record<string, string> = {},
  replaceExisting = false,
  teardownRollback = false,
): void {
  const stdout = runDeepAgentsAdapterCommand(
    sandboxName,
    entry,
    buildDeepAgentsMcpRegisterCommand(
      entry,
      replaceExisting,
      registryOwnedDeepAgentsEntries(sandboxName, entry),
      teardownRollback,
    ),
    `Deep Agents Code MCP config registration failed for '${entry.server}'.`,
    { envValues },
  );
  if (teardownRollback) {
    if (!loadDeepAgentsMcpRuntime().hasRollbackRestoredMarker(stdout)) {
      throw new McpBridgeError(
        `Deep Agents Code MCP rollback verification failed for '${entry.server}'.`,
      );
    }
  } else {
    verifyDeepAgentsAdapterRegistration(sandboxName, entry);
  }
}
