// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export interface AgentAliasTarget {
  readonly name: string;
  readonly aliases: readonly string[];
  readonly aliasSummary?: string | null;
}

export type AgentAliasMap = Readonly<Record<string, string>>;

export function normalizeAgentSelector(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-");
}

/** Build one collision-free alias map from package-owned manifest declarations. */
export function createAgentAliasMap(targets: readonly AgentAliasTarget[]): AgentAliasMap {
  const names = new Set(targets.map(({ name }) => name));
  const aliases: Record<string, string> = {};
  for (const target of targets) {
    for (const declaredAlias of target.aliases) {
      const alias = normalizeAgentSelector(declaredAlias);
      if (alias !== declaredAlias || alias === target.name || names.has(alias)) {
        throw new Error(`Agent alias '${declaredAlias}' conflicts with an agent identifier`);
      }
      const existing = aliases[alias];
      if (existing !== undefined && existing !== target.name) {
        throw new Error(`Agent alias '${alias}' is declared by more than one agent`);
      }
      aliases[alias] = target.name;
    }
  }
  return Object.freeze(aliases);
}

export function resolveAgentNameAlias(
  value: string | null | undefined,
  availableAgents: readonly string[],
  aliasMap: AgentAliasMap = {},
): string | null {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed) return null;

  if (availableAgents.includes(trimmed)) return trimmed;

  const normalized = normalizeAgentSelector(trimmed);
  const exactNormalized = availableAgents.find(
    (agentName) => normalizeAgentSelector(agentName) === normalized,
  );
  if (exactNormalized) return exactNormalized;

  const aliasTarget = aliasMap[normalized];
  return aliasTarget && availableAgents.includes(aliasTarget) ? aliasTarget : null;
}

export function agentAliasSummary(
  availableAgents: readonly string[],
  targets: readonly AgentAliasTarget[] = [],
): string {
  return targets
    .filter(({ name, aliases }) => availableAgents.includes(name) && aliases.length > 0)
    .map(({ name, aliases, aliasSummary }) => aliasSummary ?? `${aliases.join("/")} → ${name}`)
    .filter((summary) => summary.length > 0)
    .join("; ");
}

export function formatAgentAliasSuffix(
  availableAgents: readonly string[],
  targets: readonly AgentAliasTarget[] = [],
): string {
  const summary = agentAliasSummary(availableAgents, targets);
  return summary ? ` (aliases: ${summary})` : "";
}
