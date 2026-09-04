// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSandboxOrThrow: vi.fn(),
  getSandboxHarnessPackage: vi.fn(),
  describeIntent: vi.fn(),
  assertCapability: vi.fn(),
  assertHermesIntent: vi.fn(),
}));

vi.mock("./mcp-bridge-state", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./mcp-bridge-state")>()),
  bridgeState: (sandbox: { mcp?: { bridges?: Record<string, unknown> } }) =>
    sandbox.mcp?.bridges ?? {},
  getSandboxOrThrow: mocks.getSandboxOrThrow,
  getSandboxHarnessPackage: mocks.getSandboxHarnessPackage,
}));

vi.mock("./mcp-bridge/package-command", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./mcp-bridge/package-command")>()),
  describeInstalledMcpRuntimeIntentVerification: mocks.describeIntent,
}));

vi.mock("./mcp-bridge/package-probe", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./mcp-bridge/package-probe")>()),
  assertInstalledMcpCapability: mocks.assertCapability,
}));

vi.mock("./mcp-bridge-hermes-reconciliation", () => ({
  assertHermesMcpRuntimeIntent: mocks.assertHermesIntent,
}));

import { assertAgentMcpRuntimeIntent } from "./mcp-bridge-adapters";

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

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSandboxOrThrow.mockReturnValue({
    name: "alpha",
    agent: "future-harness",
    harnessPackage: PACKAGE_IDENTITY,
    mcp: { bridges: { docs: ENTRY }, managedServerNames: ["docs"] },
  });
  mocks.getSandboxHarnessPackage.mockReturnValue(PACKAGE_IDENTITY);
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
    assertAgentMcpRuntimeIntent("alpha", "future-config", { credentialRevisions });

    expect(mocks.describeIntent).toHaveBeenCalledWith(
      "alpha",
      "future-config",
      "future-harness",
      [ENTRY],
      ["docs"],
      credentialRevisions,
    );
    expect(mocks.assertCapability).toHaveBeenCalledWith("alpha", {
      kind: "command",
      command: ["future-verify"],
      success: { kind: "exit-zero" },
      timeoutSeconds: 10,
      failureMessage: "future intent mismatch",
    });
    expect(mocks.assertHermesIntent).not.toHaveBeenCalled();
  });

  it("fails closed when a receipt-backed adapter cannot describe verification", () => {
    mocks.describeIntent.mockImplementation(() => {
      throw new Error("invalid package result");
    });

    expect(() => assertAgentMcpRuntimeIntent("alpha", "future-config")).toThrow(
      /invalid package result/u,
    );
    expect(mocks.assertCapability).not.toHaveBeenCalled();
    expect(mocks.assertHermesIntent).not.toHaveBeenCalled();
  });

  it("fails closed when receipt-backed runtime verification does not pass", () => {
    mocks.assertCapability.mockImplementation(() => {
      throw new Error("future intent mismatch");
    });

    expect(() => assertAgentMcpRuntimeIntent("alpha", "future-config")).toThrow(
      /future intent mismatch/u,
    );
    expect(mocks.assertHermesIntent).not.toHaveBeenCalled();
  });

  it("refuses a bridge entry that does not match the installed package", () => {
    mocks.getSandboxOrThrow.mockReturnValue({
      name: "alpha",
      agent: "future-harness",
      harnessPackage: PACKAGE_IDENTITY,
      mcp: { bridges: { docs: { ...ENTRY, agent: "other-harness" } } },
    });

    expect(() => assertAgentMcpRuntimeIntent("alpha", "future-config")).toThrow(
      /does not match the installed package runtime intent/u,
    );
    expect(mocks.describeIntent).not.toHaveBeenCalled();
    expect(mocks.assertHermesIntent).not.toHaveBeenCalled();
  });

  it("retains core Hermes reconciliation only for a no-receipt legacy sandbox", () => {
    const hermesEntry = { ...ENTRY, agent: "hermes", adapter: "hermes-config" };
    mocks.getSandboxOrThrow.mockReturnValue({
      name: "alpha",
      agent: "hermes",
      mcp: { bridges: { docs: hermesEntry }, managedServerNames: ["docs", "removed"] },
    });
    mocks.getSandboxHarnessPackage.mockReturnValue(null);

    assertAgentMcpRuntimeIntent("alpha", "hermes-config");

    expect(mocks.assertHermesIntent).toHaveBeenCalledWith("alpha", {
      entries: [hermesEntry],
      managedServerNames: ["docs", "removed"],
    });
    expect(mocks.describeIntent).not.toHaveBeenCalled();
  });
});
