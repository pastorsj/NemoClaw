// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentDefinition } from "../../agent/defs";
import { enforceRunningGatewayRevalidation } from "./gateway-restart";

const SANDBOX = "future-box";
const FUTURE_AGENT = { name: "future-gateway" } as AgentDefinition;

let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  consoleErrorSpy.mockRestore();
});

describe("enforceRunningGatewayRevalidation", () => {
  it("does not interpret harness-native markers for a future package", () => {
    const exec = vi.fn(() => ({
      status: 1,
      stdout: "SECRET_BOUNDARY_REFUSED\n",
      stderr: "future controller refused\n",
    }));

    const result = enforceRunningGatewayRevalidation(SANDBOX, FUTURE_AGENT, exec);

    expect(result).toEqual({
      refused: true,
      reason: "unexpected-marker",
      stderr: "future controller refused\n",
    });
    expect(exec).toHaveBeenCalledWith(SANDBOX, "recover");
    const diagnostics = consoleErrorSpy.mock.calls.flat().join("\n");
    expect(diagnostics).toContain("Running gateway revalidation did not complete cleanly");
    expect(diagnostics).not.toContain("Hermes");
    expect(diagnostics).not.toContain(".hermes");
  });
});
