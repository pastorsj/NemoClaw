// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

const buildOpenshellExecArgsMock = vi.hoisted(() =>
  vi.fn(
    (
      _sandboxName: string,
      command: readonly string[],
      _options?: { timeoutSeconds?: number },
      _gatewayName?: string,
    ) => command,
  ),
);

vi.mock("../exec", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../exec")>()),
  buildOpenshellExecArgs: buildOpenshellExecArgsMock,
  wrapExecCommandWithRuntimeEnv: vi.fn((command: readonly string[]) => command),
  wrapOpenClawAgentCommandWithRuntimeEnv: vi.fn((command: readonly string[]) => command),
}));

import { buildOpenshellExecArgs } from "../exec";
import {
  type AgentNonJsonPassthroughDeps,
  type AgentPassthroughDeps,
  runAgentNonJsonPassthrough,
  runStructuredTurnTextPassthrough,
} from "./passthrough";

const FUTURE_STRUCTURED_TURN_DECLARATION = {
  argv: ["future-agent", "run"],
  output_mode: "bounded-text",
  output_interpretation: "structured-turn-envelope",
} as const;

describe("runAgentNonJsonPassthrough", () => {
  function makeNonJsonProcMock() {
    const stdoutWrites: string[] = [];
    const stderrWrites: string[] = [];
    const exit = vi.fn((code: number) => {
      throw new Error(`__exit:${code}`);
    });
    return {
      stdoutWrites,
      stderrWrites,
      exit,
      proc: {
        exit: exit as unknown as (code: number) => never,
        stdout: {
          write: (s: string) => {
            stdoutWrites.push(s);
            return true;
          },
        },
        stderr: {
          write: (s: string) => {
            stderrWrites.push(s);
            return true;
          },
        },
      } as NonNullable<AgentPassthroughDeps["process"]>,
    };
  }

  function makeDispatchMock(
    stdout: string,
    stderr: string,
    status: number | null = 0,
  ): NonNullable<AgentNonJsonPassthroughDeps["runDispatch"]> {
    return vi.fn(async () => ({
      stdout,
      stderr,
      status,
      pid: 1,
      signal: null,
      output: [],
      error: undefined,
    }));
  }

  const stubBinary = () => "/usr/local/bin/openshell";

  it("rejects embedded fallback for a declared envelope without naming a harness", async () => {
    const { proc, stderrWrites } = makeNonJsonProcMock();
    const runDispatchMock = makeDispatchMock("", "transport: embedded", 0);

    await expect(
      runStructuredTurnTextPassthrough(
        FUTURE_STRUCTURED_TURN_DECLARATION,
        "future",
        ["future-agent", "run"],
        proc,
        {
          getOpenshellBinary: stubBinary,
          runDispatch: runDispatchMock,
        },
      ),
    ).rejects.toThrow("__exit:1");

    expect(stderrWrites.join("")).toContain("Agent runtime is running in embedded-fallback mode");
    expect(stderrWrites.join("")).not.toContain("OpenClaw");
  });

  it("fails closed before dispatch without a matching structured-turn declaration", async () => {
    const { proc, stderrWrites } = makeNonJsonProcMock();
    const runDispatchMock = makeDispatchMock("PONG\n", "", 0);

    await expect(
      runStructuredTurnTextPassthrough(
        FUTURE_STRUCTURED_TURN_DECLARATION,
        "future",
        ["another-agent", "run"],
        proc,
        {
          getOpenshellBinary: stubBinary,
          runDispatch: runDispatchMock,
        },
      ),
    ).rejects.toThrow("__exit:2");

    expect(runDispatchMock).not.toHaveBeenCalled();
    expect(stderrWrites.join("")).toContain("not authorized");
  });

  it("does not infer a legacy timeout from declared receipt command bytes", async () => {
    const declaration = {
      argv: ["openclaw", "agent"],
      output_mode: "bounded-text",
      output_interpretation: "structured-turn-envelope",
    } as const;
    const command = ["openclaw", "agent", "--timeout", "30"];
    const { proc } = makeNonJsonProcMock();
    const runDispatchMock = makeDispatchMock("PONG\n", "", 0);

    await expect(
      runStructuredTurnTextPassthrough(declaration, "future", command, proc, {
        getOpenshellBinary: stubBinary,
        runDispatch: runDispatchMock,
      }),
    ).rejects.toThrow("__exit:0");

    expect(buildOpenshellExecArgsMock.mock.calls.at(-1)?.[2]?.timeoutSeconds).toBeUndefined();
  });

  it("bounds the host transport when the turn requests a deadline (#8723)", async () => {
    const { proc } = makeNonJsonProcMock();
    const runDispatchMock = makeDispatchMock("PONG\n", "", 0);
    await expect(
      runAgentNonJsonPassthrough(
        "my-sb",
        ["openclaw", "agent", "--agent", "main", "--timeout", "30", "-m", "ping"],
        proc,
        { getOpenshellBinary: stubBinary, runDispatch: runDispatchMock },
      ),
    ).rejects.toThrow("__exit:0");
    // Outlasts the requested deadline so the in-sandbox turn still reports its
    // own timeout; the host bound only catches a turn that stops answering.
    expect(buildOpenshellExecArgsMock.mock.calls[0]?.[2]?.timeoutSeconds).toBe(60);
    // The turn still receives the deadline it asked for.
    expect(buildOpenshellExecArgsMock.mock.calls[0]?.[1]).toContain("30");
  });

  it("leaves the host transport unbounded when the turn requests no deadline (#8723)", async () => {
    const { proc } = makeNonJsonProcMock();
    const runDispatchMock = makeDispatchMock("PONG\n", "", 0);
    await expect(
      runAgentNonJsonPassthrough(
        "my-sb",
        ["openclaw", "agent", "--agent", "main", "-m", "ping"],
        proc,
        {
          getOpenshellBinary: stubBinary,
          runDispatch: runDispatchMock,
        },
      ),
    ).rejects.toThrow("__exit:0");
    expect(buildOpenshellExecArgsMock.mock.calls[0]?.[2]?.timeoutSeconds).toBeUndefined();
  });

  it("emits a clean embedded-fallback error and exits 1 when EMBEDDED FALLBACK appears in stdout", async () => {
    const { stderrWrites, stdoutWrites, exit, proc } = makeNonJsonProcMock();
    const runDispatchMock = makeDispatchMock("EMBEDDED FALLBACK: using local model\nPONG\n", "", 0);
    await expect(
      runAgentNonJsonPassthrough("my-sb", ["openclaw", "agent", "--agent", "main"], proc, {
        getOpenshellBinary: stubBinary,
        runDispatch: runDispatchMock,
      }),
    ).rejects.toThrow("__exit:1");
    expect(exit).toHaveBeenCalledWith(1);
    const errText = stderrWrites.join("");
    expect(errText).toMatch(/embedded-fallback mode in sandbox 'my-sb'/);
    expect(errText).toMatch(/my-sb recover/);
    expect(errText).toMatch(/my-sb rebuild --yes/);
    expect(errText).toMatch(/onboard --resume/);
    expect(stdoutWrites.join("")).toBe("");
  });

  it("emits a clean embedded-fallback error and exits 1 when [agent/embedded] appears in stderr", async () => {
    const { stderrWrites, exit, proc } = makeNonJsonProcMock();
    const runDispatchMock = makeDispatchMock(
      "",
      "[agent/embedded] transport active\nsome response\n",
      0,
    );
    await expect(
      runAgentNonJsonPassthrough("my-sb", ["openclaw", "agent", "--agent", "main"], proc, {
        getOpenshellBinary: stubBinary,
        runDispatch: runDispatchMock,
      }),
    ).rejects.toThrow("__exit:1");
    expect(exit).toHaveBeenCalledWith(1);
    expect(stderrWrites.join("")).toMatch(/embedded-fallback mode/);
  });

  it("passes through clean stdout and exits with the real exit code when no embedded-fallback pattern is found", async () => {
    const { stdoutWrites, stderrWrites, exit, proc } = makeNonJsonProcMock();
    const runDispatchMock = makeDispatchMock("PONG\n", "", 0);
    await expect(
      runAgentNonJsonPassthrough(
        "my-sb",
        ["openclaw", "agent", "--agent", "main", "-m", "ping"],
        proc,
        {
          getOpenshellBinary: stubBinary,
          runDispatch: runDispatchMock,
        },
      ),
    ).rejects.toThrow("__exit:0");
    expect(exit).toHaveBeenCalledWith(0);
    expect(stdoutWrites.join("")).toBe("PONG\n");
    expect(stderrWrites.join("")).toBe("");
  });

  it("fails loud instead of reporting success when the turn's deadline fired (#8723)", async () => {
    const { stdoutWrites, stderrWrites, exit, proc } = makeNonJsonProcMock();
    const timedOut =
      "LLM request failed.\nRequest timed out before a response was generated. Please try again, or increase `agents.defaults.timeoutSeconds` in your config.\n";
    const runDispatchMock = makeDispatchMock(timedOut, "", 0);
    await expect(
      runAgentNonJsonPassthrough("my-sb", ["openclaw", "agent", "-m", "ping"], proc, {
        getOpenshellBinary: stubBinary,
        runDispatch: runDispatchMock,
      }),
    ).rejects.toThrow("__exit:1");
    expect(exit).toHaveBeenCalledWith(1);
    // The partial trace still reaches the caller ahead of the verdict.
    expect(stdoutWrites.join("")).toBe(timedOut);
    const errText = stderrWrites.join("");
    expect(errText).toMatch(/timed out before producing a result/);
    expect(errText).toContain("nemoclaw 'my-sb' sessions export <key>");
    expect(errText).toContain("models.providers.<id>.timeoutSeconds");
    expect(errText).toMatch(/may have already applied side effects/);
  });

  it("keeps a completed reply that quotes the timeout sentence successful (#8723)", async () => {
    const { stdoutWrites, stderrWrites, exit, proc } = makeNonJsonProcMock();
    const reply =
      'The message "Request timed out before a response was generated" means the deadline fired.\n';
    const runDispatchMock = makeDispatchMock(reply, "", 0);

    await expect(
      runAgentNonJsonPassthrough("my-sb", ["openclaw", "agent", "-m", "explain"], proc, {
        getOpenshellBinary: stubBinary,
        runDispatch: runDispatchMock,
      }),
    ).rejects.toThrow("__exit:0");

    expect(exit).toHaveBeenCalledWith(0);
    expect(stdoutWrites.join("")).toBe(reply);
    expect(stderrWrites.join("")).toBe("");
  });

  it("keeps an upstream non-zero code for a turn that also reported a timeout (#8723)", async () => {
    const { exit, proc } = makeNonJsonProcMock();
    const runDispatchMock = makeDispatchMock(
      "Request timed out before a response was generated.\n",
      "",
      3,
    );
    await expect(
      runAgentNonJsonPassthrough("my-sb", ["openclaw", "agent", "-m", "ping"], proc, {
        getOpenshellBinary: stubBinary,
        runDispatch: runDispatchMock,
      }),
    ).rejects.toThrow("__exit:3");
    expect(exit).toHaveBeenCalledWith(3);
  });

  it("passes through non-zero exit code on clean failure without embedded-fallback", async () => {
    const { stderrWrites, exit, proc } = makeNonJsonProcMock();
    const runDispatchMock = makeDispatchMock("", "Error: agent session not found\n", 1);
    await expect(
      runAgentNonJsonPassthrough("my-sb", ["openclaw", "agent", "--agent", "main"], proc, {
        getOpenshellBinary: stubBinary,
        runDispatch: runDispatchMock,
      }),
    ).rejects.toThrow("__exit:1");
    expect(exit).toHaveBeenCalledWith(1);
    expect(stderrWrites.join("")).toContain("Error: agent session not found");
  });

  it("returns exit 143 after the supervised OpenShell child receives SIGTERM (#8723)", async () => {
    const { stderrWrites, exit, proc } = makeNonJsonProcMock();
    const runDispatchMock = vi.fn(async () => ({
      status: null,
      signal: "SIGTERM" as const,
      stdout: "",
      stderr: "agent turn interrupted\n",
    }));

    await expect(
      runAgentNonJsonPassthrough("my-sb", ["openclaw", "agent", "--agent", "main"], proc, {
        getOpenshellBinary: stubBinary,
        runDispatch: runDispatchMock,
      }),
    ).rejects.toThrow("__exit:143");

    expect(exit).toHaveBeenCalledWith(143);
    expect(stderrWrites.join("")).toContain("agent turn interrupted");
  });

  it("fails loud instead of reporting success when the dispatch delivers nothing", async () => {
    const { stdoutWrites, stderrWrites, exit, proc } = makeNonJsonProcMock();
    const runDispatchMock = makeDispatchMock("", "", 0);
    await expect(
      runAgentNonJsonPassthrough(
        "my-sb",
        ["openclaw", "agent", "--session-key", "agent:main:main", "-m", "ping"],
        proc,
        {
          getGatewayName: () => null,
          getOpenshellBinary: stubBinary,
          runDispatch: runDispatchMock,
          stdinIsTty: () => false,
        },
      ),
    ).rejects.toThrow("__exit:1");
    expect(exit).toHaveBeenCalledWith(1);
    expect(stdoutWrites).toEqual([]);
    expect(stderrWrites.join("")).toContain("without producing any output");
  });

  it("keeps a stderr-only turn a success so quiet turns do not misfire", async () => {
    const { exit, proc } = makeNonJsonProcMock();
    const runDispatchMock = makeDispatchMock("", "openclaw warning\n", 0);
    await expect(
      runAgentNonJsonPassthrough("my-sb", ["openclaw", "agent", "--agent", "main"], proc, {
        getGatewayName: () => null,
        getOpenshellBinary: stubBinary,
        runDispatch: runDispatchMock,
        stdinIsTty: () => false,
      }),
    ).rejects.toThrow("__exit:0");
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("pins the sandbox's owning gateway when building the dispatch argv", async () => {
    const { proc } = makeNonJsonProcMock();
    const runDispatchMock = makeDispatchMock("PONG\n", "", 0);
    await expect(
      runAgentNonJsonPassthrough("my-sb", ["openclaw", "agent", "--agent", "main"], proc, {
        getGatewayName: () => "nemoclaw-8081",
        getOpenshellBinary: stubBinary,
        runDispatch: runDispatchMock,
        stdinIsTty: () => false,
      }),
    ).rejects.toThrow("__exit:0");
    expect(buildOpenshellExecArgs).toHaveBeenCalledWith(
      "my-sb",
      expect.anything(),
      { tty: false },
      "nemoclaw-8081",
    );
  });

  it("withholds an interactive terminal from the non-interactive dispatch", async () => {
    const { proc } = makeNonJsonProcMock();
    const runDispatchMock = makeDispatchMock("PONG\n", "", 0);
    await expect(
      runAgentNonJsonPassthrough("my-sb", ["openclaw", "agent", "--agent", "main"], proc, {
        getGatewayName: () => null,
        getOpenshellBinary: stubBinary,
        runDispatch: runDispatchMock,
        stdinIsTty: () => true,
      }),
    ).rejects.toThrow("__exit:0");
    expect(vi.mocked(runDispatchMock).mock.calls[0]?.[2]).toEqual({ stdinIsTty: true });
  });
});
