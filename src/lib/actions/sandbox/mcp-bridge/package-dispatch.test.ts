// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentMcpAdapter } from "../../../agent/defs";
import type { McpBridgeEntry } from "../../../state/registry";

const mocks = vi.hoisted(() => ({
  getConfigDirectory: vi.fn(),
  getPackage: vi.fn(),
  getSandbox: vi.fn(),
  registerInstalled: vi.fn(),
  registerLegacy: vi.fn(),
  unregisterInstalled: vi.fn(),
  unregisterLegacy: vi.fn(),
}));

vi.mock("../mcp-bridge-state", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../mcp-bridge-state")>()),
  getAgentConfigDir: mocks.getConfigDirectory,
  getSandboxHarnessPackage: mocks.getPackage,
  getSandboxOrThrow: mocks.getSandbox,
}));

vi.mock("./package-mutation", () => ({
  registerInstalledMcpAdapter: mocks.registerInstalled,
  unregisterInstalledMcpAdapter: mocks.unregisterInstalled,
}));

vi.mock("./legacy-mutation", () => ({
  registerLegacyMcpAdapter: mocks.registerLegacy,
  unregisterLegacyMcpAdapter: mocks.unregisterLegacy,
}));

import { registerAgentAdapter, unregisterAgentAdapter } from "../mcp-bridge-adapters";

const PACKAGE_IDENTITY = Object.freeze({
  kind: "agent-runtime" as const,
  id: "package-agent",
  packageVersion: "1.0.0",
  contentDigest: "a".repeat(64),
});

function entry(agent: string, adapter: AgentMcpAdapter): McpBridgeEntry {
  return {
    server: "docs",
    agent,
    adapter,
    url: "https://example.test/mcp",
    env: ["FUTURE_TOKEN"],
    providerName: "future-provider",
    policyName: "future-policy",
    addedAt: "2026-08-30T12:00:00.000Z",
  };
}

beforeEach(() => {
  mocks.getConfigDirectory.mockReset().mockReturnValue("/sandbox/.package-agent");
  mocks.getPackage.mockReset().mockReturnValue(PACKAGE_IDENTITY);
  mocks.getSandbox.mockReset().mockReturnValue({ name: "alpha" });
  mocks.registerInstalled.mockReset();
  mocks.registerLegacy.mockReset();
  mocks.unregisterInstalled.mockReset().mockReturnValue("removed");
  mocks.unregisterLegacy.mockReset().mockReturnValue("removed");
});

describe("MCP package mutation dispatch", () => {
  it.each([
    ["openclaw", "mcporter"],
    ["hermes", "hermes-config"],
    ["langchain-deepagents-code", "deepagents-config"],
    ["future-harness", "future-config"],
  ] as const)("registers package agent %s through the generic %s plan", (agent, adapter) => {
    const packageEntry = entry(agent, adapter);

    registerAgentAdapter(
      "alpha",
      adapter,
      packageEntry,
      { FUTURE_TOKEN: "host-only-secret" },
      { replaceExisting: true, credentialRevision: "v12" },
    );

    expect(mocks.registerInstalled).toHaveBeenCalledWith(
      "alpha",
      adapter,
      packageEntry,
      { FUTURE_TOKEN: "host-only-secret" },
      {
        replaceExisting: true,
        credentialRevision: "v12",
        configDirectory: "/sandbox/.package-agent",
      },
    );
    expect(mocks.registerLegacy).not.toHaveBeenCalled();
  });

  it.each([
    ["openclaw", "mcporter"],
    ["hermes", "hermes-config"],
    ["langchain-deepagents-code", "deepagents-config"],
    ["future-harness", "future-config"],
  ] as const)("removes package agent %s through the generic %s plan", (agent, adapter) => {
    const packageEntry = entry(agent, adapter);

    expect(
      unregisterAgentAdapter("alpha", adapter, packageEntry, {
        force: true,
        bestEffort: true,
      }),
    ).toBe("removed");

    expect(mocks.unregisterInstalled).toHaveBeenCalledWith("alpha", adapter, packageEntry, {
      force: true,
      bestEffort: true,
      configDirectory: "/sandbox/.package-agent",
    });
    expect(mocks.unregisterLegacy).not.toHaveBeenCalled();
  });

  it("uses the isolated native fallback when the registry has no package authority", () => {
    mocks.getPackage.mockReturnValue(null);
    const legacyEntry = entry("openclaw", "mcporter");

    registerAgentAdapter("alpha", "mcporter", legacyEntry);
    expect(unregisterAgentAdapter("alpha", "mcporter", legacyEntry)).toBe("removed");

    expect(mocks.registerLegacy).toHaveBeenCalledOnce();
    expect(mocks.unregisterLegacy).toHaveBeenCalledOnce();
    expect(mocks.registerInstalled).not.toHaveBeenCalled();
    expect(mocks.unregisterInstalled).not.toHaveBeenCalled();
  });
});
