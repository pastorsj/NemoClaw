// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { loadAgent } from "../../../agent/defs";
import type { SandboxEntry } from "../../../state/registry";
import { LaunchReadinessEvidenceError, resolveTrustedLaunchAgent } from "./health";

const PACKAGE_IDENTITY = Object.freeze({
  kind: "agent-runtime" as const,
  id: "future-harness",
  packageVersion: "1.0.0",
  contentDigest: "a".repeat(64),
});

function packageBackedEntry(): SandboxEntry {
  return {
    name: "future",
    agent: "future-harness",
    harnessPackage: PACKAGE_IDENTITY,
  };
}

describe("launch-readiness agent authority", () => {
  it("loads a package-backed agent from its installed receipt without consulting the catalogue", () => {
    const entry = packageBackedEntry();
    const installedAgent = Object.freeze({
      ...loadAgent("langchain-deepagents-code"),
      name: "future-harness",
      displayName: "Future Harness",
    });
    const getRegisteredAgent = vi.fn(() => installedAgent);
    const listAgents = vi.fn(() => {
      throw new Error("ambient catalogue must not be consulted");
    });
    const loadAmbientAgent = vi.fn(() => {
      throw new Error("ambient manifest must not be loaded");
    });

    const resolved = resolveTrustedLaunchAgent(entry, {
      getRegisteredAgent,
      listAgents,
      loadAgent: loadAmbientAgent,
    });

    expect({
      resolved,
      registeredCalls: getRegisteredAgent.mock.calls,
      catalogueCalls: listAgents.mock.calls,
      ambientLoadCalls: loadAmbientAgent.mock.calls,
    }).toEqual({
      resolved: installedAgent,
      registeredCalls: [[entry]],
      catalogueCalls: [],
      ambientLoadCalls: [],
    });
  });

  it.each([
    ["returns no agent", () => null],
    [
      "rejects the receipt",
      () => {
        throw new Error("installed package receipt changed");
      },
    ],
  ])("fails closed when package authority $0", (_case, getRegisteredAgent) => {
    expect(() =>
      resolveTrustedLaunchAgent(packageBackedEntry(), {
        getRegisteredAgent,
        listAgents: () => ["future-harness"],
        loadAgent: () => loadAgent("langchain-deepagents-code"),
      }),
    ).toThrow(LaunchReadinessEvidenceError);
  });

  it("retains the ambient catalogue path for legacy rows", () => {
    const entry = { name: "legacy", agent: "hermes" } as SandboxEntry;
    const legacyAgent = loadAgent("hermes");
    const getRegisteredAgent = vi.fn(() => null);
    const listAgents = vi.fn(() => ["hermes"]);
    const loadLegacyAgent = vi.fn(() => legacyAgent);

    const resolved = resolveTrustedLaunchAgent(entry, {
      getRegisteredAgent,
      listAgents,
      loadAgent: loadLegacyAgent,
    });

    expect({
      resolved,
      registeredCalls: getRegisteredAgent.mock.calls,
      catalogueCalls: listAgents.mock.calls,
      legacyLoadCalls: loadLegacyAgent.mock.calls,
    }).toEqual({
      resolved: legacyAgent,
      registeredCalls: [],
      catalogueCalls: [[]],
      legacyLoadCalls: [["hermes"]],
    });
  });
});
