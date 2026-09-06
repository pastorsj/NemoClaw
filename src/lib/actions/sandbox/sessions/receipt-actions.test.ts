// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ensureLive: vi.fn(async () => undefined),
  capture: vi.fn(),
  run: vi.fn(),
  exec: vi.fn(async () => undefined),
  gateway: vi.fn(),
  resolveAuthority: vi.fn(),
  confirmAuthority: vi.fn(),
  withLock: vi.fn(async (_name: string, operation: () => unknown) => await operation()),
}));

vi.mock("../../../adapters/openshell/runtime", () => ({
  captureOpenshell: mocks.capture,
  runOpenshell: mocks.run,
}));
vi.mock("../gateway-state", () => ({ ensureLiveSandboxOrExit: mocks.ensureLive }));
vi.mock("../exec", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../exec")>()),
  execSandbox: mocks.exec,
}));
vi.mock("./gateway-rpc", () => ({ callOpenclawGateway: mocks.gateway }));
vi.mock("./command-authority", () => ({
  resolveSessionCommandAuthority: mocks.resolveAuthority,
  confirmSessionCommandAuthority: mocks.confirmAuthority,
  ensureLiveSessionSandbox: mocks.ensureLive,
  withSessionCommandLock: mocks.withLock,
  assertSessionCommandAvailable: vi.fn(),
}));
vi.mock("../../../state/mcp-lifecycle-lock-acquisition", () => ({
  withMcpLifecycleLock: mocks.withLock,
}));
vi.mock("../../../onboard/experimental/portable-agent-lifecycle", () => ({
  assertHermesPortableCommandUnavailable: vi.fn(),
}));

import type { HarnessSessionAdapterHostModule } from "../../../agent-runtime/session-module";
import { deleteSandboxSession } from "./delete";
import { exportSandboxSessions } from "./export";
import { resetSandboxSession } from "./reset";

const PACKAGE_IDENTITY = Object.freeze({
  kind: "agent-runtime" as const,
  id: "future-harness",
  packageVersion: "1.0.0",
  contentDigest: "a".repeat(64),
});

function sessionAdapter(
  overrides: Partial<HarnessSessionAdapterHostModule> = {},
): HarnessSessionAdapterHostModule {
  return {
    buildSessionListPlan: vi.fn(
      () => ({ kind: "unsupported", reason: "list unavailable" }) as const,
    ),
    interpretSessionListOutput: vi.fn(() => ({ kind: "refused", reason: "not captured" }) as const),
    buildSessionMutationPlan: vi.fn(
      () =>
        ({
          kind: "unsupported",
          reason: "mutation unavailable",
        }) as const,
    ),
    interpretSessionMutationOutput: vi.fn(
      () =>
        ({
          kind: "refused",
          reason: "not captured",
        }) as const,
    ),
    buildSessionExportPlan: vi.fn(
      () =>
        ({
          kind: "unsupported",
          reason: "export unavailable",
        }) as const,
    ),
    interpretSessionExportIndex: vi.fn(
      () =>
        ({
          kind: "refused",
          reason: "not captured",
        }) as const,
    ),
    ...overrides,
  };
}

function useReceiptAdapter(adapter: HarnessSessionAdapterHostModule): void {
  mocks.resolveAuthority.mockReturnValue({ identity: PACKAGE_IDENTITY, adapter });
  mocks.confirmAuthority.mockReturnValue(adapter);
}

let processExitSpy: ReturnType<typeof vi.spyOn>;
let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  processExitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
    throw new Error(`process.exit:${String(code)}`);
  });
  consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  processExitSpy.mockRestore();
  consoleErrorSpy.mockRestore();
});

describe("receipt-backed session authority", () => {
  it("refuses an unknown package's typed unsupported delete before OpenShell", async () => {
    useReceiptAdapter(sessionAdapter());

    await expect(deleteSandboxSession("alpha", { key: "session" })).rejects.toThrow(
      "process.exit:1",
    );

    expect(mocks.ensureLive).not.toHaveBeenCalled();
    expect(mocks.confirmAuthority).not.toHaveBeenCalled();
    expect(mocks.gateway).not.toHaveBeenCalled();
    expect(mocks.exec).not.toHaveBeenCalled();
    expect(mocks.capture).not.toHaveBeenCalled();
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it("refuses manifest/result disagreement before reset can reach OpenShell", async () => {
    const adapter = sessionAdapter({
      buildSessionMutationPlan: vi.fn(() => {
        throw new Error("does not match its declared reset capability");
      }),
    });
    useReceiptAdapter(adapter);

    await expect(resetSandboxSession("alpha", { key: "session" })).rejects.toThrow(
      "process.exit:1",
    );

    expect(mocks.ensureLive).not.toHaveBeenCalled();
    expect(mocks.gateway).not.toHaveBeenCalled();
  });

  it("rechecks the complete package receipt immediately before delete mutation", async () => {
    const plan = {
      kind: "capture" as const,
      command: ["future-session-admin", "delete", "session"],
    };
    const adapter = sessionAdapter({ buildSessionMutationPlan: vi.fn(() => plan) });
    useReceiptAdapter(adapter);
    mocks.confirmAuthority.mockImplementation(() => {
      throw new Error("harness package authority changed");
    });

    await expect(deleteSandboxSession("alpha", { key: "session" })).rejects.toThrow(
      /authority changed/u,
    );

    expect(mocks.ensureLive).toHaveBeenCalledOnce();
    expect(mocks.confirmAuthority).toHaveBeenCalledWith("alpha", PACKAGE_IDENTITY);
    expect(mocks.gateway).not.toHaveBeenCalled();
  });

  it("executes and interprets an unknown package delete capture without the legacy gateway", async () => {
    const plan = {
      kind: "capture" as const,
      command: ["future-session-admin", "delete", "session"],
    };
    const adapter = sessionAdapter({
      buildSessionMutationPlan: vi.fn(() => plan),
      interpretSessionMutationOutput: vi.fn(() => ({
        kind: "completed" as const,
        operation: "delete" as const,
        key: "future:session",
        removedTranscript: true,
        entry: null,
      })),
    });
    useReceiptAdapter(adapter);
    mocks.capture.mockReturnValue({
      status: 0,
      output: '{"ok":true}',
      stdout: '{"ok":true}\n',
      stderr: "",
    });

    await expect(deleteSandboxSession("alpha", { key: "session" })).resolves.toEqual({
      key: "future:session",
      removedTranscript: true,
    });

    const capturedArgs = mocks.capture.mock.calls[0]?.[0] as string[];
    expect(capturedArgs.slice(-plan.command.length)).toEqual(plan.command);
    expect(adapter.interpretSessionMutationOutput).toHaveBeenCalledWith({
      request: expect.objectContaining({ operation: "delete", key: "session" }),
      plan,
      output: '{"ok":true}',
    });
    expect(mocks.gateway).not.toHaveBeenCalled();
    expect(mocks.exec).not.toHaveBeenCalled();
  });

  it("executes and interprets an unknown package reset capture without the legacy gateway", async () => {
    const plan = {
      kind: "capture" as const,
      command: ["future-session-admin", "reset", "session"],
    };
    const adapter = sessionAdapter({
      buildSessionMutationPlan: vi.fn(() => plan),
      interpretSessionMutationOutput: vi.fn(() => ({
        kind: "completed" as const,
        operation: "reset" as const,
        key: "future:session",
        reason: "new" as const,
        entry: null,
      })),
    });
    useReceiptAdapter(adapter);
    mocks.capture.mockReturnValue({
      status: 0,
      output: '{"ok":true}',
      stdout: '{"ok":true}\n',
      stderr: "",
    });

    await expect(resetSandboxSession("alpha", { key: "session", reason: "new" })).resolves.toEqual({
      key: "future:session",
      reason: "new",
    });

    const capturedArgs = mocks.capture.mock.calls[0]?.[0] as string[];
    expect(capturedArgs.slice(-plan.command.length)).toEqual(plan.command);
    expect(adapter.interpretSessionMutationOutput).toHaveBeenCalledWith({
      request: expect.objectContaining({ operation: "reset", key: "session", reason: "new" }),
      plan,
      output: '{"ok":true}',
    });
    expect(mocks.gateway).not.toHaveBeenCalled();
    expect(mocks.exec).not.toHaveBeenCalled();
  });

  it("refuses typed unsupported export before OpenShell or host filesystem mutation", async () => {
    useReceiptAdapter(sessionAdapter());
    const mkdirSpy = vi.spyOn(fs, "mkdirSync");
    const mkdtempSpy = vi.spyOn(fs, "mkdtempSync");
    try {
      await expect(exportSandboxSessions({ sandboxName: "alpha" })).rejects.toThrow(
        /export unavailable/u,
      );
      expect(mocks.ensureLive).not.toHaveBeenCalled();
      expect(mocks.capture).not.toHaveBeenCalled();
      expect(mocks.run).not.toHaveBeenCalled();
      expect(mkdirSpy).not.toHaveBeenCalled();
      expect(mkdtempSpy).not.toHaveBeenCalled();
    } finally {
      mkdirSpy.mockRestore();
      mkdtempSpy.mockRestore();
    }
  });

  it("rejects an unsafe package export path before OpenShell or filesystem mutation", async () => {
    const adapter = sessionAdapter({
      buildSessionExportPlan: vi.fn(
        () =>
          ({
            kind: "indexed-files",
            agent: "future",
            format: "dir",
            selectedKeys: "all",
            sourceDirectory: "/sandbox/../host",
            indexCommand: ["future", "sessions", "list"],
          }) as const,
      ),
    });
    useReceiptAdapter(adapter);
    const mkdirSpy = vi.spyOn(fs, "mkdirSync");
    const mkdtempSpy = vi.spyOn(fs, "mkdtempSync");
    try {
      await expect(exportSandboxSessions({ sandboxName: "alpha" })).rejects.toThrow(
        /unsafe session source path/u,
      );
      expect(mocks.capture).not.toHaveBeenCalled();
      expect(mocks.run).not.toHaveBeenCalled();
      expect(mkdirSpy).not.toHaveBeenCalled();
      expect(mkdtempSpy).not.toHaveBeenCalled();
    } finally {
      mkdirSpy.mockRestore();
      mkdtempSpy.mockRestore();
    }
  });

  it("refuses receipt drift before executing a package index command", async () => {
    const adapter = sessionAdapter({
      buildSessionExportPlan: vi.fn(
        () =>
          ({
            kind: "indexed-files",
            agent: "future",
            format: "dir",
            selectedKeys: "all",
            sourceDirectory: "/sandbox/sessions",
            indexCommand: ["future", "sessions", "list"],
          }) as const,
      ),
    });
    useReceiptAdapter(adapter);
    mocks.confirmAuthority.mockImplementation(() => {
      throw new Error("harness package authority changed");
    });

    await expect(exportSandboxSessions({ sandboxName: "alpha" })).rejects.toThrow(
      /authority changed/u,
    );

    expect(mocks.capture).not.toHaveBeenCalled();
    expect(mocks.run).not.toHaveBeenCalled();
  });
});
