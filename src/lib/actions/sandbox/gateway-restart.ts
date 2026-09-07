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
    };

export type RunningGatewayRevalidation =
  | { refused: false }
  | {
      refused: true;
      reason: "agent-missing" | "exec-failed" | "unexpected-marker";
      stderr: string;
    };

type GatewaySupervisorRequest = (
  sandboxName: string,
  action: "restart" | "recover" | "probe",
  timeout?: number,
) => { status: number; stdout: string; stderr: string } | null;

function printControllerStderr(stderr: string): void {
  if (!stderr.trim()) return;
  for (const line of stderr.split(/\r?\n/u)) {
    if (line.trim()) console.error(`  ${line}`);
  }
}

/** Revalidate a receipt-backed running gateway through its reviewed package controller. */
export function enforceRunningGatewayRevalidation(
  sandboxName: string,
  agent: AgentDefinition | undefined,
  requestGatewaySupervisorAction: GatewaySupervisorRequest,
  required = true,
): RunningGatewayRevalidation | null {
  if (!required) return null;
  if (!agent) {
    console.error("");
    console.error(`  ${R}Agent definition could not be loaded for sandbox '${sandboxName}'.${R}`);
    console.error("  Refusing recovery because the package revalidation contract is unavailable.");
    return { refused: true, reason: "agent-missing", stderr: "" };
  }
  const result = requestGatewaySupervisorAction(sandboxName, "recover");
  if (!result) {
    console.error("");
    console.error(
      `  ${R}Running gateway revalidation could not run in sandbox '${sandboxName}'.${R}`,
    );
    console.error("  Refusing recovery because the package controller could not be reached.");
    return { refused: true, reason: "exec-failed", stderr: "" };
  }
  if (result.status === 0 && result.stdout.includes("GATEWAY_PID=")) {
    return { refused: false };
  }
  printControllerStderr(result.stderr);
  console.error("");
  console.error(
    `  ${R}Running gateway revalidation did not complete cleanly in sandbox '${sandboxName}'.${R}`,
  );
  console.error(
    "  Refusing recovery; inspect the package controller output before re-running the recover command.",
  );
  return { refused: true, reason: "unexpected-marker", stderr: result.stderr };
}

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

export function isGatewayTerminalRepairLayer(
  layer: GatewayRestartFailureLayer | null | undefined,
): layer is "config hash mismatch" | "relaunch quarantined" {
  return layer === "config hash mismatch" || layer === "relaunch quarantined";
}

/** Report terminal restart repair without treating process quarantine as config drift. */
export function gatewayTerminalRepairLines(
  sandboxName: string,
  layer: "config hash mismatch" | "relaunch quarantined",
): readonly string[] {
  if (layer === "relaunch quarantined") {
    return [
      "The in-sandbox supervisor stopped relaunch after repeated process or health failures.",
      `Inspect the Hermes failure with \`nemoclaw ${sandboxName} logs --tail 50\`.`,
      `After correcting the cause, reset the supervisor with \`nemoclaw ${sandboxName} stop\`, then \`nemoclaw ${sandboxName} start\`.`,
      `If the sandbox still cannot start, rebuild it with \`nemoclaw ${sandboxName} rebuild --yes\`.`,
    ];
  }
  return [
    "The restart transaction could not validate its integrity metadata.",
    `Restore the registered configuration and refresh its integrity metadata with \`nemoclaw ${sandboxName} rebuild --yes\`.`,
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
  if (isGatewayTerminalRepairLayer(layer)) {
    for (const line of gatewayTerminalRepairLines(sandboxName, layer)) {
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
    const failure = classifyGatewayRestartFailure(restartResult, {
      allowLegacyHarnessMarkers: !receiptBacked,
    });
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
