// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { HarnessMcpCapabilityProbe } from "../../../agent-runtime/host-module";
import { assertInstalledMcpCapability } from "./package-probe";

const dependencies = {
  executeShellCommand: vi.fn(),
  executeArgvCommand: vi.fn(),
  recoverAgentGateway: vi.fn(),
  sleep: vi.fn(),
};

const managedRecoveryCompleted = {
  status: 0,
  stdout: `v1 ${"a".repeat(64)} complete ok 0 42\nGATEWAY_PID=42`,
  stderr: "",
};
const runtimeSelection = { gatewayName: "nemoclaw-8091", workspace: "default" } as const;

function commandProbe(
  overrides: Partial<Extract<HarnessMcpCapabilityProbe, { kind: "command" }>> = {},
): Extract<HarnessMcpCapabilityProbe, { kind: "command" }> {
  return {
    kind: "command",
    command: "future-probe",
    success: { kind: "exit-zero" },
    timeoutSeconds: 30,
    failureMessage: "Future runtime capability is unavailable.",
    ...overrides,
  };
}

beforeEach(() => {
  dependencies.executeShellCommand.mockReset();
  dependencies.executeArgvCommand.mockReset();
  dependencies.recoverAgentGateway.mockReset().mockReturnValue(managedRecoveryCompleted);
  dependencies.sleep.mockReset();
});

describe("installed MCP capability probe", () => {
  it("accepts a capability that requires no runtime probe", () => {
    expect(() =>
      assertInstalledMcpCapability(
        "alpha",
        { kind: "not-required" },
        runtimeSelection,
        dependencies,
      ),
    ).not.toThrow();
    expect(dependencies.executeShellCommand).not.toHaveBeenCalled();
  });

  it("runs a shell command and accepts the declared success rule", () => {
    dependencies.executeShellCommand.mockReturnValue({ status: 0, stdout: "ready\n", stderr: "" });

    assertInstalledMcpCapability(
      "alpha",
      commandProbe({ success: { kind: "stdout-trimmed-equals", value: "ready" } }),
      runtimeSelection,
      dependencies,
    );

    expect(dependencies.executeShellCommand).toHaveBeenCalledWith(
      "alpha",
      "future-probe",
      30,
      runtimeSelection,
    );
  });

  it("runs an argv command without converting it to shell source", () => {
    dependencies.executeArgvCommand.mockReturnValue({
      status: 0,
      stdout: 'framing\n{"ok":true}\n',
      stderr: "",
    });

    assertInstalledMcpCapability(
      "alpha",
      commandProbe({
        command: ["future-probe", "--json"],
        success: { kind: "last-json-line-ok" },
      }),
      runtimeSelection,
      dependencies,
    );

    expect(dependencies.executeArgvCommand).toHaveBeenCalledWith(
      "alpha",
      ["future-probe", "--json"],
      30,
      runtimeSelection,
    );
  });

  it("recovers the agent gateway only after the declared retry result", () => {
    dependencies.executeArgvCommand
      .mockReturnValueOnce({ status: 1, stdout: "", stderr: "gateway pending" })
      .mockReturnValueOnce({ status: 1, stdout: "", stderr: "gateway pending" })
      .mockReturnValueOnce({ status: 0, stdout: '{"ok":true}', stderr: "" });

    assertInstalledMcpCapability(
      "alpha",
      commandProbe({
        command: ["future-probe"],
        success: { kind: "last-json-line-ok" },
        retry: {
          outputExact: "gateway pending",
          initialAttempts: 2,
          intervalMilliseconds: 5,
          recovery: {
            kind: "agent-gateway",
            timeoutSeconds: 15,
            postRecoveryAttempts: 3,
          },
        },
      }),
      runtimeSelection,
      dependencies,
    );

    expect(dependencies.sleep).toHaveBeenCalledTimes(1);
    expect(dependencies.recoverAgentGateway).toHaveBeenCalledWith(
      "alpha",
      15_000,
      runtimeSelection,
    );
    expect(dependencies.executeArgvCommand).toHaveBeenCalledTimes(3);
  });

  it("fails without recovery when output does not match the retry rule", () => {
    dependencies.executeShellCommand.mockReturnValue({
      status: 1,
      stdout: "",
      stderr: "integrity failure",
    });

    expect(() =>
      assertInstalledMcpCapability(
        "alpha",
        commandProbe({
          retry: {
            outputExact: "gateway pending",
            initialAttempts: 3,
            intervalMilliseconds: 5,
          },
        }),
        runtimeSelection,
        dependencies,
      ),
    ).toThrow("Future runtime capability is unavailable.");
    expect(dependencies.sleep).not.toHaveBeenCalled();
    expect(dependencies.recoverAgentGateway).not.toHaveBeenCalled();
  });

  it("rejects a recovery command that claims completion without the managed protocol", () => {
    dependencies.executeShellCommand.mockReturnValue({
      status: 1,
      stdout: "",
      stderr: "gateway pending",
    });
    dependencies.recoverAgentGateway.mockReturnValue({
      status: 0,
      stdout: "recovered",
      stderr: "",
    });

    expect(() =>
      assertInstalledMcpCapability(
        "alpha",
        commandProbe({
          retry: {
            outputExact: "gateway pending",
            initialAttempts: 1,
            intervalMilliseconds: 5,
            recovery: {
              kind: "agent-gateway",
              timeoutSeconds: 15,
              postRecoveryAttempts: 2,
            },
          },
        }),
        runtimeSelection,
        dependencies,
      ),
    ).toThrow("Managed gateway recovery failed: recovered");
    expect(dependencies.executeShellCommand).toHaveBeenCalledTimes(1);
  });

  it("rejects a terminal gateway integrity refusal before retrying the package probe", () => {
    dependencies.executeShellCommand.mockReturnValue({
      status: 1,
      stdout: "",
      stderr: "gateway pending",
    });
    dependencies.recoverAgentGateway.mockReturnValue({
      status: 1,
      stdout: "",
      stderr: "HERMES_CONFIG_HASH_MISMATCH",
    });

    expect(() =>
      assertInstalledMcpCapability(
        "alpha",
        commandProbe({
          retry: {
            outputExact: "gateway pending",
            initialAttempts: 1,
            intervalMilliseconds: 5,
            recovery: {
              kind: "agent-gateway",
              timeoutSeconds: 15,
              postRecoveryAttempts: 2,
            },
          },
        }),
        runtimeSelection,
        dependencies,
      ),
    ).toThrow("HERMES_CONFIG_HASH_MISMATCH");
    expect(dependencies.executeShellCommand).toHaveBeenCalledTimes(1);
  });
});
