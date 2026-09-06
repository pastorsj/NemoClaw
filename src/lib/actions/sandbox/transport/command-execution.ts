// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  buildOpenShellRuntimeSelectionEnv,
  captureSandboxSshConfig,
  getOpenshellBinary,
  type OpenShellRuntimeSelection,
} from "../../../adapters/openshell/runtime";
import {
  type CommandTransportDependencies,
  DEFAULT_SANDBOX_EXEC_TIMEOUT_MS,
  executeSandboxCommandTransport,
  executeSandboxExecCommandTransport,
  type SandboxCommandResult,
  type SandboxExecCommandOptions,
} from "../../../adapters/sandbox/command-transport";
import { REPOSITORY_ROOT } from "../../../core/repository-root";
import {
  isDirectSandboxFallbackUnavailableError,
  executePrivilegedSandboxCommand,
} from "../../../sandbox/privileged-exec";
import { buildSubprocessEnv } from "../../../subprocess-env";
import {
  buildSandboxExecMarkedCommand,
  extractSandboxExecCommandStdout,
} from "../sandbox-exec-output";

export type SandboxCommandExecutionOptions = {
  runtimeSelection?: OpenShellRuntimeSelection;
  timeout?: number;
};

export type SandboxExecCommandExecutionOptions = SandboxExecCommandOptions & {
  runtimeSelection?: OpenShellRuntimeSelection;
};

function commandTransportDependencies(): CommandTransportDependencies {
  return {
    buildSandboxExecMarkedCommand,
    buildSubprocessEnv,
    captureSandboxSshConfig,
    executePrivilegedSandboxCommand,
    extractSandboxExecCommandStdout,
    getOpenshellBinary,
    isDirectSandboxFallbackUnavailableError,
    openshellProbeTimeoutMs: DEFAULT_SANDBOX_EXEC_TIMEOUT_MS,
    root: REPOSITORY_ROOT,
  };
}

/** Run one shell command through the OpenShell-selected sandbox SSH endpoint. */
export function executeSandboxCommand(
  sandboxName: string,
  command: string,
  timeoutOrOptions: number | SandboxCommandExecutionOptions = DEFAULT_SANDBOX_EXEC_TIMEOUT_MS,
): SandboxCommandResult | null {
  const timeout =
    typeof timeoutOrOptions === "number"
      ? timeoutOrOptions
      : (timeoutOrOptions.timeout ?? DEFAULT_SANDBOX_EXEC_TIMEOUT_MS);
  const runtimeSelection =
    typeof timeoutOrOptions === "number" ? undefined : timeoutOrOptions.runtimeSelection;
  const runtimeEnv = runtimeSelection
    ? buildOpenShellRuntimeSelectionEnv(buildSubprocessEnv(), runtimeSelection)
    : undefined;
  return executeSandboxCommandTransport(
    commandTransportDependencies(),
    sandboxName,
    command,
    timeout,
    {
      ...(runtimeSelection ? { gatewayName: runtimeSelection.gatewayName } : {}),
      runtimeEnv,
    },
  );
}

/** Run one shell command through OpenShell exec with the guarded local fallback. */
export function executeSandboxExecCommand(
  sandboxName: string,
  command: string,
  timeout = DEFAULT_SANDBOX_EXEC_TIMEOUT_MS,
  options: SandboxExecCommandExecutionOptions = {},
): SandboxCommandResult | null {
  const { runtimeSelection, ...transportOptions } = options;
  const runtimeEnv = runtimeSelection
    ? buildOpenShellRuntimeSelectionEnv(buildSubprocessEnv(), runtimeSelection)
    : options.runtimeEnv;
  return executeSandboxExecCommandTransport(
    commandTransportDependencies(),
    sandboxName,
    command,
    timeout,
    {
      ...transportOptions,
      ...(runtimeSelection
        ? {
            allowLocalDockerFallback: false,
            gatewayName: runtimeSelection.gatewayName,
          }
        : {}),
      ...(runtimeEnv ? { runtimeEnv } : {}),
    },
  );
}

export type { SandboxCommandResult, SandboxExecCommandOptions };
