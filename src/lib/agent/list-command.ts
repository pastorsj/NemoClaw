// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  listHarnessPackageInventory,
  type HarnessPackageInventory,
} from "../agent-runtime/package/catalog";

export interface AgentRuntimeListEntry {
  readonly name: string;
  readonly description: string;
}

export interface AgentRuntimeListDependencies {
  readonly listHarnessPackageInventory: () => HarnessPackageInventory;
}

export const agentRuntimeListDependencies: AgentRuntimeListDependencies = {
  listHarnessPackageInventory,
};

function compareAgentRuntimeEntries(
  left: AgentRuntimeListEntry,
  right: AgentRuntimeListEntry,
): number {
  return left.name.localeCompare(right.name);
}

/** Project receipt-verified standard packages into the legacy agents list shape. */
export function listAgentRuntimeEntries(
  dependencies: AgentRuntimeListDependencies = agentRuntimeListDependencies,
): AgentRuntimeListEntry[] {
  const inventory = dependencies.listHarnessPackageInventory();
  const defaultIds = new Set(
    inventory.installed
      .filter(({ isDefaultOnboardingChoice }) => isDefaultOnboardingChoice)
      .map(({ id }) => id),
  );
  return inventory.installed
    .flatMap((installed): AgentRuntimeListEntry[] => {
      if (installed.state !== "installed") return [];
      return [{ name: installed.id, description: installed.description ?? "" }];
    })
    .sort((left, right) => {
      if (defaultIds.has(left.name)) return -1;
      if (defaultIds.has(right.name)) return 1;
      return compareAgentRuntimeEntries(left, right);
    });
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
