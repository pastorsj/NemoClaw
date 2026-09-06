// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { AgentMcpAdapter } from "../../../agent/defs";
import type {
  HarnessMcpAdapterCommandPlan,
  HarnessMcpSnapshotRestorePlan,
} from "../../../agent-runtime/host-module";
import type { McpBridgeEntry, SandboxEntry } from "../../../state/registry";
import { inspectAdapterRegistrationCommand } from "../mcp-bridge-adapter-inspection";
import type { OpenShellCommandResult } from "../mcp-bridge-output";
import type { McpProviderInspectionRuntimeSelection } from "../mcp-bridge-provider-inspection";
import {
  getBridgeAdapter,
  getSandboxAgent,
  requireSandboxHarnessPackage,
} from "../mcp-bridge-state";
import { executeMcpArgvCommand, executeMcpShellCommand } from "./command-execution";
import { McpBridgeError } from "./error";
import {
  buildInstalledMcpInspectionCommand,
  buildInstalledMcpSnapshotRestorePlan,
} from "./package-command";
import { assertInstalledMcpCapability } from "./package-probe";

export interface PreparedInstalledMcpSnapshotRestore {
  readonly sandboxName: string;
  readonly agentName: string;
  readonly adapter: AgentMcpAdapter;
  readonly entries: readonly McpBridgeEntry[];
  readonly plan: Extract<HarnessMcpSnapshotRestorePlan, { readonly kind: "conditional-repair" }>;
}

interface InstalledMcpSnapshotDependencies {
  readonly executeShellCommand: typeof executeMcpShellCommand;
  readonly executeArgvCommand: typeof executeMcpArgvCommand;
  readonly assertCapability: typeof assertInstalledMcpCapability;
  readonly inspectRegistration: typeof inspectAdapterRegistrationCommand;
}

const defaultDependencies: InstalledMcpSnapshotDependencies = {
  executeShellCommand: executeMcpShellCommand,
  executeArgvCommand: executeMcpArgvCommand,
  assertCapability: assertInstalledMcpCapability,
  inspectRegistration: inspectAdapterRegistrationCommand,
};

function requirePackageOwnedEntries(
  sandbox: SandboxEntry,
  agentName: string,
  adapter: AgentMcpAdapter,
): readonly McpBridgeEntry[] {
  const entries = Object.values(sandbox.mcp?.bridges ?? {});
  for (const entry of entries) {
    if (entry.agent !== agentName || entry.adapter !== adapter) {
      throw new McpBridgeError(
        `Managed MCP state for sandbox '${sandbox.name}' does not match its reconciled harness package authority. Remove the stale MCP entry or reconcile the sandbox package, then retry.`,
        1,
        "package-authority-required",
      );
    }
  }
  return Object.freeze([...entries].sort((left, right) => left.server.localeCompare(right.server)));
}

/**
 * Ask the installed package whether snapshot restore needs one MCP repair.
 * Core retains transaction authority; the package can only return the finite,
 * schema-validated command plan defined by the harness contract.
 */
export function prepareInstalledMcpSnapshotRestore(
  sandbox: SandboxEntry,
): PreparedInstalledMcpSnapshotRestore | null {
  const agent = getSandboxAgent(sandbox);
  if (agent.mcpCapability.support !== "bridge") return null;

  const harnessPackage = requireSandboxHarnessPackage(sandbox.name);
  if (harnessPackage.id !== agent.name) {
    throw new McpBridgeError(
      `Managed MCP requires reconciled harness package authority for sandbox '${sandbox.name}'. Re-run the NemoClaw installer to reconcile this sandbox's harness package, then retry.`,
      1,
      "package-authority-required",
    );
  }
  const adapter = getBridgeAdapter(agent);
  const entries = requirePackageOwnedEntries(sandbox, agent.name, adapter);
  const plan = buildInstalledMcpSnapshotRestorePlan(sandbox.name, adapter, agent.name, entries);
  if (!plan) {
    throw new McpBridgeError(
      `Managed MCP requires reconciled harness package authority for sandbox '${sandbox.name}'. Re-run the NemoClaw installer to reconcile this sandbox's harness package, then retry.`,
      1,
      "package-authority-required",
    );
  }
  if (plan.kind === "not-required") return null;
  return Object.freeze({
    sandboxName: sandbox.name,
    agentName: agent.name,
    adapter,
    entries,
    plan,
  });
}

function commandStdout(result: OpenShellCommandResult | null): string {
  if (!result || result.status !== 0) return "";
  const stdout =
    typeof result.stdout === "string" ? result.stdout : (result.stdout?.toString() ?? "");
  return stdout.trim().split(/\r?\n/u).at(-1)?.trim() ?? "";
}

function executePlanCommand(
  prepared: PreparedInstalledMcpSnapshotRestore,
  command: HarnessMcpAdapterCommandPlan,
  timeoutSeconds: number,
  runtimeSelection: McpProviderInspectionRuntimeSelection,
  dependencies: InstalledMcpSnapshotDependencies,
): OpenShellCommandResult | null {
  switch (command.kind) {
    case "shell":
      return dependencies.executeShellCommand(
        prepared.sandboxName,
        command.script,
        timeoutSeconds,
        runtimeSelection,
      );
    case "argv":
      return dependencies.executeArgvCommand(
        prepared.sandboxName,
        command.argv,
        timeoutSeconds,
        runtimeSelection,
      );
  }
}

/** Apply a prepared package repair after the snapshot transaction fences are revalidated. */
export function applyInstalledMcpSnapshotRestore(
  prepared: PreparedInstalledMcpSnapshotRestore,
  runtimeSelection: McpProviderInspectionRuntimeSelection,
  dependencies: InstalledMcpSnapshotDependencies = defaultDependencies,
): void {
  const { applicability, capability, execution } = prepared.plan;
  const applicabilityResult = executePlanCommand(
    prepared,
    applicability.command,
    applicability.timeoutSeconds,
    runtimeSelection,
    dependencies,
  );
  const applicabilityOutput = commandStdout(applicabilityResult);
  if (applicabilityOutput === applicability.skipWhenOutput) return;
  if (applicabilityOutput !== applicability.repairWhenOutput) {
    throw new McpBridgeError(applicability.failureMessage);
  }

  dependencies.assertCapability(prepared.sandboxName, capability, runtimeSelection);
  const executionResult = executePlanCommand(
    prepared,
    execution.command,
    execution.timeoutSeconds,
    runtimeSelection,
    dependencies,
  );
  if (!executionResult || executionResult.status !== 0) {
    throw new McpBridgeError(execution.failureMessage);
  }

  for (const entry of prepared.entries) {
    const command = buildInstalledMcpInspectionCommand(
      prepared.sandboxName,
      prepared.adapter,
      entry,
      { failOnMismatch: true },
    );
    if (!command) {
      throw new McpBridgeError(
        `Managed MCP requires reconciled harness package authority for sandbox '${prepared.sandboxName}'. Re-run the NemoClaw installer to reconcile this sandbox's harness package, then retry.`,
        1,
        "package-authority-required",
      );
    }
    const inspection = dependencies.inspectRegistration(
      prepared.sandboxName,
      entry,
      command,
      runtimeSelection,
    );
    if (inspection.state === "registered") continue;
    const detail = inspection.state === "error" ? inspection.detail : inspection.state;
    throw new McpBridgeError(`${prepared.plan.verificationFailureMessage}: ${detail}.`);
  }
}
