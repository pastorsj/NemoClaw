// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

import type { AgentDefinition } from "../agent-runtime/manifest-types";
import { formatEnvAssignment } from "../core/url-utils";

const DEFAULT_OPENCLAW_CONFIG_DIR = "/sandbox/.openclaw";
const OPENCLAW_AUTO_PAIR_RUNTIME_ENV_KEYS = [
  "NEMOCLAW_AUTO_PAIR_DEADLINE_SECS",
  "NEMOCLAW_AUTO_PAIR_FAST_DEADLINE_SECS",
  "NEMOCLAW_AUTO_PAIR_FAST_REENTRY_INTERVAL_SECS",
  "NEMOCLAW_AUTO_PAIR_FAST_REENTRY_POLLS",
  "NEMOCLAW_AUTO_PAIR_RUN_TIMEOUT_SECS",
  "NEMOCLAW_AUTO_PAIR_SLOW_INTERVAL_SECS",
] as const;
const OPENCLAW_DIAGNOSTIC_RUNTIME_ENV_KEYS = ["NEMOCLAW_MCP_SHADOW_DIAGNOSTICS"] as const;
const OPENCLAW_MCP_TOOLS_LIST_TIMEOUT_ENV = "NEMOCLAW_MCP_TOOLS_LIST_TIMEOUT_MS";
const OPENCLAW_MCP_TOOLS_LIST_TIMEOUT_MIN_MS = 1500;
const OPENCLAW_MCP_TOOLS_LIST_TIMEOUT_MAX_MS = 10_000;

function isLegacyOpenClaw(agent: AgentDefinition | null): boolean {
  return agent === null || agent.name === "openclaw";
}

function appendLegacyOpenClawPaths(envArgs: string[], agent: AgentDefinition | null): void {
  if (!isLegacyOpenClaw(agent)) return;
  const configDir = agent?.configPaths?.dir || DEFAULT_OPENCLAW_CONFIG_DIR;
  const homeDir = path.posix.dirname(configDir);
  envArgs.push(formatEnvAssignment("OPENCLAW_HOME", homeDir));
  envArgs.push(formatEnvAssignment("OPENCLAW_STATE_DIR", configDir));
  envArgs.push(formatEnvAssignment("OPENCLAW_WORKSPACE_DIR", `${configDir}/workspace`));
}

function appendLegacyOpenClawRuntimeControls(
  envArgs: string[],
  agent: AgentDefinition | null,
  env: NodeJS.ProcessEnv,
): void {
  if (!isLegacyOpenClaw(agent)) return;
  for (const key of OPENCLAW_AUTO_PAIR_RUNTIME_ENV_KEYS) {
    const value = env[key]?.trim();
    if (value) envArgs.push(formatEnvAssignment(key, value));
  }
  for (const key of OPENCLAW_DIAGNOSTIC_RUNTIME_ENV_KEYS) {
    if (env[key]?.trim() === "1") envArgs.push(formatEnvAssignment(key, "1"));
  }
}

function appendLegacyOpenClawMcpTimeout(
  envArgs: string[],
  agent: AgentDefinition | null,
  env: NodeJS.ProcessEnv,
): void {
  if (!isLegacyOpenClaw(agent)) return;
  const raw = env[OPENCLAW_MCP_TOOLS_LIST_TIMEOUT_ENV];
  if (raw === undefined || raw.trim() === "") return;
  const value = raw.trim();
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    throw new Error(
      `${OPENCLAW_MCP_TOOLS_LIST_TIMEOUT_ENV} must be an integer from ${OPENCLAW_MCP_TOOLS_LIST_TIMEOUT_MIN_MS} to ${OPENCLAW_MCP_TOOLS_LIST_TIMEOUT_MAX_MS} milliseconds.`,
    );
  }
  const timeoutMs = Number(value);
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < OPENCLAW_MCP_TOOLS_LIST_TIMEOUT_MIN_MS ||
    timeoutMs > OPENCLAW_MCP_TOOLS_LIST_TIMEOUT_MAX_MS
  ) {
    throw new Error(
      `${OPENCLAW_MCP_TOOLS_LIST_TIMEOUT_ENV} must be an integer from ${OPENCLAW_MCP_TOOLS_LIST_TIMEOUT_MIN_MS} to ${OPENCLAW_MCP_TOOLS_LIST_TIMEOUT_MAX_MS} milliseconds.`,
    );
  }
  envArgs.push(formatEnvAssignment(OPENCLAW_MCP_TOOLS_LIST_TIMEOUT_ENV, String(timeoutMs)));
}

function appendLegacyObservability(
  envArgs: string[],
  agent: AgentDefinition | null,
  observabilityEnabled: boolean,
): void {
  if (agent?.name !== "langchain-deepagents-code") return;
  envArgs.push(formatEnvAssignment("NEMOCLAW_OBSERVABILITY", observabilityEnabled ? "1" : "0"));
}

/**
 * Preserve startup arguments for pre-package sessions only. Receipt-backed
 * packages declare startup behavior through their manifest and typed startup
 * adapter, so they must never reach these historical package-ID decisions.
 */
export function appendLegacyRuntimeEnvironment(
  envArgs: string[],
  agent: AgentDefinition | null,
  env: NodeJS.ProcessEnv,
  observabilityEnabled: boolean,
): void {
  appendLegacyOpenClawPaths(envArgs, agent);
  appendLegacyOpenClawRuntimeControls(envArgs, agent, env);
  appendLegacyOpenClawMcpTimeout(envArgs, agent, env);
  appendLegacyObservability(envArgs, agent, observabilityEnabled);
}
