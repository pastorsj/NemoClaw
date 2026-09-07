// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";

import {
  connectModulePath,
  createConnectHarness,
  requireDist,
} from "../../../../test/support/connect-flow-test-harness";

describe("connectSandbox recovery diagnostics", () => {
  let exitSpy: MockInstance;
  const originalStdinIsTty = process.stdin.isTTY;
  const originalStdinSetRawMode = (
    process.stdin as typeof process.stdin & { setRawMode?: (mode: boolean) => unknown }
  ).setRawMode;
  const originalStdoutIsTty = process.stdout.isTTY;

  beforeEach(() => {
    process.env.NEMOCLAW_TEST_NO_SLEEP = "1";
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
    exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number | string | null) => {
      throw new Error(`process.exit(${code ?? 0})`);
    }) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      value: originalStdoutIsTty,
    });
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: originalStdinIsTty,
    });
    Object.defineProperty(process.stdin, "setRawMode", {
      configurable: true,
      value: originalStdinSetRawMode,
    });
    delete process.env.NEMOCLAW_TEST_NO_SLEEP;
    delete require.cache[requireDist.resolve(connectModulePath)];
  });

  it("does not suggest a manual forward when gateway recovery fails before forward start", async () => {
    const harness = createConnectHarness({
      processCheck: {
        checked: true,
        wasRunning: false,
        recovered: false,
        forwardRecovered: false,
        recoveryFailureDetail:
          "the replacement container identity changed during the final managed supervisor health check",
      },
    });

    await expect(harness.connectSandbox("alpha", { probeOnly: true })).rejects.toThrow(
      "process.exit(1)",
    );

    const errorOutput = harness.errorSpy.mock.calls.map((call) => String(call[0] ?? "")).join("\n");
    expect(errorOutput).toContain("NemoClaw could not recover the OpenClaw gateway in 'alpha'");
    expect(errorOutput).toContain(
      "the replacement container identity changed during the final managed supervisor health check",
    );
    expect(errorOutput).not.toContain("gateway is running");
    expect(errorOutput).not.toContain("openshell forward start");
    expect(harness.runAutoPairSpy).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it.each([
    {
      condition: "a Docker final-handoff failure",
      expectedDetail:
        "Docker could not start the replacement container to complete the final recovery handoff",
      recoveryFailureDetail:
        "Docker could not start the replacement container to complete the final recovery handoff",
    },
    {
      condition: "a pinned replacement identity failure",
      expectedDetail:
        "the replacement container identity changed during the final managed supervisor health check",
      recoveryFailureDetail:
        "the replacement container identity changed during the final managed supervisor health check",
    },
    {
      condition: "an OpenShell readiness failure",
      expectedDetail: "the replacement container did not become ready in OpenShell",
      recoveryFailureDetail:
        "the replacement container did not become ready in OpenShell\nAuthorization: Bearer opaque-connect-recovery-token\u001b[31m",
    },
    {
      condition: "an unconfirmed rollback after a gateway wait failure",
      expectedDetail: "NemoClaw could not confirm rollback to the previous sandbox container",
      recoveryFailureDetail:
        "NemoClaw could not confirm rollback to the previous sandbox container. Inspect Docker state before retrying. Recovery failure before rollback: the recovered gateway did not become responsive before the recovery timeout",
    },
    {
      condition: "a detail-free recovery failure",
      expectedDetail: "the gateway recovery attempt did not complete",
      recoveryFailureDetail: undefined,
    },
  ])(
    "stops non-probe connect before route repair, pairing, or SSH after $condition (#9364)",
    async ({ expectedDetail, recoveryFailureDetail }) => {
      const harness = createConnectHarness({
        registryEntry: { model: "qwen3-vl:4b", provider: "ollama-local" },
        processCheck: {
          checked: true,
          wasRunning: false,
          recovered: false,
          forwardRecovered: false,
          recoveryFailureDetail,
        },
      });

      await expect(harness.connectSandbox("alpha")).rejects.toThrow("process.exit(1)");

      const errorOutput = harness.errorSpy.mock.calls
        .map((call) => String(call[0] ?? ""))
        .join("\n");
      expect(errorOutput).toContain(
        "Recovery failed: NemoClaw could not recover the OpenClaw gateway in 'alpha'",
      );
      expect(errorOutput).toContain(expectedDetail);
      expect(errorOutput).not.toContain("opaque-connect-recovery-token");
      expect(errorOutput).not.toContain("\u001b");
      expect(harness.ensureOllamaAuthProxySpy).not.toHaveBeenCalled();
      expect(harness.findReachableOllamaHostSpy).not.toHaveBeenCalled();
      expect(harness.withGatewayRouteMutationLockSpy).not.toHaveBeenCalled();
      expect(harness.settlePortablePairingSpy).not.toHaveBeenCalled();
      expect(harness.runAutoPairSpy).not.toHaveBeenCalled();
      expect(harness.spawnSyncSpy).not.toHaveBeenCalledWith(
        "openshell",
        ["sandbox", "connect", "alpha"],
        expect.any(Object),
      );
      expect(exitSpy).toHaveBeenCalledWith(1);
    },
  );

  it("redacts untrusted gateway recovery details before reporting them", async () => {
    const opaqueToken = "opaque-gateway-recovery-token";
    const harness = createConnectHarness({
      processCheck: {
        checked: true,
        wasRunning: false,
        recovered: false,
        forwardRecovered: false,
        recoveryFailureDetail: `OpenShell failed\nAuthorization: Bearer ${opaqueToken}\u001b[31m`,
      },
    });

    await expect(harness.connectSandbox("alpha", { probeOnly: true })).rejects.toThrow(
      "process.exit(1)",
    );

    const errorOutput = harness.errorSpy.mock.calls.map((call) => String(call[0] ?? "")).join("\n");
    expect(errorOutput).toContain("Recovery detail:");
    expect(errorOutput).not.toContain(opaqueToken);
    expect(errorOutput).not.toContain("\u001b");
    expect(errorOutput).toMatch(/Recovery detail: .*\.$/mu);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("keeps a direct recovery failure detail separate from an earlier callback layer", () => {
    const harness = createConnectHarness();
    harness.checkAndRecoverSpy.mockImplementation(
      (
        _sandboxName: string,
        options?: {
          onRecoveryFailureLayer?: (layer: string, detail?: string) => void;
        },
      ) => {
        options?.onRecoveryFailureLayer?.("supervisor not running", "SUPERVISOR_NOT_RUNNING");
        return {
          checked: true,
          wasRunning: false,
          recovered: false,
          forwardRecovered: false,
          recoveryFailureDetail:
            "the managed supervisor health check for the recreated sandbox did not pass",
        };
      },
    );

    expect(harness.restoreSandboxStartupState("alpha")).toMatchObject({
      recoveryFailureDetail:
        "the managed supervisor health check for the recreated sandbox did not pass",
      recoveryFailureLayer: null,
    });
  });
});
