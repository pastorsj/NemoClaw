// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as f from "./snapshot-restore-test-fixture";
import {
  OPENCLAW_PACKAGE,
  configureCloneRegistry,
  expectSnapshotStateRestore,
  harnessPackage,
  packageManagedSandbox,
} from "./snapshot/lifecycle-test-fixture";

beforeEach(() => {
  f.resetSnapshotRestoreMocks();
});
afterEach(() => {
  f.cleanupSnapshotRestoreMocks();
});
describe("runSandboxSnapshot restore: gateway pairing on a freshly created destination", () => {
  it("pairs after restore without reconstructing policy from NemoClaw state", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const alphaEntry = packageManagedSandbox("alpha", OPENCLAW_PACKAGE);
    f.modelPendingCloneRegistry((name) => (name === "alpha" ? alphaEntry : null));
    f.parseLiveSandboxNamesMock.mockReturnValue(new Set(["alpha"]));
    f.captureOpenshellMock.mockImplementation((args) =>
      f.openshellResponses(args, {
        "sandbox exec": { status: 0, output: f.dcodeProbeOutput("no-runtime") },
        "sandbox list": { status: 0, output: "alpha Ready\nbeta Ready\n" },
      }),
    );
    f.getLatestBackupMock.mockReturnValue({ ...f.latestBackupFixture });
    f.restoreSandboxStateMock.mockReturnValue({
      success: true,
      restoredDirs: ["workspace"],
      restoredFiles: ["user.md"],
      failedDirs: [],
      failedFiles: [],
    });
    const { runSandboxSnapshot } = await import("./snapshot");

    await expect(
      runSandboxSnapshot("alpha", { kind: "restore", to: "beta", yes: true }),
    ).resolves.toBeUndefined();

    expectSnapshotStateRestore("beta");
    expect(f.applyPresetMock).not.toHaveBeenCalled();
    expect(f.applyPresetContentMock).not.toHaveBeenCalled();
    expect(f.removePresetMock).not.toHaveBeenCalled();
    expect(f.establishRestoredSandboxGatewayPairingMock).toHaveBeenCalledWith("beta");
  });

  it("fails with repair guidance when restored gateway pairing cannot be verified (#7431)", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    configureCloneRegistry(packageManagedSandbox("alpha", OPENCLAW_PACKAGE));
    f.parseLiveSandboxNamesMock.mockReturnValue(new Set(["alpha"]));
    f.captureOpenshellMock.mockImplementation((args) =>
      f.openshellResponses(args, {
        "sandbox exec": { status: 0, output: f.dcodeProbeOutput("no-runtime") },
        "sandbox list": { status: 0, output: "alpha Ready\nbeta Ready\n" },
      }),
    );
    f.getLatestBackupMock.mockReturnValue({ ...f.latestBackupFixture });
    f.restoreSandboxStateMock.mockReturnValue({
      success: true,
      restoredDirs: ["workspace"],
      restoredFiles: ["user.md"],
      failedDirs: [],
      failedFiles: [],
    });
    f.establishRestoredSandboxGatewayPairingMock.mockImplementationOnce(() => {
      throw new Error("authenticated gateway verification failed");
    });
    const { runSandboxSnapshot } = await import("./snapshot");

    await expect(
      runSandboxSnapshot("alpha", { kind: "restore", to: "beta", yes: true }),
    ).rejects.toMatchObject({
      exitCode: 1,
      lines: [
        "State restored into 'beta', but gateway pairing could not be verified.",
        "Run `nemoclaw beta connect` to retry pairing before running an agent.",
        expect.stringContaining("authenticated gateway verification failed"),
      ],
    });
  });

  it.each(["hermes", "langchain-deepagents-code"] as const)(
    "does not run OpenClaw pairing for a cross-sandbox %s restore (#7431)",
    async (agent) => {
      vi.spyOn(console, "log").mockImplementation(() => {});
      const agentPackage = harnessPackage(agent, agent === "hermes" ? "b" : "c");
      configureCloneRegistry(packageManagedSandbox("alpha", agentPackage));
      f.parseLiveSandboxNamesMock.mockReturnValue(new Set(["alpha"]));
      f.captureOpenshellMock.mockImplementation((args) =>
        f.openshellResponses(args, {
          "sandbox exec": { status: 0, output: f.dcodeProbeOutput("no-runtime") },
          "sandbox list": { status: 0, output: "alpha Ready\nbeta Ready\n" },
        }),
      );
      f.getLatestBackupMock.mockReturnValue({ ...f.latestBackupFixture, agentType: agent });
      f.restoreSandboxStateMock.mockReturnValue({
        success: true,
        restoredDirs: ["workspace"],
        restoredFiles: [],
        failedDirs: [],
        failedFiles: [],
      });
      const { runSandboxSnapshot } = await import("./snapshot");

      await runSandboxSnapshot("alpha", { kind: "restore", to: "beta", yes: true });

      expectSnapshotStateRestore("beta");
      expect(f.establishRestoredSandboxGatewayPairingMock).not.toHaveBeenCalled();
    },
  );

  it("leaves the working gateway credentials untouched on a self-restore", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    f.getSandboxMock.mockReturnValue(packageManagedSandbox("alpha", OPENCLAW_PACKAGE));
    f.getLatestBackupMock.mockReturnValue({ ...f.latestBackupFixture });
    f.restoreSandboxStateMock.mockReturnValue({
      success: true,
      restoredDirs: ["workspace"],
      restoredFiles: ["user.md"],
      failedDirs: [],
      failedFiles: [],
    });
    const { runSandboxSnapshot } = await import("./snapshot");

    await runSandboxSnapshot("alpha", { kind: "restore" });

    expectSnapshotStateRestore("alpha");
    expect(f.establishRestoredSandboxGatewayPairingMock).not.toHaveBeenCalled();
  });
});
