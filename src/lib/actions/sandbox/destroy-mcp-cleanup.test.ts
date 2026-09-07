// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  expectAbsentSandboxMcpFinalize,
  expectFailedMcpFinalizePreservesRegistry,
  expectFailedMcpRestorePreservesDestroyFailure,
  expectMcpFinalizeAfterDelete,
  expectMcpFinalizeBridgeErrorReturnsFailure,
  expectMcpPrepareBridgeErrorAborts,
  expectMcpRestoreAfterDeleteFailure,
} from "../../../../test/helpers/destroy-flow-test-assertions";
import {
  createDestroyHarness,
  resetDestroyModuleCache,
} from "../../../../test/helpers/destroy-flow-test-harness";

describe("destroySandbox MCP cleanup", () => {
  let originalGatewayEnv: string | undefined;

  beforeEach(() => {
    originalGatewayEnv = process.env.OPENSHELL_GATEWAY;
    vi.spyOn(process, "exit").mockImplementation(((code?: number | string | null) => {
      throw new Error(`process.exit(${code ?? 0})`);
    }) as never);
  });

  afterEach(() => {
    originalGatewayEnv === undefined
      ? delete process.env.OPENSHELL_GATEWAY
      : (process.env.OPENSHELL_GATEWAY = originalGatewayEnv);
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    resetDestroyModuleCache();
  });

  it("preserves a no-receipt row when legacy provider cleanup does not converge", async () => {
    const harness = createDestroyHarness({
      providerDeleteStatus: 1,
      providerDeleteOutput: "gateway timeout",
      skipForwardPortVerification: true,
    });

    await expect(harness.destroySandbox("alpha", { yes: true })).rejects.toThrow(
      "cleanup did not converge",
    );

    expect(harness.removeSandboxSpy).not.toHaveBeenCalled();
  });

  it("preserves a receipt row when a same-name provider has unrelated metadata", async () => {
    const harnessPackage = {
      kind: "agent-runtime" as const,
      id: "openclaw",
      packageVersion: "1.0.0",
      contentDigest: "a".repeat(64),
    };
    const harness = createDestroyHarness({
      receiptProviderCleanupError:
        "Receipt-backed provider cleanup authority is invalid: provider 'alpha-discord-bridge' does not match its persisted binding.",
      registryEntryOverrides: { harnessPackage },
    });

    await expect(harness.destroySandbox("alpha", { yes: true })).rejects.toThrow("process.exit(1)");

    expect(harness.executeSandboxDestroySpy).not.toHaveBeenCalled();
    expect(harness.removeSandboxSpy).not.toHaveBeenCalled();
    expect(
      harness.runOpenshellSpy.mock.calls.some(
        ([args]) => Array.isArray(args) && args[0] === "provider" && args[1] === "delete",
      ),
    ).toBe(false);
    expect(harness.errorSpy.mock.calls.map((call) => String(call[0])).join("\n")).toContain(
      "does not match its persisted binding",
    );
  });

  it("detaches MCP providers before delete and finalizes them only after delete succeeds", async () => {
    const harness = createDestroyHarness({ mcpServers: ["github", "slack"] });

    await harness.destroySandbox("alpha", { yes: true });

    expectMcpFinalizeAfterDelete(harness);
  });

  it("restores MCP runtime state when sandbox delete fails", async () => {
    const harness = createDestroyHarness({
      deleteStatus: 7,
      deleteOutput: "delete failed",
      mcpServers: ["github"],
    });

    await expect(harness.destroySandbox("alpha", { yes: true })).rejects.toThrow("process.exit(7)");

    expectMcpRestoreAfterDeleteFailure(harness);
  });

  it("preserves destroy failure when MCP rollback fails", async () => {
    const harness = createDestroyHarness({
      deleteStatus: 7,
      deleteOutput: "delete failed",
      mcpServers: ["github"],
      restoreMcpError: "injected MCP restore failure",
    });

    await expect(harness.destroySandbox("alpha", { yes: true })).rejects.toThrow("process.exit(7)");

    expectFailedMcpRestorePreservesDestroyFailure(harness);
  });

  it("preserves the registry when post-delete MCP cleanup fails, even with force", async () => {
    const harness = createDestroyHarness({
      finalizeMcpError: "provider delete failed",
      mcpServers: ["github"],
    });

    await expect(harness.destroySandbox("alpha", { yes: true, force: true })).rejects.toThrow(
      "provider delete failed",
    );

    expectFailedMcpFinalizePreservesRegistry(harness);
  });

  it("finalizes exact MCP providers when the sandbox was already externally removed", async () => {
    const harness = createDestroyHarness({
      deleteStatus: 1,
      deleteOutput: "Error: sandbox alpha not found",
      mcpServers: ["github"],
      sandboxPresent: false,
    });

    await expect(harness.destroySandbox("alpha", { yes: true })).resolves.toBeUndefined();

    expectAbsentSandboxMcpFinalize(harness);
  });

  it("exits with code 1 when MCP bridge prepare throws McpBridgeError, gateway down (#8103)", async () => {
    const harness = createDestroyHarness({
      mcpServers: ["github"],
      prepareMcpBridgeError: "Could not inspect OpenShell provider: gateway unreachable",
    });

    await expect(harness.destroySandbox("alpha", { yes: true })).rejects.toThrow("process.exit(1)");

    expectMcpPrepareBridgeErrorAborts(harness);
  });

  it("redacts MCP bridge finalize errors after sandbox deletion (#8103)", async () => {
    const secretMarker = "destroy-secret-marker";
    const harness = createDestroyHarness({
      mcpServers: ["github"],
      finalizeMcpBridgeError: `Could not inspect OpenShell provider: OPENAI_API_KEY=${secretMarker}`,
    });

    await expect(harness.destroySandbox("alpha", { yes: true })).rejects.toThrow("process.exit(1)");

    expectMcpFinalizeBridgeErrorReturnsFailure(harness, secretMarker);
  });

  it("retires retained MCP state when destroy retries after finalization failure (#8103)", async () => {
    const harness = createDestroyHarness({
      mcpServers: ["github"],
      finalizeMcpBridgeError: "Could not inspect OpenShell provider: gateway unreachable",
    });

    await expect(harness.destroySandbox("alpha", { yes: true })).rejects.toThrow("process.exit(1)");

    harness.setSandboxPresent(false);
    harness.finalizeMcpBridgesAfterSandboxDeleteSpy.mockResolvedValue(undefined);

    await expect(
      harness.destroySandbox("alpha", { yes: true, cleanupGateway: true }),
    ).resolves.toBeUndefined();

    expect(harness.prepareMcpBridgesForAbsentSandboxDestroySpy).toHaveBeenCalledWith("alpha", {
      force: false,
      runtimeSelection: expect.objectContaining({
        gatewayName: "nemoclaw-19080",
        workspace: "default",
      }),
    });
    expect(harness.finalizeMcpBridgesAfterSandboxDeleteSpy).toHaveBeenCalledTimes(2);
    expect(harness.removeSandboxSpy).toHaveBeenCalledWith("alpha");
    expect(harness.compareAndSwapSessionSpy).toHaveBeenCalledOnce();
    expect(harness.updateSessionSpy).not.toHaveBeenCalled();
    expect(harness.cleanupGatewaySpy).toHaveBeenCalledWith("nemoclaw-19080", expect.any(Function));
  });
});
