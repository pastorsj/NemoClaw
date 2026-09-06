// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from "node:module";

import type { HarnessMcpAdapterModule } from "@nvidia/nemoclaw-harness-contract";
import { describe, expect, it, vi } from "vitest";

import { assertInstalledMcpCapability } from "../../../../src/lib/actions/sandbox/mcp-bridge/package-probe";

const requireModule = createRequire(import.meta.url);
const hermesMcpAdapter = requireModule("../../host/mcp-adapter.cts") as HarnessMcpAdapterModule;

type ProbeResult = { status: number; stdout: string; stderr: string };

function runHermesProbe(results: ProbeResult[]) {
  const runtimeSelection = {
    gatewayName: "nemoclaw-8091",
    workspace: "default",
  } as const;
  let calls = 0;
  const recoveryActions: number[] = [];
  const probe = hermesMcpAdapter.describeMcpMutationCapability({ sandboxName: "hermes-box" });
  let message = "";
  try {
    assertInstalledMcpCapability("hermes-box", probe, runtimeSelection, {
      executeShellCommand: vi.fn(() => {
        throw new Error("Hermes declares an argv probe");
      }),
      executeArgvCommand: (_sandboxName, command, timeoutSeconds, selectedRuntime) => {
        expect(command).toEqual([
          "/usr/local/lib/nemoclaw/hermes-mcp-config-transaction.py",
          "probe",
        ]);
        expect(timeoutSeconds).toBe(30);
        expect(selectedRuntime).toEqual(runtimeSelection);
        return results[calls++] ?? null;
      },
      recoverAgentGateway: (_sandboxName, timeoutMilliseconds) => {
        recoveryActions.push(timeoutMilliseconds);
        return null;
      },
      sleep: vi.fn(),
    });
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }

  return { calls, recoveryActions, message };
}

const starting: ProbeResult = {
  status: 1,
  stdout: "",
  stderr: "Hermes gateway is not running for managed MCP reload",
};
const ready: ProbeResult = {
  status: 0,
  stdout: '{"ok":true}\n',
  stderr: "",
};
describe("Hermes managed MCP startup probe", () => {
  it("retries only the exact transient gateway-starting result", () => {
    expect(runHermesProbe([starting, ready])).toEqual({
      calls: 2,
      recoveryActions: [],
      message: "",
    });
  });

  it("does not recover when the third exact startup probe is ready", () => {
    expect(runHermesProbe([starting, starting, ready])).toEqual({
      calls: 3,
      recoveryActions: [],
      message: "",
    });
  });

  it("fails closed on the selected target without host-local supervisor recovery", () => {
    const result = runHermesProbe([starting, starting, starting, ready]);

    expect(result.calls).toBe(3);
    expect(result.recoveryActions).toEqual([]);
    expect(result.message).toContain("cannot invoke the managed MCP transaction helper");
  });

  it("fails immediately on trust and topology errors", () => {
    const result = runHermesProbe([
      {
        status: 1,
        stdout: "",
        stderr: "Hermes gateway PID does not identify the trusted launcher",
      },
      ready,
    ]);

    expect(result.calls).toBe(1);
    expect(result.recoveryActions).toEqual([]);
    expect(result.message).toContain("cannot invoke the managed MCP transaction helper");
    expect(result.message).not.toContain("does not identify the trusted launcher");
    expect(result.message).not.toContain("nemoclaw hermes-box recover");
  });

  it("directs an unmanaged but trusted gateway to recovery before mutation", () => {
    const result = runHermesProbe([
      {
        status: 1,
        stdout: "",
        stderr: "Hermes gateway is not running under the managed service lifecycle",
      },
      ready,
    ]);

    expect(result.calls).toBe(1);
    expect(result.recoveryActions).toEqual([]);
    expect(result.message).toContain("cannot invoke the managed MCP transaction helper");
    expect(result.message).not.toContain("managed service lifecycle");
  });

  it("fails clearly when the gateway never becomes ready", () => {
    const result = runHermesProbe([starting, starting, starting]);

    expect(result.calls).toBe(3);
    expect(result.recoveryActions).toEqual([]);
    expect(result.message).toContain("cannot invoke the managed MCP transaction helper");
  });
});
