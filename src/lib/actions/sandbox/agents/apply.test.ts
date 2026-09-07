// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  capture: vi.fn(),
  confirmAuthority: vi.fn(),
  ensureLive: vi.fn(),
  exec: vi.fn(),
  legacyApply: vi.fn(),
  resolveAuthority: vi.fn(),
  withLock: vi.fn(async (_sandboxName: string, operation: () => unknown) => operation()),
}));

vi.mock("../../../adapters/openshell/runtime", () => ({ captureOpenshell: mocks.capture }));
vi.mock("../exec", async (loadOriginal) => {
  const original = await loadOriginal<typeof import("../exec")>();
  return { ...original, execSandbox: mocks.exec };
});
vi.mock("./command-authority", () => ({
  confirmAgentRosterCommandAuthority: mocks.confirmAuthority,
  ensureLiveAgentRosterSandbox: mocks.ensureLive,
  resolveAgentRosterCommandAuthority: mocks.resolveAuthority,
  withAgentRosterCommandLock: mocks.withLock,
}));
vi.mock("./legacy-roster", () => ({ runLegacyAgentsApply: mocks.legacyApply }));

import { runAgentsApply } from "./apply";

const identity = {
  id: "future-roster",
  packageVersion: "1.0.0",
  contentDigest: "sha256:" + "a".repeat(64),
  source: {
    kind: "bundled",
    nemoclawBuildIdentity: { nemoclawVersion: "0.0.113", sourceRevision: "b".repeat(40) },
  },
} as const;

let temporaryDirectory = "";
let manifestPath = "";

function exitWithCode(code: number): never {
  throw new Error(`exit:${String(code)}`);
}

beforeEach(() => {
  temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-roster-apply-"));
  manifestPath = path.join(temporaryDirectory, "agents.yaml");
  fs.writeFileSync(manifestPath, "workers:\n  - name: planner\n", "utf8");
  mocks.capture.mockReturnValue({ status: 0, output: '{"workers":[]}', stdout: '{"workers":[]}' });
  mocks.ensureLive.mockResolvedValue(undefined);
  mocks.exec.mockResolvedValue(undefined);
});

afterEach(() => {
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
});

describe("receipt-backed agent roster apply", () => {
  it("executes a synthetic package plan without selecting behavior by package ID", async () => {
    const adapter = {
      buildAgentRosterInspection: vi.fn(() => ({
        kind: "capture" as const,
        command: ["future-roster", "inspect", "--json"],
      })),
      buildAgentRosterApplyPlan: vi.fn(() => ({
        kind: "ready" as const,
        current_count: 0,
        additions: [{ agent_id: "planner", command: ["future-roster", "add", "planner"] }],
        deletions: [],
        rebuild_only_fields: [],
        notices: [],
      })),
    };
    const authority = { kind: "package" as const, identity, adapter, displayName: "Future Roster" };
    mocks.resolveAuthority.mockReturnValue(authority);
    mocks.confirmAuthority.mockReturnValue(adapter);
    const messages: string[] = [];

    await runAgentsApply(
      { sandboxName: "alpha", manifestPath, yes: true },
      { log: (message) => messages.push(message), exit: exitWithCode },
    );

    expect(adapter.buildAgentRosterInspection).toHaveBeenCalledWith({
      manifest: { workers: [{ name: "planner" }] },
    });
    expect(mocks.capture).toHaveBeenCalledWith(
      expect.arrayContaining(["future-roster", "inspect", "--json"]),
      expect.objectContaining({ maxBuffer: 63 * 1024 * 1024 }),
    );
    expect(mocks.confirmAuthority).toHaveBeenCalledWith("alpha", identity);
    expect(mocks.exec).toHaveBeenCalledWith(
      "alpha",
      ["future-roster", "add", "planner"],
      {},
      expect.any(Object),
    );
    expect(messages).toContain("  Apply complete.");
    expect(mocks.withLock).toHaveBeenCalledWith("alpha", expect.any(Function));
    expect(mocks.legacyApply).not.toHaveBeenCalled();
  });

  it("renders package-owned rebuild distinctions and notices before returning a no-op", async () => {
    const adapter = {
      buildAgentRosterInspection: vi.fn(() => ({
        kind: "capture" as const,
        command: ["future-roster", "inspect", "--json"],
      })),
      buildAgentRosterApplyPlan: vi.fn(() => ({
        kind: "ready" as const,
        current_count: 1,
        additions: [],
        deletions: [],
        rebuild_only_fields: ["workers[planner].model"],
        notices: [{ message: "A package-owned setting needs a rebuild." }],
      })),
    };
    mocks.resolveAuthority.mockReturnValue({
      kind: "package",
      identity,
      adapter,
      displayName: "Future Roster",
    });
    const messages: string[] = [];

    await runAgentsApply(
      { sandboxName: "alpha", manifestPath },
      { log: (message) => messages.push(message), exit: exitWithCode },
    );

    expect(messages).toContain("     - workers[planner].model");
    expect(messages).toContain("  ⚠  A package-owned setting needs a rebuild.");
    expect(messages).toContain("  No roster changes to apply.");
    expect(mocks.exec).not.toHaveBeenCalled();
  });

  it("keeps confirmation semantics in core for package mutations", async () => {
    const adapter = {
      buildAgentRosterInspection: vi.fn(() => ({
        kind: "capture" as const,
        command: ["future-roster", "inspect", "--json"],
      })),
      buildAgentRosterApplyPlan: vi.fn(() => ({
        kind: "ready" as const,
        current_count: 0,
        additions: [{ agent_id: "planner", command: ["future-roster", "add", "planner"] }],
        deletions: [],
        rebuild_only_fields: [],
        notices: [],
      })),
    };
    mocks.resolveAuthority.mockReturnValue({
      kind: "package",
      identity,
      adapter,
      displayName: "Future Roster",
    });

    await expect(
      runAgentsApply(
        { sandboxName: "alpha", manifestPath, nonInteractive: true },
        { log: vi.fn(), exit: exitWithCode },
      ),
    ).rejects.toThrow("exit:1");
    expect(mocks.exec).not.toHaveBeenCalled();
  });

  it("returns typed unsupported before liveness for a receipt without the capability", async () => {
    mocks.resolveAuthority.mockReturnValue({
      kind: "unsupported",
      displayName: "Future Harness",
      reason: "Future Harness does not declare managed agent roster support.",
    });

    await expect(
      runAgentsApply(
        { sandboxName: "alpha", manifestPath, yes: true },
        { log: vi.fn(), exit: exitWithCode },
      ),
    ).rejects.toThrow("exit:1");
    expect(mocks.ensureLive).not.toHaveBeenCalled();
    expect(mocks.capture).not.toHaveBeenCalled();
    expect(mocks.exec).not.toHaveBeenCalled();
    expect(mocks.legacyApply).not.toHaveBeenCalled();
  });

  it("keeps no-receipt reconciliation in the explicit legacy module", async () => {
    mocks.resolveAuthority.mockReturnValue({ kind: "legacy" });

    await runAgentsApply(
      { sandboxName: "alpha", manifestPath, yes: true },
      { log: vi.fn(), exit: exitWithCode },
    );

    expect(mocks.legacyApply).toHaveBeenCalledWith(
      { sandboxName: "alpha", manifestPath, yes: true },
      expect.objectContaining({ log: expect.any(Function), exit: expect.any(Function) }),
    );
    expect(mocks.capture).not.toHaveBeenCalled();
  });

  it("honors package validation refusal before OpenShell liveness", async () => {
    const adapter = {
      buildAgentRosterInspection: vi.fn(() => ({
        kind: "refused" as const,
        reason: "workers must be a list",
      })),
      buildAgentRosterApplyPlan: vi.fn(),
    };
    mocks.resolveAuthority.mockReturnValue({
      kind: "package",
      identity,
      adapter,
      displayName: "Future Roster",
    });

    await expect(
      runAgentsApply(
        { sandboxName: "alpha", manifestPath, yes: true },
        { log: vi.fn(), exit: exitWithCode },
      ),
    ).rejects.toThrow("exit:1");
    expect(mocks.ensureLive).not.toHaveBeenCalled();
    expect(mocks.capture).not.toHaveBeenCalled();
  });
});
