// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { McpBridgeError } from "./mcp-bridge-contracts";
import { loadDeepAgentsMcpRuntime } from "./runtime/mcp-bridge-adapter-deepagents-runtime";
import { executeSandboxCommand } from "./process-recovery";

export function assertDeepAgentsMcpMutationRuntimeCapability(sandboxName: string): void {
  const capability = loadDeepAgentsMcpRuntime().getMutationCapability(sandboxName);
  const result = executeSandboxCommand(sandboxName, capability.command);
  if (result?.status !== 0 || result.stdout.trim() !== capability.marker) {
    throw new McpBridgeError(capability.failureMessage);
  }
}
