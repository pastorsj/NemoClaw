// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { buildOpenshellExecArgs, wrapExecCommandWithRuntimeEnv } from "../exec";
import { runPackageAgentCapturedPassthrough } from "./passthrough-captured";

describe("receipt-backed agent command capture", () => {
  it("relays a future package's raw output without OpenClaw envelope interpretation", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const exit = vi.fn((code: number) => {
      throw new Error(`__exit:${code}`);
    });
    const runDispatch = vi.fn(async () => ({
      status: 0,
      signal: null,
      stdout: JSON.stringify({ status: "incomplete", transport: "embedded" }),
      stderr: "EMBEDDED FALLBACK",
    }));
    // A future package may choose stock-looking argv. Receipt capture must not
    // infer the legacy OpenClaw transport timeout from those bytes.
    const command = ["openclaw", "agent", "--timeout", "30", "--json"];

    await expect(
      runPackageAgentCapturedPassthrough(
        "future-sandbox",
        command,
        {
          exit: exit as unknown as (code: number) => never,
          stdout: { write: (value) => stdout.push(value) },
          stderr: { write: (value) => stderr.push(value) },
        },
        {
          getOpenshellBinary: () => "openshell",
          getGatewayName: () => null,
          stdinIsTty: () => false,
          runDispatch,
        },
      ),
    ).rejects.toThrow("__exit:0");

    expect(runDispatch).toHaveBeenCalledWith(
      "openshell",
      buildOpenshellExecArgs("future-sandbox", wrapExecCommandWithRuntimeEnv(command), {
        tty: false,
      }),
      { stdinIsTty: false },
    );
    expect(stdout.join("")).toContain('"status":"incomplete"');
    expect(stderr.join("")).toBe("EMBEDDED FALLBACK");
    expect(exit).toHaveBeenCalledWith(0);
  });
});
