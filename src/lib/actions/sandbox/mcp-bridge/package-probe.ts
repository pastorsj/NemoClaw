// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { HarnessMcpCapabilityProbe } from "../../../agent-runtime/host-module";
import { commandOutput, type OpenShellCommandResult } from "../mcp-bridge-output";
import {
  executeMcpArgvCommand,
  executeMcpShellCommand,
  recoverMcpAgentGateway,
} from "./command-execution";
import { McpBridgeError } from "./error";
import { inspectManagedMcpGatewayRecovery } from "./gateway-recovery";
import { sleepMcpBridgeRetry } from "./timing";

type CapabilityCommandProbe = Extract<HarnessMcpCapabilityProbe, { readonly kind: "command" }>;

interface McpCapabilityProbeDependencies {
  readonly executeShellCommand: typeof executeMcpShellCommand;
  readonly executeArgvCommand: (
    sandboxName: string,
    command: readonly string[],
    timeoutSeconds: number,
  ) => OpenShellCommandResult | null;
  readonly recoverAgentGateway: (
    sandboxName: string,
    timeoutMilliseconds: number,
  ) => OpenShellCommandResult | null;
  readonly sleep: (milliseconds: number) => void;
}

const defaultDependencies: McpCapabilityProbeDependencies = {
  executeShellCommand: executeMcpShellCommand,
  executeArgvCommand(sandboxName, command, timeoutSeconds) {
    try {
      return executeMcpArgvCommand(sandboxName, command, timeoutSeconds);
    } catch {
      return null;
    }
  },
  recoverAgentGateway(sandboxName, timeoutMilliseconds) {
    return recoverMcpAgentGateway(sandboxName, timeoutMilliseconds);
  },
  sleep: sleepMcpBridgeRetry,
};

function lastJsonLineReportsSuccess(stdout: string): boolean {
  for (const line of stdout.trim().split(/\r?\n/u).reverse()) {
    try {
      const value = JSON.parse(line) as unknown;
      if (value && typeof value === "object" && !Array.isArray(value)) {
        return (value as { readonly ok?: unknown }).ok === true;
      }
    } catch {
      // OpenShell can write framing lines around the package command result.
    }
  }
  return false;
}

function probeSucceeded(probe: CapabilityCommandProbe, result: OpenShellCommandResult): boolean {
  if (result.status !== 0) return false;
  const stdout =
    typeof result.stdout === "string" ? result.stdout : (result.stdout?.toString() ?? "");
  switch (probe.success.kind) {
    case "exit-zero":
      return true;
    case "stdout-trimmed-equals":
      return stdout.trim() === probe.success.value;
    case "last-json-line-ok":
      return lastJsonLineReportsSuccess(stdout);
  }
}

function executeCapabilityCommand(
  sandboxName: string,
  probe: CapabilityCommandProbe,
  dependencies: McpCapabilityProbeDependencies,
): OpenShellCommandResult | null {
  return typeof probe.command === "string"
    ? dependencies.executeShellCommand(sandboxName, probe.command, probe.timeoutSeconds)
    : dependencies.executeArgvCommand(sandboxName, probe.command, probe.timeoutSeconds);
}

function runProbeAttempts(
  sandboxName: string,
  probe: CapabilityCommandProbe,
  attempts: number,
  intervalMilliseconds: number,
  dependencies: McpCapabilityProbeDependencies,
): boolean {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = executeCapabilityCommand(sandboxName, probe, dependencies);
    if (result && probeSucceeded(probe, result)) return true;
    const retryable =
      result !== null &&
      probe.retry !== undefined &&
      commandOutput(result) === probe.retry.outputExact;
    if (!retryable) throw new McpBridgeError(probe.failureMessage);
    if (attempt < attempts) dependencies.sleep(intervalMilliseconds);
  }
  return false;
}

function recoverAgentGatewayForProbe(
  sandboxName: string,
  probe: CapabilityCommandProbe,
  timeoutMilliseconds: number,
  dependencies: McpCapabilityProbeDependencies,
): void {
  let result: OpenShellCommandResult | null = null;
  let failureDetail = "";
  try {
    result = dependencies.recoverAgentGateway(sandboxName, timeoutMilliseconds);
  } catch (error) {
    failureDetail = error instanceof Error ? error.message : String(error);
  }
  const inspection = inspectManagedMcpGatewayRecovery(result, failureDetail);
  if (!inspection.terminal) return;
  throw new McpBridgeError(
    `${probe.failureMessage} Managed gateway recovery failed: ${inspection.detail}.`,
  );
}

/** Prove one package-declared MCP capability before NemoClaw mutates managed state. */
export function assertInstalledMcpCapability(
  sandboxName: string,
  probe: HarnessMcpCapabilityProbe,
  dependencies: McpCapabilityProbeDependencies = defaultDependencies,
): void {
  if (probe.kind === "not-required") return;
  const retry = probe.retry;
  if (
    runProbeAttempts(
      sandboxName,
      probe,
      retry?.initialAttempts ?? 1,
      retry?.intervalMilliseconds ?? 0,
      dependencies,
    )
  ) {
    return;
  }
  if (!retry?.recovery) throw new McpBridgeError(probe.failureMessage);
  recoverAgentGatewayForProbe(
    sandboxName,
    probe,
    retry.recovery.timeoutSeconds * 1000,
    dependencies,
  );
  if (
    runProbeAttempts(
      sandboxName,
      probe,
      retry.recovery.postRecoveryAttempts,
      retry.intervalMilliseconds,
      dependencies,
    )
  ) {
    return;
  }
  throw new McpBridgeError(probe.failureMessage);
}
