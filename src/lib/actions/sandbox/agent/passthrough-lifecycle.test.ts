// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { runAgentPassthrough } from "./passthrough";

describe("agent passthrough lifecycle exit", () => {
  it("forwards one deferred exit through readiness and Fabric dispatch", async () => {
    const harnessPackage = {
      kind: "agent-runtime" as const,
      id: "hermes",
      packageVersion: "0.1.0",
      contentDigest: "d".repeat(64),
    };
    const sandbox = { agent: "hermes", harnessPackage };
    const resolveAgent = vi.fn(() => ({
      recordedAgent: "hermes",
      effectiveAgentId: "hermes",
      definition: {
        name: "hermes",
        runtime: {
          kind: "gateway" as const,
          interactive_command: "hermes",
          headless_command: "nemoclaw-fabric run --config /sandbox/.hermes/fabric.json",
          prompt_transport: "stdin" as const,
        },
      },
      harnessPackage,
      harnessPackageMigration: null,
    }));
    const ensureLive = vi.fn(async () => ({
      state: "present",
      phase: "Ready",
      output: "Phase: Ready",
    }));
    const exec = vi.fn(async () => undefined);
    const deferredLifecycleExit = vi.fn((_code: number): never => {
      throw new Error("deferred exit should not run during this successful mock dispatch");
    });

    await runAgentPassthrough(
      "hermes-sandbox",
      { extraArgs: ["Reply with PONG"] },
      {
        getSandbox: () => sandbox as never,
        resolveAgent: resolveAgent as never,
        ensureLive: ensureLive as never,
        exec,
        deferredLifecycleExit,
        process: {
          exit: deferredLifecycleExit,
          stdout: process.stdout,
          stderr: process.stderr,
        },
      },
    );

    expect(ensureLive).toHaveBeenCalledWith("hermes-sandbox", {
      allowNonReadyPhase: true,
      exit: deferredLifecycleExit,
    });
    expect(exec).toHaveBeenCalledWith(
      "hermes-sandbox",
      ["nemoclaw-fabric", "run", "--config", "/sandbox/.hermes/fabric.json", "--stdin"],
      { stdinInput: "Reply with PONG", tty: false },
      { exit: deferredLifecycleExit },
    );
  });
});
