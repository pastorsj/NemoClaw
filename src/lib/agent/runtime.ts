// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Agent-specific runtime logic. Runtime commands resolve the sandbox registry
// identity before they use manifest-owned paths, probes, commands, or labels.
// The legacy null registry encoding resolves the selected OpenClaw manifest.
// Only entirely absent registry and session state keeps hardcoded defaults.
// A present recorded identity must resolve to its selected manifest.

import { DASHBOARD_PORT } from "../core/ports";
import * as onboardSession from "../state/onboard-session";
import * as registry from "../state/registry";
import { type AgentDefinition, isTerminalAgent, listAgents, loadAgent } from "./defs";
import {
  getInteractiveAgentCommand as getManifestInteractiveAgentCommand,
  getTerminalCommand,
} from "./gateway-restart-scripts";

type RegisteredAgentSource = { agent?: string | null } | null | undefined;

export {
  type AgentRecoveryScript,
  buildRecoveryScript,
  getTerminalCommand,
  isTerminalAgentRecoveryScript,
  TERMINAL_AGENT_RECOVERY_SCRIPT,
} from "./gateway-restart-scripts";

/**
 * Resolve the agent for a sandbox. Checks the per-sandbox registry first
 * (so status/connect/recovery use the right agent even when multiple
 * sandboxes exist), then falls back to the global onboard session.
 * Returns null only when registry and session state are both absent. A legacy
 * null identity means OpenClaw. Any present identity fails closed when its
 * selected manifest is unavailable.
 */
export function getSessionAgent(sandboxName?: string): AgentDefinition | null {
  if (sandboxName) {
    const sandbox = registry.getSandbox(sandboxName);
    if (sandbox) return requireRecordedAgent(sandbox, `sandbox '${sandboxName}'`, "openclaw");
  }
  const session = onboardSession.loadSession();
  return session ? requireRecordedAgent(session, "onboard session", "openclaw") : null;
}

/**
 * Resolve only the canonical agent persisted on the supplied sandbox registry row.
 * Registry state is user-writable, so validate against the trusted manifest inventory
 * before allowing its value to become a filesystem path component in loadAgent().
 */
export function getRegisteredAgent(source: RegisteredAgentSource): AgentDefinition | null {
  if (!source) return null;
  const name = source.agent ?? "openclaw";
  if (typeof name !== "string" || name.length === 0) return null;
  try {
    if (!listAgents().includes(name)) return null;
    const agent = loadAgent(name);
    return agent.name === name ? agent : null;
  } catch {
    return null;
  }
}

function requireRecordedAgent(
  source: RegisteredAgentSource,
  sourceLabel: string,
  legacyAgentName?: string,
): AgentDefinition | null {
  const name: unknown = source?.agent;
  if (name !== null && name !== undefined && typeof name !== "string") {
    throw new Error(`Cannot resolve the recorded agent identity from ${sourceLabel}.`);
  }
  const recordedName = name === null || name === undefined ? legacyAgentName : name;
  if (recordedName === undefined) return null;
  const agent = getRegisteredAgent({ agent: recordedName });
  if (agent) return agent;
  throw new Error(
    `Cannot resolve the recorded agent identity ${JSON.stringify(recordedName)} from ${sourceLabel}.`,
  );
}

/**
 * Resolve the trusted manifest command used for an interactive agent handoff.
 * Legacy state can still supply null for OpenClaw. Launch and connect hints
 * load its selected manifest when possible and otherwise use the historical
 * interactive command.
 */
export function getInteractiveAgentCommand(
  agent: AgentDefinition | null,
  agentName: string | null | undefined,
): string {
  const name = agentName || agent?.name || "openclaw";
  let trustedAgent = agent;
  if (!trustedAgent) {
    try {
      if (listAgents().includes(name)) trustedAgent = loadAgent(name);
    } catch {
      trustedAgent = null;
    }
  }
  return getManifestInteractiveAgentCommand(trustedAgent, name);
}

/**
 * Get the health probe URL for the agent.
 * Returns the agent's configured probe URL, or the OpenClaw /health endpoint.
 *
 * Uses /health (not /) because /health returns 200 regardless of device auth
 * state, while / returns 401 when device auth is enabled. This ensures
 * health probes work correctly in all configurations. Fixes #2342.
 */
export function getHealthProbeUrl(agent: AgentDefinition | null): string {
  if (!agent) return `http://127.0.0.1:${DASHBOARD_PORT}/health`;
  if (isTerminalAgent(agent)) return "";
  return agent.healthProbe?.url || `http://127.0.0.1:${DASHBOARD_PORT}/health`;
}

export function hasGatewayRuntime(
  agent: { runtime?: { kind?: unknown } | null } | null | undefined,
): boolean {
  return !isTerminalAgent(agent);
}

/**
 * Get the display name for the current agent.
 */
export function getAgentDisplayName(agent: AgentDefinition | null): string {
  return agent ? agent.displayName : "OpenClaw";
}

/**
 * Get the gateway command for the current agent.
 */
export function getGatewayCommand(agent: AgentDefinition | null): string {
  if (agent && isTerminalAgent(agent)) return getTerminalCommand(agent) ?? agent.versionCommand;
  return agent?.gateway_command || "openclaw gateway run";
}
