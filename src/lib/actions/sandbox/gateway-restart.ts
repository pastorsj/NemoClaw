// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { AgentDefinition } from "../../agent/defs";
import * as agentRuntime from "../../agent/runtime";
import type { HarnessPackageIdentity } from "../../agent-runtime/package/identity";
import { G, R } from "../../cli/terminal-style";
import { assertHermesPortableCommandUnavailable } from "../../onboard/experimental/portable-agent-lifecycle";
import { withMcpLifecycleLockSync } from "../../state/mcp-lifecycle-lock-acquisition";
import { packageProcessLifecycleUnsupportedReason } from "./process-lifecycle";
import {
  classifyGatewayRestartFailure,
  type GatewayRestartCommandResult,
  type GatewayRestartFailureLayer,
  parseManagedGatewayControlCompletion,
  sanitizeGatewayRestartFailureLine,
} from "./runtime/gateway-result";
import {
  collectLegacyGatewayFailureLog,
  isLegacyManagedGatewayAgent,
  legacyDefaultGatewayAgentName,
  legacyGatewayRestartSupportLine,
  legacyRecoveryDisplayName,
  needsLegacyOpenClawRelaunchWindow,
  requiresLegacyRunningGatewayRevalidation,
  validateLegacyGatewayRestartAgent,
} from "./runtime/legacy-recovery";
import { mcpRuntimeIntentRemediationLines } from "./mcp-bridge/recovery-guidance";

export {
  packageProcessLifecycleUnsupportedReason,
  PROCESS_LIFECYCLE_UNSUPPORTED_MARKER,
  executeSandboxProcessLifecycle,
} from "./process-lifecycle";
export {
  classifyGatewayRestartFailure,
  type GatewayRestartCommandResult,
  type GatewayRestartFailureLayer,
  MANAGED_CONTROL_IDENTITY_CHANGED_MARKER,
  type ManagedGatewayControlCompletion,
  parseManagedGatewayControlCompletion,
  redactGatewayRestartFailureDetail,
} from "./runtime/gateway-result";
export {
  isLegacyManagedGatewayAgent,
  legacyRecoveryDisplayName,
  needsLegacyOpenClawRelaunchWindow,
  requiresLegacyRunningGatewayRevalidation,
  validateLegacyGatewayRestartAgent,
};

export function withLegacyPortableGatewayRestartFence<T>(
  sandboxName: string,
  getSandbox: SandboxAgentLookup,
  operation: () => T,
): T {
  return withMcpLifecycleLockSync(sandboxName, () => {
    let legacyAuthority = false;
    try {
      legacyAuthority = getSandbox(sandboxName)?.harnessPackage == null;
    } catch {
      // Let the generic operation report the lookup failure. Do not enter a
      // native compatibility fence when package authority is unreadable.
    }
    if (legacyAuthority) {
      assertHermesPortableCommandUnavailable(sandboxName, "sandbox:gateway:restart");
    }
    return operation();
  });
}

export type GatewayRestartResult =
  | {
      ok: true;
      restarted: true;
      healthPassed: true;
      forwardRecovered: boolean;
    }
  | {
      ok: false;
      failureLayer: GatewayRestartFailureLayer;
      detail: string;
      restarted?: never;
      healthPassed?: never;
    }
  | {
      ok: false;
      failureLayer: "MCP reconciliation refusal";
      detail: string;
      restarted: true;
      healthPassed: true;
    };

type SandboxAgentRecord = {
  agent?: string | null;
  harnessPackage?: HarnessPackageIdentity | null;
};

type SandboxAgentLookup = (sandboxName: string) => SandboxAgentRecord | null | undefined;

type SupervisorAction = (
  sandboxName: string,
  action: "restart" | "recover" | "probe",
  timeout?: number,
) => GatewayRestartCommandResult | null;

type SandboxExec = (
  sandboxName: string,
  command: string,
  timeout?: number,
) => GatewayRestartCommandResult | null;

type InspectMcpRuntimeIntentRefusal = (sandboxName: string) => { detail: string } | null;

export type GatewayRestartDeps = {
  getSessionAgent: typeof agentRuntime.getSessionAgent;
  getSandbox: SandboxAgentLookup;
  resolveSandboxDashboardPort: (sandboxName: string) => number;
  requestGatewaySupervisorAction: SupervisorAction;
  executeSandboxExecCommand: SandboxExec;
  waitForRecoveredSandboxGateway: (
    sandboxName: string,
    options?: {
      quiet?: boolean;
      timeoutSeconds?: number;
      initialManagedHealthPassed?: boolean;
    },
  ) => boolean;
  ensureSandboxPortForward: (sandboxName: string) => boolean;
  ensureHermesDashboardPortForwardIfEnabled: (sandboxName: string) => boolean | null;
  recoverMessagingHostForward: (sandboxName: string, options: { quiet: boolean }) => boolean | null;
  recoverDeclaredAgentForwardPorts: (
    sandboxName: string,
    recoveryPort: number,
    options: { quiet: boolean },
  ) => boolean | null;
  printGatewayWedgeDiagnostics: (
    sandboxName: string,
    exec: (sandboxName: string, command: string) => GatewayRestartCommandResult | null,
  ) => boolean;
  inspectMcpRuntimeIntentRefusal: InspectMcpRuntimeIntentRefusal;
};

export type RestartSandboxGatewayOptions = {
  quiet?: boolean;
  /** Rebuilds pin the definition selected at preflight; standalone restarts omit it. */
  agentDefinition?: AgentDefinition;
  deps?: Partial<GatewayRestartDeps>;
};

export function sandboxAgentName(
  sandboxName: string,
  getSandbox: SandboxAgentLookup,
): string | null {
  return getSandbox(sandboxName)?.agent ?? null;
}

export function isGatewayIntegrityRepairLayer(
  layer: GatewayRestartFailureLayer | null | undefined,
): layer is "config hash mismatch" | "relaunch quarantined" {
  return layer === "config hash mismatch" || layer === "relaunch quarantined";
}

/**
 * The supported repair for a sandbox whose protected configuration drifted away
 * from its recorded integrity metadata. Both layers are deterministic refusals:
 * every relaunch re-reads the same drifted file, so retrying a restart or a
 * recover only burns the supervisor's crash budget. `rebuild` is the documented
 * command that restores the registered configuration, refreshes the integrity
 * hashes, and brings the gateway back in one transaction (#7801).
 */
export function gatewayIntegrityRepairLines(
  sandboxName: string,
  layer: "config hash mismatch" | "relaunch quarantined",
): readonly string[] {
  const cause =
    layer === "config hash mismatch"
      ? "A protected configuration file no longer matches its recorded integrity hash."
      : "The in-sandbox supervisor quarantined gateway relaunch after a startup refusal.";
  return [
    `${cause} Retrying the restart cannot clear it.`,
    `Restore the registered configuration and refresh its integrity metadata with \`nemoclaw ${sandboxName} rebuild --yes\`.`,
    `Then make intended changes through supported commands such as \`nemoclaw ${sandboxName} config set\` or \`nemoclaw inference set --sandbox ${sandboxName}\`, which update the configuration and its hashes together.`,
  ];
}

export function printGatewayRestartFailure(
  sandboxName: string,
  layer: GatewayRestartFailureLayer,
  detail: string,
  gatewayLogTail: readonly string[] = [],
): void {
  console.error(`  Failure layer: ${layer} - gateway restart failed for '${sandboxName}'.`);
  if (detail.trim()) {
    const lines = detail
      .split(/\r?\n/)
      .map((line) => sanitizeGatewayRestartFailureLine(line.trim()))
      .filter(Boolean)
      .slice(-12);
    for (const line of lines) {
      console.error(`  ${line}`);
    }
  }
  // Remediation is emitted outside the detail guard: an empty controller detail
  // is exactly the case where the operator has nothing else to go on.
  if (layer === "MCP reconciliation refusal") {
    for (const line of mcpRuntimeIntentRemediationLines(sandboxName)) {
      console.error(`  ${line}`);
    }
  }
  if (gatewayLogTail.length > 0) {
    console.error("  Hermes gateway log tail (sanitized):");
    for (const line of gatewayLogTail) console.error(`  ${line}`);
  }
  if (isGatewayIntegrityRepairLayer(layer)) {
    for (const line of gatewayIntegrityRepairLines(sandboxName, layer)) {
      console.error(`  ${line}`);
    }
  }
}

function unsupportedGatewayRestartAgentDetail(
  agentName: string,
  reason: string,
  receiptBacked = false,
): string {
  return [
    `Agent '${agentName}' does not support gateway restart.`,
    receiptBacked
      ? "Receipt-backed packages support gateway restart when their manifest declares runtime.kind 'gateway' and managed process lifecycle support."
      : legacyGatewayRestartSupportLine(),
    reason,
  ].join("\n");
}

type RestartAuxiliaryRecoveryResult = {
  label: string;
  recovered: boolean | null;
};

function failedAuxiliaryRecoveryDetail(results: RestartAuxiliaryRecoveryResult[]): string | null {
  const failed = results
    .filter((result) => result.recovered === false)
    .map((result) => result.label);
  if (failed.length === 0) return null;
  return `gateway health passed but ${failed.join(", ")} could not be re-established`;
}

export function restartSandboxGatewayWithDeps(
  sandboxName: string,
  {
    quiet = false,
    deps,
  }: {
    quiet?: boolean;
    deps: GatewayRestartDeps;
  },
): GatewayRestartResult {
  let sandbox: SandboxAgentRecord | null | undefined;
  let persistedAgent: string | null;
  try {
    sandbox = deps.getSandbox(sandboxName);
    persistedAgent = sandbox?.agent ?? null;
  } catch (error) {
    const reason =
      error instanceof Error && error.message.trim()
        ? `Sandbox agent lookup failed: ${error.message}.`
        : "Sandbox agent lookup failed.";
    const detail = unsupportedGatewayRestartAgentDetail("unknown", reason);
    printGatewayRestartFailure(sandboxName, "unsupported agent", detail);
    return { ok: false, failureLayer: "unsupported agent", detail };
  }
  const receipt = sandbox?.harnessPackage ?? null;
  let agent: AgentDefinition | null;
  try {
    agent = deps.getSessionAgent(sandboxName);
  } catch (error) {
    const agentName = receipt?.id ?? persistedAgent ?? legacyDefaultGatewayAgentName();
    const reason = receipt
      ? "The package receipt's agent definition could not be resolved exactly."
      : error instanceof Error && error.message.trim()
        ? `Agent definition lookup failed: ${error.message}.`
        : "Agent definition lookup failed.";
    const detail = unsupportedGatewayRestartAgentDetail(agentName, reason, receipt !== null);
    printGatewayRestartFailure(sandboxName, "unsupported agent", detail);
    return { ok: false, failureLayer: "unsupported agent", detail };
  }
  const agentName = receipt?.id ?? agent?.name ?? persistedAgent ?? legacyDefaultGatewayAgentName();
  const persistedAgentName = receipt?.id ?? persistedAgent ?? legacyDefaultGatewayAgentName();
  const receiptBacked = receipt !== null;

  if (agent && agent.name !== persistedAgentName) {
    const detail = unsupportedGatewayRestartAgentDetail(
      agent.name,
      `The supplied agent definition does not match the sandbox's persisted '${persistedAgentName}' agent.`,
      receiptBacked,
    );
    printGatewayRestartFailure(sandboxName, "unsupported agent", detail);
    return { ok: false, failureLayer: "unsupported agent", detail };
  }

  if (agent && !agentRuntime.hasGatewayRuntime(agent)) {
    const detail = unsupportedGatewayRestartAgentDetail(
      agent.name,
      receiptBacked
        ? `${agentRuntime.getAgentDisplayName(agent)} declares runtime.kind 'terminal'; gateway restart requires runtime.kind 'gateway'.`
        : `${agentRuntime.getAgentDisplayName(agent)} has no gateway runtime.`,
      receiptBacked,
    );
    printGatewayRestartFailure(sandboxName, "unsupported agent", detail);
    return { ok: false, failureLayer: "unsupported agent", detail };
  }
  if (receiptBacked) {
    if (
      !agent ||
      agent.name !== receipt.id ||
      (persistedAgent !== null && persistedAgent !== receipt.id)
    ) {
      const detail = unsupportedGatewayRestartAgentDetail(
        agentName,
        "The package receipt's agent definition could not be resolved exactly.",
        true,
      );
      printGatewayRestartFailure(sandboxName, "unsupported agent", detail);
      return { ok: false, failureLayer: "unsupported agent", detail };
    }
    const processLifecycleReason = packageProcessLifecycleUnsupportedReason(agent);
    if (processLifecycleReason) {
      const detail = unsupportedGatewayRestartAgentDetail(agentName, processLifecycleReason, true);
      printGatewayRestartFailure(sandboxName, "unsupported agent", detail);
      return { ok: false, failureLayer: "unsupported agent", detail };
    }
  } else {
    const legacyValidation = validateLegacyGatewayRestartAgent(persistedAgent, agent);
    if (legacyValidation) {
      const detail = unsupportedGatewayRestartAgentDetail(
        legacyValidation.agentName,
        legacyValidation.reason,
      );
      printGatewayRestartFailure(sandboxName, "unsupported agent", detail);
      return { ok: false, failureLayer: "unsupported agent", detail };
    }
  }
  const dashboardPort = deps.resolveSandboxDashboardPort(sandboxName);

  if (!quiet) {
    console.log("");
    console.log(
      `  Restarting ${agentRuntime.getAgentDisplayName(agent)} gateway in '${sandboxName}'...`,
    );
  }
  const restartResult = deps.requestGatewaySupervisorAction(sandboxName, "restart", 210000);
  const hasRestartMarker =
    restartResult?.status === 0 &&
    restartResult.stdout.split(/\r?\n/).some((line) => line.startsWith("GATEWAY_PID="));
  if (!hasRestartMarker) {
    const failure = classifyGatewayRestartFailure(restartResult);
    const gatewayLogTail = receiptBacked
      ? []
      : collectLegacyGatewayFailureLog(sandboxName, persistedAgent, deps.executeSandboxExecCommand);
    printGatewayRestartFailure(sandboxName, failure.layer, failure.detail, gatewayLogTail);
    return { ok: false, failureLayer: failure.layer, detail: failure.detail };
  }

  if (
    !deps.waitForRecoveredSandboxGateway(sandboxName, {
      quiet,
      initialManagedHealthPassed: true,
    })
  ) {
    const detail = "gateway process restarted but health did not pass before timeout";
    printGatewayRestartFailure(sandboxName, "health timeout", detail);
    if (!receiptBacked) {
      deps.printGatewayWedgeDiagnostics(sandboxName, deps.executeSandboxExecCommand);
    }
    return { ok: false, failureLayer: "health timeout", detail };
  }

  const refusal = deps.inspectMcpRuntimeIntentRefusal(sandboxName);
  if (refusal) {
    const { detail } = refusal;
    printGatewayRestartFailure(sandboxName, "MCP reconciliation refusal", detail);
    return {
      ok: false,
      failureLayer: "MCP reconciliation refusal",
      detail,
      restarted: true,
      healthPassed: true,
    };
  }

  const forwardRecovered = deps.ensureSandboxPortForward(sandboxName);
  const dashboardForwardRecovered = receiptBacked
    ? null
    : deps.ensureHermesDashboardPortForwardIfEnabled(sandboxName);
  const messagingForwardRecovered = deps.recoverMessagingHostForward(sandboxName, { quiet });
  const declaredForwardsRecovered = deps.recoverDeclaredAgentForwardPorts(
    sandboxName,
    dashboardPort,
    { quiet },
  );
  const auxiliaryFailureDetail = failedAuxiliaryRecoveryDetail([
    { label: "the Hermes dashboard host forward", recovered: dashboardForwardRecovered },
    { label: "the messaging webhook host forward", recovered: messagingForwardRecovered },
    { label: "one or more agent-declared host forwards", recovered: declaredForwardsRecovered },
  ]);

  if (!forwardRecovered) {
    const detail =
      "gateway health passed but the primary dashboard/API host forward could not be re-established";
    printGatewayRestartFailure(sandboxName, "forward recovery failure", detail);
    return { ok: false, failureLayer: "forward recovery failure", detail };
  }
  if (auxiliaryFailureDetail !== null) {
    printGatewayRestartFailure(sandboxName, "forward recovery failure", auxiliaryFailureDetail);
    return { ok: false, failureLayer: "forward recovery failure", detail: auxiliaryFailureDetail };
  }

  if (!quiet) {
    console.log(
      `  ${G}✓${R} Gateway restarted; health passed; forwards checked/recovered for '${sandboxName}'.`,
    );
  }
  return {
    ok: true,
    restarted: true,
    healthPassed: true,
    forwardRecovered:
      forwardRecovered ||
      dashboardForwardRecovered === true ||
      messagingForwardRecovered === true ||
      declaredForwardsRecovered === true,
  };
}
