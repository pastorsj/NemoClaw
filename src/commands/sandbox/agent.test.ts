// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type CommandPassthroughDeps = {
  deferredLifecycleExit?: (code: number) => never;
  process: { exit(code: number): never };
};

const runAgentPassthroughMock = vi.hoisted(() =>
  vi.fn(
    async (
      _sandboxName: string,
      _options: { extraArgs?: readonly string[] },
      _deps?: CommandPassthroughDeps,
    ) => {},
  ),
);
vi.mock("../../lib/actions/sandbox/agent/passthrough", () => ({
  runAgentPassthrough: runAgentPassthroughMock,
}));

import { log } from "../../lib/cli/logger";
import SandboxAgentCommand from "./agent";

const rootDir = process.cwd();

describe("SandboxAgentCommand oclif parse path", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    runAgentPassthroughMock.mockReset();
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it("forwards the OpenClaw argv verbatim to runAgentPassthrough", async () => {
    await SandboxAgentCommand.run(["alpha", "--agent", "work", "-m", "hi"], rootDir);
    expect(runAgentPassthroughMock).toHaveBeenCalledWith(
      "alpha",
      { extraArgs: ["--agent", "work", "-m", "hi"] },
      expect.anything(),
    );
  });

  it("forwards downstream logging flags without changing host logging", async () => {
    const configure = vi.spyOn(log, "configure").mockImplementation(() => undefined);

    await SandboxAgentCommand.run(["alpha", "--debug", "-m", "hi"], rootDir);

    expect(runAgentPassthroughMock).toHaveBeenCalledWith(
      "alpha",
      { extraArgs: ["--debug", "-m", "hi"] },
      expect.anything(),
    );
    expect(configure).toHaveBeenCalledWith({ debug: false, quiet: false });
    expect(configure).not.toHaveBeenCalledWith({ debug: true, quiet: false });
  });

  it("preserves the option boundary without treating later flags as host flags", async () => {
    const configure = vi.spyOn(log, "configure").mockImplementation(() => undefined);

    await SandboxAgentCommand.run(["alpha", "--", "--quiet"], rootDir);

    expect(runAgentPassthroughMock).toHaveBeenCalledWith(
      "alpha",
      { extraArgs: ["--", "--quiet"] },
      expect.anything(),
    );
    expect(configure).toHaveBeenCalledWith({ debug: false, quiet: false });
    expect(configure).not.toHaveBeenCalledWith({ debug: false, quiet: true });
  });

  it("passes --help after the sandbox name to agent-aware dispatch (#5790)", async () => {
    await SandboxAgentCommand.run(["alpha", "--help"], rootDir);
    expect(runAgentPassthroughMock).toHaveBeenCalledWith(
      "alpha",
      { extraArgs: ["--help"] },
      expect.anything(),
    );
  });

  it("does not call runAgentPassthrough when no sandbox name is supplied", async () => {
    await SandboxAgentCommand.run([], rootDir);
    expect(runAgentPassthroughMock).not.toHaveBeenCalled();
    const help = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
    expect(help).toMatch(/package-declared headless or native command/);
  });

  it("treats sandbox name '--help' as a help request, not a name", async () => {
    await SandboxAgentCommand.run(["--help"], rootDir);
    expect(runAgentPassthroughMock).not.toHaveBeenCalled();
  });

  it("passes a bare sandbox invocation to agent-aware dispatch (#5790)", async () => {
    await SandboxAgentCommand.run(["alpha"], rootDir);
    expect(runAgentPassthroughMock).toHaveBeenCalledWith(
      "alpha",
      { extraArgs: [] },
      expect.anything(),
    );
  });

  it("defers passthrough exits until the command lifecycle fence can finish", async () => {
    runAgentPassthroughMock.mockImplementationOnce(async (_sandboxName, _options, deps) => {
      expect(deps).toBeDefined();
      expect(deps?.deferredLifecycleExit).toBe(deps?.process.exit);
      deps!.process.exit(7);
    });

    await expect(
      SandboxAgentCommand.run(["alpha", "Reply with PONG"], rootDir),
    ).resolves.toBeUndefined();

    expect(process.exitCode).toBe(7);
  });
});
