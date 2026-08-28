// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHarnessInventoryView, type HarnessInventoryView } from "../harness/package-list";

export interface AgentRuntimeListEntry {
  readonly name: string;
  readonly description: string;
}

export interface AgentRuntimeListDependencies {
  readonly createHarnessInventoryView: () => HarnessInventoryView;
}

export const agentRuntimeListDependencies: AgentRuntimeListDependencies = {
  createHarnessInventoryView,
};

const STANDARD_AGENT_RUNTIME_DESCRIPTIONS: Readonly<Record<string, string>> = Object.freeze({
  openclaw: "Gateway-based AI agent with plugin ecosystem (openclaw.ai)",
  hermes: "Self-improving AI agent with learning loop (Nous Research)",
  "langchain-deepagents-code": "Terminal coding agent built on the Deep Agents SDK",
});

function compareAgentRuntimeEntries(
  left: AgentRuntimeListEntry,
  right: AgentRuntimeListEntry,
): number {
  if (left.name === "openclaw") return -1;
  if (right.name === "openclaw") return 1;
  return left.name.localeCompare(right.name);
}

/** Project receipt-verified standard packages into the legacy agents list shape. */
export function listAgentRuntimeEntries(
  dependencies: AgentRuntimeListDependencies = agentRuntimeListDependencies,
): AgentRuntimeListEntry[] {
  return dependencies
    .createHarnessInventoryView()
    .installed.flatMap((installed): AgentRuntimeListEntry[] => {
      const description = STANDARD_AGENT_RUNTIME_DESCRIPTIONS[installed.id];
      if (installed.health !== "healthy" || installed.identity === null || !description) return [];
      return [{ name: installed.id, description }];
    })
    .sort(compareAgentRuntimeEntries);
}

export function renderAgentRuntimeList(
  entries: readonly AgentRuntimeListEntry[] = listAgentRuntimeEntries(),
): string {
  if (entries.length === 0) return "No agent runtimes are installed.";

  const nameWidth = Math.max(...entries.map((entry) => entry.name.length));
  return entries
    .map((entry) => {
      if (!entry.description) return entry.name;
      return `${entry.name.padEnd(nameWidth + 2)}${entry.description}`;
    })
    .join("\n");
}

export function printAgentRuntimeList(
  log: (message: string) => void = console.log,
  dependencies: AgentRuntimeListDependencies = agentRuntimeListDependencies,
): void {
  log(renderAgentRuntimeList(listAgentRuntimeEntries(dependencies)));
}
