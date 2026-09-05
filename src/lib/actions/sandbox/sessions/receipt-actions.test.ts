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
vi.mock("../exec", () => ({ execSandbox: mocks.exec }));
vi.mock("./gateway-rpc", () => ({ callOpenclawGateway: mocks.gateway }));
vi.mock("./package-authority", () => ({
  resolveSessionPackageAuthority: mocks.resolveAuthority,
  confirmSessionPackageAuthority: mocks.confirmAuthority,
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
      kind: "admin-rpc" as const,
      method: "sessions.delete" as const,
      params: { key: "agent:main:session", deleteTranscript: true },
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
