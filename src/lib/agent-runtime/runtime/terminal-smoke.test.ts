// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { type AgentDefinition, loadAgent } from "../../agent/defs";
import { readAgentRuntime } from "./manifest";
import {
  buildAgentSmokeArgs,
  createAgentSmokeCommandVerifier,
  runAgentSmokeCommands,
} from "./terminal-smoke";

function agent(
  name: string,
  runtime: Partial<NonNullable<AgentDefinition["runtime"]>> = {},
): AgentDefinition {
  return {
    name,
    runtime: { smoke_commands: ["dcode --version"], ...runtime },
  } as unknown as AgentDefinition;
}

function managedSmokeAgent(name = "example-agent"): AgentDefinition {
  return agent(name, {
    command_shell: "/bin/sh",
    smoke_boundary: {
      kind: "managed-launcher",
      launcher: "/usr/local/lib/nemoclaw/example-managed-exec",
      home: "/usr/local/lib/nemoclaw",
    },
  });
}

describe("terminal agent smoke command invocation", () => {
  it("uses a package-declared managed launcher without adding a login shell (#8624)", () => {
    const args = buildAgentSmokeArgs("probe-box", managedSmokeAgent(), "dcode --version");

    expect(args).not.toContain("-lc");
    expect(args.join(" ")).not.toContain("sh -lc");
    expect(args).toContain("/usr/local/lib/nemoclaw/example-managed-exec");
    expect(args).toContain("HOME=/usr/local/lib/nemoclaw");
    expect(args).toContain("BASH_ENV=");
    expect(args).toContain("ENV=");
    expect(args.at(-1)).toBe("dcode --version");
  });

  it("keeps the login shell for other terminal agents (#8624)", () => {
    const args = buildAgentSmokeArgs("probe-box", agent("hermes"), "hermes --version");

    expect(args).toContain("-lc");
    expect(args).toContain("/bin/sh");
    expect(args).not.toContain("/usr/local/lib/nemoclaw/example-managed-exec");
    expect(args.at(-1)).toBe("hermes --version");
  });

  it("uses the package-declared Bash command shell", () => {
    const args = buildAgentSmokeArgs(
      "probe-box",
      agent("example-agent", { command_shell: "/bin/bash" }),
      "example-agent --version",
    );

    expect(args).toContain("/bin/bash");
    expect(args).toContain("-lc");
    expect(args.at(-3)).toContain('/bin/bash -lc "$1"');
    expect(args.at(-1)).toBe("example-agent --version");
  });

  it("loads command and smoke boundaries from package manifests", () => {
    expect(
      readAgentRuntime({
        runtime: { kind: "terminal", command_shell: "/bin/bash", interactive_command: "pi" },
      }).command_shell,
    ).toBe("/bin/bash");
    expect(loadAgent("langchain-deepagents-code").runtime?.smoke_boundary).toEqual({
      kind: "managed-launcher",
      launcher: "/usr/local/lib/nemoclaw/dcode-managed-exec",
      home: "/usr/local/lib/nemoclaw",
    });
  });

  it("pins every smoke exec to the owning OpenShell gateway (#8942)", () => {
    const capture = vi.fn((_args: string[]) => ({
      status: 0,
      output: "NEMOCLAW_AGENT_SMOKE_BEGIN\nNEMOCLAW_AGENT_SMOKE_EXIT:0\n",
    }));

    expect(
      runAgentSmokeCommands(
        "alpha",
        loadAgent("langchain-deepagents-code"),
        capture,
        "nemoclaw-8091",
      ),
    ).toEqual({ ok: true });

    expect(capture).toHaveBeenCalled();
    capture.mock.calls.forEach(([args]) => {
      expect(args.slice(0, 7)).toEqual([
        "sandbox",
        "exec",
        "-n",
        "alpha",
        "-g",
        "nemoclaw-8091",
        "--no-tty",
      ]);
    });
  });

  it("does not add a login shell to Deep Agents Code smoke exec (#8624)", () => {
    const issued: string[][] = [];
    const result = runAgentSmokeCommands(
      "probe-box",
      managedSmokeAgent("langchain-deepagents-code"),
      (args) => {
        issued.push(args);
        return {
          status: 0,
          output: "NEMOCLAW_AGENT_SMOKE_BEGIN\nNEMOCLAW_AGENT_SMOKE_EXIT:0\n",
        };
      },
    );

    expect(result).toEqual({ ok: true });
    expect(issued).toHaveLength(1);
    expect(issued[0]).not.toContain("-lc");
    expect(issued[0]!.join(" ")).not.toContain("sh -lc");
  });

  it("rejects forged managed markers when the transport exits before the runner (#8624)", () => {
    const result = runAgentSmokeCommands("probe-box", managedSmokeAgent(), () => ({
      status: 97,
      output: "NEMOCLAW_AGENT_SMOKE_BEGIN\nNEMOCLAW_AGENT_SMOKE_EXIT:0\n",
    }));

    expect(result).toMatchObject({ ok: false, command: "dcode --version" });
  });

  it("rejects string-only managed smoke evidence without transport status (#8624)", () => {
    const result = runAgentSmokeCommands(
      "probe-box",
      managedSmokeAgent(),
      () => "NEMOCLAW_AGENT_SMOKE_BEGIN\nNEMOCLAW_AGENT_SMOKE_EXIT:0\n",
    );

    expect(result).toMatchObject({ ok: false, command: "dcode --version" });
  });

  it("rejects extra marker evidence around the managed runner boundary (#8624)", () => {
    const result = runAgentSmokeCommands("probe-box", managedSmokeAgent(), () => ({
      status: 0,
      output:
        "NEMOCLAW_AGENT_SMOKE_EXIT:0\nNEMOCLAW_AGENT_SMOKE_BEGIN\nNEMOCLAW_AGENT_SMOKE_EXIT:42\n",
    }));

    expect(result).toMatchObject({ ok: false, command: "dcode --version" });
  });

  it("verifies package smoke commands against the selected gateway", () => {
    const capture = vi.fn((_args: string[]) => "NEMOCLAW_AGENT_SMOKE_EXIT:0\n");
    const verify = createAgentSmokeCommandVerifier(agent("openclaw"), capture, () => "gateway-a");

    expect(() => verify("sandbox-a")).not.toThrow();
    expect(capture.mock.calls[0]![0]).toEqual(
      expect.arrayContaining(["sandbox-a", "-g", "gateway-a"]),
    );
  });

  it("reports the package smoke command that fails", () => {
    const verify = createAgentSmokeCommandVerifier(
      { ...agent("openclaw"), displayName: "OpenClaw" },
      () => "NEMOCLAW_AGENT_SMOKE_EXIT:12\n",
      () => "gateway-a",
    );

    expect(() => verify("sandbox-a")).toThrow(
      "OpenClaw package smoke command failed: dcode --version",
    );
  });
});
