// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const DEPLOYMENT_PROBE_TIMEOUT_MS = 15000;
type VerificationCommandResult = { status: number; stdout: string; stderr: string };
type VerificationCommandExecutor = (
  sandboxName: string,
  script: string,
  timeout: number,
  options: { allowLocalDockerFallback: boolean; gatewayName: string },
) => VerificationCommandResult | null;

function executeThroughProcessRecovery(
  ...args: Parameters<VerificationCommandExecutor>
): ReturnType<VerificationCommandExecutor> {
  const recovery: typeof import("../../actions/sandbox/status/process-recovery") = require("../../actions/sandbox/status/process-recovery");
  return recovery.executeSandboxExecCommand(...args);
}

/** Create a gateway-pinned executor for read-only final deployment probes. */
export function createDeploymentVerificationCommandExecutor(
  gatewayName: string,
  execute: VerificationCommandExecutor = executeThroughProcessRecovery,
) {
  return (sandboxName: string, script: string) =>
    execute(sandboxName, script, DEPLOYMENT_PROBE_TIMEOUT_MS, {
      allowLocalDockerFallback: true,
      gatewayName,
    });
}
