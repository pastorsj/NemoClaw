// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { loadAgent } from "../../agent/defs";
import type { SandboxEntry } from "../../state/registry";
import {
  LaunchReadinessObservationError,
  requireLaunchSemanticHealth,
  type LaunchReadinessHealthDeps,
} from "./launch-readiness/health";
import { isSandboxGatewayRunningForStatus } from "./process-recovery";

describe("launch-readiness gateway health scope", () => {
  it("pins the semantic gateway probe to the owning OpenShell gateway (#8942)", async () => {
    const capture = vi.fn(async (_args: string[]) => ({
      status: 0,
      output: "__NEMOCLAW_SANDBOX_EXEC_STARTED__\nRUNNING\n",
      stdout: "__NEMOCLAW_SANDBOX_EXEC_STARTED__\nRUNNING\n",
      stderr: "",
    }));

    await expect(
      isSandboxGatewayRunningForStatus("alpha", "nemoclaw-8091", {
        getSessionAgent: () => null,
        getHealthProbeUrl: () => "http://127.0.0.1:18789/health",
        capture: capture as never,
      }),
    ).resolves.toBe(true);

    expect(capture).toHaveBeenCalledTimes(1);
    expect(capture.mock.calls[0]?.[0]?.slice(0, 7)).toEqual([
      "sandbox",
      "exec",
      "--name",
      "alpha",
      "-g",
      "nemoclaw-8091",
      "--",
    ]);
  });

  it("uses the package-declared successful health statuses", async () => {
    const capture = vi.fn(async (_args: string[]) => ({
      status: 0,
      output: "__NEMOCLAW_SANDBOX_EXEC_STARTED__\nRUNNING\n",
      stdout: "__NEMOCLAW_SANDBOX_EXEC_STARTED__\nRUNNING\n",
      stderr: "",
    }));
    const agent = {
      runtime: { kind: "gateway" },
      healthProbe: {
        url: "http://127.0.0.1:19001/health",
        port: 19001,
        timeout_seconds: 10,
        success_statuses: [204],
      },
    } as unknown as ReturnType<typeof loadAgent>;

    await expect(
      isSandboxGatewayRunningForStatus("alpha", "nemoclaw-8091", {
        getSessionAgent: () => agent,
        getHealthProbeUrl: () => agent.healthProbe!.url,
        capture: capture as never,
      }),
    ).resolves.toBe(true);

    const shellCommand = capture.mock.calls[0]?.[0]?.at(-1);
    expect(shellCommand).toContain('case "$HTTP_CODE" in 204)');
    expect(shellCommand).not.toContain("200|401");
  });

  it("pins Hermes readiness checks to its recorded OpenShell gateway (#10302)", async () => {
    const gatewayHealth = vi.fn(async () => true);
    const forwardsHealthy = vi.fn(() => true);
    const inferenceProbe = vi.fn(() => ({
      healthy: true,
      broken: false,
      httpStatus: 200,
      detail: "OK 200",
    }));
    const agent = loadAgent("hermes");
    const entry = {
      name: "alpha",
      agent: "hermes",
      provider: "ollama-local",
      model: "nemotron-3-nano:30b",
    } as SandboxEntry;

    await expect(
      requireLaunchSemanticHealth("alpha", "nemoclaw-19080", "hermes", entry, agent, true, {
        gatewayHealth,
        forwardsHealthy,
        inferenceProbe,
      }),
    ).resolves.toBeUndefined();

    expect(gatewayHealth).toHaveBeenCalledWith("alpha", "nemoclaw-19080");
    expect(gatewayHealth).toHaveBeenCalledOnce();
    expect(forwardsHealthy).toHaveBeenCalledWith("alpha", "nemoclaw-19080");
    expect(forwardsHealthy).toHaveBeenCalledOnce();
    expect(inferenceProbe).toHaveBeenCalledWith("alpha", agent, "nemoclaw-19080");
    expect(inferenceProbe).toHaveBeenCalledOnce();
  });
});

const SANDBOX = "alpha";
const GATEWAY = "nemoclaw";
const MODEL = "nvidia/nemotron-3-ultra-550b-a55b";
const dcodeAgent = loadAgent("langchain-deepagents-code");

function dcodeEntry(): SandboxEntry {
  return {
    name: SANDBOX,
    agent: "langchain-deepagents-code",
    provider: "openrouter-api",
    model: MODEL,
    preferredInferenceApi: null,
  } as SandboxEntry;
}

function dcodeHealthDeps(
  invocation: ReturnType<NonNullable<LaunchReadinessHealthDeps["inferenceInvocationProbe"]>>,
): LaunchReadinessHealthDeps {
  return {
    smoke: vi.fn(() => ({ ok: true }) as const),
    inferenceProbe: vi.fn(() => ({
      healthy: true,
      broken: false,
      httpStatus: 404,
      detail: "OK 404",
    })),
    inferenceInvocationProbe: vi.fn(() => invocation),
  };
}

describe("Deep Agents Code OpenRouter launch readiness", () => {
  it("accepts readiness after an inference request succeeds (#9834)", async () => {
    const currentDeps = dcodeHealthDeps({ ok: true });

    await expect(
      requireLaunchSemanticHealth(
        SANDBOX,
        GATEWAY,
        "langchain-deepagents-code",
        dcodeEntry(),
        dcodeAgent,
        true,
        currentDeps,
      ),
    ).resolves.toBeUndefined();
    expect(currentDeps.inferenceInvocationProbe).toHaveBeenCalledWith({
      sandboxName: SANDBOX,
      gatewayName: GATEWAY,
      agentName: "langchain-deepagents-code",
      provider: "openrouter-api",
      model: MODEL,
      preferredInferenceApi: null,
    });
  });

  it("does not give a receipt-backed same-ID package the legacy DCode probe boundary", async () => {
    const currentDeps = dcodeHealthDeps({ ok: true });
    const { smoke_boundary: _legacyBoundary, ...runtime } = dcodeAgent.runtime!;
    const packageAgent = { ...dcodeAgent, runtime };
    const packageEntry = {
      ...dcodeEntry(),
      harnessPackage: {
        kind: "agent-runtime" as const,
        id: "langchain-deepagents-code",
        packageVersion: "9.9.9",
        contentDigest: "d".repeat(64),
      },
    };

    await expect(
      requireLaunchSemanticHealth(
        SANDBOX,
        GATEWAY,
        "langchain-deepagents-code",
        packageEntry,
        packageAgent,
        true,
        currentDeps,
      ),
    ).resolves.toBeUndefined();

    expect(currentDeps.inferenceInvocationProbe).toHaveBeenCalledWith(
      expect.objectContaining({
        agentName: "langchain-deepagents-code",
        probeBoundary: { kind: "login-shell" },
      }),
    );
  });

  it("rejects readiness and names the inference request when invocation fails (#9834)", async () => {
    const currentDeps = dcodeHealthDeps({
      ok: false,
      detail: "sandbox inference invocation probe returned HTTP 401",
      httpStatus: 401,
    });

    await expect(
      requireLaunchSemanticHealth(
        SANDBOX,
        GATEWAY,
        "langchain-deepagents-code",
        dcodeEntry(),
        dcodeAgent,
        true,
        currentDeps,
      ),
    ).rejects.toEqual(
      expect.objectContaining<Partial<LaunchReadinessObservationError>>({
        category: "health",
        failedCheck: "inference request",
      }),
    );
  });
});
