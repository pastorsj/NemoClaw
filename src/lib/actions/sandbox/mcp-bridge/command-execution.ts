// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { runOpenshellProviderCommand } from "../../../adapters/openshell/provider-command";
import type { OpenShellCommandResult } from "../mcp-bridge-output";
import { executeGatewaySupervisorAction, executeSandboxCommand } from "../status/process-recovery";

/** Run package-owned shell source through the established sandbox transport. */
export function executeMcpShellCommand(
  sandboxName: string,
  command: string,
  timeoutSeconds: number,
): OpenShellCommandResult | null {
  return executeSandboxCommand(sandboxName, command, timeoutSeconds * 1000);
}

/** Run package-owned argv without converting it to shell source. */
export function executeMcpArgvCommand(
  sandboxName: string,
  command: readonly string[],
  timeoutSeconds: number,
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
      stdio: ["ignore", "pipe", "pipe"],
      // Let the remote timeout end the command before the local transport exits.
      timeout: (timeoutSeconds + 25) * 1000,
    },
  );
}

/** Recover the package runtime through NemoClaw's managed gateway controller. */
export function recoverMcpAgentGateway(
  sandboxName: string,
  timeoutMilliseconds: number,
): OpenShellCommandResult | null {
  return executeGatewaySupervisorAction(sandboxName, "recover", timeoutMilliseconds);
}
