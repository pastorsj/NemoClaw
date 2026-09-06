// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Agent runtime lookup and shared lifecycle helpers. Package-backed sandboxes
// resolve their exact installed manifest; legacy rows retain the historical
// source-manifest and OpenClaw-default behavior.

import { DASHBOARD_PORT } from "../core/ports";
import type {
  HarnessPackageIdentity,
  HarnessPackageMigration,
} from "../agent-runtime/package/identity";
import * as onboardSession from "../state/onboard-session";
import * as registry from "../state/registry";
import { type AgentDefinition, isTerminalAgent, listAgents, loadAgent } from "./defs";
import { resolveSandboxAgent, type ResolveSandboxAgentOptions } from "../onboard/sandbox-agent";
import {
  getInteractiveAgentCommand as getManifestInteractiveAgentCommand,
  getTerminalCommand,
} from "./gateway-restart-scripts";

type RegisteredAgentSource =
  | {
      readonly agent?: string | null;
      readonly harnessPackage?: HarnessPackageIdentity | null;
      readonly harnessPackageMigration?: HarnessPackageMigration | null;
    }
  | null
  | undefined;

export {
  type AgentInteractiveCommandPlan,
  type AgentRecoveryScript,
  buildRecoveryScript,
  getTerminalCommand,
  isTerminalAgentRecoveryScript,
  planAgentInteractiveCommand,
  TERMINAL_AGENT_RECOVERY_SCRIPT,
} from "./gateway-restart-scripts";

/**
 * Resolve the agent for a sandbox. Checks the per-sandbox registry first
 * (so status/connect/recovery use the right agent even when multiple
 * sandboxes exist), then falls back to the global onboard session.
 * Package-backed rows return their exact installed definition. A legacy
 * OpenClaw row remains null so existing default behavior is preserved.
 */
export function getSessionAgent(
  sandboxName?: string,
  options: ResolveSandboxAgentOptions = {},
): AgentDefinition | null {
  if (sandboxName) {
    const sandbox = registry.getSandbox(sandboxName);
    if (sandbox) return getRegisteredAgent(sandbox, options);
  }
  return getRegisteredAgent(onboardSession.loadSession(), options);
}

/**
 * Resolve only the canonical authority persisted on the supplied registry or
 * session record. A package receipt is authoritative and must validate; rows
 * without one retain the explicit legacy manifest lookup.
 */
export function getRegisteredAgent(
  source: RegisteredAgentSource,
  options: ResolveSandboxAgentOptions = {},
): AgentDefinition | null {
  if (source?.harnessPackage != null || source?.harnessPackageMigration != null) {
    return resolveSandboxAgent(
      {
        agent: source.agent,
        ...(source.harnessPackage == null ? {} : { harnessPackage: source.harnessPackage }),
        ...(source.harnessPackageMigration == null
          ? {}
          : { harnessPackageMigration: source.harnessPackageMigration }),
      },
      options,
    ).definition;
  }

  const name = source?.agent;
  if (!name || name === "openclaw") return null;
  try {
    if (!listAgents().includes(name)) return null;
    return loadAgent(name);
  } catch {
    return null;
  }
}

/**
 * Resolve the trusted manifest command used for an interactive agent handoff.
 * OpenClaw remains `null` in getSessionAgent because its recovery behavior uses
 * legacy defaults, but launch and connect hints still load its repository-owned
 * manifest here. The historical OpenClaw fallback is used only when that
 * manifest is genuinely unavailable.
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
