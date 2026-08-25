// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { runOnboardCommand } from "./command";

function exitWithCode(code: number): never {
  throw new Error(`exit:${code}`);
}

describe("onboarding agent runtime activation", () => {
  it("exits before credential activation when no agent runtime package is installed", async () => {
    const errors: string[] = [];
    const env: NodeJS.ProcessEnv = {};
    const runOnboard = vi.fn(async () => {});
    const loadPortableInferenceDescriptor = vi.fn(async () => null);

    await expect(
      runOnboardCommand({
        flags: { "experimental-profile": "portable" },
        env,
        listAgents: () => ["openclaw", "hermes", "langchain-deepagents-code"],
        listInstalledAgents: () => [],
        loadPortableInferenceDescriptor,
        runOnboard,
        error: (message = "") => errors.push(message),
        exit: exitWithCode,
      }),
    ).rejects.toThrow("exit:1");

    expect(errors.join("\n")).toContain("No agent runtime packages are installed");
    expect(errors.join("\n")).toContain("nemoclaw harness install");
    expect(errors.join("\n")).toContain("nemoclaw onboard");
    expect(loadPortableInferenceDescriptor).not.toHaveBeenCalled();
    expect(runOnboard).not.toHaveBeenCalled();
    expect(env).toEqual({});
  });

  it("reports the exact install command for an explicit available agent runtime", async () => {
    const errors: string[] = [];
    const runOnboard = vi.fn(async () => {});

    await expect(
      runOnboardCommand({
        flags: { agent: "nemohermes" },
        env: {},
        listAgents: () => ["openclaw", "hermes"],
        listInstalledAgents: () => [],
        runOnboard,
        error: (message = "") => errors.push(message),
        exit: exitWithCode,
      }),
    ).rejects.toThrow("exit:1");

    expect(errors.join("\n")).toContain("Agent runtime package 'hermes'");
    expect(errors.join("\n")).toContain("nemoclaw harness install hermes");
    expect(runOnboard).not.toHaveBeenCalled();
  });

  it("selects the only installed agent runtime before onboarding", async () => {
    const runOnboard = vi.fn(async () => {});

    await runOnboardCommand({
      flags: {},
      env: {},
      listAgents: () => ["openclaw", "hermes", "langchain-deepagents-code"],
      listInstalledAgents: () => ["hermes"],
      canPrompt: () => true,
      runOnboard,
    });

    expect(runOnboard).toHaveBeenCalledWith(expect.objectContaining({ agent: "hermes" }));
  });

  it("leaves multiple installed agent runtime packages for the interactive picker", async () => {
    const runOnboard = vi.fn(async () => {});

    await runOnboardCommand({
      flags: {},
      env: {},
      listAgents: () => ["openclaw", "hermes", "langchain-deepagents-code"],
      listInstalledAgents: () => ["openclaw", "hermes"],
      canPrompt: () => true,
      runOnboard,
    });

    expect(runOnboard).toHaveBeenCalledWith(expect.objectContaining({ agent: null }));
  });

  it("preserves the OpenClaw default when multiple runtimes cannot prompt", async () => {
    const runOnboard = vi.fn(async () => {});

    await runOnboardCommand({
      flags: { "non-interactive": true },
      env: {},
      listAgents: () => ["openclaw", "hermes", "langchain-deepagents-code"],
      listInstalledAgents: () => ["hermes", "openclaw"],
      canPrompt: () => false,
      runOnboard,
    });

    expect(runOnboard).toHaveBeenCalledWith(
      expect.objectContaining({ agent: "openclaw", nonInteractive: true }),
    );
  });

  it("requires --agent when multiple installed runtimes cannot prompt without OpenClaw", async () => {
    const errors: string[] = [];
    const runOnboard = vi.fn(async () => {});

    await expect(
      runOnboardCommand({
        flags: { "non-interactive": true },
        env: {},
        listAgents: () => ["openclaw", "hermes", "langchain-deepagents-code"],
        listInstalledAgents: () => ["hermes", "langchain-deepagents-code"],
        canPrompt: () => false,
        runOnboard,
        error: (message = "") => errors.push(message),
        exit: exitWithCode,
      }),
    ).rejects.toThrow("exit:1");

    expect(errors.join("\n")).toContain("Select one with --agent <name>");
    expect(runOnboard).not.toHaveBeenCalled();
  });

  it("canonicalizes an installed NEMOCLAW_AGENT alias", async () => {
    const runOnboard = vi.fn(async () => {});

    await runOnboardCommand({
      flags: {},
      env: { NEMOCLAW_AGENT: "nemohermes" },
      listAgents: () => ["openclaw", "hermes"],
      listInstalledAgents: () => ["hermes"],
      runOnboard,
    });

    expect(runOnboard).toHaveBeenCalledWith(expect.objectContaining({ agent: "hermes" }));
  });

  it("reports the exact install command for an uninstalled NEMOCLAW_AGENT", async () => {
    const errors: string[] = [];
    const runOnboard = vi.fn(async () => {});

    await expect(
      runOnboardCommand({
        flags: {},
        env: { NEMOCLAW_AGENT: "nemohermes" },
        listAgents: () => ["openclaw", "hermes"],
        listInstalledAgents: () => ["openclaw"],
        runOnboard,
        error: (message = "") => errors.push(message),
        exit: exitWithCode,
      }),
    ).rejects.toThrow("exit:1");

    expect(errors.join("\n")).toContain("nemoclaw harness install hermes");
    expect(runOnboard).not.toHaveBeenCalled();
  });

  it("refuses resume when the recorded agent runtime package is not installed", async () => {
    const errors: string[] = [];
    const runOnboard = vi.fn(async () => {});

    await expect(
      runOnboardCommand({
        flags: { resume: true },
        env: {},
        listAgents: () => ["openclaw", "hermes"],
        listInstalledAgents: () => ["openclaw"],
        loadSession: () => ({ agent: "hermes" }),
        resolveResumeIntent: () => ({ effectiveResume: true, snapshot: null }),
        runOnboard,
        error: (message = "") => errors.push(message),
        exit: exitWithCode,
      }),
    ).rejects.toThrow("exit:1");

    expect(errors.join("\n")).toContain("session requires agent runtime package 'hermes'");
    expect(errors.join("\n")).toContain("nemoclaw harness install hermes");
    expect(runOnboard).not.toHaveBeenCalled();
  });

  it("treats a null recorded agent as OpenClaw during resume validation", async () => {
    const errors: string[] = [];

    await expect(
      runOnboardCommand({
        flags: { resume: true },
        env: {},
        listAgents: () => ["openclaw", "hermes"],
        listInstalledAgents: () => ["hermes"],
        loadSession: () => ({ agent: null }),
        resolveResumeIntent: () => ({ effectiveResume: true, snapshot: null }),
        runOnboard: vi.fn(async () => {}),
        error: (message = "") => errors.push(message),
        exit: exitWithCode,
      }),
    ).rejects.toThrow("exit:1");

    expect(errors.join("\n")).toContain("session requires agent runtime package 'openclaw'");
    expect(errors.join("\n")).toContain("nemoclaw harness install openclaw");
  });

  it("uses the recorded installed agent runtime during resume", async () => {
    const runOnboard = vi.fn(async () => {});

    await runOnboardCommand({
      flags: { resume: true },
      env: {},
      listAgents: () => ["openclaw", "hermes"],
      listInstalledAgents: () => ["openclaw", "hermes"],
      loadSession: () => ({ agent: "hermes" }),
      resolveResumeIntent: () => ({ effectiveResume: true, snapshot: null }),
      runOnboard,
    });

    expect(runOnboard).toHaveBeenCalledWith(
      expect.objectContaining({ agent: "hermes", resume: true }),
    );
  });

  it("refuses an explicit agent runtime that conflicts with the resumed session", async () => {
    const errors: string[] = [];
    const runOnboard = vi.fn(async () => {});

    await expect(
      runOnboardCommand({
        flags: { agent: "openclaw", resume: true },
        env: {},
        listAgents: () => ["openclaw", "hermes"],
        listInstalledAgents: () => ["openclaw", "hermes"],
        loadSession: () => ({ agent: "hermes" }),
        resolveResumeIntent: () => ({ effectiveResume: true, snapshot: null }),
        runOnboard,
        error: (message = "") => errors.push(message),
        exit: exitWithCode,
      }),
    ).rejects.toThrow("exit:1");

    expect(errors.join("\n")).toContain(
      "Session was started with agent runtime 'hermes', not 'openclaw'",
    );
    expect(errors.join("\n")).toContain("nemoclaw onboard --fresh");
    expect(runOnboard).not.toHaveBeenCalled();
  });

  it("ignores the saved agent runtime during fresh onboarding", async () => {
    const runOnboard = vi.fn(async () => {});

    await runOnboardCommand({
      flags: { fresh: true },
      env: {},
      listAgents: () => ["openclaw", "hermes"],
      listInstalledAgents: () => ["openclaw"],
      loadSession: () => ({ agent: "hermes" }),
      resolveResumeIntent: () => ({ effectiveResume: false, snapshot: null }),
      runOnboard,
    });

    expect(runOnboard).toHaveBeenCalledWith(
      expect.objectContaining({ agent: "openclaw", fresh: true, resume: false }),
    );
  });
});
