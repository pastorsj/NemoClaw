// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

import { McpBridgeError } from "./mcp-bridge-contracts";

const mocks = vi.hoisted(() => ({
  requireSandboxHarnessPackage: vi.fn(),
}));

vi.mock("./mcp-bridge-state", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./mcp-bridge-state")>()),
  requireSandboxHarnessPackage: mocks.requireSandboxHarnessPackage,
}));

import { assertMcpCommandRuntimeAvailable } from "./mcp-bridge-runtime-capabilities";

beforeEach(() => vi.clearAllMocks());

describe("MCP command runtime authority", () => {
  it("accepts a receipt-backed package without selecting a harness-specific guard", () => {
    mocks.requireSandboxHarnessPackage.mockReturnValue({
      kind: "agent-runtime",
      id: "future-harness",
      packageVersion: "1.0.0",
      contentDigest: "a".repeat(64),
    });

    assertMcpCommandRuntimeAvailable("alpha", "sandbox:mcp:add");

    expect(mocks.requireSandboxHarnessPackage).toHaveBeenCalledWith("alpha");
  });

  it("propagates the typed package-authority refusal", () => {
    mocks.requireSandboxHarnessPackage.mockImplementation(() => {
      throw new McpBridgeError(
        "Managed MCP requires reconciled harness package authority. Re-run the NemoClaw installer.",
        1,
        "package-authority-required",
      );
    });

    expect(() => assertMcpCommandRuntimeAvailable("alpha", "sandbox:mcp:add")).toThrowError(
      expect.objectContaining({ reasonCode: "package-authority-required" }),
    );
  });
});
