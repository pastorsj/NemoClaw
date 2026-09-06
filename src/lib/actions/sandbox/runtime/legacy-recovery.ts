// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { AgentDefinition } from "../../../agent/defs";
import * as agentRuntime from "../../../agent/runtime";
import { redactFullWithUrls } from "../../../security/redact";

type LegacyRecoveryCommandResult = {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
};

const LEGACY_GATEWAY_AGENTS = ["openclaw", "hermes"] as const;
const LEGACY_HERMES_LOG_TAIL_LINES = 12;
const LEGACY_HERMES_LOG_TAIL_COMMAND = `tail -n ${String(LEGACY_HERMES_LOG_TAIL_LINES)} /tmp/gateway.log 2>/dev/null || true`;

/** Historical default used only when a pre-receipt row recorded no agent. */
export function legacyDefaultGatewayAgentName(): string {
  return "openclaw";
}

/** Explain why a pre-receipt sandbox cannot use the historical gateway controller. */
export function validateLegacyGatewayRestartAgent(
  persistedAgent: string | null,
  agent: AgentDefinition | null,
): { readonly agentName: string; readonly reason: string } | null {
  const agentName = agent?.name ?? persistedAgent ?? "openclaw";
  if (!agent && persistedAgent && persistedAgent !== "openclaw") {
    return {
      agentName: persistedAgent,
      reason:
        persistedAgent === "hermes"
          ? "Hermes agent definition could not be loaded."
          : `${persistedAgent} agent definition could not be loaded.`,
    };
  }
  if (agentName === "hermes") {
    return agent?.name === "hermes"
      ? null
      : { agentName, reason: "Hermes agent definition could not be loaded." };
  }
  if (agentName === "openclaw" && (!agent || agent.name === "openclaw")) return null;
  return {
    agentName,
    reason:
      `${agentRuntime.getAgentDisplayName(agent)} does not declare a supported ` +
      "supervisor-mediated gateway restart runtime.",
  };
}

/** Whether a no-receipt row may use NemoClaw's historical managed controller. */
export function isLegacyManagedGatewayAgent(
  persistedAgent: string | null,
  agent: AgentDefinition | null,
): boolean {
  if (persistedAgent === "hermes") return agent?.name === "hermes";
  return (
    (persistedAgent === null || persistedAgent === "openclaw") &&
    (agent === null || agent.name === "openclaw")
  );
}

/** Historical pre-receipt Hermes rows require the running-gateway boundary check. */
export function requiresLegacyRunningGatewayRevalidation(persistedAgent: string | null): boolean {
  return persistedAgent === "hermes";
}

/** Preserve the longer recreation window of pre-receipt OpenClaw sandboxes. */
export function needsLegacyOpenClawRelaunchWindow(agent: AgentDefinition | null): boolean {
  return agent === null || agent.name === "openclaw";
}

/** Render the historical default name without teaching generic recovery its ID. */
export function legacyRecoveryDisplayName(
  persistedAgent: string | null,
  agent: AgentDefinition | null,
): string {
  if (agent) return agentRuntime.getAgentDisplayName(agent);
  if (persistedAgent && persistedAgent !== "openclaw") return persistedAgent;
  return agentRuntime.getAgentDisplayName(null);
}

/** Compatibility text for no-receipt gateway restart support. */
export function legacyGatewayRestartSupportLine(): string {
  return `Gateway restart-supported agents: ${LEGACY_GATEWAY_AGENTS.join(", ")}.`;
}

/**
 * Preserve the pre-receipt Hermes log diagnostic. Package controllers own all
 * receipt-backed diagnostic output and core only applies its bounded redaction.
 */
export function collectLegacyGatewayFailureLog(
  sandboxName: string,
  persistedAgent: string | null,
  exec: (
    sandboxName: string,
    command: string,
    timeout?: number,
  ) => LegacyRecoveryCommandResult | null,
): string[] {
  if (persistedAgent !== "hermes") return [];
  const result = exec(sandboxName, LEGACY_HERMES_LOG_TAIL_COMMAND);
  if (!result || result.status !== 0) return [];
  return redactFullWithUrls(result.stdout)
    .replace(
      /\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\)|[@-_])|[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/gu,
      "",
    )
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-LEGACY_HERMES_LOG_TAIL_LINES);
}
