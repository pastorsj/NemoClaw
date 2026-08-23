// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

import { testTimeoutOptions } from "../../../test/helpers/timeouts";

const mocks = vi.hoisted(() => ({
  resolveHarnessPackage: vi.fn(),
  rejectResolution: new Map<string, () => never>([
    [
      "langchain-deepagents-code",
      () => {
        throw new Error("unexpected Deep Agents Code package resolution");
      },
    ],
  ]),
}));

vi.mock("../harness/package-registry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../harness/package-registry")>();
  return {
    ...actual,
    resolveHarnessPackage(id: string, env?: NodeJS.ProcessEnv) {
      mocks.resolveHarnessPackage(id);
      mocks.rejectResolution.get(id)?.();
      return actual.resolveHarnessPackage(id, env);
    },
  };
});

beforeEach(() => {
  vi.resetModules();
  mocks.resolveHarnessPackage.mockClear();
});

describe("lazy Deep Agents Code specifications", testTimeoutOptions(30_000), () => {
  it("does not resolve the DCode package for generic connect, smoke, or snapshot modules", async () => {
    const { buildSandboxInferenceRouteProbeArgs, parseSandboxInferenceRouteProbeResult } =
      await import("../actions/sandbox/connect-inference-route-probe");
    const { buildAgentSmokeArgs } = await import("./terminal-smoke");

    expect(buildSandboxInferenceRouteProbeArgs("openclaw-box", { name: "openclaw" })).toContain(
      "sh",
    );
    expect(
      parseSandboxInferenceRouteProbeResult(
        { status: 1, output: "generic route unavailable" },
        { name: "openclaw" },
      ),
    ).toMatchObject({ healthy: false, broken: false });
    expect(
      buildAgentSmokeArgs("hermes-box", { name: "hermes" } as never, "hermes --version"),
    ).toContain("-lc");
    await expect(import("../actions/sandbox/snapshot")).resolves.toBeDefined();
    await expect(
      import("../actions/sandbox/mcp-bridge-adapter-deepagents-legacy"),
    ).resolves.toBeDefined();
    await expect(
      import("../actions/sandbox/mcp-bridge-adapter-deepagents-projection"),
    ).resolves.toBeDefined();

    expect(mocks.resolveHarnessPackage).not.toHaveBeenCalledWith("langchain-deepagents-code");
  });

  it("resolves the DCode package after the selected agent has the fixed DCode identity", async () => {
    const { buildSandboxInferenceRouteProbeArgs } =
      await import("../actions/sandbox/connect-inference-route-probe");

    expect(() =>
      buildSandboxInferenceRouteProbeArgs("dcode-box", {
        name: "langchain-deepagents-code",
      }),
    ).toThrow("unexpected Deep Agents Code package resolution");
    expect(mocks.resolveHarnessPackage).toHaveBeenCalledWith("langchain-deepagents-code");
  });
});
