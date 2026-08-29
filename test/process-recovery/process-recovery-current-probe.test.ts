// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import * as forwardHealth from "../../src/lib/actions/sandbox/forward-health.ts";
import { checkAndRecoverSandboxProcesses } from "../../src/lib/actions/sandbox/process-recovery.ts";
import * as openshellRuntime from "../../src/lib/adapters/openshell/runtime.ts";
import * as agentRuntime from "../../src/lib/agent/runtime.ts";
import * as registry from "../../src/lib/state/registry.ts";

const ACCEPTED_MANAGED_PROBE = {
  status: 0,
  stdout: "GATEWAY_PID=4242\n",
  stderr: "",
} as const;
const MISSING_MANAGED_SUPERVISOR = {
  status: 1,
  stdout: "",
  stderr: "SUPERVISOR_NOT_RUNNING",
} as const;

function pinnedIdentityRefusal(sandboxName: string) {
  return {
    status: 1,
    stdout: "",
    stderr: `MANAGED_CONTROL_IDENTITY_CHANGED\nOpenShell container identity changed for sandbox '${sandboxName}'; refusing privileged execution against a different container.`,
  } as const;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function mockOpenClawSandbox(sandboxName: string, healthTimeoutSeconds = 30) {
  vi.spyOn(agentRuntime, "getSessionAgent").mockReturnValue({
    name: "openclaw",
    displayName: "OpenClaw",
    forwardPort: 18789,
    healthProbe: {
      url: "http://127.0.0.1:18789/health",
      port: 18789,
      timeout_seconds: healthTimeoutSeconds,
    },
  } as never);
  vi.spyOn(registry, "getSandbox").mockReturnValue({
    name: sandboxName,
    agent: "openclaw",
    dashboardPort: 18789,
    openshellDriver: "docker",
  });
}

function setImmediateRecoveryPolling() {
  vi.stubEnv("NEMOCLAW_GATEWAY_RECOVERY_POLL_INTERVAL_SECONDS", "0");
  vi.stubEnv("NEMOCLAW_GATEWAY_RECOVERY_WAIT_SECONDS", "0");
  vi.stubEnv("NEMOCLAW_GATEWAY_RECOVERY_SETTLE_SECONDS", "0");
  vi.stubEnv("NEMOCLAW_FORWARD_RECOVERY_WAIT_MS", "0");
}

describe("checkAndRecoverSandboxProcesses current-probe reporting", () => {
  it("reports GATEWAY_UNSAFE_CONFIG_PATH after a transient identity refusal clears (#9364)", () => {
    mockOpenClawSandbox("current-probe-box");
    setImmediateRecoveryPolling();
    vi.stubEnv("NEMOCLAW_GATEWAY_RECOVERY_WAIT_SECONDS", "1");
    const finalize = vi.fn(() => ({ backupRemoved: true, rolledBack: false }));
    const relaunchManagedSupervisorSessionImpl = vi.fn(() => ({
      containerId: "replacement-container-id",
      finalize,
    }));
    const requestGatewaySupervisorAction = vi.fn(() => MISSING_MANAGED_SUPERVISOR);
    const unsafeConfigProbe = {
      status: 1,
      stdout: "",
      stderr: "GATEWAY_UNSAFE_CONFIG_PATH",
    } as const;
    const requestPinnedGatewaySupervisorAction = vi
      .fn()
      .mockReturnValueOnce(pinnedIdentityRefusal("current-probe-box"))
      .mockReturnValueOnce(ACCEPTED_MANAGED_PROBE)
      .mockReturnValueOnce(ACCEPTED_MANAGED_PROBE)
      .mockReturnValue(unsafeConfigProbe);
    const waitForRecreatedSandboxOpenShellReadyImpl = vi.fn(
      (_name, options) => options.beforeProbe?.(1000) === true,
    );
    vi.spyOn(forwardHealth, "isLocalForwardReachable").mockReturnValue(true);
    vi.spyOn(openshellRuntime, "captureOpenshell").mockReturnValue({
      status: 0,
      output:
        "SANDBOX  BIND  PORT  PID  STATUS\ncurrent-probe-box  127.0.0.1  18789  12345  running",
    });
    const runOpenshell = vi
      .spyOn(openshellRuntime, "runOpenshell")
      .mockReturnValue({ status: 0 } as never);

    const result = checkAndRecoverSandboxProcesses("current-probe-box", {
      quiet: true,
      isSandboxGatewayRunningImpl: () => false,
      requestGatewaySupervisorAction,
      requestPinnedGatewaySupervisorAction,
      relaunchManagedSupervisorSessionImpl,
      waitForRecreatedSandboxOpenShellReadyImpl,
    });

    expect(result).toMatchObject({
      checked: true,
      wasRunning: false,
      recovered: false,
      forwardRecovered: false,
      recoveryFailureDetail: expect.stringContaining(
        "unsafe config path: GATEWAY_UNSAFE_CONFIG_PATH",
      ),
    });
    expect("recoveryFailureDetail" in result ? result.recoveryFailureDetail : "").not.toContain(
      "identity changed",
    );
    expect(requestPinnedGatewaySupervisorAction).toHaveBeenCalledTimes(4);
    expect(finalize).toHaveBeenCalledWith(true);
    expect(runOpenshell).toHaveBeenCalledOnce();
  });
});
