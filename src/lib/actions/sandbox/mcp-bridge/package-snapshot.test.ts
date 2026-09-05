// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SandboxEntry } from "../../../state/registry";
import { McpBridgeError } from "./error";

const mocks = vi.hoisted(() => ({
  getSandboxAgent: vi.fn(),
  requirePackage: vi.fn(),
  getBridgeAdapter: vi.fn(),
  buildSnapshotPlan: vi.fn(),
  buildInspection: vi.fn(),
}));

vi.mock("../mcp-bridge-state", () => ({
  getSandboxAgent: mocks.getSandboxAgent,
  requireSandboxHarnessPackage: mocks.requirePackage,
  getBridgeAdapter: mocks.getBridgeAdapter,
}));

vi.mock("./package-command", () => ({
  buildInstalledMcpSnapshotRestorePlan: mocks.buildSnapshotPlan,
  buildInstalledMcpInspectionCommand: mocks.buildInspection,
}));

import {
  applyInstalledMcpSnapshotRestore,
  prepareInstalledMcpSnapshotRestore,
} from "./package-snapshot";

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

const SANDBOX = Object.freeze({
  name: "alpha",
  agent: "future-harness",
  harnessPackage: {
    kind: "agent-runtime" as const,
    id: "future-harness",
    packageVersion: "1.0.0",
    contentDigest: "a".repeat(64),
  },
  mcp: { bridges: { docs: ENTRY } },
}) as SandboxEntry;

const PLAN = Object.freeze({
  kind: "conditional-repair" as const,
  applicability: {
    command: ["future-runtime-kind"],
    timeoutSeconds: 10,
    repairWhenOutput: "managed",
    skipWhenOutput: "legacy",
    failureMessage: "Future runtime kind is unavailable.",
  },
  capability: { kind: "not-required" as const },
  execution: {
    command: "future-repair",
    timeoutSeconds: 30,
    success: { kind: "exit-zero" as const },
    failureMessage: "Future repair failed.",
  },
  verificationFailureMessage: "Future repair verification failed",
});

const RUNTIME_SELECTION = Object.freeze({ gatewayName: "alpha-gateway", workspace: "default" });

beforeEach(() => {
  mocks.getSandboxAgent.mockReset().mockReturnValue({
    name: "future-harness",
    mcpCapability: { support: "bridge", adapter: "future-config" },
  });
  mocks.requirePackage.mockReset().mockReturnValue(SANDBOX.harnessPackage);
  mocks.getBridgeAdapter.mockReset().mockReturnValue("future-config");
  mocks.buildSnapshotPlan.mockReset().mockReturnValue(PLAN);
  mocks.buildInspection.mockReset().mockReturnValue("future-inspect");
});

describe("installed MCP package snapshot restore", () => {
  it("fails before package planning when receipt authority is missing", () => {
    mocks.requirePackage.mockImplementation(() => {
      throw new McpBridgeError("package authority required", 1, "package-authority-required");
    });

    expect(() => prepareInstalledMcpSnapshotRestore(SANDBOX)).toThrow(
      /package authority required/u,
    );
    expect(mocks.buildSnapshotPlan).not.toHaveBeenCalled();
  });

  it("uses one typed package plan for an arbitrary harness", () => {
    const prepared = prepareInstalledMcpSnapshotRestore(SANDBOX);

    expect(prepared).toMatchObject({
      sandboxName: "alpha",
      agentName: "future-harness",
      adapter: "future-config",
      entries: [ENTRY],
      plan: PLAN,
    });
    expect(mocks.buildSnapshotPlan).toHaveBeenCalledWith(
      "alpha",
      "future-config",
      "future-harness",
      [ENTRY],
    );
  });

  it("refuses registry entries owned by another package before planning", () => {
    const mismatched = {
      ...SANDBOX,
      mcp: {
        bridges: {
          docs: { ...ENTRY, agent: "other-harness", adapter: "other-config" },
        },
      },
    } as SandboxEntry;

    expect(() => prepareInstalledMcpSnapshotRestore(mismatched)).toThrow(
      /does not match its reconciled harness package authority/u,
    );
    expect(mocks.buildSnapshotPlan).not.toHaveBeenCalled();
  });

  it("executes and verifies a package repair without adapter-name dispatch", () => {
    const executeArgvCommand = vi.fn().mockReturnValue({
      status: 0,
      stdout: "managed\n",
      stderr: "",
    });
    const executeShellCommand = vi.fn().mockReturnValue({ status: 0, stdout: "", stderr: "" });
    const assertCapability = vi.fn();
    const inspectRegistration = vi.fn().mockReturnValue({ state: "registered" });
    const prepared = prepareInstalledMcpSnapshotRestore(SANDBOX);
    if (!prepared) throw new Error("expected a package repair plan");

    applyInstalledMcpSnapshotRestore(prepared, RUNTIME_SELECTION, {
      executeArgvCommand,
      executeShellCommand,
      assertCapability,
      inspectRegistration,
    });

    expect(executeArgvCommand).toHaveBeenCalledWith(
      "alpha",
      ["future-runtime-kind"],
      10,
      RUNTIME_SELECTION,
    );
    expect(assertCapability).toHaveBeenCalledWith(
      "alpha",
      { kind: "not-required" },
      RUNTIME_SELECTION,
    );
    expect(executeShellCommand).toHaveBeenCalledWith(
      "alpha",
      "future-repair",
      30,
      RUNTIME_SELECTION,
    );
    expect(inspectRegistration).toHaveBeenCalledWith(
      "alpha",
      ENTRY,
      "future-inspect",
      RUNTIME_SELECTION,
    );
  });

  it("skips mutation when the package declares the runtime non-applicable", () => {
    const executeArgvCommand = vi.fn().mockReturnValue({
      status: 0,
      stdout: "legacy\n",
      stderr: "",
    });
    const executeShellCommand = vi.fn();
    const assertCapability = vi.fn();
    const inspectRegistration = vi.fn();
    const prepared = prepareInstalledMcpSnapshotRestore(SANDBOX);
    if (!prepared) throw new Error("expected a package repair plan");

    applyInstalledMcpSnapshotRestore(prepared, RUNTIME_SELECTION, {
      executeArgvCommand,
      executeShellCommand,
      assertCapability,
      inspectRegistration,
    });

    expect(executeShellCommand).not.toHaveBeenCalled();
    expect(assertCapability).not.toHaveBeenCalled();
    expect(inspectRegistration).not.toHaveBeenCalled();
  });
});
