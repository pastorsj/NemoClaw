// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  confirmAuthority: vi.fn(),
  ensureLive: vi.fn(),
  exec: vi.fn(),
  legacy: vi.fn(),
  resolveAuthority: vi.fn(),
  withLock: vi.fn(async (_sandboxName: string, operation: () => unknown) => operation()),
}));

vi.mock("../exec", () => ({ execSandbox: mocks.exec }));
vi.mock("./command-authority", () => ({
  confirmAgentRosterCommandAuthority: mocks.confirmAuthority,
  ensureLiveAgentRosterSandbox: mocks.ensureLive,
  resolveAgentRosterCommandAuthority: mocks.resolveAuthority,
  withAgentRosterCommandLock: mocks.withLock,
}));
vi.mock("./legacy-roster", () => ({ runLegacyAgentsPassthrough: mocks.legacy }));

import { runAgentsPassthrough } from "./passthrough";

const identity = {
  id: "future-roster",
  packageVersion: "1.0.0",
  contentDigest: "sha256:" + "a".repeat(64),
  source: {
    kind: "bundled",
    nemoclawBuildIdentity: { nemoclawVersion: "0.0.113", sourceRevision: "b".repeat(40) },
  },
} as const;

beforeEach(() => {
  mocks.ensureLive.mockResolvedValue(undefined);
  mocks.exec.mockResolvedValue(undefined);
});

describe("receipt-backed agent roster commands", () => {
  it("runs a synthetic package command without an ID branch", async () => {
    const adapter = {
      buildAgentRosterCommand: vi.fn(() => ({
        kind: "stream" as const,
        command: ["future-roster", "workers", "list", "--json"],
      })),
    };
    mocks.resolveAuthority.mockReturnValue({
      kind: "package",
      identity,
      adapter,
      displayName: "Future Roster",
    });

    await runAgentsPassthrough("alpha", { verb: "list", extraArgs: ["--json"] });

    expect(adapter.buildAgentRosterCommand).toHaveBeenCalledWith({
      operation: "list",
      arguments: ["--json"],
    });
    expect(mocks.ensureLive).toHaveBeenCalledOnce();
    expect(mocks.exec).toHaveBeenCalledWith(
      "alpha",
      ["future-roster", "workers", "list", "--json"],
      {},
      expect.any(Object),
    );
    expect(mocks.legacy).not.toHaveBeenCalled();
  });

  it("revalidates a mutating package command under the sandbox lock", async () => {
    const plan = { kind: "stream" as const, command: ["future-roster", "add", "planner"] };
    const adapter = { buildAgentRosterCommand: vi.fn(() => plan) };
    mocks.resolveAuthority.mockReturnValue({
      kind: "package",
      identity,
      adapter,
      displayName: "Future Roster",
    });
    mocks.confirmAuthority.mockReturnValue(adapter);

    await runAgentsPassthrough("alpha", { verb: "add", extraArgs: ["planner"] });

    expect(mocks.withLock).toHaveBeenCalledWith("alpha", expect.any(Function));
    expect(mocks.confirmAuthority).toHaveBeenCalledWith("alpha", identity);
    expect(adapter.buildAgentRosterCommand).toHaveBeenCalledTimes(2);
  });

  it("never falls back for a receipt-backed package without the capability", async () => {
    mocks.resolveAuthority.mockReturnValue({
      kind: "unsupported",
      displayName: "Future Harness",
      reason: "Future Harness does not declare managed agent roster support.",
    });
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit:${String(code)}`);
    }) as typeof process.exit);

    await expect(runAgentsPassthrough("alpha", { verb: "list", extraArgs: [] })).rejects.toThrow(
      "exit:1",
    );
    expect(exit).toHaveBeenCalledWith(1);
    expect(mocks.ensureLive).not.toHaveBeenCalled();
    expect(mocks.exec).not.toHaveBeenCalled();
    expect(mocks.legacy).not.toHaveBeenCalled();
  });

  it("routes only no-receipt sandboxes to explicit legacy behavior", async () => {
    mocks.resolveAuthority.mockReturnValue({ kind: "legacy" });

    await runAgentsPassthrough("alpha", { verb: "delete", extraArgs: ["planner"] });

    expect(mocks.legacy).toHaveBeenCalledWith("alpha", "delete", ["planner"]);
    expect(mocks.exec).not.toHaveBeenCalled();
  });
});
