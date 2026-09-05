// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  capture: vi.fn(),
  exec: vi.fn(async () => {}),
  ensureLive: vi.fn(async () => ({})),
  getSandbox: vi.fn(),
  resolvePackage: vi.fn(),
  loadAdapter: vi.fn(),
  runLegacy: vi.fn(async () => {}),
  assertPortableUnavailable: vi.fn(),
  withLifecycleLock: vi.fn(
    async (_sandboxName: string, operation: () => unknown) => await operation(),
  ),
}));

vi.mock("../../../adapters/openshell/runtime", () => ({ captureOpenshell: mocks.capture }));
vi.mock("../../../agent-runtime/session-module", () => ({
  loadHarnessSessionAdapterHostModule: mocks.loadAdapter,
}));
vi.mock("../../../onboard/package/package-authority", () => ({
  resolvePackageBackedSandboxAgent: mocks.resolvePackage,
}));
vi.mock("../../../onboard/experimental/portable-agent-lifecycle", () => ({
  assertHermesPortableCommandUnavailable: mocks.assertPortableUnavailable,
}));
vi.mock("../../../state/registry", () => ({ getSandbox: mocks.getSandbox }));
vi.mock("../../../state/mcp-lifecycle-lock-acquisition", () => ({
  withMcpLifecycleLock: mocks.withLifecycleLock,
}));
vi.mock("./legacy-list", () => ({ runLegacySessionList: mocks.runLegacy }));
vi.mock("../exec", async () => {
  const actual = await vi.importActual<typeof import("../exec")>("../exec");
  return { ...actual, execSandbox: mocks.exec };
});
vi.mock("../gateway-state", () => ({ ensureLiveSandboxOrExit: mocks.ensureLive }));

import { printSessionsPassthroughHelp, runSessionsPassthrough } from "./passthrough";

const PACKAGE_IDENTITY = Object.freeze({
  kind: "agent-runtime" as const,
  id: "future-sessions",
  packageVersion: "1.0.0",
  contentDigest: "a".repeat(64),
});

function packageSandbox() {
  return { name: "alpha", agent: "future-sessions", harnessPackage: PACKAGE_IDENTITY };
}

function sessionAdapter(plan: Record<string, unknown>) {
  return {
    buildSessionListPlan: vi.fn(() => plan),
    interpretSessionListOutput: vi.fn(() => ({ kind: "output", output: "visible output" })),
  };
}

describe("session-list package orchestration", () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSandbox.mockReturnValue(packageSandbox());
    mocks.resolvePackage.mockReturnValue({ harnessPackage: PACKAGE_IDENTITY });
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it("executes and interprets a receipt-backed capture plan", async () => {
    const adapter = sessionAdapter({
      kind: "capture",
      command: ["future-sessions", "list", "--json"],
    });
    mocks.loadAdapter.mockReturnValue(adapter);
    mocks.capture.mockReturnValue({ status: 0, output: "native output", stderr: "warning" });

    await runSessionsPassthrough("alpha", { verb: "list", extraArgs: ["--json"] });

    expect(mocks.resolvePackage).toHaveBeenCalledWith(packageSandbox());
    expect(mocks.loadAdapter).toHaveBeenCalledWith(PACKAGE_IDENTITY);
    expect(adapter.buildSessionListPlan).toHaveBeenCalledWith({
      arguments: ["--json"],
      useListSubcommand: true,
    });
    expect(mocks.capture).toHaveBeenCalledWith(
      ["sandbox", "exec", "--name", "alpha", "--", "future-sessions", "list", "--json"],
      { ignoreError: true, includeStreams: true, maxBuffer: 64 * 1024 * 1024 },
    );
    expect(adapter.interpretSessionListOutput).toHaveBeenCalledWith({
      output: "native output",
      jsonOutput: true,
      hiddenSessionIdPrefix: expect.any(String),
    });
    expect(stdoutSpy).toHaveBeenCalledWith("visible output\n");
    expect(stderrSpy).toHaveBeenCalledWith("warning\n");
  });

  it("streams a package plan without invoking the output interpreter", async () => {
    const adapter = sessionAdapter({ kind: "stream", command: ["future-sessions", "list"] });
    mocks.loadAdapter.mockReturnValue(adapter);

    await runSessionsPassthrough("alpha", { verb: "list" });

    expect(mocks.exec).toHaveBeenCalledWith(
      "alpha",
      ["future-sessions", "list"],
      {},
      expect.objectContaining({ exit: expect.any(Function) }),
    );
    expect(mocks.capture).not.toHaveBeenCalled();
    expect(adapter.interpretSessionListOutput).not.toHaveBeenCalled();
  });

  it("stops before OpenShell when the package returns typed unsupported", async () => {
    const adapter = sessionAdapter({ kind: "unsupported", reason: "listing is unavailable" });
    mocks.loadAdapter.mockReturnValue(adapter);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`process.exit:${String(code)}`);
    });

    try {
      await expect(runSessionsPassthrough("alpha", { verb: "list" })).rejects.toThrow(
        "process.exit:1",
      );
    } finally {
      exitSpy.mockRestore();
    }

    expect(consoleErrorSpy).toHaveBeenCalledWith("  listing is unavailable");
    expect(mocks.capture).not.toHaveBeenCalled();
    expect(mocks.exec).not.toHaveBeenCalled();
  });

  it("stops before OpenShell when manifest and adapter list support disagree", async () => {
    const adapter = sessionAdapter({});
    adapter.buildSessionListPlan.mockImplementation(() => {
      throw new Error(
        "Installed harness session adapter does not match its declared list capability",
      );
    });
    mocks.loadAdapter.mockReturnValue(adapter);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`process.exit:${String(code)}`);
    });

    try {
      await expect(runSessionsPassthrough("alpha", { verb: "list" })).rejects.toThrow(
        "process.exit:1",
      );
    } finally {
      exitSpy.mockRestore();
    }

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("declared list capability"),
    );
    expect(mocks.capture).not.toHaveBeenCalled();
    expect(mocks.exec).not.toHaveBeenCalled();
  });

  it("does not interpret output after the native command fails", async () => {
    const adapter = sessionAdapter({ kind: "capture", command: ["future-sessions", "list"] });
    mocks.loadAdapter.mockReturnValue(adapter);
    mocks.capture.mockReturnValue({ status: 3, output: "", stderr: "native failure" });
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`process.exit:${String(code)}`);
    });

    try {
      await expect(runSessionsPassthrough("alpha", { verb: "list" })).rejects.toThrow(
        "process.exit:3",
      );
    } finally {
      exitSpy.mockRestore();
    }

    expect(adapter.interpretSessionListOutput).not.toHaveBeenCalled();
    expect(stderrSpy).toHaveBeenCalledWith("native failure\n");
  });

  it("delegates only a no-receipt registry row to the legacy decoder", async () => {
    mocks.getSandbox.mockReturnValue({ name: "legacy", agent: "legacy-agent" });

    await runSessionsPassthrough("legacy", { extraArgs: ["--limit", "2"] });

    expect(mocks.runLegacy).toHaveBeenCalledWith("legacy", "legacy-agent", {
      useListSubcommand: false,
      arguments: ["--limit", "2"],
    });
    expect(mocks.resolvePackage).not.toHaveBeenCalled();
    expect(mocks.loadAdapter).not.toHaveBeenCalled();
  });
});

describe("session-list help", () => {
  it("describes the package contract without naming a harness", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      printSessionsPassthroughHelp("list");
      const help = logSpy.mock.calls.map((call) => String(call[0] ?? "")).join("\n");
      expect(help).toContain("installed harness package");
      expect(help).not.toMatch(/openclaw|hermes/iu);
    } finally {
      logSpy.mockRestore();
    }
  });
});
