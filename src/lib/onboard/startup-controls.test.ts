// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  hasSandboxApprovalModeDrift,
  hasSandboxObservabilityDrift,
  prepareSandboxApprovalCreatePlan,
  resolveSandboxApprovalMode,
} from "./managed-startup/startup-controls";

describe("sandbox startup controls", () => {
  it("resolves approval state for a declaring package without a harness ID", () => {
    expect(
      resolveSandboxApprovalMode({
        supported: true,
        requestedMode: "thread-opt-in",
        recordedMode: "disabled",
      }),
    ).toMatchObject({ value: "thread-opt-in", issue: null });
  });

  it("rejects approval enablement when the package does not declare the control", () => {
    expect(
      resolveSandboxApprovalMode({
        supported: false,
        requestedMode: "thread-opt-in",
        recordedMode: undefined,
      }),
    ).toMatchObject({ value: "disabled", issue: "unsupported-request" });
  });

  it("detects declared approval and observability drift without a harness ID", () => {
    expect(
      hasSandboxApprovalModeDrift({
        supported: true,
        liveExists: true,
        hasRegistryEntry: true,
        recordedMode: "disabled",
        requestedMode: "thread-opt-in",
      }),
    ).toBe(true);
    expect(
      hasSandboxObservabilityDrift({
        supported: true,
        liveExists: true,
        hasRegistryEntry: true,
        recordedEnabled: false,
        requestedEnabled: true,
      }),
    ).toBe(true);
  });

  it("fails closed when a declared approval control has malformed durable state", () => {
    const error = vi.fn();
    const exitProcess = vi.fn((code: number): never => {
      throw new Error(`exit ${String(code)}`);
    });
    expect(() =>
      prepareSandboxApprovalCreatePlan(
        {
          sandboxName: "future",
          supported: true,
          liveExists: true,
          registryEntry: { approvalMode: "always" },
          requestedMode: "disabled",
        },
        { error, exitProcess },
      ),
    ).toThrow("exit 1");
    expect(error).toHaveBeenCalledWith(expect.stringContaining("approval mode is invalid"));
  });
});
