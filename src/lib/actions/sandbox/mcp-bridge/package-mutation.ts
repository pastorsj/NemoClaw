// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { AgentMcpAdapter } from "../../../agent/defs";
import type {
  HarnessMcpExecutionPlan,
  HarnessMcpRegistrationPlan,
} from "../../../agent-runtime/host-module";
import type { McpBridgeEntry } from "../../../state/registry";
import type {
  AdapterMutationOptions,
  AdapterRemovalOutcome,
} from "../mcp-bridge-adapter-inspection";
import { inspectAdapterRegistrationCommand } from "../mcp-bridge-adapter-inspection";
import { redactBridgeSecretsForDisplay, type OpenShellCommandResult } from "../mcp-bridge-output";
import {
  type McpAttachedCredentialRevision,
  observeMcpCredentialRevision,
} from "../mcp-bridge-provider-readiness";
import { McpBridgeError } from "./error";
import { findRegisteredSandbox } from "../mcp-bridge-state";
import {
  buildInstalledMcpInspectionCommand,
  buildInstalledMcpRegistrationPlan,
  buildInstalledMcpRemovalPlan,
} from "./package-command";
import { executeMcpArgvCommand, executeMcpShellCommand } from "./command-execution";

const MCP_ROLLBACK_RESTORED_MARKER = "NEMOCLAW_MCP_ROLLBACK_RESTORED=1";
const MCP_REMOVAL_OUTCOME_PATTERN = /NEMOCLAW_MCP_REMOVAL_OUTCOME=(removed|absent|unowned)/u;

type McpMutationCommandResult = OpenShellCommandResult & {
  readonly error?: Error;
};

interface InstalledMcpMutationDependencies {
  readonly executeShellCommand: typeof executeMcpShellCommand;
  readonly executeArgvCommand: typeof executeMcpArgvCommand;
  readonly inspectRegistration: typeof inspectAdapterRegistrationCommand;
  readonly observeCredentialRevision: typeof observeMcpCredentialRevision;
}

const defaultDependencies: InstalledMcpMutationDependencies = {
  executeShellCommand: executeMcpShellCommand,
  executeArgvCommand: executeMcpArgvCommand,
  inspectRegistration: inspectAdapterRegistrationCommand,
  observeCredentialRevision: observeMcpCredentialRevision,
};

interface InstalledMcpRegistrationOptions {
  readonly replaceExisting?: boolean;
  readonly teardownRollback?: boolean;
  readonly credentialRevision?: McpAttachedCredentialRevision;
  readonly configDirectory?: string;
}

interface InstalledMcpRemovalOptions extends AdapterMutationOptions {
  readonly configDirectory?: string;
}

function commandText(value: string | Buffer | null | undefined): string {
  return typeof value === "string" ? value : (value?.toString() ?? "");
}

function parseLastJsonObject(output: string): Record<string, unknown> | null {
  for (const line of output.trim().split(/\r?\n/u).reverse()) {
    try {
      const parsed = JSON.parse(line) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // OpenShell can frame diagnostics around the package command result.
    }
  }
  return null;
}

function redactMutationOutput(
  result: OpenShellCommandResult | null,
  entry: McpBridgeEntry,
  envValues: Record<string, string>,
): string {
  if (!result) return "";
  return redactBridgeSecretsForDisplay(
    [commandText(result.stdout), commandText(result.stderr)].filter(Boolean).join("\n").trim(),
    entry,
    envValues,
  );
}

function executeMcpMutationPlan(
  sandboxName: string,
  entry: McpBridgeEntry,
  execution: HarnessMcpExecutionPlan,
  envValues: Record<string, string>,
  bestEffort: boolean,
  dependencies: InstalledMcpMutationDependencies,
): McpMutationCommandResult | null {
  let result: McpMutationCommandResult | null;
  try {
    result =
      typeof execution.command === "string"
        ? dependencies.executeShellCommand(sandboxName, execution.command, execution.timeoutSeconds)
        : dependencies.executeArgvCommand(sandboxName, execution.command, execution.timeoutSeconds);
  } catch (error) {
    if (bestEffort) return null;
    const detail = error instanceof Error ? error.message : String(error);
    throw new McpBridgeError(
      redactBridgeSecretsForDisplay(detail, entry, envValues) || execution.failureMessage,
    );
  }

  const output = redactMutationOutput(result, entry, envValues);
  if (!result || result.status !== 0 || result.error) {
    if (bestEffort) return null;
    const errorDetail = result?.error
      ? redactBridgeSecretsForDisplay(result.error.message, entry, envValues)
      : "";
    throw new McpBridgeError(errorDetail || output || execution.failureMessage);
  }

  if (execution.success.kind === "lifecycle-json") {
    const response = parseLastJsonObject(commandText(result.stdout));
    if (
      response?.ok !== true ||
      typeof response.changed !== "boolean" ||
      typeof response.reloaded !== "boolean"
    ) {
      if (bestEffort) return null;
      throw new McpBridgeError(execution.success.invalidResponseMessage);
    }
    if (execution.success.requireReload && response.reloaded !== true) {
      if (bestEffort) return null;
      throw new McpBridgeError(execution.success.reloadRequiredMessage);
    }
  }
  return result;
}

function requireRegistrationPlan(
  plan: HarnessMcpRegistrationPlan | null,
  sandboxName: string,
  adapter: AgentMcpAdapter,
): HarnessMcpRegistrationPlan {
  if (plan) return plan;
  throw new McpBridgeError(
    `Installed MCP adapter '${adapter}' for sandbox '${sandboxName}' is unavailable.`,
  );
}

function registryOwnedMcpEntries(sandboxName: string, entry: McpBridgeEntry): McpBridgeEntry[] {
  const entries = new Map<string, McpBridgeEntry>();
  const bridges = findRegisteredSandbox(sandboxName)?.mcp?.bridges ?? {};
  for (const bridge of Object.values(bridges)) entries.set(bridge.server, bridge);
  entries.set(entry.server, entry);
  return [...entries.values()];
}

function verifyInstalledMcpRegistration(
  sandboxName: string,
  adapter: AgentMcpAdapter,
  entry: McpBridgeEntry,
  plan: HarnessMcpRegistrationPlan,
  credentialRevision: McpAttachedCredentialRevision | undefined,
  configDirectory: string | undefined,
  result: McpMutationCommandResult,
  dependencies: InstalledMcpMutationDependencies,
): void {
  if (plan.verification.kind === "rollback-restored") {
    if (commandText(result.stdout).includes(MCP_ROLLBACK_RESTORED_MARKER)) return;
    throw new McpBridgeError(plan.verification.failureMessage);
  }

  const command = buildInstalledMcpInspectionCommand(sandboxName, adapter, entry, {
    failOnMismatch: true,
    credentialRevision,
    configDirectory,
  });
  if (command === null) {
    throw new McpBridgeError(
      `Installed MCP adapter '${adapter}' for sandbox '${sandboxName}' is unavailable.`,
    );
  }
  const inspection = dependencies.inspectRegistration(sandboxName, entry, command);
  if (inspection.state === "registered") return;
  const detail = inspection.state === "error" ? inspection.detail : inspection.state;
  throw new McpBridgeError(`${plan.verification.failureMessage}: ${detail}.`);
}

function buildRegistrationPlan(
  sandboxName: string,
  adapter: AgentMcpAdapter,
  entry: McpBridgeEntry,
  options: InstalledMcpRegistrationOptions,
): HarnessMcpRegistrationPlan {
  return requireRegistrationPlan(
    buildInstalledMcpRegistrationPlan(sandboxName, adapter, entry, {
      managedEntries: registryOwnedMcpEntries(sandboxName, entry),
      replaceExisting: options.replaceExisting === true,
      teardownRollback: options.teardownRollback === true,
      credentialRevision: options.credentialRevision,
      configDirectory: options.configDirectory,
    }),
    sandboxName,
    adapter,
  );
}

function convergeCredentialRevisionAfterReload(
  sandboxName: string,
  adapter: AgentMcpAdapter,
  entry: McpBridgeEntry,
  envValues: Record<string, string>,
  options: InstalledMcpRegistrationOptions,
  plan: HarnessMcpRegistrationPlan,
  dependencies: InstalledMcpMutationDependencies,
): void {
  const credentialRevision = options.credentialRevision;
  if (
    credentialRevision === undefined ||
    plan.credentialConvergence.kind !== "after-runtime-reload"
  ) {
    return;
  }
  const observedRevision = dependencies.observeCredentialRevision(sandboxName, entry);
  if (observedRevision === credentialRevision) return;
  if (observedRevision === "absent" || observedRevision === "canonical") {
    throw new McpBridgeError(plan.credentialConvergence.unavailableMessage);
  }

  const convergedPlan = buildRegistrationPlan(sandboxName, adapter, entry, {
    ...options,
    replaceExisting: true,
    credentialRevision: observedRevision,
  });
  const result = executeMcpMutationPlan(
    sandboxName,
    entry,
    convergedPlan.execution,
    envValues,
    false,
    dependencies,
  );
  if (!result) throw new McpBridgeError(convergedPlan.execution.failureMessage);
  verifyInstalledMcpRegistration(
    sandboxName,
    adapter,
    entry,
    convergedPlan,
    observedRevision,
    options.configDirectory,
    result,
    dependencies,
  );
  if (dependencies.observeCredentialRevision(sandboxName, entry) !== observedRevision) {
    throw new McpBridgeError(plan.credentialConvergence.unstableMessage);
  }
}

/** Apply one package registration plan without selecting behavior by adapter name. */
export function registerInstalledMcpAdapter(
  sandboxName: string,
  adapter: AgentMcpAdapter,
  entry: McpBridgeEntry,
  envValues: Record<string, string>,
  options: InstalledMcpRegistrationOptions = {},
  dependencies: InstalledMcpMutationDependencies = defaultDependencies,
): void {
  const plan = buildRegistrationPlan(sandboxName, adapter, entry, options);
  const result = executeMcpMutationPlan(
    sandboxName,
    entry,
    plan.execution,
    envValues,
    false,
    dependencies,
  );
  if (!result) throw new McpBridgeError(plan.execution.failureMessage);
  verifyInstalledMcpRegistration(
    sandboxName,
    adapter,
    entry,
    plan,
    options.credentialRevision,
    options.configDirectory,
    result,
    dependencies,
  );
  convergeCredentialRevisionAfterReload(
    sandboxName,
    adapter,
    entry,
    envValues,
    options,
    plan,
    dependencies,
  );
}

/** Apply one package removal plan without selecting behavior by adapter name. */
export function unregisterInstalledMcpAdapter(
  sandboxName: string,
  adapter: AgentMcpAdapter,
  entry: McpBridgeEntry,
  options: InstalledMcpRemovalOptions = {},
  dependencies: InstalledMcpMutationDependencies = defaultDependencies,
): AdapterRemovalOutcome {
  const plan = buildInstalledMcpRemovalPlan(sandboxName, adapter, entry, {
    force: options.force === true,
    adaptiveTeardown: options.teardown === true,
    configDirectory: options.configDirectory,
  });
  if (!plan) {
    throw new McpBridgeError(
      `Installed MCP adapter '${adapter}' for sandbox '${sandboxName}' is unavailable.`,
    );
  }
  const result = executeMcpMutationPlan(
    sandboxName,
    entry,
    plan.execution,
    options.envValues ?? {},
    options.bestEffort === true,
    dependencies,
  );
  if (plan.outcome.kind === "removed") return "removed";
  const marker = commandText(result?.stdout).match(MCP_REMOVAL_OUTCOME_PATTERN);
  return (marker?.[1] as AdapterRemovalOutcome | undefined) ?? "unowned";
}
