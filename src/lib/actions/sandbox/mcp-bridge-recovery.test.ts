// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findSandbox: vi.fn(),
  getAgent: vi.fn(),
  getAdapter: vi.fn(),
  inspectIntent: vi.fn(),
}));

vi.mock("./mcp-bridge-state", () => ({
  bridgeState: (sandbox: { mcp?: { bridges?: Record<string, unknown> } }) =>
    sandbox.mcp?.bridges ?? {},
  findRegisteredSandbox: mocks.findSandbox,
  getSandboxAgent: mocks.getAgent,
  getBridgeAdapter: mocks.getAdapter,
}));

vi.mock("./mcp-bridge-adapters", () => ({
  inspectAgentMcpRuntimeIntent: mocks.inspectIntent,
}));

import {
  inspectMcpRuntimeIntent,
  inspectMcpRuntimeIntentRefusal,
  processRecoveryMcpReconciliationRefusal,
} from "./mcp-bridge-recovery";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getAgent.mockReturnValue({ name: "future-harness" });
  mocks.getAdapter.mockReturnValue("future-config");
  mocks.inspectIntent.mockReturnValue({ ok: true, state: "matched" });
});

describe("package-owned MCP recovery boundary (#6257)", () => {
  it("does not require a package operation when no managed MCP state exists", () => {
    mocks.findSandbox.mockReturnValue({ name: "alpha", agent: "future-harness" });

    expect(inspectMcpRuntimeIntent("alpha")).toEqual({
      ok: true,
      state: "not-applicable",
    });
    expect(mocks.getAgent).not.toHaveBeenCalled();
    expect(mocks.inspectIntent).not.toHaveBeenCalled();
  });

  it("routes an unknown harness through the same typed package intent operation", () => {
    const entry = { server: "docs", agent: "future-harness", adapter: "future-config" };
    mocks.findSandbox.mockReturnValue({
      name: "alpha",
      agent: "future-harness",
      mcp: { bridges: { docs: entry } },
    });

    expect(inspectMcpRuntimeIntent("alpha")).toEqual({ ok: true, state: "matched" });
    expect(mocks.inspectIntent).toHaveBeenCalledWith("alpha", "future-config", {
      entries: [entry],
      runtimeSelection: undefined,
    });
  });

  it("turns missing package authority into an actionable recovery refusal", () => {
    mocks.findSandbox.mockReturnValue({
      name: "alpha",
      agent: "future-harness",
      mcp: { bridges: {} },
    });
    mocks.getAgent.mockImplementation(() => {
      throw new Error(
        "Managed MCP requires reconciled harness package authority. Re-run the NemoClaw installer.",
      );
    });

    expect(inspectMcpRuntimeIntent("alpha")).toEqual({
      ok: false,
      state: "error",
      detail:
        "Managed MCP requires reconciled harness package authority. Re-run the NemoClaw installer.",
    });
    expect(mocks.inspectIntent).not.toHaveBeenCalled();
  });

  it("continues when runtime intent matches", () => {
    expect(
      inspectMcpRuntimeIntentRefusal("alpha", () => ({
        ok: true,
        state: "matched",
      })),
    ).toBeNull();
  });

  it("sanitizes a reconciliation refusal once at the shared boundary", () => {
    expect(
      inspectMcpRuntimeIntentRefusal("alpha", () => ({
        ok: false,
        state: "mismatch",
        detail: "\u001b[31mdrifted\u001b[0m\nFORGED",
      })),
    ).toEqual({ detail: "drifted FORGED" });
  });

  it.each([true, false])("maps refusal into the process recovery contract (%s)", (wasRunning) => {
    expect(
      processRecoveryMcpReconciliationRefusal("alpha", wasRunning, () => ({
        ok: false,
        state: "error",
        detail: "runtime mismatch",
      })),
    ).toEqual({
      checked: true,
      wasRunning,
      recovered: false,
      forwardRecovered: false,
      mcpReconciliationRefused: true,
      mcpReconciliationReason: "runtime mismatch",
    });
  });
});
