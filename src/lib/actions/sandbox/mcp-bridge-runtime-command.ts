// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { AgentMcpAdapter } from "../../agent/defs";
import { shellQuote } from "../../core/shell-quote";
import { McpBridgeError } from "./mcp-bridge-contracts";
import { requireSandboxHarnessPackage } from "./mcp-bridge-state";
import { buildInstalledMcpRuntimeCommand } from "./mcp-bridge/package-command";

export interface McpRuntimePackageContext {
  readonly sandboxName: string;
  readonly agentName: string;
}

/** Quote one argument for an MCP bridge-owned shell command. */
export const quoteMcpBridgeShellArg = shellQuote;

/**
 * Process-control variables that must not reach a credential-bearing child
 * diagnostic. Trusted proxy and CA variables remain available; OpenShell
 * injects the managed MCP credential at the policy boundary, and the discovery
 * runtime never accepts a credential or Authorization header as input.
 */
export const MCP_RUNTIME_SANITIZED_ENV_VARS = [
  "BASH_ENV",
  "ENV",
  "GCONV_PATH",
  "GLIBC_TUNABLES",
  "LD_AUDIT",
  "LD_LIBRARY_PATH",
  "LD_PRELOAD",
  "LOCPATH",
  "NODE_OPTIONS",
  "NODE_PATH",
  "NODE_TLS_REJECT_UNAUTHORIZED",
  "OPENSSL_CONF",
  "OPENSSL_CONF_INCLUDE",
  "OPENSSL_ENGINES",
  "OPENSSL_MODULES",
  "OPENCLAW_GATEWAY_URL",
  "OPENCLAW_GATEWAY_PORT",
  "OPENCLAW_GATEWAY_TOKEN",
  "OPENCLAW_ALLOW_INSECURE_PRIVATE_WS",
  "NEMOCLAW_OPENCLAW_ALLOW_INSECURE_PRIVATE_WS",
  "PYTHONHOME",
  "PYTHONINSPECT",
  "PYTHONPATH",
  "PYTHONSTARTUP",
  "PYTHONUSERBASE",
  "SSLKEYLOGFILE",
] as const;

/**
 * OpenShell binds generated MCP policies to the configured adapter executable
 * and its process ancestry. Keep that runtime as the parent of a shared child
 * command instead of implementing the wire operation separately per adapter.
 */
export function wrapMcpRuntimeCommand(
  adapter: AgentMcpAdapter,
  command: readonly string[],
  packageContext?: McpRuntimePackageContext,
): string {
  if (!packageContext) {
    throw new McpBridgeError(
      "Managed MCP runtime commands require reconciled harness package authority. Re-run the NemoClaw installer to install and reconcile the sandbox's harness package, then retry.",
      1,
      "package-authority-required",
    );
  }
  requireSandboxHarnessPackage(packageContext.sandboxName);
  const installedCommand = buildInstalledMcpRuntimeCommand(
    packageContext.sandboxName,
    adapter,
    packageContext.agentName,
    command,
  );
  if (installedCommand === null) {
    throw new McpBridgeError(
      `Installed MCP adapter '${adapter}' for sandbox '${packageContext.sandboxName}' is unavailable.`,
    );
  }
  return installedCommand.map(shellQuote).join(" ");
}
