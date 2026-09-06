// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  recoverNamedGatewayRuntime: vi.fn(),
  replaceOpenShellRuntimeSelectionEnv: vi.fn(),
}));

vi.mock("../../../gateway-runtime-action", () => ({
  recoverNamedGatewayRuntime: mocks.recoverNamedGatewayRuntime,
  replaceOpenShellRuntimeSelectionEnv: mocks.replaceOpenShellRuntimeSelectionEnv,
}));

vi.mock("../gateway-target", () => ({
  getSandboxTargetGatewayName: () => "nemoclaw-8091",
}));

import { ensureSandboxGatewaySelected } from "./gateway-selection";

const runtimeSelection = {
  gatewayName: "nemoclaw-8091",
  workspace: "default",
} as const;

describe("MCP gateway selection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("pins later commands after selecting the recorded healthy gateway", async () => {
    mocks.recoverNamedGatewayRuntime.mockResolvedValue({
      recovered: true,
      before: { state: "absent" },
      after: { state: "healthy_named" },
    });

    await expect(ensureSandboxGatewaySelected("alpha", runtimeSelection)).resolves.toBeUndefined();

    expect(mocks.recoverNamedGatewayRuntime).toHaveBeenCalledWith({
      gatewayName: "nemoclaw-8091",
      runtimeSelection,
    });
    expect(mocks.replaceOpenShellRuntimeSelectionEnv).toHaveBeenCalledWith(
      process.env,
      runtimeSelection,
    );
  });

  it("refuses MCP mutation when the recorded gateway cannot become healthy", async () => {
    mocks.recoverNamedGatewayRuntime.mockResolvedValue({
      recovered: false,
      before: { state: "unhealthy_named" },
      after: { state: "unhealthy_named" },
    });

    await expect(ensureSandboxGatewaySelected("alpha", runtimeSelection)).rejects.toThrow(
      "Could not select healthy OpenShell gateway 'nemoclaw-8091' for sandbox 'alpha'",
    );
    expect(mocks.replaceOpenShellRuntimeSelectionEnv).not.toHaveBeenCalled();
  });
});
