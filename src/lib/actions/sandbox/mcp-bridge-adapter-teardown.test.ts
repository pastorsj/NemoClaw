// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentDefinition } from "../../agent/defs";
import type { McpBridgeEntry, SandboxEntry } from "../../state/registry";

const mocks = vi.hoisted(() => ({
  assertMcpDestroyNotPending: vi.fn(),
  assertMcpAdapterTeardownRuntimeCapabilities: vi.fn(),
  bridgeState: vi.fn(),
  discardSafeIncompleteMcpAdds: vi.fn(),
  ensureSandboxGatewaySelected: vi.fn(),
  getMcpProviderInspectionRuntimeSelection: vi.fn(() => ({
    gatewayName: "nemoclaw-8091",
    workspace: "default",
  })),
  getBridgeAdapter: vi.fn(),
  getSandboxAgent: vi.fn(),
  captureRecordedSandboxBasePolicy: vi.fn(),
  getSandboxOrThrow: vi.fn(),
  inspectExactMcpDestroyProvider: vi.fn(),
  inspectMcpProvider: vi.fn(),
  observeMcpCredentialRevision: vi.fn(),
  preflightMcpEntryTargets: vi.fn(),
  removeGeneratedPolicy: vi.fn(),
  registerAgentAdapterAtCurrentCredentialRevision: vi.fn(),
  restoreExistingMcpBridgeRuntime: vi.fn(),
  unregisterAgentAdapter: vi.fn(),
}));

vi.mock("../../state/registry", () => ({
  getSandbox: vi.fn(),
  updateSandbox: vi.fn(),
}));

vi.mock("./mcp-bridge-adapters", () => ({
  registerAgentAdapterAtCurrentCredentialRevision:
    mocks.registerAgentAdapterAtCurrentCredentialRevision,
  unregisterAgentAdapter: mocks.unregisterAgentAdapter,
}));

vi.mock("./mcp-bridge-provider-readiness", () => ({
  observeMcpCredentialRevision: mocks.observeMcpCredentialRevision,
}));

vi.mock("./mcp-bridge-provider", () => ({
  assertMcpProviderRecoverable: vi.fn(),
  assertNoProviderCredentialCollisions: vi.fn(),
  assertNoRegisteredProviderCredentialCollisions: vi.fn(),
  detachProvider: vi.fn(),
  getMcpProviderInspectionRuntimeSelection: mocks.getMcpProviderInspectionRuntimeSelection,
  inspectMcpProvider: mocks.inspectMcpProvider,
  preflightMcpEntryTargets: mocks.preflightMcpEntryTargets,
  waitForDetachedMcpCredential: vi.fn(),
}));

vi.mock("./mcp-bridge-destroy-preflight", () => ({
  cloneMcpBridgeEntry: vi.fn((entry: McpBridgeEntry) => ({ ...entry, env: [...entry.env] })),
  discardSafeIncompleteMcpAdds: mocks.discardSafeIncompleteMcpAdds,
  inspectExactMcpDestroyProvider: mocks.inspectExactMcpDestroyProvider,
}));

vi.mock("./mcp-bridge-policy", () => ({
  assertGeneratedPolicyMutationSafe: vi.fn(),
  assertGeneratedPolicyRegistrationMutationSafe: vi.fn(),
  buildMcpBridgePolicyKey: vi.fn(() => "mcp_bridge_github"),
  removeGeneratedPolicy: mocks.removeGeneratedPolicy,
}));

vi.mock("../../policy", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../policy")>()),
  captureRecordedSandboxBasePolicy: mocks.captureRecordedSandboxBasePolicy,
}));

vi.mock("./mcp-bridge-restart", () => ({
  restoreExistingMcpBridgeRuntime: mocks.restoreExistingMcpBridgeRuntime,
}));

vi.mock("./mcp-bridge-runtime-capabilities", () => ({
  assertMcpAdapterTeardownRuntimeCapabilities: mocks.assertMcpAdapterTeardownRuntimeCapabilities,
}));

vi.mock("./mcp-bridge-state", () => ({
  assertMcpDestroyNotPending: mocks.assertMcpDestroyNotPending,
  bridgeState: mocks.bridgeState,
  ensureSandboxGatewaySelected: mocks.ensureSandboxGatewaySelected,
  getBridgeAdapter: mocks.getBridgeAdapter,
  getSandboxAgent: mocks.getSandboxAgent,
  getSandboxOrThrow: mocks.getSandboxOrThrow,
  nowIso: vi.fn(() => new Date(0).toISOString()),
  setBridgeState: vi.fn(),
}));

vi.mock("./mcp-bridge-validation", () => ({
  assertAuthenticatedBridgeEntry: vi.fn(),
  validateSandboxName: vi.fn(),
}));

import { prepareMcpBridgesForDestroy } from "./mcp-bridge-destroy";
import {
  prepareMcpBridgesForAbsentSandboxRebuild,
  prepareMcpBridgesForExecUnavailableRebuild,
  prepareMcpBridgesForRebuild,
} from "./mcp-bridge-rebuild";
import {
  rollbackScrubbedMcpAdapters,
  scrubManagedMcpAdapterOrThrow,
} from "./mcp-bridge-adapter-teardown";

const sandbox = { agent: "hermes" } as SandboxEntry;
const runtimeSelection = { gatewayName: "nemoclaw-8091", workspace: "default" } as const;
const hermesDefinition = {
  name: "hermes",
  configPaths: { dir: "/sandbox/.hermes" },
  mcpCapability: { support: "bridge", adapter: "hermes-config" },
} as AgentDefinition;
const entry: McpBridgeEntry = {
  server: "github",
  agent: "hermes",
  adapter: "hermes-config",
  url: "https://api.githubcopilot.com/mcp/",
  env: ["GITHUB_TOKEN"],
  providerName: "alpha-mcp-github",
  providerId: "11111111-2222-4333-8444-555555555555",
  policyName: "mcp-bridge-github",
  addedAt: new Date(0).toISOString(),
};

function requireSetupValue<T>(value: T | undefined, message: string): T {
  assert(value !== undefined, message);
  return value;
}

describe("MCP adapter teardown rollback", () => {
  beforeEach(() => {
    mocks.bridgeState.mockReset().mockReturnValue({ github: entry });
    mocks.discardSafeIncompleteMcpAdds.mockReset().mockResolvedValue(sandbox);
    mocks.ensureSandboxGatewaySelected.mockReset().mockResolvedValue(undefined);
    mocks.getBridgeAdapter.mockReset().mockImplementation((agent: AgentDefinition) => {
      return requireSetupValue(agent.mcpCapability.adapter, "pinned agent has no MCP adapter");
    });
    mocks.getSandboxAgent.mockReset().mockImplementation((_sandbox, agent?: AgentDefinition) => {
      return agent ?? hermesDefinition;
    });
    mocks.getMcpProviderInspectionRuntimeSelection.mockReset().mockReturnValue(runtimeSelection);
    mocks.captureRecordedSandboxBasePolicy
      .mockReset()
      .mockReturnValue("version: 1\nnetwork_policies:\n  mcp_bridge_github: {}\n");
    mocks.getSandboxOrThrow.mockReset().mockReturnValue(sandbox);
    mocks.inspectExactMcpDestroyProvider.mockReset().mockReturnValue({
      credentialKeys: ["GITHUB_TOKEN"],
      exists: true,
      id: entry.providerId,
      resourceVersion: 12,
      type: "nemoclaw-mcp-v1",
    });
    mocks.inspectMcpProvider.mockReset().mockReturnValue({ exists: false });
    mocks.observeMcpCredentialRevision.mockReset().mockReturnValue("v12");
    mocks.removeGeneratedPolicy.mockReset().mockImplementation(() => {
      throw new Error("forced lifecycle failure after adapter scrub");
    });
    mocks.registerAgentAdapterAtCurrentCredentialRevision.mockReset();
    mocks.restoreExistingMcpBridgeRuntime.mockReset();
    mocks.unregisterAgentAdapter.mockReset().mockReturnValue("removed");
    mocks.assertMcpAdapterTeardownRuntimeCapabilities.mockReset();
    mocks.preflightMcpEntryTargets.mockReset().mockResolvedValue(new Map());
  });

  it.each([
    ["rebuild", prepareMcpBridgesForRebuild],
    ["destroy", prepareMcpBridgesForDestroy],
  ] as const)(
    "restores the fresh revision observed after a later %s step fails (#10155)",
    async (_lifecycle, prepare) => {
      mocks.observeMcpCredentialRevision
        .mockReset()
        .mockReturnValueOnce("v12")
        .mockReturnValueOnce("v13")
        .mockReturnValue("v13");

      await expect(prepare("alpha")).rejects.toThrow(
        "forced lifecycle failure after adapter scrub",
      );
      expect(mocks.unregisterAgentAdapter).toHaveBeenCalledOnce();
      expect(mocks.registerAgentAdapterAtCurrentCredentialRevision).toHaveBeenCalledWith(
        "alpha",
        "hermes-config",
        expect.objectContaining({ ...entry, credentialRevision: "v12" }),
        runtimeSelection,
        {},
        "v13",
        {
          replaceExisting: true,
          teardownRollback: true,
        },
      );
      expect(mocks.restoreExistingMcpBridgeRuntime).not.toHaveBeenCalled();
    },
  );

  it("rejects a credential-bearing MCP rebuild capture before teardown side effects", async () => {
    mocks.captureRecordedSandboxBasePolicy.mockReturnValue(
      [
        "version: 1",
        "network_policies:",
        "  mcp_bridge_github: {}",
        "process:",
        "  environment:",
        "    SERVICE_API_KEY: opaque-late-policy-credential",
        "",
      ].join("\n"),
    );

    await expect(prepareMcpBridgesForRebuild("alpha")).rejects.toThrow(
      "Cannot prepare the MCP rebuild policy handoff for sandbox 'alpha' because its live OpenShell policy contains a literal credential value.",
    );
    expect(mocks.removeGeneratedPolicy).not.toHaveBeenCalled();
    expect(mocks.unregisterAgentAdapter).not.toHaveBeenCalled();
  });

  it("does not derive a Hermes credential revision from an exact provider resource version", () => {
    mocks.observeMcpCredentialRevision.mockReturnValue("absent");
    mocks.inspectMcpProvider.mockReturnValue({
      credentialKeys: ["GITHUB_TOKEN"],
      exists: true,
      id: entry.providerId,
      resourceVersion: 12,
      type: "nemoclaw-mcp-v1",
    });

    expect(() => scrubManagedMcpAdapterOrThrow("alpha", sandbox, entry, runtimeSelection)).toThrow(
      "Could not prove a revision-scoped credential before removing the managed adapter entry for MCP server 'github'.",
    );
    expect(mocks.inspectMcpProvider).not.toHaveBeenCalled();
    expect(mocks.unregisterAgentAdapter).not.toHaveBeenCalled();
    expect(mocks.registerAgentAdapterAtCurrentCredentialRevision).not.toHaveBeenCalled();
  });

  it("rejects a pinned definition without an MCP adapter before rebuild cleanup", async () => {
    const agentDefinition = {
      name: "hermes",
      configPaths: { dir: "/sandbox/.installed-hermes" },
      mcpCapability: { support: "bridge" },
    } as AgentDefinition;

    await expect(prepareMcpBridgesForRebuild("alpha", { agentDefinition })).rejects.toThrow(
      "pinned agent has no MCP adapter",
    );

    expect(mocks.getSandboxAgent).toHaveBeenCalledWith(sandbox, agentDefinition);
    expect(mocks.assertMcpAdapterTeardownRuntimeCapabilities).not.toHaveBeenCalled();
    expect(mocks.discardSafeIncompleteMcpAdds).not.toHaveBeenCalled();
    expect(mocks.ensureSandboxGatewaySelected).not.toHaveBeenCalled();
    expect(mocks.preflightMcpEntryTargets).not.toHaveBeenCalled();
    expect(mocks.removeGeneratedPolicy).not.toHaveBeenCalled();
    expect(mocks.unregisterAgentAdapter).not.toHaveBeenCalled();
    expect(mocks.registerAgentAdapterAtCurrentCredentialRevision).not.toHaveBeenCalled();
  });

  it("passes one pinned OpenClaw definition through adapter scrub and rollback", () => {
    const agentDefinition = {
      name: "openclaw",
      configPaths: { dir: "/sandbox/.installed-openclaw" },
      mcpCapability: { support: "bridge", adapter: "mcporter" },
    } as AgentDefinition;
    const openClawSandbox = { name: "alpha", agent: "openclaw" } as SandboxEntry;
    const openClawEntry = {
      ...entry,
      agent: "openclaw",
      adapter: "mcporter" as const,
    };
    mocks.observeMcpCredentialRevision
      .mockReset()
      .mockReturnValueOnce("v12")
      .mockReturnValue("v13");

    const scrubbed = scrubManagedMcpAdapterOrThrow(
      "alpha",
      openClawSandbox,
      openClawEntry,
      runtimeSelection,
      agentDefinition,
    );
    expect(
      rollbackScrubbedMcpAdapters(
        "alpha",
        openClawSandbox,
        [scrubbed],
        runtimeSelection,
        agentDefinition,
      ),
    ).toEqual([]);

    expect(mocks.unregisterAgentAdapter).toHaveBeenCalledWith(
      "alpha",
      "mcporter",
      openClawEntry,
      runtimeSelection,
      { envValues: {}, teardown: true },
      agentDefinition,
    );
    expect(mocks.registerAgentAdapterAtCurrentCredentialRevision).toHaveBeenCalledWith(
      "alpha",
      "mcporter",
      expect.objectContaining({ server: "github" }),
      runtimeSelection,
      {},
      "v13",
      { replaceExisting: true, teardownRollback: true },
      agentDefinition,
    );
  });

  it("recovers the recorded gateway before initial destroy provider inspection (#10514)", async () => {
    const events: string[] = [];
    mocks.ensureSandboxGatewaySelected.mockImplementation(async () => {
      events.push("gateway-selected");
    });
    mocks.inspectExactMcpDestroyProvider.mockImplementation(() => {
      events.push("provider-inspected");
      return {
        credentialKeys: ["GITHUB_TOKEN"],
        exists: true,
        id: entry.providerId,
        resourceVersion: 12,
        type: "nemoclaw-mcp-v1",
      };
    });

    await expect(prepareMcpBridgesForDestroy("alpha")).rejects.toThrow(
      "forced lifecycle failure after adapter scrub",
    );
    expect(events.slice(0, 2)).toEqual(["gateway-selected", "provider-inspected"]);
  });

  it.each([
    ["live", prepareMcpBridgesForRebuild],
    ["absent", prepareMcpBridgesForAbsentSandboxRebuild],
  ] as const)(
    "drops a prepared-only manifest before resolving runtime authority for %s rebuild (#10514)",
    async (_kind, prepare) => {
      const preparedEntry = { ...entry, addState: "prepared" as const };
      const preparedSandbox = {
        name: "alpha",
        agent: "hermes",
        mcp: { bridges: { github: preparedEntry } },
      } as SandboxEntry;
      const clearedSandbox = { name: "alpha", agent: "hermes" } as SandboxEntry;
      mocks.getSandboxOrThrow.mockReturnValue(preparedSandbox);
      mocks.bridgeState.mockImplementation(
        (candidate: SandboxEntry) => candidate.mcp?.bridges ?? {},
      );
      mocks.discardSafeIncompleteMcpAdds.mockResolvedValue(clearedSandbox);
      mocks.getMcpProviderInspectionRuntimeSelection.mockImplementation(() => {
        throw new Error("runtime selection resolved for a prepared-only rebuild");
      });

      await expect(prepare("alpha")).resolves.toMatchObject({
        entries: [],
        detachedProviderEntries: [],
        scrubbedAdapterEntries: [],
      });

      expect(mocks.getMcpProviderInspectionRuntimeSelection).not.toHaveBeenCalled();
      expect(mocks.ensureSandboxGatewaySelected).not.toHaveBeenCalled();
    },
  );

  it("keeps empty exec-unavailable rebuild preparation independent of runtime authority (#10514)", async () => {
    const emptySandbox = {
      name: "alpha",
      agent: "hermes",
      gatewayName: "nemoclaw",
    } as SandboxEntry;
    mocks.getSandboxOrThrow.mockReturnValue(emptySandbox);
    mocks.getSandboxAgent.mockReturnValue(hermesDefinition);
    mocks.bridgeState.mockReturnValue({});
    mocks.getMcpProviderInspectionRuntimeSelection.mockImplementation(() => {
      throw new Error("runtime selection resolved for empty rebuild state");
    });

    await expect(prepareMcpBridgesForExecUnavailableRebuild("alpha")).resolves.toMatchObject({
      entries: [],
      detachedProviderEntries: [],
      scrubbedAdapterEntries: [],
    });

    expect(mocks.getMcpProviderInspectionRuntimeSelection).not.toHaveBeenCalled();
    expect(mocks.ensureSandboxGatewaySelected).not.toHaveBeenCalled();
  });
});
