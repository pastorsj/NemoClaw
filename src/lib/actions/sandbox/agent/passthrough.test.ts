// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { resolveLifecycleEligibleSandboxAgent } from "../../../onboard/package/package-authority";

type ResolvedSandboxAgent = ReturnType<typeof resolveLifecycleEligibleSandboxAgent>;

const execMock = vi.hoisted(() => vi.fn(async () => {}));
const ensureLiveMock = vi.hoisted(() =>
  vi.fn(
    async () =>
      ({ state: "present", phase: "Ready", output: "Phase: Ready" }) as {
        state: string;
        phase: string | null;
        output: string;
      },
  ),
);
const getSandboxMock = vi.hoisted(() =>
  vi.fn(
    () =>
      null as {
        agent?: string | null;
        hermesApiPort?: number | null;
        provider?: string | null;
        model?: string | null;
        endpointUrl?: string | null;
      } | null,
  ),
);
const loadAgentMock = vi.hoisted(() =>
  vi.fn(
    (
      name: string,
    ): {
      name: string;
      runtime?: {
        kind: string;
        interactive_command?: string;
        headless_command?: string;
        prompt_transport?: "argv" | "stdin";
      };
    } => ({
      name,
      runtime:
        name === "langchain-deepagents-code"
          ? {
              kind: "terminal",
              interactive_command: "dcode",
              headless_command: "nemoclaw-fabric run",
              prompt_transport: "stdin",
            }
          : undefined,
    }),
  ),
);
const resolveLifecycleEligibleSandboxAgentMock = vi.hoisted(() =>
  vi.fn((entry: { agent?: string | null }): ResolvedSandboxAgent => {
    const effectiveAgentId = entry.agent ?? "openclaw";
    return {
      recordedAgent: entry.agent ?? null,
      effectiveAgentId,
      definition: loadAgentMock(effectiveAgentId) as ResolvedSandboxAgent["definition"],
      harnessPackage: null,
      harnessPackageMigration: null,
    };
  }),
);
const isTerminalAgentMock = vi.hoisted(() =>
  vi.fn((agent: { runtime?: { kind?: string } }) => agent.runtime?.kind === "terminal"),
);
const buildOpenshellExecArgsMock = vi.hoisted(() =>
  vi.fn(
    (
      _sb: string,
      cmd: readonly string[],
      _options?: { timeoutSeconds?: number },
      _gateway?: string,
    ) => cmd,
  ),
);

vi.mock("../exec", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../exec")>()),
  execSandbox: execMock,
  buildOpenshellExecArgs: buildOpenshellExecArgsMock,
  wrapExecCommandWithRuntimeEnv: vi.fn((cmd: readonly string[]) => cmd),
  wrapOpenClawAgentCommandWithRuntimeEnv: vi.fn((cmd: readonly string[]) => cmd),
}));
vi.mock("../gateway-state", () => ({ ensureLiveSandboxOrExit: ensureLiveMock }));
vi.mock("../../../state/registry", () => ({ getSandbox: getSandboxMock }));
vi.mock("../../../agent/defs", () => ({
  isTerminalAgent: isTerminalAgentMock,
  loadAgent: loadAgentMock,
}));
vi.mock("../../../onboard/package/package-authority", () => ({
  resolveLifecycleEligibleSandboxAgent: resolveLifecycleEligibleSandboxAgentMock,
}));
vi.mock("../../../../../packages/nemoclaw-openclaw/plugin/src/onboard/config.js", () => ({
  loadOnboardConfig: vi.fn(() => null),
  describeOnboardEndpoint: vi.fn(() => "build.nvidia.com"),
  describeOnboardProvider: vi.fn(() => "NVIDIA Endpoint API"),
}));

import registerPlugin, {
  type OpenClawPluginApi,
} from "../../../../../packages/nemoclaw-openclaw/plugin/src/index";
import { buildOpenshellExecArgs } from "../exec";
import {
  type AgentNonJsonPassthroughDeps,
  type AgentPassthroughDeps,
  runAgentNonJsonPassthrough,
  runAgentPassthrough,
} from "./passthrough";

const OPENCLAW_AGENT_COMMAND = {
  argv: ["receipt-openclaw", "agent"],
  output_mode: "bounded-text",
  selector_options: ["--agent", "--session-id", "--session-key", "--to"],
  selector_required: true,
  value_options: [
    "-a",
    "-m",
    "--message",
    "--model",
    "--provider",
    "--reply-channel",
    "--thinking",
    "--timeout",
  ],
  boolean_options: ["--deliver"],
  json_output_option: "--json",
  timeout_option: "--timeout",
} as const;

function createPluginApi(): OpenClawPluginApi {
  return {
    id: "nemoclaw",
    name: "NemoClaw",
    version: "0.1.0",
    config: {},
    pluginConfig: {},
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    registerCommand: vi.fn(),
    registerProvider: vi.fn(),
    registerService: vi.fn(),
    resolvePath: vi.fn((value: string) => value),
    on: vi.fn(),
  };
}

describe("runAgentPassthrough", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function makeProcMock() {
    const writes: string[] = [];
    const exit = vi.fn((code: number) => {
      throw new Error(`__exit:${code}`);
    });
    return {
      writes,
      exit,
      proc: {
        exit: exit as unknown as (code: number) => never,
        stderr: { write: (s: string) => writes.push(s) },
      },
    };
  }

  it("rejects Hermes sandboxes with a redirect to the OpenAI-compatible API", async () => {
    getSandboxMock.mockReturnValueOnce({ agent: "hermes" });
    const { writes, exit, proc } = makeProcMock();
    await expect(
      runAgentPassthrough("alpha", { extraArgs: ["-m", "hi"] }, { process: proc }),
    ).rejects.toThrow("__exit:2");
    expect(execMock).not.toHaveBeenCalled();
    expect(ensureLiveMock).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(2);
    expect(writes.join("")).toMatch(/cannot dispatch to sandbox 'alpha' because it runs 'hermes'/);
    expect(writes.join("")).toMatch(/port 8642/);
  });

  it("redirects to the sandbox's own API port rather than the default (#8543)", async () => {
    getSandboxMock.mockReturnValue({ agent: "hermes", hermesApiPort: 8643 });
    const { writes, proc } = makeProcMock();
    await expect(
      runAgentPassthrough("beta", { extraArgs: ["-m", "hi"] }, { process: proc }),
    ).rejects.toThrow("__exit:2");
    const stderr = writes.join("");
    expect(stderr).toMatch(/port 8643/);
    expect(stderr).toMatch(/openshell forward start --background 8643 beta/);
    expect(stderr).toMatch(/http:\/\/127\.0\.0\.1:8643\/v1\/chat\/completions/);
    expect(stderr).not.toMatch(/8642/);
  });

  it("dispatches a plain prompt through a receipt-pinned Hermes headless command", async () => {
    const harnessPackage = {
      kind: "agent-runtime" as const,
      id: "hermes",
      packageVersion: "0.1.0",
      contentDigest: "d".repeat(64),
    };
    const entry = { agent: "hermes", harnessPackage };
    getSandboxMock.mockReturnValueOnce(entry as never);
    resolveLifecycleEligibleSandboxAgentMock.mockReturnValueOnce({
      recordedAgent: "hermes",
      effectiveAgentId: "hermes",
      definition: {
        name: "hermes",
        runtime: {
          kind: "gateway",
          interactive_command: "hermes",
          headless_command: "nemoclaw-fabric run --config /sandbox/.hermes/fabric.json",
          prompt_transport: "stdin",
          headless_environment: {
            HERMES_MANAGED_INFERENCE_ROUTE: "nemoclaw-managed-inference",
          },
        },
      } as unknown as ResolvedSandboxAgent["definition"],
      harnessPackage,
      harnessPackageMigration: null,
    });

    await runAgentPassthrough("hermes-sandbox", { extraArgs: ["Reply with PONG"] });

    expect(resolveLifecycleEligibleSandboxAgentMock).toHaveBeenCalledWith(entry);
    expect(loadAgentMock).not.toHaveBeenCalled();
    expect(execMock).toHaveBeenCalledWith(
      "hermes-sandbox",
      ["nemoclaw-fabric", "run", "--config", "/sandbox/.hermes/fabric.json", "--stdin"],
      {
        environment: { HERMES_MANAGED_INFERENCE_ROUTE: "nemoclaw-managed-inference" },
        stdinInput: "Reply with PONG",
        tty: false,
      },
    );
  });

  it("rejects a receipt-pinned gateway package without a headless command", async () => {
    const harnessPackage = {
      kind: "agent-runtime" as const,
      id: "hermes",
      packageVersion: "0.1.0",
      contentDigest: "e".repeat(64),
    };
    const entry = { agent: "hermes", harnessPackage };
    getSandboxMock.mockReturnValueOnce(entry as never);
    resolveLifecycleEligibleSandboxAgentMock.mockReturnValueOnce({
      recordedAgent: "hermes",
      effectiveAgentId: "hermes",
      definition: {
        name: "hermes",
        runtime: { kind: "gateway", interactive_command: "hermes" },
      } as unknown as ResolvedSandboxAgent["definition"],
      harnessPackage,
      harnessPackageMigration: null,
    });
    const { writes, exit, proc } = makeProcMock();

    await expect(
      runAgentPassthrough("hermes-sandbox", { extraArgs: ["Reply with PONG"] }, { process: proc }),
    ).rejects.toThrow("__exit:2");

    expect(ensureLiveMock).not.toHaveBeenCalled();
    expect(execMock).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(2);
    expect(writes.join("")).toContain("because it runs 'hermes'");
  });

  it("dispatches NemoCUA through the ordinary terminal-agent headless command (#9649)", async () => {
    const entry = { name: "alpha", agent: "nemocua" };
    getSandboxMock.mockReturnValueOnce(entry as never);
    loadAgentMock.mockReturnValueOnce({
      name: "nemocua",
      runtime: {
        kind: "terminal",
        interactive_command: "/bin/bash",
        headless_command: "python3 /app/run_with_harness.py",
      },
    });
    await runAgentPassthrough("alpha", { extraArgs: ["start", "--task-id", "demo"] });
    expect(execMock).toHaveBeenCalledWith(
      "alpha",
      ["python3", "/app/run_with_harness.py", "start", "--task-id", "demo"],
      { tty: false },
    );
  });

  it("dispatches Pi through the receipt-pinned command instead of the active definition", async () => {
    const harnessPackage = {
      kind: "agent-runtime" as const,
      id: "pi",
      packageVersion: "0.1.0",
      contentDigest: "a".repeat(64),
    };
    const entry = { agent: "pi", harnessPackage };
    getSandboxMock.mockReturnValueOnce(entry as never);
    resolveLifecycleEligibleSandboxAgentMock.mockReturnValueOnce({
      recordedAgent: "pi",
      effectiveAgentId: "pi",
      definition: {
        name: "pi",
        runtime: {
          kind: "terminal",
          interactive_command: "pi",
          headless_command: "receipt-pinned-pi --print",
        },
      } as unknown as ResolvedSandboxAgent["definition"],
      harnessPackage,
      harnessPackageMigration: null,
    });

    await runAgentPassthrough("pi-sandbox", { extraArgs: ["Reply with PONG"] });

    expect(resolveLifecycleEligibleSandboxAgentMock).toHaveBeenCalledWith(entry);
    expect(loadAgentMock).not.toHaveBeenCalled();
    expect(execMock).toHaveBeenCalledWith(
      "pi-sandbox",
      ["receipt-pinned-pi", "--print", "Reply with PONG"],
      { tty: false },
    );
  });

  it.each([
    ["missing", "the retained package object is missing"],
    ["tampered", "the retained package object digest does not match its receipt"],
  ])("fails closed when the receipt-pinned Pi package is %s", async (_state, message) => {
    const entry = {
      agent: "pi",
      harnessPackage: {
        kind: "agent-runtime" as const,
        id: "pi",
        packageVersion: "0.1.0",
        contentDigest: "b".repeat(64),
      },
    };
    getSandboxMock.mockReturnValueOnce(entry as never);
    resolveLifecycleEligibleSandboxAgentMock.mockImplementationOnce(() => {
      throw new Error(`Sandbox agent authority is invalid: ${message}`);
    });
    const { writes, exit, proc } = makeProcMock();

    await expect(
      runAgentPassthrough("pi-sandbox", { extraArgs: ["Reply with PONG"] }, { process: proc }),
    ).rejects.toThrow("__exit:2");

    expect(resolveLifecycleEligibleSandboxAgentMock).toHaveBeenCalledWith(entry);
    expect(ensureLiveMock).not.toHaveBeenCalled();
    expect(execMock).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(2);
    expect(writes.join("")).toContain(message);
  });

  it("fails closed when Pi qualification is no longer enabled", async () => {
    const entry = {
      agent: "pi",
      harnessPackage: {
        kind: "agent-runtime" as const,
        id: "pi",
        packageVersion: "0.1.0",
        contentDigest: "c".repeat(64),
      },
    };
    getSandboxMock.mockReturnValueOnce(entry as never);
    resolveLifecycleEligibleSandboxAgentMock.mockImplementationOnce(() => {
      throw new Error("Candidate agent 'pi' has not been qualified for this NemoClaw build");
    });
    const { writes, proc } = makeProcMock();

    await expect(
      runAgentPassthrough("pi-sandbox", { extraArgs: ["Reply with PONG"] }, { process: proc }),
    ).rejects.toThrow("__exit:2");

    expect(resolveLifecycleEligibleSandboxAgentMock).toHaveBeenCalledWith(entry);
    expect(ensureLiveMock).not.toHaveBeenCalled();
    expect(execMock).not.toHaveBeenCalled();
    expect(writes.join("")).toContain("has not been qualified");
  });

  it("uses the receipt-pinned OpenClaw command declaration for selector flags", async () => {
    const execNonJson = vi.fn(((): never => {
      throw new Error("__exit:0");
    }) as NonNullable<AgentPassthroughDeps["execNonJson"]>);
    const harnessPackage = {
      kind: "agent-runtime" as const,
      id: "openclaw",
      packageVersion: "0.1.0",
      contentDigest: "f".repeat(64),
    };
    const entry = { agent: "openclaw", harnessPackage };
    getSandboxMock.mockReturnValueOnce(entry as never);
    resolveLifecycleEligibleSandboxAgentMock.mockReturnValueOnce({
      recordedAgent: "openclaw",
      effectiveAgentId: "openclaw",
      definition: {
        name: "openclaw",
        runtime: {
          kind: "gateway",
          interactive_command: "openclaw tui",
          headless_command: "nemoclaw-fabric run --config /sandbox/.openclaw/fabric.json",
          prompt_transport: "stdin",
          agent_command: OPENCLAW_AGENT_COMMAND,
        },
      } as unknown as ResolvedSandboxAgent["definition"],
      harnessPackage,
      harnessPackageMigration: null,
    });
    await expect(
      runAgentPassthrough(
        "alpha",
        { extraArgs: ["--agent", "work", "--session-id", "s-1", "-m", "ping"] },
        { execNonJson },
      ),
    ).rejects.toThrow("__exit:0");
    expect(ensureLiveMock).toHaveBeenCalledWith("alpha", { allowNonReadyPhase: true });
    expect(execMock).not.toHaveBeenCalled();
    expect(execNonJson).toHaveBeenCalledWith(
      "alpha",
      ["receipt-openclaw", "agent", "--agent", "work", "--session-id", "s-1", "-m", "ping"],
      expect.anything(),
    );
  });

  it("never falls back to OpenClaw for an unknown receipt-backed package", async () => {
    const execJson = vi.fn(((): never => {
      throw new Error("__unexpected-json");
    }) as NonNullable<AgentPassthroughDeps["execJson"]>);
    const execNonJson = vi.fn(((): never => {
      throw new Error("__unexpected-text");
    }) as NonNullable<AgentPassthroughDeps["execNonJson"]>);
    const recoverOllama = vi.fn();
    const harnessPackage = {
      kind: "agent-runtime" as const,
      id: "future-terminal",
      packageVersion: "0.1.0",
      contentDigest: "8".repeat(64),
    };
    const entry = { agent: "future-terminal", harnessPackage };
    getSandboxMock.mockReturnValueOnce(entry as never);
    resolveLifecycleEligibleSandboxAgentMock.mockReturnValueOnce({
      recordedAgent: "future-terminal",
      effectiveAgentId: "future-terminal",
      definition: {
        name: "future-terminal",
        runtime: {
          kind: "terminal",
          interactive_command: "future-terminal",
          agent_command: {
            argv: ["future-terminal", "run"],
            output_mode: "direct",
            boolean_options: ["--json"],
          },
        },
      } as unknown as ResolvedSandboxAgent["definition"],
      harnessPackage,
      harnessPackageMigration: null,
    });

    await runAgentPassthrough(
      "future-sandbox",
      { extraArgs: ["--json", "--profile", "native"] },
      { execJson, execNonJson, runOllamaRestartRecovery: recoverOllama },
    );

    expect(execMock).toHaveBeenCalledWith(
      "future-sandbox",
      ["future-terminal", "run", "--json", "--profile", "native"],
      { tty: false },
    );
    expect(execJson).not.toHaveBeenCalled();
    expect(execNonJson).not.toHaveBeenCalled();
    expect(recoverOllama).not.toHaveBeenCalled();
  });

  it("dispatches a plain prompt through a receipt-pinned OpenClaw headless command", async () => {
    const harnessPackage = {
      kind: "agent-runtime" as const,
      id: "openclaw",
      packageVersion: "0.1.0",
      contentDigest: "1".repeat(64),
    };
    const entry = { agent: "openclaw", harnessPackage };
    getSandboxMock.mockReturnValueOnce(entry as never);
    resolveLifecycleEligibleSandboxAgentMock.mockReturnValueOnce({
      recordedAgent: "openclaw",
      effectiveAgentId: "openclaw",
      definition: {
        name: "openclaw",
        runtime: {
          kind: "gateway",
          interactive_command: "openclaw tui",
          headless_command: "nemoclaw-fabric run --config /sandbox/.openclaw/fabric.json",
          prompt_transport: "stdin",
        },
      } as ResolvedSandboxAgent["definition"],
      harnessPackage,
      harnessPackageMigration: null,
    });

    await runAgentPassthrough("openclaw-sandbox", { extraArgs: ["Reply with PONG"] });

    expect(execMock).toHaveBeenCalledWith(
      "openclaw-sandbox",
      ["nemoclaw-fabric", "run", "--config", "/sandbox/.openclaw/fabric.json", "--stdin"],
      { stdinInput: "Reply with PONG", tty: false },
    );
  });

  it("keeps a non-JSON agent reply isolated from the plugin banner (#5654)", async () => {
    const stdoutWrites: string[] = [];
    const stderrWrites: string[] = [];
    const exit = vi.fn((code: number) => {
      throw new Error(`__exit:${code}`);
    });
    const proc = {
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
    };
    const execNonJson = vi.fn(
      (
        _sb: string,
        _cmd: readonly string[],
        procArg: NonNullable<AgentPassthroughDeps["process"]>,
      ): never => {
        // Simulate NemoClaw replaying captured OpenClaw output: banner goes to proc.stderr,
        // agent reply goes to proc.stdout. This is what the captured transport path does
        // (#5654: banner must not pollute stdout).
        procArg.stdout!.write("ack\n");
        procArg.stderr.write("[gateway]   NemoClaw registered\n");
        throw new Error("__exit:0");
      },
    ) as NonNullable<AgentPassthroughDeps["execNonJson"]>;
    getSandboxMock.mockReturnValueOnce({ agent: "openclaw" });

    await expect(
      runAgentPassthrough(
        "alpha",
        { extraArgs: ["--agent", "main", "-m", "ping"] },
        { execNonJson, process: proc },
      ),
    ).rejects.toThrow("__exit:0");

    expect(stdoutWrites.join("")).toBe("ack\n");
    expect(stdoutWrites.join("")).not.toContain("NemoClaw registered");
    expect(stderrWrites.join("")).toContain("NemoClaw registered");
  });

  it("uses the captured JSON path for `openclaw agent --json` so provenance can be emitted on stderr", async () => {
    const execJson = vi.fn(() => {
      throw new Error("__exit:0");
    });
    getSandboxMock.mockReturnValueOnce({ agent: "openclaw" });
    const { proc } = makeProcMock();

    await expect(
      runAgentPassthrough(
        "alpha",
        {
          extraArgs: ["--agent", "work", "--session-id", "s-1", "-m", "ping", "--json"],
        },
        { execJson, process: proc },
      ),
    ).rejects.toThrow("__exit:0");

    expect(ensureLiveMock).toHaveBeenCalledWith("alpha", { allowNonReadyPhase: true });
    expect(execMock).not.toHaveBeenCalled();
    expect(execJson).toHaveBeenCalledWith(
      "alpha",
      ["openclaw", "agent", "--agent", "work", "--session-id", "s-1", "-m", "ping", "--json"],
      expect.objectContaining({ stderr: proc.stderr }),
    );
  });

  it("keeps --json as a message value on the normal passthrough path", async () => {
    const execJson = vi.fn(((): never => {
      throw new Error("__unexpected-json");
    }) as NonNullable<AgentPassthroughDeps["execJson"]>);
    const execNonJson = vi.fn(((): never => {
      throw new Error("__exit:0");
    }) as NonNullable<AgentPassthroughDeps["execNonJson"]>);
    getSandboxMock.mockReturnValueOnce({ agent: "openclaw" });

    await expect(
      runAgentPassthrough(
        "alpha",
        { extraArgs: ["--agent", "work", "-m", "--json"] },
        { execJson, execNonJson },
      ),
    ).rejects.toThrow("__exit:0");

    expect(execJson).not.toHaveBeenCalled();
    expect(execMock).not.toHaveBeenCalled();
    expect(execNonJson).toHaveBeenCalledWith(
      "alpha",
      ["openclaw", "agent", "--agent", "work", "-m", "--json"],
      expect.anything(),
    );
  });

  it("keeps --json after the argv terminator on the normal passthrough path", async () => {
    const execJson = vi.fn(((): never => {
      throw new Error("__unexpected-json");
    }) as NonNullable<AgentPassthroughDeps["execJson"]>);
    const execNonJson = vi.fn(((): never => {
      throw new Error("__exit:0");
    }) as NonNullable<AgentPassthroughDeps["execNonJson"]>);
    getSandboxMock.mockReturnValueOnce({ agent: "openclaw" });

    await expect(
      runAgentPassthrough(
        "alpha",
        { extraArgs: ["--agent", "work", "--", "--json"] },
        { execJson, execNonJson },
      ),
    ).rejects.toThrow("__exit:0");

    expect(execJson).not.toHaveBeenCalled();
    expect(execMock).not.toHaveBeenCalled();
    expect(execNonJson).toHaveBeenCalledWith(
      "alpha",
      ["openclaw", "agent", "--agent", "work", "--", "--json"],
      expect.anything(),
    );
  });

  it("keeps --json-something --json on the normal passthrough path", async () => {
    const execJson = vi.fn(((): never => {
      throw new Error("__unexpected-json");
    }) as NonNullable<AgentPassthroughDeps["execJson"]>);
    const execNonJson = vi.fn(((): never => {
      throw new Error("__exit:0");
    }) as NonNullable<AgentPassthroughDeps["execNonJson"]>);
    getSandboxMock.mockReturnValueOnce({ agent: "openclaw" });

    // The first unknown flag selects conservative passthrough before the later --json token.
    await expect(
      runAgentPassthrough(
        "alpha",
        { extraArgs: ["--agent", "work", "--json-something", "--json"] },
        { execJson, execNonJson },
      ),
    ).rejects.toThrow("__exit:0");

    expect(execJson).not.toHaveBeenCalled();
    expect(execMock).not.toHaveBeenCalled();
    expect(execNonJson).toHaveBeenCalledWith(
      "alpha",
      ["openclaw", "agent", "--agent", "work", "--json-something", "--json"],
      expect.anything(),
    );
  });

  it("uses the captured JSON path after documented OpenClaw boolean flags", async () => {
    const execJson = vi.fn(() => {
      throw new Error("__exit:0");
    });
    getSandboxMock.mockReturnValueOnce({ agent: "openclaw" });
    const { proc } = makeProcMock();

    await expect(
      runAgentPassthrough(
        "alpha",
        { extraArgs: ["--agent", "work", "--deliver", "--json", "-m", "ping"] },
        { execJson, process: proc },
      ),
    ).rejects.toThrow("__exit:0");

    expect(execMock).not.toHaveBeenCalled();
    expect(execJson).toHaveBeenCalledWith(
      "alpha",
      ["openclaw", "agent", "--agent", "work", "--deliver", "--json", "-m", "ping"],
      expect.objectContaining({ stderr: proc.stderr }),
    );
  });

  it("uses the captured JSON path after documented equals-form value flags", async () => {
    const execJson = vi.fn(() => {
      throw new Error("__exit:0");
    });
    getSandboxMock.mockReturnValueOnce({ agent: "openclaw" });
    const { proc } = makeProcMock();

    await expect(
      runAgentPassthrough(
        "alpha",
        { extraArgs: ["--session-id=s1", "--json", "-m", "ping"] },
        { execJson, process: proc },
      ),
    ).rejects.toThrow("__exit:0");

    expect(execMock).not.toHaveBeenCalled();
    expect(execJson).toHaveBeenCalledWith(
      "alpha",
      ["openclaw", "agent", "--session-id=s1", "--json", "-m", "ping"],
      expect.objectContaining({ stderr: proc.stderr }),
    );
  });

  it.each([
    ["-a", "--json"],
    ["--agent", "--json"],
    ["-m", "--json"],
    ["--message", "--json"],
    ["--model", "--json"],
    ["--provider", "--json"],
    ["--reply-channel", "--json"],
    ["--session-id", "--json"],
    ["--session-key", "--json"],
    ["--thinking", "--json"],
    ["--timeout", "--json"],
    ["--to", "--json"],
  ])("keeps --json consumed by %s on the normal passthrough path", async (flag, value) => {
    const execJson = vi.fn(((): never => {
      throw new Error("__unexpected-json");
    }) as NonNullable<AgentPassthroughDeps["execJson"]>);
    const execNonJson = vi.fn(((): never => {
      throw new Error("__exit:0");
    }) as NonNullable<AgentPassthroughDeps["execNonJson"]>);
    getSandboxMock.mockReturnValueOnce({ agent: "openclaw" });

    await expect(
      runAgentPassthrough(
        "alpha",
        { extraArgs: ["--session-id", "s-1", flag, value] },
        { execJson, execNonJson },
      ),
    ).rejects.toThrow("__exit:0");

    expect(execJson).not.toHaveBeenCalled();
    expect(execMock).not.toHaveBeenCalled();
    expect(execNonJson).toHaveBeenCalledWith(
      "alpha",
      ["openclaw", "agent", "--session-id", "s-1", flag, value],
      expect.anything(),
    );
  });

  it("keeps OpenClaw --help local so wrapper docs parity stays offline", async () => {
    getSandboxMock.mockReturnValueOnce({ agent: "openclaw" });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await runAgentPassthrough("alpha", { extraArgs: ["--help"] });
    } finally {
      logSpy.mockRestore();
    }
    expect(ensureLiveMock).not.toHaveBeenCalled();
    expect(execMock).not.toHaveBeenCalled();
  });

  it.each([
    ["Pi", "bare", "pi", "terminal", "pi", []],
    ["Pi", "help", "pi", "terminal", "pi", ["--help"]],
    ["Pi", "option-first", "pi", "terminal", "pi", ["--model", "native-model"]],
    ["Hermes", "bare", "hermes", "gateway", "hermes", []],
    ["Hermes", "help", "hermes", "gateway", "hermes", ["--help"]],
    ["Hermes", "option-first", "hermes", "gateway", "hermes", ["--model", "native-model"]],
    ["Deep Agents Code", "bare", "langchain-deepagents-code", "terminal", "dcode", []],
    ["Deep Agents Code", "help", "langchain-deepagents-code", "terminal", "dcode", ["--help"]],
    [
      "Deep Agents Code",
      "option-first",
      "langchain-deepagents-code",
      "terminal",
      "dcode",
      ["--model", "native-model"],
    ],
  ] as const)(
    "keeps the %s %s invocation on its native command",
    async (_displayName, _invocation, agentName, runtimeKind, nativeCommand, extraArgs) => {
      const entry = { agent: agentName };
      getSandboxMock.mockReturnValueOnce(entry as never);
      resolveLifecycleEligibleSandboxAgentMock.mockReturnValueOnce({
        recordedAgent: agentName,
        effectiveAgentId: agentName,
        definition: {
          name: agentName,
          runtime: {
            kind: runtimeKind,
            interactive_command: nativeCommand,
            headless_command: "nemoclaw-fabric run --config /sandbox/runtime/fabric.json",
            prompt_transport: "stdin",
          },
        } as ResolvedSandboxAgent["definition"],
        harnessPackage: null,
        harnessPackageMigration: null,
      });

      await runAgentPassthrough(`${agentName}-native`, { extraArgs });

      expect(execMock).toHaveBeenCalledWith(`${agentName}-native`, [nativeCommand, ...extraArgs], {
        tty: false,
      });
    },
  );
  it("dispatches Deep Agents Code through the bounded Fabric command in its manifest", async () => {
    const actualAgentDefinitions =
      await vi.importActual<typeof import("../../../agent/defs")>("../../../agent/defs");
    getSandboxMock.mockReturnValueOnce({ agent: "langchain-deepagents-code" });
    loadAgentMock.mockImplementationOnce(actualAgentDefinitions.loadAgent);

    await runAgentPassthrough("dcode-fabric", { extraArgs: ["Reply with PONG"] });

    expect(execMock).toHaveBeenCalledWith(
      "dcode-fabric",
      [
        "nemoclaw-fabric-run",
        "--deadline-seconds",
        "120",
        "--kill-grace-seconds",
        "10",
        "--config",
        "/sandbox/.deepagents/fabric.json",
        "--stdin",
      ],
      { stdinInput: "Reply with PONG", tty: false },
    );
  });

  it("keeps a message-option Fabric prompt out of argv while preserving JSON output", async () => {
    const actualAgentDefinitions =
      await vi.importActual<typeof import("../../../agent/defs")>("../../../agent/defs");
    const sentinel = "private-message-option-prompt-349c";
    getSandboxMock.mockReturnValueOnce({ agent: "langchain-deepagents-code" });
    loadAgentMock.mockImplementationOnce(actualAgentDefinitions.loadAgent);

    await runAgentPassthrough("dcode-fabric", {
      extraArgs: ["-m", sentinel, "--json"],
    });

    const invocation = execMock.mock.calls.at(-1) as unknown as
      | [string, string[], { stdinInput: string; tty: boolean }]
      | undefined;
    expect(invocation?.[1]).toEqual([
      "nemoclaw-fabric-run",
      "--deadline-seconds",
      "120",
      "--kill-grace-seconds",
      "10",
      "--config",
      "/sandbox/.deepagents/fabric.json",
      "--stdin",
      "--json",
    ]);
    expect(invocation?.[1]).not.toContain(sentinel);
    expect(invocation?.[2]).toEqual({ stdinInput: sentinel, tty: false });
  });

  it.each([
    [
      "nemoclaw-fabric-run",
      "/opt/nemoclaw-fabric-venv/bin/nemoclaw-fabric-run --config /sandbox/runtime/fabric.json",
      [
        "/opt/nemoclaw-fabric-venv/bin/nemoclaw-fabric-run",
        "--config",
        "/sandbox/runtime/fabric.json",
        "--stdin",
      ],
    ],
    [
      "nemoclaw-fabric run",
      "/usr/local/bin/nemoclaw-fabric run --config /sandbox/runtime/fabric.json",
      [
        "/usr/local/bin/nemoclaw-fabric",
        "run",
        "--config",
        "/sandbox/runtime/fabric.json",
        "--stdin",
      ],
    ],
  ] as const)(
    "delivers a prompt privately when the absolute %s executable path is installed",
    async (_runnerName, headlessCommand, expectedArgv) => {
      const sentinel = "absolute-runner-private-prompt-1d8b";
      const entry = { agent: "package-agent" };
      getSandboxMock.mockReturnValueOnce(entry as never);
      resolveLifecycleEligibleSandboxAgentMock.mockReturnValueOnce({
        recordedAgent: "package-agent",
        effectiveAgentId: "package-agent",
        definition: {
          name: "package-agent",
          runtime: {
            kind: "terminal",
            interactive_command: "package-agent",
            headless_command: headlessCommand,
            prompt_transport: "stdin",
          },
        } as ResolvedSandboxAgent["definition"],
        harnessPackage: null,
        harnessPackageMigration: null,
      });

      await runAgentPassthrough("absolute-fabric", { extraArgs: [sentinel] });

      const invocation = execMock.mock.calls.at(-1) as unknown as
        | [string, string[], { stdinInput: string; tty: boolean }]
        | undefined;
      expect(invocation?.[1]).toEqual(expectedArgv);
      expect(invocation?.[1]).not.toContain(sentinel);
      expect(invocation?.[2]).toEqual({ stdinInput: sentinel, tty: false });
    },
  );

  it("uses declared stdin transport without recognizing the executable name", async () => {
    const sentinel = "declared-private-prompt-8a2f";
    const entry = { agent: "package-agent" };
    getSandboxMock.mockReturnValueOnce(entry as never);
    resolveLifecycleEligibleSandboxAgentMock.mockReturnValueOnce({
      recordedAgent: "package-agent",
      effectiveAgentId: "package-agent",
      definition: {
        name: "package-agent",
        runtime: {
          kind: "terminal",
          interactive_command: "package-agent",
          headless_command: "package-private-runner --request-mode single",
          prompt_transport: "stdin",
        },
      } as ResolvedSandboxAgent["definition"],
      harnessPackage: null,
      harnessPackageMigration: null,
    });

    await runAgentPassthrough("declared-stdin", { extraArgs: [sentinel] });

    expect(execMock).toHaveBeenCalledWith(
      "declared-stdin",
      ["package-private-runner", "--request-mode", "single", "--stdin"],
      { stdinInput: sentinel, tty: false },
    );
  });

  it("does not infer stdin transport from a Fabric-shaped executable name", async () => {
    const entry = { agent: "package-agent" };
    getSandboxMock.mockReturnValueOnce(entry as never);
    resolveLifecycleEligibleSandboxAgentMock.mockReturnValueOnce({
      recordedAgent: "package-agent",
      effectiveAgentId: "package-agent",
      definition: {
        name: "package-agent",
        runtime: {
          kind: "terminal",
          interactive_command: "package-agent",
          headless_command: "nemoclaw-fabric-run --config /sandbox/package/fabric.json",
        },
      } as ResolvedSandboxAgent["definition"],
      harnessPackage: null,
      harnessPackageMigration: null,
    });

    await runAgentPassthrough("declared-argv", { extraArgs: ["public-prompt"] });

    expect(execMock).toHaveBeenCalledWith(
      "declared-argv",
      ["nemoclaw-fabric-run", "--config", "/sandbox/package/fabric.json", "public-prompt"],
      { tty: false },
    );
  });

  it.each([
    {
      name: "a duplicate config option",
      arguments: [
        "--config",
        "/sandbox/.deepagents/private-missing-config.json",
        "-m",
        "private-duplicate-config-prompt",
        "--json",
      ],
      forbiddenOutput: /private-missing-config\.json|private-duplicate-config-prompt/u,
    },
    {
      name: "an option after the message",
      arguments: ["-m", "private-unknown-option-prompt", "--unknown"],
      forbiddenOutput: /private-unknown-option-prompt/u,
    },
  ])(
    "rejects $name without forwarding request values in argv",
    async ({ arguments: args, forbiddenOutput }) => {
      const actualAgentDefinitions =
        await vi.importActual<typeof import("../../../agent/defs")>("../../../agent/defs");
      getSandboxMock.mockReturnValueOnce({ agent: "langchain-deepagents-code" });
      loadAgentMock.mockImplementationOnce(actualAgentDefinitions.loadAgent);
      const { writes, exit, proc } = makeProcMock();

      await expect(
        runAgentPassthrough("dcode-fabric", { extraArgs: args }, { process: proc }),
      ).rejects.toThrow("__exit:2");

      expect(exit).toHaveBeenCalledWith(2);
      expect(ensureLiveMock).not.toHaveBeenCalled();
      expect(execMock).not.toHaveBeenCalled();
      expect(writes.join("\n")).toContain("Refusing to place unrecognized request values");
      expect(writes.join("\n")).not.toMatch(forbiddenOutput);
    },
  );

  it("keeps a Fabric prompt out of argv and diagnostics while delivering exact stdin", async () => {
    const sentinel = "private-prompt-sentinel-83b2f1";
    const entry = { agent: "hermes" };
    getSandboxMock.mockReturnValueOnce(entry as never);
    resolveLifecycleEligibleSandboxAgentMock.mockReturnValueOnce({
      recordedAgent: "hermes",
      effectiveAgentId: "hermes",
      definition: {
        name: "hermes",
        runtime: {
          kind: "gateway",
          interactive_command: "hermes",
          headless_command: "nemoclaw-fabric run --config /sandbox/.hermes/fabric.json",
          prompt_transport: "stdin",
        },
      } as ResolvedSandboxAgent["definition"],
      harnessPackage: null,
      harnessPackageMigration: null,
    });
    const { writes, proc } = makeProcMock();

    await runAgentPassthrough("hermes-private", { extraArgs: [sentinel] }, { process: proc });

    const lastCall = execMock.mock.calls.at(-1) as unknown as
      | [string, string[], { stdinInput: string; tty: boolean }]
      | undefined;
    expect(lastCall?.[1]).not.toContain(sentinel);
    expect(lastCall?.[2]).toEqual({ stdinInput: sentinel, tty: false });
    expect(writes.join("\n")).not.toContain(sentinel);
  });

  it("propagates a headless terminal command failure from the sandbox exec path", async () => {
    getSandboxMock.mockReturnValueOnce({ agent: "langchain-deepagents-code" });
    execMock.mockRejectedValueOnce(new Error("__exit:42"));

    await expect(
      runAgentPassthrough("dcode-fail", { extraArgs: ["Reply with PONG"] }),
    ).rejects.toThrow("__exit:42");

    expect(ensureLiveMock).toHaveBeenCalledWith("dcode-fail", { allowNonReadyPhase: true });
    expect(execMock).toHaveBeenCalledWith("dcode-fail", ["nemoclaw-fabric", "run", "--stdin"], {
      stdinInput: "Reply with PONG",
      tty: false,
    });
  });

  it("falls back to the interactive command when a terminal agent has no headless command", async () => {
    getSandboxMock.mockReturnValueOnce({ agent: "custom-terminal" });
    loadAgentMock.mockReturnValueOnce({
      name: "custom-terminal",
      runtime: { kind: "terminal", interactive_command: "custom-agent" },
    });

    await runAgentPassthrough("custom", { extraArgs: ["--status"] });

    expect(execMock).toHaveBeenCalledWith("custom", ["custom-agent", "--status"], {
      tty: false,
    });
  });

  it("treats a clean registry miss as OpenClaw (preserves bootstrap and recovery paths)", async () => {
    const execNonJson = vi.fn(((): never => {
      throw new Error("__exit:0");
    }) as NonNullable<AgentPassthroughDeps["execNonJson"]>);
    getSandboxMock.mockReturnValueOnce(null);
    await expect(
      runAgentPassthrough("ghost", { extraArgs: ["--agent", "main", "-m", "hi"] }, { execNonJson }),
    ).rejects.toThrow("__exit:0");
    expect(execMock).not.toHaveBeenCalled();
    expect(execNonJson).toHaveBeenCalledWith(
      "ghost",
      ["openclaw", "agent", "--agent", "main", "-m", "hi"],
      expect.anything(),
    );
  });

  it("keeps registry-miss --help local for offline docs parity", async () => {
    getSandboxMock.mockReturnValueOnce(null);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await runAgentPassthrough("placeholder-sandbox", { extraArgs: ["--help"] });
    } finally {
      logSpy.mockRestore();
    }
    expect(ensureLiveMock).not.toHaveBeenCalled();
    expect(execMock).not.toHaveBeenCalled();
  });

  it("keeps legacy OpenClaw --help local without resolving package authority", async () => {
    getSandboxMock.mockReturnValueOnce({ agent: null });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await runAgentPassthrough("placeholder-sandbox", { extraArgs: ["--help"] });
    } finally {
      logSpy.mockRestore();
    }
    expect(resolveLifecycleEligibleSandboxAgentMock).not.toHaveBeenCalled();
    expect(ensureLiveMock).not.toHaveBeenCalled();
    expect(execMock).not.toHaveBeenCalled();
  });

  it("fails closed when the registry read throws and never spawns OpenShell exec", async () => {
    getSandboxMock.mockImplementationOnce(() => {
      throw new Error("EACCES: permission denied, open '~/.config/nemoclaw/sandboxes.json'");
    });
    const { writes, exit, proc } = makeProcMock();
    await expect(
      runAgentPassthrough("alpha", { extraArgs: ["-m", "hi"] }, { process: proc }),
    ).rejects.toThrow("__exit:2");
    expect(execMock).not.toHaveBeenCalled();
    expect(ensureLiveMock).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(2);
    const all = writes.join("");
    expect(all).toMatch(/Could not read the local sandbox registry/);
    expect(all).toMatch(/Refusing to forward/);
    expect(all).toMatch(/EACCES/);
  });

  it("fails closed when the recorded agent authority is malformed", async () => {
    getSandboxMock.mockReturnValueOnce({ agent: "../missing-agent" });
    resolveLifecycleEligibleSandboxAgentMock.mockImplementationOnce(() => {
      throw new Error(
        "Sandbox agent authority is invalid: the recorded agent must be a canonical identifier",
      );
    });
    const { writes, exit, proc } = makeProcMock();
    await expect(
      runAgentPassthrough("../missing-agent", { extraArgs: ["--help"] }, { process: proc }),
    ).rejects.toThrow("__exit:2");
    expect(execMock).not.toHaveBeenCalled();
    expect(ensureLiveMock).not.toHaveBeenCalled();
    expect(loadAgentMock).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(2);
    const all = writes.join("");
    expect(all).toMatch(/registered agent '\.\.\/missing-agent'/);
    expect(all).toMatch(/recorded agent must be a canonical identifier/);
    expect(all).toMatch(/Refusing to dispatch/);
  });

  it("fails closed when a known registered agent cannot be resolved before OpenShell exec", async () => {
    getSandboxMock.mockReturnValueOnce({ agent: "missing-agent" });
    resolveLifecycleEligibleSandboxAgentMock.mockImplementationOnce(() => {
      throw new Error("Agent manifest not found: agents/missing-agent/manifest.yaml");
    });
    const { writes, exit, proc } = makeProcMock();
    await expect(
      runAgentPassthrough("alpha", { extraArgs: ["-m", "hi"] }, { process: proc }),
    ).rejects.toThrow("__exit:2");
    expect(execMock).not.toHaveBeenCalled();
    expect(ensureLiveMock).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(2);
    const all = writes.join("");
    expect(all).toMatch(/registered agent 'missing-agent'/);
    expect(all).toMatch(/Agent manifest not found/);
    expect(all).toMatch(/Refusing to dispatch/);
  });

  it("fails closed for quoted terminal manifest commands instead of splitting them incorrectly", async () => {
    getSandboxMock.mockReturnValueOnce({ agent: "custom-terminal" });
    loadAgentMock.mockReturnValueOnce({
      name: "custom-terminal",
      runtime: {
        kind: "terminal",
        interactive_command: "tool",
        headless_command: 'tool --profile "Deep Agents"',
      },
    });
    const { writes, exit, proc } = makeProcMock();
    await expect(
      runAgentPassthrough("quoted-terminal", { extraArgs: ["--help"] }, { process: proc }),
    ).rejects.toThrow("__exit:2");
    expect(execMock).not.toHaveBeenCalled();
    expect(ensureLiveMock).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(2);
    const all = writes.join("");
    expect(all).toMatch(/registered agent 'custom-terminal'/);
    expect(all).toMatch(/simple whitespace-delimited argv tokens/);
    expect(all).toMatch(/quoted or escaped shell syntax is not supported/);
  });

  it("rejects with exit 2 when no target selector flag is present on a Ready OpenClaw sandbox", async () => {
    getSandboxMock.mockReturnValueOnce({ agent: "openclaw" });
    const { writes, exit, proc } = makeProcMock();
    await expect(
      runAgentPassthrough("alpha", { extraArgs: ["-m", "hi"] }, { process: proc }),
    ).rejects.toThrow("__exit:2");
    expect(execMock).not.toHaveBeenCalled();
    expect(ensureLiveMock).toHaveBeenCalledWith("alpha", { allowNonReadyPhase: true });
    expect(exit).toHaveBeenCalledWith(2);
    const all = writes.join("");
    expect(all).toMatch(/No target session selected/);
    expect(all).toMatch(/--agent <id>/);
    expect(all).toMatch(/openclaw agents list/);
  });

  it("rejects with exit 2 when extraArgs is empty on a Ready OpenClaw sandbox", async () => {
    getSandboxMock.mockReturnValueOnce({ agent: "openclaw" });
    const { exit, proc } = makeProcMock();
    await expect(runAgentPassthrough("alpha", {}, { process: proc })).rejects.toThrow("__exit:2");
    expect(execMock).not.toHaveBeenCalled();
    expect(ensureLiveMock).toHaveBeenCalledWith("alpha", { allowNonReadyPhase: true });
    expect(exit).toHaveBeenCalledWith(2);
  });

  it("prints recovery hints with exit 1 before selector rejection for the literal stopped-sandbox repro `agent -m ping` (#5655)", async () => {
    ensureLiveMock.mockResolvedValueOnce({
      state: "present",
      phase: "Error",
      output: "Phase: Error",
    });
    getSandboxMock.mockReturnValueOnce({ agent: "openclaw" });
    const { writes, exit, proc } = makeProcMock();
    await expect(
      runAgentPassthrough("my-assistant", { extraArgs: ["-m", "ping"] }, { process: proc }),
    ).rejects.toThrow("__exit:1");
    expect(execMock).not.toHaveBeenCalled();
    expect(ensureLiveMock).toHaveBeenCalledWith("my-assistant", { allowNonReadyPhase: true });
    expect(exit).toHaveBeenCalledWith(1);
    const all = writes.join("");
    expect(all).toMatch(
      /Sandbox 'my-assistant' is not ready for the agent wrapper \(phase: Error\)/,
    );
    expect(all).toMatch(/my-assistant recover/);
    expect(all).not.toMatch(/No target session selected/);
  });

  it("rejects with exit 2 when the selector token appears after the `--` argv separator", async () => {
    getSandboxMock.mockReturnValueOnce({ agent: "openclaw" });
    const { writes, exit, proc } = makeProcMock();
    await expect(
      runAgentPassthrough(
        "alpha",
        { extraArgs: ["--", "--agent", "work", "-m", "hi"] },
        { process: proc },
      ),
    ).rejects.toThrow("__exit:2");
    expect(execMock).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(2);
    expect(writes.join("")).toMatch(/No target session selected/);
  });

  it("accepts selector in --flag=value form and forwards verbatim", async () => {
    const execNonJson = vi.fn(((): never => {
      throw new Error("__exit:0");
    }) as NonNullable<AgentPassthroughDeps["execNonJson"]>);
    getSandboxMock.mockReturnValueOnce({ agent: "openclaw" });
    await expect(
      runAgentPassthrough(
        "alpha",
        { extraArgs: ["--session-key=abc-123", "-m", "ping"] },
        { execNonJson },
      ),
    ).rejects.toThrow("__exit:0");
    expect(execMock).not.toHaveBeenCalled();
    expect(execNonJson).toHaveBeenCalledWith(
      "alpha",
      ["openclaw", "agent", "--session-key=abc-123", "-m", "ping"],
      expect.anything(),
    );
  });

  it("rejects with exit 1 + recovery hints when sandbox phase is non-Ready", async () => {
    ensureLiveMock.mockResolvedValueOnce({
      state: "present",
      phase: "Error",
      output: "Phase: Error",
    });
    getSandboxMock.mockReturnValueOnce({ agent: "openclaw" });
    const { writes, exit, proc } = makeProcMock();
    await expect(
      runAgentPassthrough(
        "my-assistant",
        { extraArgs: ["--agent", "main", "-m", "hi"] },
        { process: proc },
      ),
    ).rejects.toThrow("__exit:1");
    expect(execMock).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(1);
    const all = writes.join("");
    expect(all).toMatch(
      /Sandbox 'my-assistant' is not ready for the agent wrapper \(phase: Error\)/,
    );
    expect(all).toMatch(/my-assistant recover/);
    expect(all).toMatch(/my-assistant rebuild --yes/);
    expect(all).toMatch(/onboard --resume/);
  });

  it("fails closed with exit 2 when ensureLive returns no observed phase, never invoking exec", async () => {
    ensureLiveMock.mockResolvedValueOnce({
      state: "present",
      phase: null,
      output: "Name: alpha\n(no phase line here)\n",
    });
    getSandboxMock.mockReturnValueOnce({ agent: "openclaw" });
    const { writes, exit, proc } = makeProcMock();
    await expect(
      runAgentPassthrough(
        "alpha",
        { extraArgs: ["--agent", "main", "-m", "hi"] },
        { process: proc },
      ),
    ).rejects.toThrow("__exit:2");
    expect(execMock).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(2);
    const all = writes.join("");
    expect(all).toMatch(/Could not parse a 'Phase:' line/);
    expect(all).toMatch(/Refusing to dispatch/);
  });

  it("routes non-JSON OpenClaw commands through execNonJson for embedded-fallback interception", async () => {
    const execNonJson = vi.fn(((): never => {
      throw new Error("__exit:0");
    }) as NonNullable<AgentPassthroughDeps["execNonJson"]>);
    getSandboxMock.mockReturnValueOnce({ agent: "openclaw" });
    await expect(
      runAgentPassthrough(
        "alpha",
        { extraArgs: ["--agent", "main", "-m", "ping"] },
        { execNonJson },
      ),
    ).rejects.toThrow("__exit:0");
    expect(execMock).not.toHaveBeenCalled();
    expect(execNonJson).toHaveBeenCalledWith(
      "alpha",
      ["openclaw", "agent", "--agent", "main", "-m", "ping"],
      expect.anything(),
    );
  });
});

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
