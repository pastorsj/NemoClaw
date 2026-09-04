// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentDefinition } from "../../agent/defs";
import type { SandboxEntry } from "../../state/registry";

const mocks = vi.hoisted(() => ({
  loadAgent: vi.fn(),
  resolveSandboxAgent: vi.fn(),
}));

vi.mock("../../agent/defs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agent/defs")>()),
  loadAgent: mocks.loadAgent,
}));

vi.mock("../../onboard/sandbox-agent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../onboard/sandbox-agent")>()),
  resolveSandboxAgent: mocks.resolveSandboxAgent,
}));

import { getAgentConfigDir, getBridgeAdapter, getSandboxAgent } from "./mcp-bridge-state";

function agentDefinition(
  displayName: string,
  configDirectory: string,
  adapter: string,
): AgentDefinition {
  return {
    name: "future-agent",
    displayName,
    configPaths: { dir: configDirectory },
    mcpCapability: { support: "bridge", adapter },
  } as AgentDefinition;
}

const receiptA = Object.freeze({
  kind: "agent-runtime" as const,
  id: "future-agent",
  packageVersion: "1.0.0",
  contentDigest: "a".repeat(64),
});

const sandboxWithReceiptA = Object.freeze({
  name: "alpha",
  agent: "future-agent",
  harnessPackage: receiptA,
}) as SandboxEntry;

beforeEach(() => {
  mocks.loadAgent.mockReset();
  mocks.resolveSandboxAgent.mockReset();
});

describe("MCP sandbox agent authority", () => {
  it("keeps receipt A authoritative after the active package advances to B", () => {
    const receiptDefinitionA = agentDefinition(
      "Receipt A",
      "/sandbox/.receipt-a",
      "receipt-a-adapter",
    );
    const activeDefinitionB = agentDefinition("Active B", "/sandbox/.active-b", "active-b-adapter");
    mocks.resolveSandboxAgent.mockReturnValue({ definition: receiptDefinitionA });
    mocks.loadAgent.mockReturnValue(activeDefinitionB);

    expect(getBridgeAdapter(getSandboxAgent(sandboxWithReceiptA))).toBe("receipt-a-adapter");
    expect(getAgentConfigDir("future-agent", "/sandbox/.fallback", sandboxWithReceiptA)).toBe(
      "/sandbox/.receipt-a",
    );
    expect(mocks.resolveSandboxAgent).toHaveBeenCalledTimes(2);
    expect(mocks.resolveSandboxAgent).toHaveBeenCalledWith(sandboxWithReceiptA);
    expect(mocks.loadAgent).not.toHaveBeenCalled();
  });

  it("preserves active-definition lookup for a legacy sandbox without a receipt", () => {
    const activeDefinition = agentDefinition(
      "Legacy active",
      "/sandbox/.legacy-active",
      "legacy-adapter",
    );
    const legacySandbox = { name: "alpha", agent: "future-agent" } as SandboxEntry;
    mocks.loadAgent.mockReturnValue(activeDefinition);

    expect(getSandboxAgent(legacySandbox)).toBe(activeDefinition);
    expect(getAgentConfigDir("future-agent", undefined, legacySandbox)).toBe(
      "/sandbox/.legacy-active",
    );
    expect(mocks.loadAgent).toHaveBeenCalledTimes(2);
    expect(mocks.resolveSandboxAgent).not.toHaveBeenCalled();
  });

  it("does not replace a package-authority failure with the legacy default directory", () => {
    mocks.resolveSandboxAgent.mockImplementation(() => {
      throw new Error("receipt A is unavailable");
    });

    expect(() =>
      getAgentConfigDir("future-agent", "/sandbox/.fallback", sandboxWithReceiptA),
    ).toThrow(/receipt A is unavailable/u);
    expect(mocks.loadAgent).not.toHaveBeenCalled();
  });
});
