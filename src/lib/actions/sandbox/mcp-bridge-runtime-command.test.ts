// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  buildInstalledRuntimeCommand: vi.fn(),
}));

vi.mock("./mcp-bridge/package-command", () => ({
  buildInstalledMcpRuntimeCommand: mocks.buildInstalledRuntimeCommand,
}));

import { wrapMcpRuntimeCommand } from "./mcp-bridge-runtime-command";

beforeEach(() => {
  mocks.buildInstalledRuntimeCommand.mockReset();
});

describe("MCP runtime command", () => {
  it("uses the selected package for an adapter that core does not know", () => {
    mocks.buildInstalledRuntimeCommand.mockReturnValue([
      "future-runtime",
      "child",
      "value with spaces",
      "$(unsafe)",
    ]);

    expect(
      wrapMcpRuntimeCommand("future-config", ["child", "value with spaces", "$(unsafe)"], {
        sandboxName: "future-sandbox",
        agentName: "future-agent",
      }),
    ).toBe("'future-runtime' 'child' 'value with spaces' '$(unsafe)'");
    expect(mocks.buildInstalledRuntimeCommand).toHaveBeenCalledWith(
      "future-sandbox",
      "future-config",
      "future-agent",
      ["child", "value with spaces", "$(unsafe)"],
    );
  });

  it("retains the legacy wrapper when a sandbox has no package receipt", () => {
    mocks.buildInstalledRuntimeCommand.mockReturnValue(null);

    expect(
      wrapMcpRuntimeCommand("mcporter", ["node", "probe.mjs"], {
        sandboxName: "legacy-sandbox",
        agentName: "openclaw",
      }),
    ).toContain("nemoclaw-start node");
  });
});
