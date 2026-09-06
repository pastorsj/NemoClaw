// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { HarnessConfigAdapterHostModule } from "../agent-runtime/config-module";
import type { HarnessPackageIdentity } from "../agent-runtime/package/types";
import type { AgentConfigTarget } from "./agent-config";
import {
  inspectMutableConfigPerms,
  repairMutableConfigPerms,
  type MutableConfigPermsDependencies,
} from "./mutable-config-perms";

const TARGET: AgentConfigTarget = Object.freeze({
  agentName: "future-runtime",
  configDir: "/sandbox/.future",
  configFile: "config.json",
  configPath: "/sandbox/.future/config.json",
  format: "json",
  sensitiveFiles: ["/sandbox/.future/.config-hash"],
});

const IDENTITY: HarnessPackageIdentity = Object.freeze({
  kind: "agent-runtime",
  id: TARGET.agentName,
  packageVersion: "1.0.0",
  contentDigest: "a".repeat(64),
});

const STAT_PLAN = Object.freeze({
  kind: "stat" as const,
  directoryMode: "2770",
  directoryOwner: "sandbox:sandbox",
  fileMode: "660",
  fileOwner: "sandbox:sandbox",
  repair: null,
});

const PROBE_COMMAND = Object.freeze({
  command: Object.freeze(["/usr/local/lib/future/config-probe"]),
  timeoutSeconds: 20,
  failureMessage: "Future runtime mutable configuration probe failed.",
  success: Object.freeze({ kind: "exit-zero" as const }),
});

function successfulCommandResult() {
  return {
    status: 0,
    signal: null,
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
  };
}

function createPackageHarness(
  describeMutableConfig: HarnessConfigAdapterHostModule["describeMutableConfig"],
) {
  const adapter: HarnessConfigAdapterHostModule = {
    describeInferenceConfig: vi.fn(() => ({
      kind: "mutable" as const,
      providerApiOverrides: [],
    })),
    prepareInferenceConfig: vi.fn(),
    prepareConfigUpdate: vi.fn(),
    classifyConfigUrl: vi.fn(),
    describeMutableConfig: vi.fn(describeMutableConfig),
  };
  const resolveConfigTarget = vi.fn(() => TARGET);
  const loadConfigAdapter = vi.fn(() => ({ identity: IDENTITY, adapter }));
  const resolveResourceHandle = vi.fn(() => "provider-resource-1");
  const captureSandboxCommand = vi
    .fn<MutableConfigPermsDependencies["captureSandboxCommand"]>()
    .mockImplementation((_sandboxName, command) => {
      const selectedPath = command.at(-1);
      return Buffer.from(
        command[0] === "/usr/bin/id"
          ? "1000\n"
          : selectedPath === TARGET.configDir
            ? "2770 sandbox:sandbox\n"
            : "660 sandbox:sandbox\n",
      );
    });
  const executeSandboxCommand = vi
    .fn<MutableConfigPermsDependencies["executeSandboxCommand"]>()
    .mockReturnValue(successfulCommandResult());
  const dependencies: MutableConfigPermsDependencies = {
    resolveConfigTarget,
    loadConfigAdapter,
    resolveResourceHandle,
    captureSandboxCommand,
    executeSandboxCommand,
    withMutationLock: <Result>(_sandboxName: string, operation: () => Result) => operation(),
  };
  return {
    adapter,
    captureSandboxCommand,
    dependencies,
    executeSandboxCommand,
    loadConfigAdapter,
    resolveResourceHandle,
  };
}

function expectPinnedProviderCalls(
  calls: ReadonlyArray<Parameters<MutableConfigPermsDependencies["executeSandboxCommand"]>>,
): void {
  for (const call of calls) {
    expect(call[0]).toBe("alpha");
    expect(call[2]).toMatchObject({
      expectedResourceHandle: "provider-resource-1",
      sanitizeEnvironment: true,
    });
  }
}

describe("package mutable configuration execution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("inspects a typed stat plan through one pinned provider resource", () => {
    const harness = createPackageHarness(() => STAT_PLAN);

    const inspection = inspectMutableConfigPerms("alpha", harness.dependencies);

    expect(inspection).toMatchObject({
      applies: true,
      ok: true,
      inspectionMethod: "stat",
      issues: [],
    });
    expect(harness.captureSandboxCommand).toHaveBeenCalledTimes(3);
    expectPinnedProviderCalls(harness.captureSandboxCommand.mock.calls);
    expect(harness.resolveResourceHandle).toHaveBeenCalledOnce();
    expect(harness.executeSandboxCommand).not.toHaveBeenCalled();
  });

  it("executes a typed probe plan instead of treating it as a skip", () => {
    const harness = createPackageHarness(() => ({ kind: "probe", probe: PROBE_COMMAND }));

    const inspection = inspectMutableConfigPerms("alpha", harness.dependencies);

    expect(inspection).toEqual({
      applies: true,
      ok: true,
      inspectionMethod: "probe",
      configDir: TARGET.configDir,
      configFile: TARGET.configFile,
      issues: [],
    });
    expect(harness.executeSandboxCommand).toHaveBeenCalledExactlyOnceWith(
      "alpha",
      PROBE_COMMAND.command,
      expect.objectContaining({
        expectedResourceHandle: "provider-resource-1",
        sanitizeEnvironment: true,
        timeout: 20_000,
      }),
    );
    expect(harness.captureSandboxCommand).not.toHaveBeenCalled();
    expect(harness.resolveResourceHandle).toHaveBeenCalledOnce();
  });

  it("reports a package probe failure without exposing provider output", () => {
    const harness = createPackageHarness(() => ({ kind: "probe", probe: PROBE_COMMAND }));
    harness.executeSandboxCommand.mockReturnValue({
      ...successfulCommandResult(),
      status: 1,
      stderr: Buffer.from("private provider diagnostic"),
    });

    const inspection = inspectMutableConfigPerms("alpha", harness.dependencies);

    expect(inspection).toMatchObject({
      applies: true,
      ok: false,
      inspectionMethod: "probe",
      issues: [PROBE_COMMAND.failureMessage],
    });
    expect(JSON.stringify(inspection)).not.toContain("private provider diagnostic");
  });

  it("honors a typed not-required result without contacting the provider", () => {
    const harness = createPackageHarness(() => ({
      kind: "not-required",
      reason: "The image owns this configuration.",
    }));

    expect(inspectMutableConfigPerms("alpha", harness.dependencies)).toEqual({
      applies: false,
      skipReason: "agent",
      reason: "The image owns this configuration.",
    });
    expect(harness.resolveResourceHandle).not.toHaveBeenCalled();
    expect(harness.captureSandboxCommand).not.toHaveBeenCalled();
    expect(harness.executeSandboxCommand).not.toHaveBeenCalled();
  });

  it("repairs and verifies a stat contract against the same provider resource", () => {
    const repairCommand = {
      ...PROBE_COMMAND,
      command: ["/usr/local/lib/future/config-repair"],
      failureMessage: "Future runtime mutable configuration repair failed.",
    };
    const harness = createPackageHarness((request) => ({
      ...STAT_PLAN,
      repair:
        request.sandboxUid === null
          ? null
          : {
              ...repairCommand,
              command: [...repairCommand.command, request.sandboxUid, request.sandboxGid!],
            },
    }));

    const result = repairMutableConfigPerms("alpha", harness.dependencies);

    expect(result).toEqual({ applied: true, verified: true, errors: [] });
    expect(harness.executeSandboxCommand).toHaveBeenCalledExactlyOnceWith(
      "alpha",
      ["/usr/local/lib/future/config-repair", "1000", "1000"],
      expect.objectContaining({ expectedResourceHandle: "provider-resource-1" }),
    );
    expect(harness.captureSandboxCommand).toHaveBeenCalledTimes(5);
    expectPinnedProviderCalls(harness.captureSandboxCommand.mock.calls);
    expectPinnedProviderCalls(harness.executeSandboxCommand.mock.calls);
    expect(harness.resolveResourceHandle).toHaveBeenCalledOnce();
  });

  it("reports post-repair stat drift as failed verification", () => {
    const repairCommand = {
      ...PROBE_COMMAND,
      command: ["/usr/local/lib/future/config-repair"],
      failureMessage: "Future runtime mutable configuration repair failed.",
    };
    const harness = createPackageHarness((request) => ({
      ...STAT_PLAN,
      repair: request.sandboxUid === null ? null : repairCommand,
    }));
    harness.captureSandboxCommand.mockImplementation((_sandboxName, command) => {
      return Buffer.from(
        command[0] === "/usr/bin/id"
          ? "1000\n"
          : command.at(-1) === TARGET.configDir
            ? "0700 sandbox:sandbox\n"
            : "0600 sandbox:sandbox\n",
      );
    });

    const result = repairMutableConfigPerms("alpha", harness.dependencies);

    expect(result).toMatchObject({ applied: true, verified: false });
    expect(result.applied && result.errors.join("\n")).toContain("mode 0700 (expected 2770)");
    expect(result.applied && result.errors.join("\n")).toContain("mode 0600 (expected 660)");
    expect(harness.resolveResourceHandle).toHaveBeenCalledOnce();
  });

  it("returns the typed repair failure message and does not claim verification", () => {
    const repairCommand = {
      ...PROBE_COMMAND,
      command: ["/usr/local/lib/future/config-repair"],
      failureMessage: "Future runtime mutable configuration repair failed.",
    };
    const harness = createPackageHarness((request) => ({
      ...STAT_PLAN,
      repair: request.sandboxUid === null ? null : repairCommand,
    }));
    harness.executeSandboxCommand.mockReturnValue({
      ...successfulCommandResult(),
      status: 23,
      stderr: Buffer.from("private repair output"),
    });

    const result = repairMutableConfigPerms("alpha", harness.dependencies);

    expect(result).toEqual({
      applied: true,
      verified: false,
      errors: [repairCommand.failureMessage],
    });
    expect(JSON.stringify(result)).not.toContain("private repair output");
    expect(harness.resolveResourceHandle).toHaveBeenCalledOnce();
  });
});
