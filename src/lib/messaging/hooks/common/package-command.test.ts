// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { createPackageCommandHook } from "./package-command";

describe("common package messaging command hook", () => {
  it("executes fixed argv and accepts the bounded bridge protocol", async () => {
    const commands: string[] = [];
    const lines: string[] = [];
    const hook = createPackageCommandHook({
      executeSandboxCommand(sandbox, command) {
        expect(sandbox).toBe("demo");
        commands.push(command);
        return {
          status: 0,
          stdout: JSON.stringify({
            schemaVersion: 1,
            type: "messaging-bridge-health",
            channel: "future-channel",
            lines: ["bridge ready"],
          }),
        };
      },
      log: (line) => lines.push(line),
    });

    await hook({
      channelId: "future-channel",
      hookId: "future-bridge",
      phase: "health-check",
      inputs: { currentSandbox: "demo" },
      packageOperation: {
        hookId: "future-bridge",
        kind: "sandbox-command",
        command: { argv: ["futurectl", "bridge", "status"] },
        output: "bridge-health",
      },
    });

    expect(commands).toEqual(["'futurectl' 'bridge' 'status'"]);
    expect(lines).toEqual(["bridge ready"]);
  });

  it("passes only bounded generic status facts and returns a validated report", async () => {
    let command = "";
    const report = {
      schemaVersion: 1,
      channel: "future-channel",
      agent: "future-harness",
      verdict: "healthy",
      probedAt: "2026-09-06T00:00:00.000Z",
      signals: [],
      hints: [],
      readiness: {
        state: "ready",
        category: null,
        reason: "operational",
        retryable: false,
        lastTransitionAt: null,
      },
    };
    const hook = createPackageCommandHook({
      executeSandboxCommand(_sandbox, value) {
        command = value;
        return {
          status: 0,
          stdout: JSON.stringify({ type: "messaging-channel-health", report }),
        };
      },
    });

    const result = await hook({
      channelId: "future-channel",
      hookId: "future-status",
      phase: "status",
      inputs: {
        currentSandbox: "demo",
        agent: "future-harness",
        probedAt: "2026-09-06T00:00:00.000Z",
        channelEnabledInRegistry: true,
        presetApplied: true,
        presetOnGateway: true,
        ignoredSecret: "must-not-cross",
      },
      packageOperation: {
        hookId: "future-status",
        kind: "sandbox-command",
        command: { argv: ["futurectl", "status"] },
        output: "channel-health",
        context: "channel-health",
      },
    });

    expect(command).toContain("--nemoclaw-context");
    expect(command).not.toContain("must-not-cross");
    expect(result.outputs?.channelHealth.value).toEqual({
      type: "messaging-channel-health",
      report,
    });
  });

  it("rejects a package report for another channel", async () => {
    const hook = createPackageCommandHook({
      executeSandboxCommand: () => ({
        status: 0,
        stdout: JSON.stringify({
          type: "messaging-channel-health",
          report: {
            schemaVersion: 1,
            channel: "wrong-channel",
            agent: "future-harness",
            verdict: "healthy",
            probedAt: "now",
            signals: [],
            hints: [],
          },
        }),
      }),
    });

    expect(() =>
      hook({
        channelId: "future-channel",
        hookId: "future-status",
        phase: "status",
        inputs: { currentSandbox: "demo" },
        packageOperation: {
          hookId: "future-status",
          kind: "sandbox-command",
          command: { argv: ["futurectl", "status"] },
          output: "channel-health",
          context: "channel-health",
        },
      }),
    ).toThrow("invalid result");
  });
});
