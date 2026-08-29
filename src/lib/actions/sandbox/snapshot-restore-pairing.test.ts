// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as f from "./snapshot-restore-test-fixture";
import {
  OPENCLAW_PACKAGE,
  configureCloneRegistry,
  expectSnapshotStateRestore,
  harnessPackage,
  packageManagedSandbox,
} from "./snapshot/lifecycle-test-fixture";

const tempHomes: string[] = [];
beforeEach(() => {
  f.resetSnapshotRestoreMocks();
});
afterEach(() => {
  f.cleanupSnapshotRestoreMocks();
  for (const tempHome of tempHomes.splice(0)) {
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});
describe("runSandboxSnapshot restore: gateway pairing on a freshly created destination", () => {
  const removedCustomPolicy = {
    name: "legacy-custom",
    content: "network_policies:\n  legacy-custom: {}\n",
    sourcePath: "/policies/legacy-custom.yaml",
  };
  const appliedCustomPolicy = {
    name: "new-custom",
    content: "network_policies:\n  new-custom: {}\n",
    sourcePath: "/policies/new-custom.yaml",
  };

  it.each([
    {
      label: "built-in preset application",
      snapshot: { ...f.latestBackupFixture, policyPresets: ["github"] },
      configureFailure: () => f.applyPresetMock.mockReturnValue(false),
      expectedWarning: "github (apply failed)",
      assertMutation: () =>
        expect(f.applyPresetMock).toHaveBeenCalledWith("beta", "github", {
          nonFatal: true,
          skipRegistryUpdate: true,
        }),
    },
    {
      label: "built-in OTLP removal",
      snapshot: { ...f.latestBackupFixture, policyPresets: [] },
      configureFailure: () => {
        f.getPresetContentGatewayStateMock.mockReturnValue("match");
        f.removePresetMock.mockReturnValue(false);
      },
      expectedWarning:
        "observability-otlp-local (remove failed; exact content still live after remove)",
      assertMutation: () =>
        expect(f.removePresetMock).toHaveBeenCalledWith("beta", "observability-otlp-local", {
          nonFatal: true,
          skipRegistryUpdate: true,
        }),
    },
    {
      label: "custom policy removal",
      snapshot: { ...f.latestBackupFixture, policyPresets: [], customPolicies: [] },
      configureFailure: () => {
        f.getCustomPoliciesMock.mockReturnValue([removedCustomPolicy]);
        f.removePresetMock.mockReturnValue(false);
      },
      expectedWarning: "legacy-custom (remove failed)",
      assertMutation: () =>
        expect(f.removePresetMock).toHaveBeenCalledWith("beta", removedCustomPolicy.name, {
          nonFatal: true,
          skipRegistryUpdate: true,
        }),
    },
    {
      label: "custom policy application",
      snapshot: {
        ...f.latestBackupFixture,
        policyPresets: [],
        customPolicies: [appliedCustomPolicy],
      },
      configureFailure: () => f.applyPresetContentMock.mockReturnValue(false),
      expectedWarning: "new-custom (apply failed)",
      assertMutation: () =>
        expect(f.applyPresetContentMock).toHaveBeenCalledWith(
          "beta",
          appliedCustomPolicy.name,
          appliedCustomPolicy.content,
          {
            custom: { sourcePath: appliedCustomPolicy.sourcePath },
            nonFatal: true,
            skipRegistryUpdate: true,
          },
        ),
    },
  ])(
    "warns before gateway pairing and continues after $label failure (#8210)",
    async ({ snapshot, configureFailure, expectedWarning, assertMutation }) => {
      const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-snapshot-pairing-"));
      tempHomes.push(tempHome);
      vi.stubEnv("HOME", tempHome);
      vi.spyOn(console, "log").mockImplementation(() => {});
      const events: string[] = [];
      const consoleWarn = vi.spyOn(console, "warn").mockImplementation((...args) => {
        events.push(`warn:${args.join(" ")}`);
      });
      f.establishRestoredSandboxGatewayPairingMock.mockImplementation(() => {
        events.push("pairing");
      });
      const alphaEntry = packageManagedSandbox("alpha", OPENCLAW_PACKAGE);
      f.modelPendingCloneRegistry((name) => (name === "alpha" ? alphaEntry : null));
      f.parseLiveSandboxNamesMock.mockReturnValue(new Set(["alpha"]));
      f.captureOpenshellMock.mockImplementation((args) =>
        f.openshellResponses(args, {
          "sandbox exec": { status: 0, output: f.dcodeProbeOutput("no-runtime") },
          "sandbox list": { status: 0, output: "alpha Ready\nbeta Ready\n" },
        }),
      );
      f.getLatestBackupMock.mockReturnValue(snapshot);
      configureFailure();
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
      assertMutation();
      expect(consoleWarn.mock.calls.flat().join("\n")).toContain(expectedWarning);
      const warningIndex = events.findIndex((event) => event.includes(expectedWarning));
      expect(warningIndex).toBeGreaterThanOrEqual(0);
      expect(warningIndex).toBeLessThan(events.indexOf("pairing"));
      expect(f.establishRestoredSandboxGatewayPairingMock).toHaveBeenCalledWith("beta");
    },
  );

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
