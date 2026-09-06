// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { AgentDefinition } from "../../agent/defs";
import type { WebSearchProvider } from "../../inference/web-search";

type NamedAgent = { readonly name?: unknown } | null | undefined;

function legacyAgentName(agent: NamedAgent): string {
  const name = agent?.name;
  return typeof name === "string" ? name.trim().toLowerCase() : "openclaw";
}

/** Select the historical patch owner after the caller proves package authority is absent. */
export function selectLegacyDockerfilePatchAgent(
  selectedAgent: AgentDefinition,
  loadOpenClawAgent: () => AgentDefinition,
): AgentDefinition {
  return legacyAgentName(selectedAgent) === "openclaw" ? selectedAgent : loadOpenClawAgent();
}

/** Apply the historical provider restriction after the caller proves package authority is absent. */
export function legacyAgentSupportsWebSearchProvider(
  agent: NamedAgent,
  provider: WebSearchProvider,
): boolean {
  return legacyAgentName(agent) !== "hermes" || provider === "tavily";
}

/** Apply the historical Hermes conflict after the caller proves package authority is absent. */
export function filterLegacyWebSearchToolGateways(
  agent: NamedAgent,
  provider: WebSearchProvider | null,
  gateways: readonly string[],
): string[] {
  return legacyAgentName(agent) === "hermes" && provider === "tavily"
    ? gateways.filter((gateway) => gateway !== "nous-web")
    : [...gateways];
}

/** Apply the historical OpenClaw route refresh after package authority is absent. */
export function legacyMessagingRouteRefreshRequired(agent: NamedAgent): boolean {
  return legacyAgentName(agent) === "openclaw";
}

/** Apply the historical OpenClaw pairing rule after package authority is absent. */
export function legacyDevicePairingRequired(agent: NamedAgent): boolean {
  return legacyAgentName(agent) === "openclaw";
}

/** Resume the historical OpenClaw prompt sequence only without package authority. */
export function resumesLegacyOpenClawSandboxPrompts(agent: NamedAgent): boolean {
  return legacyAgentName(agent) === "openclaw";
}

/** Decode the historical default agent after package authority is absent. */
export function isLegacyOpenClawAgentName(agentName: string | null | undefined): boolean {
  return (agentName?.trim().toLowerCase() || "openclaw") === "openclaw";
}

/** Build-only compatibility for repository-owned, pre-package Dockerfiles. */
export function legacyManagedDockerfilePatchOptions(
  agentName: string,
  wslHost: boolean,
): { readonly buildIdPolicy: "preserve" | "rewrite"; readonly wslDashboardExposure?: boolean } {
  const stableBuildId = agentName === "openclaw" || agentName === "hermes";
  return {
    buildIdPolicy: stableBuildId ? "preserve" : "rewrite",
    ...(agentName === "openclaw" ? { wslDashboardExposure: wslHost } : {}),
  };
}
