// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type {
  AvailableHarnessPackageRecord,
  DamagedInstalledHarnessPackageRecord,
  HarnessPackageInventory,
  HealthyInstalledHarnessPackageRecord,
} from "../agent-runtime/package/catalog";
import type { HarnessPackageIdentity } from "../agent-runtime/package/types";
import {
  listAgentRuntimeEntries,
  printAgentRuntimeList,
  renderAgentRuntimeList,
  type AgentRuntimeListDependencies,
} from "./list-command";

function packageIdentity(id: string, digestCharacter = "a"): HarnessPackageIdentity {
  return {
    kind: "agent-runtime",
    id,
    packageVersion: "0.1.0",
    contentDigest: digestCharacter.repeat(64),
  };
}

const PACKAGE_DESCRIPTIONS: Readonly<Record<string, string>> = Object.freeze({
  openclaw: "Gateway-based AI agent with plugin ecosystem (openclaw.ai)",
  hermes: "Self-improving AI agent with learning loop (Nous Research)",
  "langchain-deepagents-code": "Terminal coding agent built on the Deep Agents SDK",
});

function healthyPackage(id: string, displayName = id): HealthyInstalledHarnessPackageRecord {
  return {
    state: "installed",
    id,
    displayName,
    description: PACKAGE_DESCRIPTIONS[id] ?? `${displayName} package`,
    aliases: [],
    aliasSummary: null,
    isDefaultOnboardingChoice: id === "openclaw",
    defaultSandboxName: id,
    identity: packageIdentity(id),
    packageRoot: `/store/${id}`,
    matchesAvailableIdentity: true,
  };
}

function damagedPackage(id: string, displayName = id): DamagedInstalledHarnessPackageRecord {
  return {
    state: "damaged",
    id,
    displayName,
    description: PACKAGE_DESCRIPTIONS[id] ?? null,
    aliases: [],
    aliasSummary: null,
    isDefaultOnboardingChoice: id === "openclaw",
    defaultSandboxName: id,
    reason: "installed-package-integrity-failed",
  };
}

function availablePackage(id: string, displayName = id): AvailableHarnessPackageRecord {
  return {
    state: "available",
    id,
    displayName,
    description: PACKAGE_DESCRIPTIONS[id] ?? null,
    aliases: [],
    aliasSummary: null,
    isDefaultOnboardingChoice: id === "openclaw",
    defaultSandboxName: id,
    identity: packageIdentity(id, "b"),
    packageRoot: `/bundle/${id}`,
  };
}

function harnessInventory(
  installed: HarnessPackageInventory["installed"] = [],
  available: HarnessPackageInventory["available"] = [],
): HarnessPackageInventory {
  return { installed, available };
}

function inventoryDependencies(view: HarnessPackageInventory): {
  dependencies: AgentRuntimeListDependencies;
  listHarnessPackageInventory: ReturnType<typeof vi.fn>;
} {
  const listHarnessPackageInventory = vi.fn(() => view);
  return {
    dependencies: { listHarnessPackageInventory },
    listHarnessPackageInventory,
  };
}

describe("agent runtime list command support", () => {
  it("reports no agent runtimes when reviewed packages are available but not installed", () => {
    const { dependencies, listHarnessPackageInventory } = inventoryDependencies(
      harnessInventory([], [availablePackage("openclaw", "OpenClaw")]),
    );

    const entries = listAgentRuntimeEntries(dependencies);

    expect(entries).toEqual([]);
    expect(renderAgentRuntimeList(entries)).toBe("No agent runtimes are installed.");
    expect(listHarnessPackageInventory).toHaveBeenCalledOnce();
  });

  it("projects one healthy installed package with its canonical description", () => {
    const { dependencies } = inventoryDependencies(
      harnessInventory([healthyPackage("hermes", "Hermes Agent")]),
    );

    expect(listAgentRuntimeEntries(dependencies)).toEqual([
      {
        name: "hermes",
        description: "Self-improving AI agent with learning loop (Nous Research)",
      },
    ]);
  });

  it("sorts OpenClaw first and retains aligned legacy list text", () => {
    const { dependencies } = inventoryDependencies(
      harnessInventory([
        healthyPackage("langchain-deepagents-code", "LangChain Deep Agents Code"),
        healthyPackage("openclaw", "OpenClaw"),
        healthyPackage("hermes", "Hermes Agent"),
      ]),
    );

    expect(renderAgentRuntimeList(listAgentRuntimeEntries(dependencies))).toBe(
      [
        "openclaw                   Gateway-based AI agent with plugin ecosystem (openclaw.ai)",
        "hermes                     Self-improving AI agent with learning loop (Nous Research)",
        "langchain-deepagents-code  Terminal coding agent built on the Deep Agents SDK",
      ].join("\n"),
    );
  });

  it("excludes damaged and available-only packages", () => {
    const { dependencies } = inventoryDependencies(
      harnessInventory(
        [damagedPackage("openclaw", "OpenClaw")],
        [availablePackage("openclaw", "OpenClaw"), availablePackage("hermes", "Hermes Agent")],
      ),
    );

    expect(listAgentRuntimeEntries(dependencies)).toEqual([]);
  });

  it("lists every healthy installed package that implements the contract", () => {
    const { dependencies } = inventoryDependencies(
      harnessInventory([
        healthyPackage("pi", "Pi"),
        healthyPackage("nemocua", "NemoCUA"),
        healthyPackage("deepagents", "Deep Agents alias"),
        healthyPackage("future-harness", "Future Harness"),
        healthyPackage("openclaw", "OpenClaw"),
      ]),
    );

    expect(listAgentRuntimeEntries(dependencies).map(({ name }) => name)).toEqual([
      "openclaw",
      "deepagents",
      "future-harness",
      "nemocua",
      "pi",
    ]);
  });

  it("prints one installed-only projection through the supplied logger", () => {
    const log = vi.fn();
    const { dependencies, listHarnessPackageInventory } = inventoryDependencies(
      harnessInventory([healthyPackage("openclaw", "OpenClaw")]),
    );

    printAgentRuntimeList(log, dependencies);

    expect(log).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith(
      "openclaw  Gateway-based AI agent with plugin ecosystem (openclaw.ai)",
    );
    expect(listHarnessPackageInventory).toHaveBeenCalledOnce();
  });
});
