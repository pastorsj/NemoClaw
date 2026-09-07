// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type { SecondaryForwardAllocation } from "./gateway-binding/secondary-forward";
import {
  findAvailableSecondaryForwardPort,
  readRequestedSecondaryForwardPort,
  reserveCreateSandboxSecondaryForwardPort,
  resolveOnboardSecondaryForwardPort,
  resolveRecordedSecondaryForwardPort,
} from "./gateway-binding/secondary-forward";

const FUTURE_ALLOCATION: SecondaryForwardAllocation = Object.freeze({
  environment_variable: "FUTURE_RUNTIME_API_PORT",
  preferred_port: 9310,
  range_start: 9310,
  range_end: 9312,
  label: "future runtime API",
  remedy: "Stop an existing listener and retry onboarding.",
});

describe("receipt-backed secondary-forward allocation", () => {
  it("reads the package-selected environment without any harness identity", () => {
    expect(readRequestedSecondaryForwardPort(FUTURE_ALLOCATION, {})).toBe(9310);
    expect(
      readRequestedSecondaryForwardPort(FUTURE_ALLOCATION, {
        FUTURE_RUNTIME_API_PORT: "9312",
      }),
    ).toBe(9312);
    expect(() =>
      readRequestedSecondaryForwardPort(FUTURE_ALLOCATION, {
        FUTURE_RUNTIME_API_PORT: "9309",
      }),
    ).toThrow(/9310 through 9312/u);
  });

  it("skips forward, registry, and host collisions within the bounded range", () => {
    expect(
      findAvailableSecondaryForwardPort(
        "future-box",
        FUTURE_ALLOCATION,
        "other 127.0.0.1 9310 42 running",
        (port) => port === 9311,
        new Map([["9312", "future-box"]]),
      ),
    ).toBe(9312);
  });

  it("reports package-owned bounded recovery guidance when all ports collide", () => {
    expect(() =>
      findAvailableSecondaryForwardPort(
        "future-box",
        FUTURE_ALLOCATION,
        null,
        () => true,
        new Map(),
      ),
    ).toThrow(/future runtime API[\s\S]*9310-9312[\s\S]*Stop an existing listener/u);
  });

  it("fails closed when durable receipt-backed state has no valid recorded port", () => {
    expect(() => resolveRecordedSecondaryForwardPort({}, FUTURE_ALLOCATION)).toThrow(
      /port is missing or outside 9310-9312/u,
    );
    expect(() =>
      resolveRecordedSecondaryForwardPort({ secondaryForwardPort: 9400 }, FUTURE_ALLOCATION),
    ).toThrow(/port is missing or outside 9310-9312/u);
    expect(() =>
      resolveOnboardSecondaryForwardPort("future-box", FUTURE_ALLOCATION, {
        env: {},
        getSandbox: () => ({ createdAt: "2026-01-01", secondaryForwardPort: null }),
      }),
    ).toThrow(/port is missing or outside 9310-9312/u);
  });

  it("retries a transient bind collision and publishes the selected package environment", async () => {
    const env: NodeJS.ProcessEnv = {};
    const reservePort = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("occupied"), { code: "EADDRINUSE" }))
      .mockResolvedValueOnce({ port: 9311, release: vi.fn() });
    const selected = await reserveCreateSandboxSecondaryForwardPort({
      allocation: FUTURE_ALLOCATION,
      sandboxName: "future-box",
      env,
      getSandbox: () => null,
      forwardListOutput: null,
      isPortBoundCheck: () => false,
      registryOccupiedPorts: new Map(),
      reservePort,
    });

    expect(selected.effectivePort).toBe(9311);
    expect(env.FUTURE_RUNTIME_API_PORT).toBe("9311");
    expect(reservePort).toHaveBeenNthCalledWith(1, 9310);
    expect(reservePort).toHaveBeenNthCalledWith(2, 9311);
  });
});
