// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { createDeploymentVerificationCommandExecutor } from "./deployment-exec";

describe("final deployment command executor", () => {
  it("pins the gateway and enables the identity-checked local fallback", () => {
    const execute = vi.fn(() => ({ status: 0, stderr: "", stdout: "200" }));
    const executeDeploymentProbe = createDeploymentVerificationCommandExecutor(
      "nemoclaw-18133",
      execute,
    );

    expect(executeDeploymentProbe("alpha", "probe")).toEqual({
      status: 0,
      stderr: "",
      stdout: "200",
    });
    expect(execute).toHaveBeenCalledExactlyOnceWith("alpha", "probe", 15_000, {
      allowLocalDockerFallback: true,
      gatewayName: "nemoclaw-18133",
    });
  });

  it("does not hide a fail-closed identity refusal", () => {
    const refusal = new Error("sandbox identity changed");
    const execute = vi.fn(() => {
      throw refusal;
    });
    const executeDeploymentProbe = createDeploymentVerificationCommandExecutor(
      "nemoclaw-18133",
      execute,
    );

    expect(() => executeDeploymentProbe("alpha", "probe")).toThrow(refusal);
  });
});
