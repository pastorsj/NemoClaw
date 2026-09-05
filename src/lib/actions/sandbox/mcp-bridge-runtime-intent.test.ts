// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSandboxOrThrow: vi.fn(),
  getSandboxHarnessPackage: vi.fn(),
  requireSandboxHarnessPackage: vi.fn(),
  describeIntent: vi.fn(),
  assertCapability: vi.fn(),
}));

vi.mock("./mcp-bridge-state", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./mcp-bridge-state")>()),
  bridgeState: (sandbox: { mcp?: { bridges?: Record<string, unknown> } }) =>
    sandbox.mcp?.bridges ?? {},
  getSandboxOrThrow: mocks.getSandboxOrThrow,
  getSandboxHarnessPackage: mocks.getSandboxHarnessPackage,
  requireSandboxHarnessPackage: mocks.requireSandboxHarnessPackage,
}));

vi.mock("./mcp-bridge/package-command", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./mcp-bridge/package-command")>()),
  describeInstalledMcpRuntimeIntentVerification: mocks.describeIntent,
}));

vi.mock("./mcp-bridge/package-probe", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./mcp-bridge/package-probe")>()),
  assertInstalledMcpCapability: mocks.assertCapability,
}));

import { assertAgentMcpRuntimeIntent } from "./mcp-bridge-adapters";
import { McpBridgeError } from "./mcp-bridge-contracts";

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
  providerName: "future-provider",
  policyName: "future-policy",
  addedAt: "2026-08-30T12:00:00.000Z",
});
const runtimeSelection = { gatewayName: "nemoclaw-8091", workspace: "default" } as const;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSandboxOrThrow.mockReturnValue({
    name: "alpha",
    agent: "future-harness",
    harnessPackage: PACKAGE_IDENTITY,
    mcp: { bridges: { docs: ENTRY }, managedServerNames: ["docs"] },
  });
  mocks.getSandboxHarnessPackage.mockReturnValue(PACKAGE_IDENTITY);
  mocks.requireSandboxHarnessPackage.mockReturnValue(PACKAGE_IDENTITY);
  mocks.describeIntent.mockReturnValue({
    kind: "command",
    command: ["future-verify"],
    success: { kind: "exit-zero" },
    timeoutSeconds: 10,
    failureMessage: "future intent mismatch",
  });
});

describe("package MCP runtime intent authority", () => {
  it("verifies a synthetic unknown package through its typed adapter", () => {
    const credentialRevisions = new Map([["docs", "v9" as const]]);
    assertAgentMcpRuntimeIntent("alpha", "future-config", {
      credentialRevisions,
      runtimeSelection,
    });

    expect(mocks.describeIntent).toHaveBeenCalledWith(
      "alpha",
      "future-config",
      "future-harness",
      [ENTRY],
      ["docs"],
      credentialRevisions,
    );
    expect(mocks.assertCapability).toHaveBeenCalledWith(
      "alpha",
      {
        kind: "command",
        command: ["future-verify"],
        success: { kind: "exit-zero" },
        timeoutSeconds: 10,
        failureMessage: "future intent mismatch",
      },
      runtimeSelection,
    );
  });

  it("fails closed when a receipt-backed adapter cannot describe verification", () => {
    mocks.describeIntent.mockImplementation(() => {
      throw new Error("invalid package result");
    });

    expect(() =>
      assertAgentMcpRuntimeIntent("alpha", "future-config", { runtimeSelection }),
    ).toThrow(/invalid package result/u);
    expect(mocks.assertCapability).not.toHaveBeenCalled();
  });

  it("fails closed when receipt-backed runtime verification does not pass", () => {
    mocks.assertCapability.mockImplementation(() => {
      throw new Error("future intent mismatch");
    });

    expect(() =>
      assertAgentMcpRuntimeIntent("alpha", "future-config", { runtimeSelection }),
    ).toThrow(/future intent mismatch/u);
  });

  it("refuses a bridge entry that does not match the installed package", () => {
    mocks.getSandboxOrThrow.mockReturnValue({
      name: "alpha",
      agent: "future-harness",
      harnessPackage: PACKAGE_IDENTITY,
      mcp: { bridges: { docs: { ...ENTRY, agent: "other-harness" } } },
    });

    expect(() =>
      assertAgentMcpRuntimeIntent("alpha", "future-config", { runtimeSelection }),
    ).toThrow(/does not match the installed package runtime intent/u);
    expect(mocks.describeIntent).not.toHaveBeenCalled();
  });

  it("rejects a no-receipt Hermes sandbox instead of selecting a native fallback", () => {
    const hermesEntry = { ...ENTRY, agent: "hermes", adapter: "hermes-config" };
    mocks.getSandboxOrThrow.mockReturnValue({
      name: "alpha",
      agent: "hermes",
      mcp: { bridges: { docs: hermesEntry }, managedServerNames: ["docs", "removed"] },
    });
    mocks.getSandboxHarnessPackage.mockReturnValue(null);
    mocks.requireSandboxHarnessPackage.mockImplementation(() => {
      throw new McpBridgeError(
        "Managed MCP requires reconciled harness package authority. Re-run the NemoClaw installer.",
        1,
        "package-authority-required",
      );
    });

    expect(() => assertAgentMcpRuntimeIntent("alpha", "hermes-config")).toThrowError(
      expect.objectContaining({ reasonCode: "package-authority-required" }),
    );
    expect(mocks.describeIntent).not.toHaveBeenCalled();
  });
});
