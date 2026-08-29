// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Agent definition loader — each agent's definition already lives in its
// agents/*/manifest.yaml. This facade scans those per-agent files and builds
// the stable derived accessors used during onboarding; schema types and
// validation readers stay in focused sibling modules.

import fs from "node:fs";
import path from "node:path";
import { isCuaEnabled, requireCuaEnabled } from "../cua/feature";
import { ROOT } from "../runner";
import {
  formatAgentAliasSuffix,
  resolveAgentNameAlias as resolveKnownAgentNameAlias,
} from "./aliases";
import {
  isCandidateAgent,
  isCandidateAgentSelectable,
  requireCandidateAgentSelectable,
} from "./candidate";
import type { AgentChoice, AgentDefinition } from "./definition-types";
import { buildAgentDefinition } from "./definition-loader";
import { loadManifestRecord } from "./manifest-readers";

export type {
  AgentChoice,
  AgentConfigPaths,
  AgentDashboard,
  AgentDashboardKind,
  AgentDefinition,
  AgentHealthProbe,
  AgentInference,
  AgentLegacyPaths,
  AgentMcpAdapter,
  AgentMcpCapability,
  AgentMcpSupport,
  AgentStateDirectory,
  AgentStateDirectoryPath,
  AgentStateDirectoryPrefix,
  AgentStateDirectoryShields,
  AgentStateFile,
  AgentStateFileStrategy,
  AgentStateLockPlan,
  AgentVersionScheme,
  StateFileFreshHeader,
  StateFileKeyAllowlistRestoreOwnership,
  StateFileOpenClawRestoreOwnership,
  StateFileRestoreMerge,
  StateFileRestoreOwnership,
  StateFileUserKey,
  StateFileUserKeyType,
} from "./definition-types";
export type { AgentRuntime, AgentRuntimeKind } from "./runtime-manifest";
export { getAgentRuntimeKind, isTerminalAgent } from "./runtime-manifest";
export type { AgentWebAuth, AgentWebAuthMethod } from "./web-auth";

export const AGENTS_DIR = path.join(ROOT, "agents");

const _cache = new Map<string, AgentDefinition>();

function freezeAgentDefinitionTree<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== "object" || value === null || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) freezeAgentDefinitionTree(child, seen);
  return Object.freeze(value);
}

/** Detach one parsed definition from its source data and freeze its complete value tree. */
export function createImmutableAgentDefinition(definition: AgentDefinition): AgentDefinition {
  return freezeAgentDefinitionTree(structuredClone(definition));
}

export { agentAliasSummary } from "./aliases";
export { requireCandidateQualificationEnabled } from "./candidate";

export function resolveAgentNameAlias(
  value: string | null | undefined,
  availableAgents: readonly string[] = listAgents(),
): string | null {
  return resolveKnownAgentNameAlias(value, availableAgents);
}

function unknownAgentMessage(
  value: string,
  context: string | null,
  available: readonly string[],
): string {
  const choices = available.join(", ");
  const suffix = context ? ` ${context}` : "";
  return `Unknown agent '${value}'${suffix}. Available: ${choices}${formatAgentAliasSuffix(available)}`;
}

/**
 * List available agent names by scanning agents/ for directories with
 * a manifest.yaml file.
 */
export function listAgents(env: NodeJS.ProcessEnv = process.env): string[] {
  const agents = fs.existsSync(AGENTS_DIR)
    ? fs
        .readdirSync(AGENTS_DIR, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .filter((entry) => entry.name !== "nemocua" || isCuaEnabled(env))
        .filter(
          (entry) => !isCandidateAgent(entry.name) || isCandidateAgentSelectable(entry.name, env),
        )
        .filter((entry) => fs.existsSync(path.join(AGENTS_DIR, entry.name, "manifest.yaml")))
        .map((entry) => entry.name)
    : [];
  return [...new Set(agents)].sort();
}

/** Resolve a non-OpenClaw agent's required, readable baseline policy. */
export function requireAgentPolicyAdditionsPath(
  agent: Pick<AgentDefinition, "name" | "policyAdditionsPath">,
): string {
  const policyPath = agent.policyAdditionsPath;
  try {
    if (!policyPath || !fs.statSync(policyPath).isFile()) throw new Error("missing policy file");
    fs.accessSync(policyPath, fs.constants.R_OK);
    return policyPath;
  } catch {
    throw new Error(
      `Agent '${agent.name}' baseline policy is unavailable; a readable policy-additions.yaml is required. Refusing to substitute the OpenClaw baseline.`,
    );
  }
}

/**
 * Load and parse an agent manifest without consulting the process cache.
 * Destructive repository-agent authority checks use this path so each fence
 * observes current manifest bytes and owns a detached immutable definition.
 */
export function loadAgentFresh(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): AgentDefinition {
  if (name === "nemocua") requireCuaEnabled(env);
  requireCandidateAgentSelectable(name, env);
  const manifestPath = path.join(AGENTS_DIR, name, "manifest.yaml");
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Agent '${name}' not found: ${manifestPath}`);
  }
  return createImmutableAgentDefinition(
    buildAgentDefinition({
      manifest: loadManifestRecord(manifestPath),
      manifestPath,
      packageRoot: ROOT,
    }),
  );
}

/**
 * Load and parse an agent manifest through the ordinary process cache.
 */
export function loadAgent(name: string, env: NodeJS.ProcessEnv = process.env): AgentDefinition {
  if (name === "nemocua") requireCuaEnabled(env);
  requireCandidateAgentSelectable(name, env);
  const manifestPath = path.join(AGENTS_DIR, name, "manifest.yaml");
  const cacheKey = `${ROOT}\0${manifestPath}`;
  const cached = _cache.get(cacheKey);
  if (cached) return cached;
  const agent = loadAgentFresh(name, env);
  _cache.set(cacheKey, agent);
  return agent;
}

/**
 * Get agent choices for interactive prompt (name, display_name, description).
 * OpenClaw is listed first as the default.
 */
export function getAgentChoices(): AgentChoice[] {
  // Build the menu defensively: a single malformed non-default manifest must
  // not abort interactive onboarding (e.g. an OpenClaw user accepting the
  // default). Skip agents that fail to load and surface a warning instead.
  const agents = listAgents().flatMap((name) => {
    try {
      const agent = loadAgent(name);
      return [
        {
          name: agent.name,
          displayName: agent.displayName,
          description: agent.description ?? "",
        },
      ];
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.error(`  Warning: skipping agent '${name}' — failed to load manifest: ${reason}`);
      return [];
    }
  });

  agents.sort((left, right) => {
    if (left.name === "openclaw") return -1;
    if (right.name === "openclaw") return 1;
    return left.name.localeCompare(right.name);
  });

  return agents;
}

/**
 * Resolve the effective agent from CLI flags, env vars, or session state.
 * Priority: explicit flag > env var > session > default ("openclaw").
 */
export function resolveAgentName({
  agentFlag = null,
  session = null,
}: {
  agentFlag?: string | null;
  session?: { agent?: string } | null;
} = {}): string {
  if (agentFlag) {
    const available = listAgents();
    const resolved = resolveAgentNameAlias(agentFlag, available);
    if (!resolved) {
      throw new Error(unknownAgentMessage(agentFlag, null, available));
    }
    return resolved;
  }

  const envAgent = process.env.NEMOCLAW_AGENT;
  if (envAgent) {
    const available = listAgents();
    const resolved = resolveAgentNameAlias(envAgent, available);
    if (!resolved) {
      throw new Error(unknownAgentMessage(envAgent, "(from NEMOCLAW_AGENT)", available));
    }
    return resolved;
  }

  if (session?.agent) {
    const available = listAgents();
    const resolved = resolveAgentNameAlias(session.agent, available);
    if (!resolved) {
      // A recorded release candidate must fail closed. Falling back to OpenClaw
      // would silently change the agent a resumed session was created with and
      // strand its agent-scoped state.
      requireCandidateAgentSelectable(session.agent);
      console.error(
        `  Warning: session references unknown agent '${session.agent}', falling back to openclaw.`,
      );
      return "openclaw";
    }
    return resolved;
  }

  return "openclaw";
}
