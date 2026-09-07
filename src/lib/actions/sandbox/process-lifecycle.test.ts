// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type { AgentDefinition } from "../../agent/defs";
import {
  buildSandboxProcessLifecyclePlan,
  executeSandboxProcessLifecycle,
  PROCESS_LIFECYCLE_MAX_OUTPUT_BYTES,
  type SandboxProcessLifecycleAction,
  type SandboxProcessLifecycleExecutorDeps,
} from "./process-lifecycle";

const NONCE = "a".repeat(64);
const RECEIPT = {
  kind: "agent-runtime" as const,
  id: "future-gateway",
  packageVersion: "3.4.5",
  contentDigest: "b".repeat(64),
};

function futureGateway(
  processLifecycle: NonNullable<AgentDefinition["runtime"]>["process_lifecycle"],
): AgentDefinition {
  return {
    name: RECEIPT.id,
    runtime: { kind: "gateway", process_lifecycle: processLifecycle },
  } as AgentDefinition;
}

function executorDeps(agent: AgentDefinition | null) {
  const executeCommand = vi.fn(() => ({
    status: 0,
    signal: null,
    stdout: Buffer.from("GATEWAY_PID=42\n"),
    stderr: Buffer.alloc(0),
  }));
  const getSessionAgent = vi.fn(() => agent);
  const deps = {
    getSandbox: () => ({ agent: RECEIPT.id, harnessPackage: RECEIPT }),
    getSessionAgent,
    createNonce: () => NONCE,
    resolveTarget: () => ({ providerId: "docker", resourceHandle: "container-42" }),
    executeCommand,
    withExecutionLease: (_sandboxName, _operation, operation) => operation(),
  } satisfies SandboxProcessLifecycleExecutorDeps;
  return { deps, executeCommand, getSessionAgent };
}

describe("sandbox process lifecycle plans", () => {
  it.each(["probe", "restart", "recover"] as const)(
    "executes a synthetic receipt-backed package's %s command under core authority",
    (action) => {
      const agent = futureGateway({
        support: "managed",
        command: ["/usr/local/bin/future-process-control", "--structured"],
      });
      const { deps, executeCommand } = executorDeps(agent);

      const execution = executeSandboxProcessLifecycle("future-box", action, {
        timeout: 12_345,
        deps,
      });

      expect(execution).toMatchObject({
        kind: "completed",
        authority: "package",
        nonce: NONCE,
        targetResourceHandle: "container-42",
      });
      expect(executeCommand).toHaveBeenCalledWith(
        "future-box",
        ["/usr/local/bin/future-process-control", "--structured", action, NONCE],
        {
          sanitizeEnvironment: true,
          expectedResourceHandle: "container-42",
          timeout: 12_345,
          maxOutputBytes: PROCESS_LIFECYCLE_MAX_OUTPUT_BYTES,
        },
      );
      expect(executeCommand.mock.calls.flat().join(" ")).not.toContain(
        "/usr/local/bin/nemoclaw-gateway-control",
      );
    },
  );

  it("returns a typed unsupported result without privileged execution", () => {
    const { deps, executeCommand } = executorDeps(
      futureGateway({ support: "unsupported", reason: "uses an external process manager" }),
    );

    expect(
      executeSandboxProcessLifecycle("future-box", "restart", { timeout: 1000, deps }),
    ).toEqual({ kind: "unsupported", reason: "uses an external process manager" });
    expect(executeCommand).not.toHaveBeenCalled();
  });

  it("fails closed when the receipt's exact package declaration cannot be loaded", () => {
    const { deps, executeCommand } = executorDeps(null);

    expect(executeSandboxProcessLifecycle("future-box", "probe", { timeout: 1000, deps })).toEqual({
      kind: "unsupported",
      reason: "the exact package process lifecycle declaration is unavailable",
    });
    expect(executeCommand).not.toHaveBeenCalled();
  });

  it("fails closed before privileged execution for a mutable package controller", () => {
    const { deps, executeCommand } = executorDeps(
      futureGateway({ support: "managed", command: ["/sandbox/process-control"] }),
    );

    expect(
      executeSandboxProcessLifecycle("future-box", "restart", { timeout: 1000, deps }),
    ).toEqual({
      kind: "unsupported",
      reason: "the package process lifecycle command is not stored in the immutable image",
    });
    expect(executeCommand).not.toHaveBeenCalled();
  });

  it("retains the fixed controller only for an explicit no-receipt legacy sandbox", () => {
    const action: SandboxProcessLifecycleAction = "recover";
    expect(
      buildSandboxProcessLifecyclePlan(
        { agent: "openclaw", harnessPackage: null },
        null,
        action,
        NONCE,
      ),
    ).toEqual({
      kind: "command",
      authority: "legacy",
      command: ["/usr/local/bin/nemoclaw-gateway-control", action, NONCE],
    });
  });
});
