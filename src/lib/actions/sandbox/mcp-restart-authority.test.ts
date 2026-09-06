// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentDefinition } from "../../agent/defs";
import type { McpBridgeEntry, SandboxEntry } from "../../state/registry";

const mocks = vi.hoisted(() => ({
  applyGeneratedPolicy: vi.fn(),
  assertAgentMcpRuntimeIntent: vi.fn(),
  assertMcpAdapterMutationRuntimeCapabilities: vi.fn(),
  attachProvider: vi.fn(),
  ensureMcpBridgeProviderProfile: vi.fn(),
  ensureSandboxGatewaySelected: vi.fn(),
  getBridgeAdapter: vi.fn(),
  getSandboxAgent: vi.fn(),
  getSandboxOrThrow: vi.fn(),
  preflightMcpEntryTargets: vi.fn(),
  refreshMcpProviderEnvironment: vi.fn(),
  registerAgentAdapterAtCurrentCredentialRevision: vi.fn(),
  writeBridgeEntry: vi.fn(),
}));

vi.mock("../../state/mcp-lifecycle-lock", () => ({
  withMcpLifecycleLock: vi.fn(),
}));

vi.mock("../../onboard/experimental/portable-agent-lifecycle", () => ({
  assertHermesPortableCommandUnavailable: vi.fn(),
}));

vi.mock("./mcp-bridge-adapters", () => ({
  assertAgentMcpRuntimeIntent: mocks.assertAgentMcpRuntimeIntent,
  registerAgentAdapterAtCurrentCredentialRevision:
    mocks.registerAgentAdapterAtCurrentCredentialRevision,
}));

vi.mock("./mcp-bridge-policy", () => ({
  applyGeneratedPolicy: mocks.applyGeneratedPolicy,
  assertGeneratedPolicyMutationSafe: vi.fn(),
}));

vi.mock("./mcp-bridge-provider", () => ({
  assertMcpProviderRecoverable: vi.fn(() => ({ exists: true })),
  assertNoAttachedProviderCredentialCollisions: vi.fn(),
  assertNoProviderCredentialCollisions: vi.fn(),
  attachProvider: mocks.attachProvider,
  detachMissingProviderReference: vi.fn(),
  ensureMcpBridgeProviderProfile: mocks.ensureMcpBridgeProviderProfile,
  getMcpProviderInspectionRuntimeSelection: vi.fn(() => ({
    gatewayName: "nemoclaw-8091",
    workspace: "default",
  })),
  refreshMcpProviderEnvironment: mocks.refreshMcpProviderEnvironment,
  observeMcpCredentialRevision: vi.fn(),
  preflightMcpEntryTargets: mocks.preflightMcpEntryTargets,
  upsertMcpProvider: vi.fn(),
  waitForAttachedMcpCredential: vi.fn(),
  waitForDetachedMcpCredential: vi.fn(),
}));

vi.mock("./mcp-bridge-runtime-capabilities", () => ({
  assertMcpAdapterConfigMutationsAllowed: vi.fn(),
  assertMcpAdapterMutationRuntimeCapabilities: mocks.assertMcpAdapterMutationRuntimeCapabilities,
  assertMcpAdapterTeardownRuntimeCapabilities: vi.fn(),
}));

vi.mock("./mcp-bridge-state", () => ({
  assertMcpDestroyNotPending: vi.fn(),
  bridgeState: (sandbox: SandboxEntry) => sandbox.mcp?.bridges ?? {},
  getBridgeAdapter: mocks.getBridgeAdapter,
  getSandboxAgent: mocks.getSandboxAgent,
  getSandboxOrThrow: mocks.getSandboxOrThrow,
  nowIso: vi.fn(() => new Date(0).toISOString()),
  writeBridgeEntry: mocks.writeBridgeEntry,
}));

vi.mock("./mcp-bridge/gateway-selection", () => ({
  ensureSandboxGatewaySelected: mocks.ensureSandboxGatewaySelected,
}));

vi.mock("./mcp-bridge-validation", () => ({
  assertAuthenticatedBridgeEntry: vi.fn(),
  assertMcpCredentialBoundaryRuntimeVersion: vi.fn(),
  resolveCredentialEnv: vi.fn(),
  validateSandboxName: vi.fn(),
}));

import { restoreExistingMcpBridgeRuntime } from "./mcp-bridge-restart";

const openClawDefinition = {
  name: "openclaw",
  configPaths: { dir: "/sandbox/.installed-openclaw" },
  mcpCapability: { support: "bridge", adapter: "mcporter" },
} as AgentDefinition;

const entry: McpBridgeEntry = {
  server: "github",
  agent: "openclaw",
  adapter: "mcporter",
  url: "https://api.githubcopilot.com/mcp/",
  env: ["GITHUB_TOKEN"],
  providerName: "alpha-mcp-github",
  providerId: "11111111-2222-4333-8444-555555555555",
  policyName: "mcp-bridge-github",
  addedAt: new Date(0).toISOString(),
};

const openClawSandbox = {
  name: "alpha",
  agent: "openclaw",
  mcp: { bridges: { github: entry } },
} as SandboxEntry;

function expectNoRestoreMutation(): void {
  expect(mocks.ensureMcpBridgeProviderProfile).not.toHaveBeenCalled();
  expect(mocks.applyGeneratedPolicy).not.toHaveBeenCalled();
  expect(mocks.attachProvider).not.toHaveBeenCalled();
  expect(mocks.refreshMcpProviderEnvironment).not.toHaveBeenCalled();
  expect(mocks.registerAgentAdapterAtCurrentCredentialRevision).not.toHaveBeenCalled();
  expect(mocks.writeBridgeEntry).not.toHaveBeenCalled();
}

function resolvePinnedAgentDefinition(
  sandbox: SandboxEntry,
  agentDefinition?: AgentDefinition,
): AgentDefinition {
  const resolvedDefinition = agentDefinition ?? openClawDefinition;
  assert(
    !agentDefinition || sandbox.agent === agentDefinition.name,
    `Sandbox '${sandbox.name}' records agent '${sandbox.agent}', not the pinned '${resolvedDefinition.name}' definition.`,
  );
  return resolvedDefinition;
}

describe("MCP rebuild restoration authority", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.preflightMcpEntryTargets.mockResolvedValue(
      new Map([["github", { addresses: ["8.8.8.8"] }]]),
    );
    mocks.ensureSandboxGatewaySelected.mockResolvedValue(undefined);
    mocks.getSandboxOrThrow.mockReturnValue(openClawSandbox);
    mocks.getSandboxAgent.mockImplementation(resolvePinnedAgentDefinition);
    mocks.getBridgeAdapter.mockImplementation(
      (agentDefinition: AgentDefinition) => agentDefinition.mcpCapability.adapter,
    );
  });

  it("rereads and rejects sandbox-agent drift after target preflight", async () => {
    const driftedSandbox = { ...openClawSandbox, agent: "hermes" } as SandboxEntry;
    mocks.preflightMcpEntryTargets.mockImplementation(async () => {
      mocks.getSandboxOrThrow.mockReturnValue(driftedSandbox);
      return new Map([["github", { addresses: ["8.8.8.8"] }]]);
    });

    await expect(
      restoreExistingMcpBridgeRuntime("alpha", [entry], {
        agentDefinition: openClawDefinition,
      }),
    ).rejects.toThrow(
      "Sandbox 'alpha' records agent 'hermes', not the pinned 'openclaw' definition.",
    );

    expect(mocks.preflightMcpEntryTargets).toHaveBeenCalledOnce();
    expect(mocks.ensureSandboxGatewaySelected).not.toHaveBeenCalled();
    expect(mocks.getSandboxOrThrow).toHaveBeenCalledTimes(2);
    expectNoRestoreMutation();
  });

  it("rejects exact bridge-state drift after target preflight", async () => {
    const driftedEntry = { ...entry, url: "https://example.com/replaced" };
    const driftedSandbox = {
      ...openClawSandbox,
      mcp: { bridges: { github: driftedEntry } },
    } as SandboxEntry;
    mocks.preflightMcpEntryTargets.mockImplementation(async () => {
      mocks.getSandboxOrThrow.mockReturnValue(driftedSandbox);
      return new Map([["github", { addresses: ["8.8.8.8"] }]]);
    });

    await expect(
      restoreExistingMcpBridgeRuntime("alpha", [entry], {
        agentDefinition: openClawDefinition,
      }),
    ).rejects.toThrow(
      "MCP bridge definitions changed while sandbox 'alpha' runtime restoration was being preflighted.",
    );

    expect(entry.url).toBe("https://api.githubcopilot.com/mcp/");
    expect(mocks.getSandboxAgent).not.toHaveBeenCalled();
    expectNoRestoreMutation();
  });

  it("keeps omitted-definition restoration on ambient agent resolution", async () => {
    mocks.assertMcpAdapterMutationRuntimeCapabilities.mockImplementation(() => {
      throw new Error("ordinary restoration reached runtime capability preflight");
    });

    await expect(restoreExistingMcpBridgeRuntime("alpha", [entry])).rejects.toThrow(
      "ordinary restoration reached runtime capability preflight",
    );

    expect(mocks.getSandboxAgent).toHaveBeenCalledWith(openClawSandbox);
    expectNoRestoreMutation();
  });
});
