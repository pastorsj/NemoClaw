// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { AgentDefinition } from "../../agent/defs";

// Names that collide with CLI command namespaces. A sandbox named 'status'
// makes 'nemoclaw status connect' route to the global status command instead
// of the sandbox. Keep this rule beside the normalization helpers used at
// every sandbox-name entry point.
export const RESERVED_SANDBOX_NAMES = new Set([
  "onboard",
  "list",
  "setup",
  "setup-spark",
  "start",
  "stop",
  "status",
  "debug",
  "uninstall",
  "update",
  "credentials",
  "help",
  "sandbox",
]);

export const UNKNOWN_SANDBOX_AGENT_NAME = "unknown";

export function normalizeSandboxAgentName(agentName: string | null | undefined): string {
  const trimmed = typeof agentName === "string" ? agentName.trim() : "";
  return trimmed && trimmed !== "openclaw" ? trimmed : "openclaw";
}

export function getRequestedSandboxAgentName(agent: AgentDefinition | null | undefined): string {
  return normalizeSandboxAgentName(agent?.name);
}

export function formatSandboxAgentName(agentName: string | null | undefined): string {
  const normalized = normalizeSandboxAgentName(agentName);
  if (normalized === "openclaw") return "OpenClaw";
  if (normalized === "hermes") return "Hermes";
  if (normalized === "langchain-deepagents-code") return "LangChain Deep Agents Code";
  return normalized;
}
