// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentMcpAdapter } from "../../../agent/defs";
import type { McpBridgeEntry } from "../../../state/registry";

const mocks = vi.hoisted(() => ({
  assertCapability: vi.fn(),
  buildInspection: vi.fn(),
  describeIntent: vi.fn(),
  describeMutation: vi.fn(),
  describeTeardown: vi.fn(),
  getConfigDirectory: vi.fn(),
  getPackage: vi.fn(),
  getSandbox: vi.fn(),
  inspectRegistration: vi.fn(),
  registerInstalled: vi.fn(),
  requirePackage: vi.fn(),
  unregisterInstalled: vi.fn(),
}));

vi.mock("../mcp-bridge-state", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../mcp-bridge-state")>()),
  getAgentConfigDir: mocks.getConfigDirectory,
  getSandboxHarnessPackage: mocks.getPackage,
  getSandboxOrThrow: mocks.getSandbox,
  requireSandboxHarnessPackage: mocks.requirePackage,
}));

vi.mock("../mcp-bridge-adapter-inspection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../mcp-bridge-adapter-inspection")>()),
  inspectAdapterRegistrationCommand: mocks.inspectRegistration,
}));

vi.mock("./package-command", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./package-command")>()),
  buildInstalledMcpInspectionCommand: mocks.buildInspection,
  describeInstalledMcpMutationCapability: mocks.describeMutation,
  describeInstalledMcpRuntimeIntentVerification: mocks.describeIntent,
  describeInstalledMcpTeardownCapability: mocks.describeTeardown,
}));

vi.mock("./package-probe", () => ({
  assertInstalledMcpCapability: mocks.assertCapability,
}));

vi.mock("./package-mutation", () => ({
  registerInstalledMcpAdapter: mocks.registerInstalled,
  unregisterInstalledMcpAdapter: mocks.unregisterInstalled,
}));

import {
  assertAgentMcpMutationRuntimeCapability,
  assertAgentMcpTeardownRuntimeCapability,
  inspectAgentAdapterRegistration,
  inspectAgentMcpRuntimeIntent,
  registerAgentAdapter,
  unregisterAgentAdapter,
} from "../mcp-bridge-adapters";
import { McpBridgeError } from "../mcp-bridge-contracts";

const PACKAGE_IDENTITY = Object.freeze({
  kind: "agent-runtime" as const,
  id: "package-agent",
  packageVersion: "1.0.0",
  contentDigest: "a".repeat(64),
});
const runtimeSelection = { gatewayName: "nemoclaw-8091", workspace: "default" } as const;

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
  mocks.assertCapability.mockReset();
  mocks.buildInspection.mockReset().mockReturnValue("package-inspect");
  mocks.describeIntent.mockReset().mockReturnValue({ kind: "not-required" });
  mocks.describeMutation.mockReset().mockReturnValue({ kind: "not-required" });
  mocks.describeTeardown.mockReset().mockReturnValue({ kind: "not-required" });
  mocks.getConfigDirectory.mockReset().mockReturnValue("/sandbox/.package-agent");
  mocks.getPackage.mockReset().mockReturnValue(PACKAGE_IDENTITY);
  mocks.getSandbox.mockReset().mockReturnValue({ name: "alpha" });
  mocks.inspectRegistration.mockReset().mockReturnValue({ state: "registered" });
  mocks.registerInstalled.mockReset();
  mocks.requirePackage.mockReset().mockReturnValue(PACKAGE_IDENTITY);
  mocks.unregisterInstalled.mockReset().mockReturnValue("removed");
});

describe("MCP package mutation dispatch", () => {
  it.each([
    ["openclaw", "mcporter"],
    ["hermes", "hermes-config"],
    ["langchain-deepagents-code", "deepagents-config"],
    ["future-harness", "future-config"],
  ] as const)("uses one package path for agent %s and adapter %s", (agent, adapter) => {
    const packageEntry = entry(agent, adapter);
    const packageIdentity = { ...PACKAGE_IDENTITY, id: agent };
    mocks.getPackage.mockReturnValue(packageIdentity);
    mocks.requirePackage.mockReturnValue(packageIdentity);
    mocks.getSandbox.mockReturnValue({
      name: "alpha",
      agent,
      harnessPackage: packageIdentity,
      mcp: { bridges: { docs: packageEntry }, managedServerNames: ["docs"] },
    });

    expect(
      inspectAgentAdapterRegistration("alpha", adapter, packageEntry, runtimeSelection),
    ).toEqual({ state: "registered" });
    assertAgentMcpMutationRuntimeCapability("alpha", adapter, runtimeSelection);
    assertAgentMcpTeardownRuntimeCapability("alpha", adapter, runtimeSelection);
    expect(
      inspectAgentMcpRuntimeIntent("alpha", adapter, {
        entries: [packageEntry],
        managedServerNames: ["docs"],
        runtimeSelection,
      }),
    ).toBeUndefined();

    registerAgentAdapter(
      "alpha",
      adapter,
      packageEntry,
      runtimeSelection,
      { FUTURE_TOKEN: "host-only-secret" },
      { replaceExisting: true, credentialRevision: "v12" },
    );
    expect(
      unregisterAgentAdapter("alpha", adapter, packageEntry, runtimeSelection, {
        force: true,
        bestEffort: true,
      }),
    ).toBe("removed");

    expect(mocks.buildInspection).toHaveBeenCalledWith("alpha", adapter, packageEntry, {
      configDirectory: "/sandbox/.package-agent",
    });
    expect(mocks.describeMutation).toHaveBeenCalledWith("alpha", adapter, agent);
    expect(mocks.describeTeardown).toHaveBeenCalledWith("alpha", adapter, agent);
    expect(mocks.describeIntent).toHaveBeenCalledWith(
      "alpha",
      adapter,
      agent,
      [packageEntry],
      ["docs"],
      undefined,
    );
    expect(mocks.registerInstalled).toHaveBeenCalledWith(
      "alpha",
      adapter,
      packageEntry,
      runtimeSelection,
      { FUTURE_TOKEN: "host-only-secret" },
      {
        replaceExisting: true,
        credentialRevision: "v12",
        configDirectory: "/sandbox/.package-agent",
      },
    );
    expect(mocks.unregisterInstalled).toHaveBeenCalledWith(
      "alpha",
      adapter,
      packageEntry,
      runtimeSelection,
      {
        force: true,
        bestEffort: true,
        configDirectory: "/sandbox/.package-agent",
      },
    );
  });

  it("fails with typed guidance before either mutation without package authority", () => {
    mocks.getPackage.mockReturnValue(null);
    mocks.requirePackage.mockImplementation(() => {
      throw new McpBridgeError(
        "Managed MCP requires reconciled harness package authority. Re-run the NemoClaw installer.",
        1,
        "package-authority-required",
      );
    });
    const legacyEntry = entry("openclaw", "mcporter");

    for (const action of [
      () => registerAgentAdapter("alpha", "mcporter", legacyEntry, runtimeSelection),
      () => unregisterAgentAdapter("alpha", "mcporter", legacyEntry, runtimeSelection),
    ]) {
      try {
        action();
        throw new Error("expected package authority refusal");
      } catch (error) {
        expect(error).toBeInstanceOf(McpBridgeError);
        expect((error as McpBridgeError).reasonCode).toBe("package-authority-required");
        expect((error as Error).message).toMatch(/Re-run the NemoClaw installer/u);
      }
    }

    expect(mocks.registerInstalled).not.toHaveBeenCalled();
    expect(mocks.unregisterInstalled).not.toHaveBeenCalled();
  });
});
