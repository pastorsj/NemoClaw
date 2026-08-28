// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type {
  HarnessAvailableInventoryRow,
  HarnessInstalledInventoryRow,
  HarnessInventoryView,
} from "../harness/package-list";
import type { HarnessPackageIdentity } from "../harness/package-types";
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
    contractVersion: 1,
    contentDigest: digestCharacter.repeat(64),
  };
}

function healthyPackage(id: string, displayName = id): HarnessInstalledInventoryRow {
  return { id, displayName, health: "healthy", identity: packageIdentity(id) };
}

function damagedPackage(id: string, displayName = id): HarnessInstalledInventoryRow {
  return { id, displayName, health: "damaged", identity: null };
}

function availablePackage(id: string, displayName = id): HarnessAvailableInventoryRow {
  return {
    displayName,
    identity: packageIdentity(id, "b"),
    installationState: "not-installed",
  };
}

function harnessInventory(
  installed: readonly HarnessInstalledInventoryRow[] = [],
  available: readonly HarnessAvailableInventoryRow[] = [],
): HarnessInventoryView {
  return { schemaVersion: 1, installed, available };
}

function inventoryDependencies(view: HarnessInventoryView): {
  dependencies: AgentRuntimeListDependencies;
  createHarnessInventoryView: ReturnType<typeof vi.fn>;
} {
  const createHarnessInventoryView = vi.fn(() => view);
  return {
    dependencies: { createHarnessInventoryView },
    createHarnessInventoryView,
  };
}

describe("agent runtime list command support", () => {
  it("reports no agent runtimes when reviewed packages are available but not installed", () => {
    const { dependencies, createHarnessInventoryView } = inventoryDependencies(
      harnessInventory([], [availablePackage("openclaw", "OpenClaw")]),
    );

    const entries = listAgentRuntimeEntries(dependencies);

    expect(entries).toEqual([]);
    expect(renderAgentRuntimeList(entries)).toBe("No agent runtimes are installed.");
    expect(createHarnessInventoryView).toHaveBeenCalledOnce();
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

  it("excludes candidate, unsupported, and alias rows from the compatibility view", () => {
    const { dependencies } = inventoryDependencies(
      harnessInventory([
        healthyPackage("pi", "Pi"),
        healthyPackage("nemocua", "NemoCUA"),
        healthyPackage("deepagents", "Deep Agents alias"),
        healthyPackage("future-harness", "Future Harness"),
        healthyPackage("openclaw", "OpenClaw"),
      ]),
    );

    expect(listAgentRuntimeEntries(dependencies)).toEqual([
      {
        name: "openclaw",
        description: "Gateway-based AI agent with plugin ecosystem (openclaw.ai)",
      },
    ]);
  });

  it("prints one installed-only projection through the supplied logger", () => {
    const log = vi.fn();
    const { dependencies, createHarnessInventoryView } = inventoryDependencies(
      harnessInventory([healthyPackage("openclaw", "OpenClaw")]),
    );

    printAgentRuntimeList(log, dependencies);

    expect(log).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith(
      "openclaw  Gateway-based AI agent with plugin ecosystem (openclaw.ai)",
    );
    expect(createHarnessInventoryView).toHaveBeenCalledOnce();
  });
});
