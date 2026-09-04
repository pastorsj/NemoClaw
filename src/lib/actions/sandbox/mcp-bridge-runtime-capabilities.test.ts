// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSandboxHarnessPackage: vi.fn(),
  assertPortableUnavailable: vi.fn(),
}));

vi.mock("./mcp-bridge-state", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./mcp-bridge-state")>()),
  getSandboxHarnessPackage: mocks.getSandboxHarnessPackage,
}));

vi.mock("../../onboard/experimental/portable-agent-lifecycle", () => ({
  assertHermesPortableCommandUnavailable: mocks.assertPortableUnavailable,
}));

import { assertMcpCommandRuntimeAvailable } from "./mcp-bridge-runtime-capabilities";

beforeEach(() => vi.clearAllMocks());

describe("MCP command runtime authority", () => {
  it("does not apply a Hermes-specific command guard to a receipt-backed package", () => {
    mocks.getSandboxHarnessPackage.mockReturnValue({
      kind: "agent-runtime",
      id: "future-harness",
      packageVersion: "1.0.0",
      contentDigest: "a".repeat(64),
    });

    assertMcpCommandRuntimeAvailable("alpha", "sandbox:mcp:add");

    expect(mocks.assertPortableUnavailable).not.toHaveBeenCalled();
  });

  it("retains the legacy guard when the sandbox has no package receipt", () => {
    mocks.getSandboxHarnessPackage.mockReturnValue(null);

    assertMcpCommandRuntimeAvailable("alpha", "sandbox:mcp:add");

    expect(mocks.assertPortableUnavailable).toHaveBeenCalledWith("alpha", "sandbox:mcp:add");
  });
});
