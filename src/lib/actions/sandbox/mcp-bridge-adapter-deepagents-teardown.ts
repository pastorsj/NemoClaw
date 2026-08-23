// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { McpBridgeEntry } from "../../state/registry";
import { runDeepAgentsAdapterCommand } from "./mcp-bridge-adapter-deepagents-command";
import { loadDeepAgentsMcpRuntime } from "./runtime/mcp-bridge-adapter-deepagents-runtime";
import type {
  AdapterMutationOptions,
  AdapterRemovalOutcome,
} from "./mcp-bridge-adapter-inspection";
import { entryHeaders } from "./mcp-bridge-adapter-status";

export function buildDeepAgentsMcpRemoveCommand(
  entry: McpBridgeEntry,
  force = false,
  adaptiveTeardown = false,
): string {
  return loadDeepAgentsMcpRuntime().buildRemoveCommand(
    { server: entry.server, url: entry.url, headers: entryHeaders(entry) },
    force,
    adaptiveTeardown,
  );
}

export function unregisterDeepAgentsAdapter(
  sandboxName: string,
  entry: McpBridgeEntry,
  options: AdapterMutationOptions = {},
): AdapterRemovalOutcome {
  const stdout = runDeepAgentsAdapterCommand(
    sandboxName,
    entry,
    buildDeepAgentsMcpRemoveCommand(entry, options.force === true, options.teardown === true),
    `Deep Agents Code MCP config removal failed for '${entry.server}'.`,
    options,
  );
  return loadDeepAgentsMcpRuntime().parseRemovalOutcome(stdout);
}
