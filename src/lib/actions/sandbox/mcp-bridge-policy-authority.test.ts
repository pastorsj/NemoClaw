// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";
import YAML from "yaml";

const mocks = vi.hoisted(() => ({
  listAgents: vi.fn(),
  loadAgent: vi.fn(),
  getSandboxAgent: vi.fn(),
  requireSandboxHarnessPackage: vi.fn(),
  getSandboxOrThrow: vi.fn(),
}));

vi.mock("../../agent/defs", () => ({
  listAgents: mocks.listAgents,
  loadAgent: mocks.loadAgent,
}));

vi.mock("./mcp-bridge-state", () => ({
  getSandboxAgent: mocks.getSandboxAgent,
  requireSandboxHarnessPackage: mocks.requireSandboxHarnessPackage,
  getSandboxOrThrow: mocks.getSandboxOrThrow,
}));

import { buildGeneratedMcpPolicyContent } from "./mcp-bridge-policy";

const PACKAGE_IDENTITY = Object.freeze({
  kind: "agent-runtime" as const,
  id: "future-harness",
  packageVersion: "1.0.0",
  contentDigest: "a".repeat(64),
});

const ENTRY = Object.freeze({
  server: "docs",
  agent: "future-harness",
  adapter: "future-config",
  url: "https://example.test/mcp",
  env: ["FUTURE_TOKEN"],
  allowedIps: ["8.8.8.8"],
  providerName: "future-provider",
  policyName: "mcp-bridge-docs",
  addedAt: "2026-08-30T12:00:00.000Z",
});

const PINNED_DEFINITION = Object.freeze({
  name: "future-harness",
  mcpCapability: Object.freeze({
    support: "bridge" as const,
    adapter: "future-config",
    policy_binaries: Object.freeze(["/opt/future/bin/runtime"]),
  }),
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireSandboxHarnessPackage.mockReturnValue(PACKAGE_IDENTITY);
  mocks.getSandboxOrThrow.mockReturnValue({
    name: "alpha",
    agent: "future-harness",
    harnessPackage: PACKAGE_IDENTITY,
  });
  mocks.getSandboxAgent.mockReturnValue(PINNED_DEFINITION);
  mocks.listAgents.mockReturnValue(["future-harness"]);
  mocks.loadAgent.mockReturnValue({
    name: "future-harness",
    mcpCapability: {
      support: "bridge",
      adapter: "future-config",
      policy_binaries: ["/usr/local/bin/ambient-drift"],
    },
  });
});

describe("receipt-backed MCP policy authority", () => {
  it("renders an unknown external package from its exact receipt definition", () => {
    const policy = YAML.parse(
      buildGeneratedMcpPolicyContent(
        "alpha",
        ENTRY,
        { addresses: ["8.8.8.8"] },
        { agentDefinition: PINNED_DEFINITION as never },
      ),
    ) as { network_policies: { mcp_bridge_docs: { binaries: Array<{ path: string }> } } };

    expect(policy.network_policies.mcp_bridge_docs.binaries).toEqual([
      { path: "/opt/future/bin/runtime" },
    ]);
    expect(mocks.getSandboxAgent).toHaveBeenCalledWith(
      expect.objectContaining({ harnessPackage: PACKAGE_IDENTITY }),
    );
    expect(mocks.listAgents).not.toHaveBeenCalled();
    expect(mocks.loadAgent).not.toHaveBeenCalled();
  });

  it("does not let a changed ambient definition override receipt-pinned policy binaries", () => {
    const policy = YAML.parse(
      buildGeneratedMcpPolicyContent("alpha", ENTRY, { addresses: ["8.8.8.8"] }),
    ) as { network_policies: { mcp_bridge_docs: { binaries: Array<{ path: string }> } } };

    expect(policy.network_policies.mcp_bridge_docs.binaries).toEqual([
      { path: "/opt/future/bin/runtime" },
    ]);
    expect(policy.network_policies.mcp_bridge_docs.binaries).not.toContainEqual({
      path: "/usr/local/bin/ambient-drift",
    });
    expect(mocks.loadAgent).not.toHaveBeenCalled();
  });

  it("rejects a same-name definition that drifted after receipt resolution", () => {
    const driftedDefinition = {
      ...PINNED_DEFINITION,
      mcpCapability: {
        ...PINNED_DEFINITION.mcpCapability,
        policy_binaries: ["/usr/local/bin/ambient-drift"],
      },
    };

    expect(() =>
      buildGeneratedMcpPolicyContent(
        "alpha",
        ENTRY,
        { addresses: ["8.8.8.8"] },
        { agentDefinition: driftedDefinition as never },
      ),
    ).toThrow(/changed after its package definition was pinned/u);
    expect(mocks.loadAgent).not.toHaveBeenCalled();
  });

  it("fails closed when the pinned definition does not own the recorded adapter", () => {
    mocks.getSandboxAgent.mockReturnValue({
      ...PINNED_DEFINITION,
      mcpCapability: {
        support: "bridge",
        adapter: "other-config",
        policy_binaries: ["/opt/other/bin/runtime"],
      },
    });

    expect(() =>
      buildGeneratedMcpPolicyContent("alpha", ENTRY, { addresses: ["8.8.8.8"] }),
    ).toThrow(/does not match policy owner/u);
    expect(mocks.loadAgent).not.toHaveBeenCalled();
  });
});
