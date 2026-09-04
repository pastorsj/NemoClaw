// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { runOpenshellProviderCommand } from "../../../adapters/openshell/provider-command";
import type { OpenShellCommandResult } from "../mcp-bridge-output";
import type { McpProviderInspectionRuntimeSelection } from "../mcp-bridge-provider-inspection";
import { executeSandboxCommand } from "../status/process-recovery";

/** Run package-owned shell source through the established sandbox transport. */
export function executeMcpShellCommand(
  sandboxName: string,
  command: string,
  timeoutSeconds: number,
  runtimeSelection: McpProviderInspectionRuntimeSelection,
): OpenShellCommandResult | null {
  return executeSandboxCommand(sandboxName, command, {
    runtimeSelection,
    timeout: timeoutSeconds * 1000,
  });
}

/** Run package-owned argv without converting it to shell source. */
export function executeMcpArgvCommand(
  sandboxName: string,
  command: readonly string[],
  timeoutSeconds: number,
  runtimeSelection: McpProviderInspectionRuntimeSelection,
): ReturnType<typeof runOpenshellProviderCommand> {
  return runOpenshellProviderCommand(
    [
      "sandbox",
      "exec",
      "--name",
      sandboxName,
      "--timeout",
      String(timeoutSeconds),
      "--no-tty",
      "--",
      ...command,
    ],
    {
      ignoreError: true,
      runtimeSelection,
      stdio: ["ignore", "pipe", "pipe"],
      // Let the remote timeout end the command before the local transport exits.
      timeout: (timeoutSeconds + 25) * 1000,
    },
  );
}

/** Recover the package runtime through NemoClaw's managed gateway controller. */
export function recoverMcpAgentGateway(
  _sandboxName: string,
  _timeoutMilliseconds: number,
  runtimeSelection: McpProviderInspectionRuntimeSelection,
): OpenShellCommandResult | null {
  return {
    status: 1,
    stdout: "",
    stderr: `SELECTED_RUNTIME_SUPERVISOR_UNAVAILABLE: host-local supervisor control is not valid for recorded OpenShell target '${runtimeSelection.gatewayName}'`,
  };
}
