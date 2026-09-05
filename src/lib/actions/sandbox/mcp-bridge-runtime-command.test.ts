// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  buildInstalledRuntimeCommand: vi.fn(),
  requirePackage: vi.fn(),
}));

vi.mock("./mcp-bridge/package-command", () => ({
  buildInstalledMcpRuntimeCommand: mocks.buildInstalledRuntimeCommand,
}));

vi.mock("./mcp-bridge-state", () => ({
  requireSandboxHarnessPackage: mocks.requirePackage,
}));

import { wrapMcpRuntimeCommand } from "./mcp-bridge-runtime-command";

beforeEach(() => {
  mocks.buildInstalledRuntimeCommand.mockReset();
  mocks.requirePackage.mockReset().mockReturnValue({
    kind: "agent-runtime",
    id: "future-agent",
    packageVersion: "1.0.0",
    contentDigest: "a".repeat(64),
  });
});

describe("MCP runtime command", () => {
  it.each([
    ["openclaw", "mcporter"],
    ["hermes", "hermes-config"],
    ["langchain-deepagents-code", "deepagents-config"],
    ["future-agent", "future-config"],
  ] as const)("uses the selected %s package for adapter %s", (agentName, adapter) => {
    mocks.buildInstalledRuntimeCommand.mockReturnValue([
      "future-runtime",
      "child",
      "value with spaces",
      "$(unsafe)",
    ]);

    expect(
      wrapMcpRuntimeCommand(adapter, ["child", "value with spaces", "$(unsafe)"], {
        sandboxName: "future-sandbox",
        agentName,
      }),
    ).toBe("'future-runtime' 'child' 'value with spaces' '$(unsafe)'");
    expect(mocks.buildInstalledRuntimeCommand).toHaveBeenCalledWith(
      "future-sandbox",
      adapter,
      agentName,
      ["child", "value with spaces", "$(unsafe)"],
    );
  });

  it("fails with typed repair guidance before resolving a runtime without package authority", () => {
    mocks.requirePackage.mockImplementation(() => {
      const error = new Error(
        "Managed MCP requires reconciled harness package authority. Re-run the NemoClaw installer.",
      ) as Error & { reasonCode: string };
      error.reasonCode = "package-authority-required";
      throw error;
    });

    expect(() =>
      wrapMcpRuntimeCommand("mcporter", ["node", "probe.mjs"], {
        sandboxName: "legacy-sandbox",
        agentName: "openclaw",
      }),
    ).toThrowError(expect.objectContaining({ reasonCode: "package-authority-required" }));
    expect(mocks.buildInstalledRuntimeCommand).not.toHaveBeenCalled();
  });

  it("does not accept an authority-free runtime call", () => {
    expect(() => wrapMcpRuntimeCommand("mcporter", ["node", "probe.mjs"])).toThrowError(
      expect.objectContaining({ reasonCode: "package-authority-required" }),
    );
  });
});
