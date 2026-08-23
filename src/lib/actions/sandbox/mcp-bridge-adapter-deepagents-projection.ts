// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { loadDeepAgentsMcpRuntime } from "./runtime/mcp-bridge-adapter-deepagents-runtime";

export function getDeepAgentsMcpMaxServers(): number {
  return loadDeepAgentsMcpRuntime().DEEPAGENTS_MCP_MAX_SERVERS;
}
