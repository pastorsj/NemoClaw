// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { McpBridgeEntry } from "../../state/registry";
import { loadDeepAgentsMcpRuntime } from "./runtime/mcp-bridge-adapter-deepagents-runtime";
import { entryHeaders } from "./mcp-bridge-adapter-status";

export function buildDeepAgentsMcpRollbackRegisterCommand(
  entry: McpBridgeEntry,
  expectedServers: Record<string, Record<string, unknown>>,
): string {
  return loadDeepAgentsMcpRuntime().buildRollbackRegisterCommand(
    { server: entry.server, url: entry.url, headers: entryHeaders(entry) },
    expectedServers,
  );
}
