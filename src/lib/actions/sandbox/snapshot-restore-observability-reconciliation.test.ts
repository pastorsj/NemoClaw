// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as f from "./snapshot-restore-test-fixture";

const DCODE_PACKAGE = {
  kind: "agent-runtime" as const,
  id: "langchain-deepagents-code",
  packageVersion: "1.2.3",
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
describe("runSandboxSnapshot restore: observability policy reconciliation", () => {
  it("does not promote a forged snapshot digest into trusted-private pin authority", async () => {
    const content =
      "network_policies:\n  private-api:\n    endpoints:\n      - host: api.corp.example\n        allowed_ips:\n          - 10.20.30.40\n";
    const customPolicy = {
      name: "private-api",
      content,
      sourcePath: "/policies/private-api.yaml",
      trustedPrivatePins: {
        version: 1 as const,
        contentDigest: "a".repeat(64),
      },
    };
    f.getSandboxMock.mockReturnValue({
      name: "alpha",
      agent: "langchain-deepagents-code",
      harnessPackage: DCODE_PACKAGE,
      policyTier: "balanced",
    } as never);
    f.getLatestBackupMock.mockReturnValue({
      ...DCODE_SNAPSHOT,
      policyPresets: [customPolicy.name],
      customPolicies: [customPolicy],
    });
    f.getCustomPoliciesMock.mockReturnValue([]);
    f.applyPresetContentMock.mockReturnValue(false);
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { runSandboxSnapshot } = await import("./snapshot");

    await runSandboxSnapshot("alpha", { kind: "restore" });

    expect(f.applyPresetContentMock).toHaveBeenCalledWith(
      "alpha",
      customPolicy.name,
      customPolicy.content,
      {
        custom: { sourcePath: customPolicy.sourcePath },
        nonFatal: true,
        skipRegistryUpdate: true,
      },
    );
    expect(consoleWarn.mock.calls.flat().join("\n")).toContain("private-api (apply failed)");
  });

  it("does not resurrect an earlier removed preset while restoring unverified OTLP attribution", async () => {
    let registryEntry = {
      name: "alpha",
      agent: "langchain-deepagents-code",
      harnessPackage: DCODE_PACKAGE,
      observabilityEnabled: false,
      policyTier: "balanced",
      policies: ["github", "observability-otlp-local"],
    };
    f.getSandboxMock.mockImplementation(() => registryEntry as never);
    f.getLatestBackupMock.mockReturnValue({
      ...DCODE_SNAPSHOT,
      policyPresets: [],
    });
    f.getAppliedPresetsMock.mockReturnValue(["github", "observability-otlp-local"]);
    f.getPresetContentGatewayStateMock.mockReturnValue("match");
    f.removePresetMock
      .mockImplementationOnce((_sandboxName, presetName) => {
        expect(presetName).toBe("github");
        return true;
      })
      .mockReturnValue(true);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { runSandboxSnapshot } = await import("./snapshot");

    await runSandboxSnapshot("alpha", { kind: "restore" });

    expect(f.removePresetMock.mock.calls.map((call) => call[1])).toEqual([
      "github",
      "observability-otlp-local",
    ]);
    expect(f.updateSandboxIfCurrentMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ name: "alpha" }),
      { policies: ["observability-otlp-local"] },
    );
    expect(registryEntry.policies).toEqual(["observability-otlp-local"]);
  });

  it.each([
    {
      label: "records an exact live enabled policy",
      observabilityEnabled: true,
      liveState: "match" as const,
      policies: ["npm"],
      expectedPolicies: ["npm", "observability-otlp-local"],
    },
    {
      label: "prunes an exact absent disabled policy",
      observabilityEnabled: false,
      liveState: "absent" as const,
      policies: ["npm", "observability-otlp-local"],
      expectedPolicies: ["npm"],
    },
  ])(
    "repairs stale OTLP registry state: $label",
    async ({ observabilityEnabled, liveState, policies: recordedPolicies, expectedPolicies }) => {
      f.getSandboxMock.mockReturnValue({
        name: "alpha",
        agent: "langchain-deepagents-code",
        harnessPackage: DCODE_PACKAGE,
        observabilityEnabled,
        policyTier: "balanced",
        policies: recordedPolicies,
      } as never);
      f.getLatestBackupMock.mockReturnValue({
        ...DCODE_SNAPSHOT,
        policyPresets: ["npm"],
      });
      f.getAppliedPresetsMock.mockReturnValue(recordedPolicies);
      f.getPresetContentGatewayStateMock.mockReturnValue(liveState);
      const { runSandboxSnapshot } = await import("./snapshot");

      await runSandboxSnapshot("alpha", { kind: "restore" });

      expect(f.updateSandboxIfCurrentMock).toHaveBeenCalledWith(
        expect.objectContaining({ name: "alpha" }),
        { policies: expectedPolicies },
      );
      expect(f.applyPresetMock).not.toHaveBeenCalledWith("alpha", "observability-otlp-local");
      expect(f.removePresetMock).not.toHaveBeenCalledWith("alpha", "observability-otlp-local");
    },
  );

  it("does not let a same-name, different-key custom replay suppress stale built-in OTLP cleanup", async () => {
    const customPolicy = {
      name: "observability-otlp-local",
      content: "network_policies:\n  operator-collector: {}\n",
      sourcePath: "/policies/operator-collector.yaml",
    };
    f.getSandboxMock.mockReturnValue({
      name: "alpha",
      agent: "langchain-deepagents-code",
      harnessPackage: DCODE_PACKAGE,
      observabilityEnabled: false,
      policyTier: "balanced",
    } as never);
    f.getLatestBackupMock.mockReturnValue({
      ...DCODE_SNAPSHOT,
      policyPresets: [customPolicy.name],
      customPolicies: [customPolicy],
    });
    f.getCustomPoliciesMock.mockReturnValueOnce([]).mockReturnValue([customPolicy]);
    f.getAppliedPresetsMock.mockReturnValue(["observability-otlp-local"]);
    f.getPresetContentGatewayStateMock.mockReturnValueOnce("match").mockReturnValueOnce("absent");
    const { runSandboxSnapshot } = await import("./snapshot");

    await runSandboxSnapshot("alpha", { kind: "restore" });

    expect(f.applyPresetContentMock).toHaveBeenCalledWith(
      "alpha",
      customPolicy.name,
      customPolicy.content,
      {
        custom: { sourcePath: customPolicy.sourcePath },
        nonFatal: true,
        skipRegistryUpdate: true,
      },
    );
    expect(f.removePresetMock).toHaveBeenCalledTimes(1);
    expect(f.removePresetMock).toHaveBeenCalledWith("alpha", "observability-otlp-local", {
      nonFatal: true,
      skipRegistryUpdate: true,
    });
    expect(f.applyPresetMock).not.toHaveBeenCalledWith("alpha", customPolicy.name);
    expect(f.updateSandboxIfCurrentMock).toHaveBeenCalledTimes(1);
  });

  it("lets successfully replayed corp-otel content own its exact live OTLP key", async () => {
    const customPolicy = {
      name: "corp-otel",
      content:
        "network_policies:\n  observability-otlp-local:\n    endpoints:\n      - host: collector.corp.example\n",
      sourcePath: "/policies/corp-otel.yaml",
    };
    f.getSandboxMock.mockReturnValue({
      name: "alpha",
      agent: "langchain-deepagents-code",
      harnessPackage: DCODE_PACKAGE,
      observabilityEnabled: false,
      policyTier: "balanced",
      policies: ["npm", "observability-otlp-local"],
    } as never);
    f.getLatestBackupMock.mockReturnValue({
      ...DCODE_SNAPSHOT,
      policyPresets: ["npm", "observability-otlp-local"],
      customPolicies: [customPolicy],
    });
    f.getCustomPoliciesMock.mockReturnValueOnce([]).mockReturnValue([customPolicy]);
    f.getAppliedPresetsMock.mockReturnValue(["npm", "corp-otel", "observability-otlp-local"]);
    f.getPresetContentGatewayStateMock.mockImplementation((_sandbox, content) =>
      content === customPolicy.content ? "match" : "drift",
    );
    const { runSandboxSnapshot } = await import("./snapshot");
    await runSandboxSnapshot("alpha", { kind: "restore" });

    expect(f.applyPresetContentMock).toHaveBeenCalledWith(
      "alpha",
      customPolicy.name,
      customPolicy.content,
      {
        custom: { sourcePath: customPolicy.sourcePath },
        nonFatal: true,
        skipRegistryUpdate: true,
      },
    );
    expect(f.applyPresetMock).not.toHaveBeenCalledWith("alpha", "observability-otlp-local");
    expect(f.removePresetMock).not.toHaveBeenCalledWith("alpha", "observability-otlp-local");
    expect(f.removePresetMock).not.toHaveBeenCalledWith("alpha", customPolicy.name);
    expect(f.updateSandboxIfCurrentMock).toHaveBeenCalledWith(
      expect.objectContaining({ name: "alpha" }),
      { policies: ["npm"] },
    );
    expect(f.getPresetContentGatewayStateMock).toHaveBeenCalledTimes(1);
    expect(f.getPresetContentGatewayStateMock.mock.calls[0]?.[1]).toBe(customPolicy.content);
    expect(f.getPresetContentGatewayStateMock.mock.calls[0]?.[2]).toBe("observability-otlp-local");
  });

  it("does not let a failed corp-otel replay suppress stale built-in OTLP cleanup", async () => {
    const customPolicy = {
      name: "corp-otel",
      content:
        "network_policies:\n  observability-otlp-local:\n    endpoints:\n      - host: collector.corp.example\n",
      sourcePath: "/policies/corp-otel.yaml",
    };
    f.getSandboxMock.mockReturnValue({
      name: "alpha",
      agent: "langchain-deepagents-code",
      harnessPackage: DCODE_PACKAGE,
      observabilityEnabled: false,
      policyTier: "balanced",
      policies: ["npm", "observability-otlp-local"],
    } as never);
    f.getLatestBackupMock.mockReturnValue({
      ...DCODE_SNAPSHOT,
      policyPresets: ["npm", "observability-otlp-local"],
      customPolicies: [customPolicy],
    });
    f.getAppliedPresetsMock.mockReturnValue(["npm", "observability-otlp-local"]);
    f.applyPresetContentMock.mockReturnValue(false);
    f.getPresetContentGatewayStateMock.mockReturnValueOnce("match").mockReturnValueOnce("absent");
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { runSandboxSnapshot } = await import("./snapshot");

    await runSandboxSnapshot("alpha", { kind: "restore" });

    expect(consoleWarn.mock.calls.flat().join("\n")).toContain("corp-otel (apply failed)");
    expect(f.removePresetMock).toHaveBeenCalledWith("alpha", "observability-otlp-local", {
      nonFatal: true,
      skipRegistryUpdate: true,
    });
    expect(f.getPresetContentGatewayStateMock).toHaveBeenCalledTimes(2);
    expect(f.getPresetContentGatewayStateMock).toHaveBeenCalledWith(
      "alpha",
      f.builtinObservabilityPolicy,
    );
  });

  it("aborts preset reconciliation when custom OTLP ownership is unreadable", async () => {
    const currentCustomPolicy = {
      name: "corp-otel",
      content: "network_policies:\n  observability-otlp-local: {}\n",
      sourcePath: "/policies/old-collector.yaml",
    };
    f.getSandboxMock.mockReturnValue({
      name: "alpha",
      agent: "langchain-deepagents-code",
      harnessPackage: DCODE_PACKAGE,
      observabilityEnabled: true,
      policyTier: "balanced",
    } as never);
    f.getLatestBackupMock.mockReturnValue({
      ...DCODE_SNAPSHOT,
      policyPresets: [],
      customPolicies: [],
    });
    f.getCustomPoliciesMock.mockReturnValue([currentCustomPolicy]);
    f.removePresetMock.mockReturnValue(false);
    f.getPresetContentGatewayStateMock.mockImplementation((_sandbox, content) =>
      content === currentCustomPolicy.content ? null : "absent",
    );
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { runSandboxSnapshot } = await import("./snapshot");
    await runSandboxSnapshot("alpha", { kind: "restore" });
    expect(f.removePresetMock).toHaveBeenCalledWith("alpha", currentCustomPolicy.name, {
      nonFatal: true,
      skipRegistryUpdate: true,
    });
    expect(f.applyPresetMock).not.toHaveBeenCalledWith("alpha", "observability-otlp-local");
    expect(consoleWarn.mock.calls.flat().join("\n")).toContain(
      "leaving live policy presets unchanged",
    );
  });
  it.each(["drift", null] as const)(
    "does not remove built-in OTLP when its exact live content state is %s",
    async (gatewayState) => {
      f.getSandboxMock.mockReturnValue({
        name: "alpha",
        agent: "langchain-deepagents-code",
        harnessPackage: DCODE_PACKAGE,
        observabilityEnabled: false,
        policyTier: "balanced",
      } as never);
      f.getLatestBackupMock.mockReturnValue({
        ...DCODE_SNAPSHOT,
        policyPresets: ["observability-otlp-local"],
      });
      f.getAppliedPresetsMock.mockReturnValue(["observability-otlp-local"]);
      f.getPresetContentGatewayStateMock.mockReturnValue(gatewayState);
      const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const { runSandboxSnapshot } = await import("./snapshot");

      await runSandboxSnapshot("alpha", { kind: "restore" });

      expect(f.removePresetMock).not.toHaveBeenCalled();
      expect(consoleWarn.mock.calls.flat().join("\n")).toContain(
        "leaving its live policy content unchanged",
      );
    },
  );

  it("normalizes a legacy restricted tier before deciding built-in OTLP egress", async () => {
    f.getSandboxMock.mockReturnValue({
      name: "alpha",
      agent: "langchain-deepagents-code",
      harnessPackage: DCODE_PACKAGE,
      observabilityEnabled: true,
      policyTier: " Restricted ",
    } as never);
    f.getLatestBackupMock.mockReturnValue({
      ...DCODE_SNAPSHOT,
      policyPresets: [],
    });
    const { runSandboxSnapshot } = await import("./snapshot");

    await runSandboxSnapshot("alpha", { kind: "restore" });

    expect(f.applyPresetMock).not.toHaveBeenCalledWith("alpha", "observability-otlp-local");
  });
});
