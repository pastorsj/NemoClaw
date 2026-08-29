// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { testTimeoutOptions } from "../../../../test/helpers/timeouts";
import * as f from "./snapshot-restore-test-fixture";

const DCODE_PACKAGE = {
  kind: "agent-runtime" as const,
  id: "langchain-deepagents-code",
  packageVersion: "1.2.3",
  contractVersion: 1 as const,
  contentDigest: "c".repeat(64),
};
const DCODE_SNAPSHOT = {
  ...f.latestBackupFixture,
  version: 2,
  backupComplete: true,
  agentType: DCODE_PACKAGE.id,
  harnessPackage: DCODE_PACKAGE,
};

beforeEach(f.resetSnapshotRestoreMocks);
afterEach(f.cleanupSnapshotRestoreMocks);
describe("runSandboxSnapshot restore: observability policy replay", () => {
  it.each([
    { enabled: true, expectedValue: "1" },
    { enabled: false, expectedValue: "0" },
  ])(
    "starts a snapshot clone with the authoritative source observability state when enabled=$enabled",
    testTimeoutOptions(10_000),
    async ({ enabled, expectedValue }) => {
      vi.stubEnv("NEMOCLAW_OBSERVABILITY", "1");
      f.modelPendingCloneRegistry((name) =>
        name === "alpha"
          ? {
              name: "alpha",
              agent: "langchain-deepagents-code",
              harnessPackage: DCODE_PACKAGE,
              imageTag: "nemoclaw-alpha:test",
              openshellDriver: "docker",
              observabilityEnabled: enabled,
              provider: "nvidia-nim",
              model: "nvidia/model-a",
            }
          : null,
      );
      f.captureOpenshellMock.mockImplementation((args) =>
        f.openshellResponses(args, {
          "sandbox exec": { status: 0, output: f.dcodeProbeOutput("idle") },
          "sandbox list": { status: 0, output: "alpha Ready\nbeta Ready\n" },
        }),
      );
      f.parseLiveSandboxNamesMock.mockReturnValue(new Set(["alpha"]));
      f.getLatestBackupMock.mockReturnValue({ ...DCODE_SNAPSHOT });
      const { runSandboxSnapshot } = await import("./snapshot");
      await runSandboxSnapshot("alpha", { kind: "restore", to: "beta" });
      const createCall = f.streamSandboxCreateMock.mock.calls[0] ?? [];
      const createArgs = createCall[1] as readonly string[];
      const createEnv = createCall[2] as NodeJS.ProcessEnv | undefined;
      expect(createCall[0]).toBe("openshell");
      expect(createArgs).toContain(`NEMOCLAW_OBSERVABILITY=${expectedValue}`);
      expect(createEnv?.NEMOCLAW_OBSERVABILITY).toBeUndefined();
      expect(f.registerSandboxMock).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "beta",
          observabilityEnabled: enabled,
        }),
        undefined,
        { pending: true, expectedCurrent: null },
      );
      expect(f.applyPresetMock).toHaveBeenCalledTimes(enabled ? 1 : 0);
    },
  );

  it.each([
    { label: "recorded", policyPresets: ["npm"] },
    { label: "legacy", policyPresets: undefined },
  ])("adds built-in OTLP egress for a $label snapshot", async ({ policyPresets }) => {
    f.getSandboxMock.mockReturnValue({
      name: "alpha",
      agent: "langchain-deepagents-code",
      harnessPackage: DCODE_PACKAGE,
      observabilityEnabled: true,
      policyTier: "balanced",
    } as never);
    f.getLatestBackupMock.mockReturnValue({ ...DCODE_SNAPSHOT, policyPresets });
    f.getAppliedPresetsMock.mockReturnValue(["npm"]);
    const { runSandboxSnapshot } = await import("./snapshot");
    await runSandboxSnapshot("alpha", { kind: "restore" });
    expect(f.applyPresetMock).toHaveBeenCalledWith("alpha", "observability-otlp-local", {
      nonFatal: true,
      skipRegistryUpdate: true,
    });
    expect(f.removePresetMock).not.toHaveBeenCalled();
  });

  it("removes historical built-in OTLP egress when observability was disabled after the snapshot", async () => {
    f.getSandboxMock.mockReturnValue({
      name: "alpha",
      agent: "langchain-deepagents-code",
      harnessPackage: DCODE_PACKAGE,
      observabilityEnabled: false,
      policyTier: "balanced",
    } as never);
    f.getLatestBackupMock.mockReturnValue({
      ...DCODE_SNAPSHOT,
      policyPresets: ["npm", "observability-otlp-local"],
    });
    f.getAppliedPresetsMock.mockReturnValue(["npm", "observability-otlp-local"]);
    f.getPresetContentGatewayStateMock.mockReturnValueOnce("match").mockReturnValueOnce("absent");
    const { runSandboxSnapshot } = await import("./snapshot");

    await runSandboxSnapshot("alpha", { kind: "restore" });

    expect(f.removePresetMock).toHaveBeenCalledWith("alpha", "observability-otlp-local", {
      nonFatal: true,
      skipRegistryUpdate: true,
    });
    expect(f.applyPresetMock).not.toHaveBeenCalledWith("alpha", "observability-otlp-local");
  });

  it("removes an exact unrecorded built-in OTLP policy when observability is disabled", async () => {
    f.getSandboxMock.mockReturnValue({
      name: "alpha",
      agent: "langchain-deepagents-code",
      harnessPackage: DCODE_PACKAGE,
      observabilityEnabled: false,
      policyTier: "balanced",
      policies: [],
    } as never);
    f.getLatestBackupMock.mockReturnValue({ ...DCODE_SNAPSHOT, policyPresets: [] });
    f.getAppliedPresetsMock.mockReturnValue([]);
    f.getPresetContentGatewayStateMock.mockReturnValueOnce("match").mockReturnValueOnce("absent");
    const { runSandboxSnapshot } = await import("./snapshot");

    await runSandboxSnapshot("alpha", { kind: "restore" });

    expect(f.getPresetContentGatewayStateMock).toHaveBeenCalledWith(
      "alpha",
      f.builtinObservabilityPolicy,
    );
    expect(f.removePresetMock).toHaveBeenCalledWith("alpha", "observability-otlp-local", {
      nonFatal: true,
      skipRegistryUpdate: true,
    });
    expect(f.updateSandboxIfCurrentMock).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "returns false",
      configureRemoval: () => f.removePresetMock.mockReturnValue(false),
    },
    {
      label: "throws",
      configureRemoval: () =>
        f.removePresetMock.mockImplementation(() => {
          throw new Error("remove exploded");
        }),
    },
    {
      label: "claims success without removing",
      configureRemoval: () => f.removePresetMock.mockReturnValue(true),
    },
  ])("retains built-in OTLP attribution when removal $label", async ({ configureRemoval }) => {
    f.getSandboxMock.mockReturnValue({
      name: "alpha",
      agent: "langchain-deepagents-code",
      harnessPackage: DCODE_PACKAGE,
      observabilityEnabled: false,
      policyTier: "balanced",
      policies: [],
    } as never);
    f.getLatestBackupMock.mockReturnValue({
      ...DCODE_SNAPSHOT,
      policyPresets: [],
    });
    f.getAppliedPresetsMock.mockReturnValue([]);
    f.getPresetContentGatewayStateMock.mockReturnValue("match");
    configureRemoval();
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { runSandboxSnapshot } = await import("./snapshot");

    await runSandboxSnapshot("alpha", { kind: "restore" });

    expect(f.getPresetContentGatewayStateMock).toHaveBeenCalledTimes(2);
    expect(f.updateSandboxIfCurrentMock).toHaveBeenCalledWith(
      expect.objectContaining({ name: "alpha" }),
      { policies: ["observability-otlp-local"] },
    );
    expect(consoleWarn.mock.calls.flat().join("\n")).toContain(
      "exact content still live after remove",
    );
  });
});
