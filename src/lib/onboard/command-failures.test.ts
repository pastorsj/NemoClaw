// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { runOnboardCommand } from "./command";
import { invalidGatewayManagementDeclarationError } from "./gateway-management";

function exitWithCode(code: number): never {
  throw new Error(`exit:${code}`);
}

describe("onboard command failure handling", () => {
  it("escapes terminal controls in gateway declaration errors before printing (#7627)", async () => {
    const errors: string[] = [];
    await expect(
      runOnboardCommand({
        flags: {},
        env: {},
        runOnboard: async () => {
          throw invalidGatewayManagementDeclarationError(
            "unknown declaration field(s): forged\n\u001b[31mError: \u202efake failure",
          );
        },
        error: (message = "") => errors.push(message),
        exit: exitWithCode,
      }),
    ).rejects.toThrow("exit:1");

    expect(errors).toEqual([
      "  Invalid gateway management declaration: unknown declaration field(s): forged\\u000a\\u001b[31mError: \\u202efake failure",
    ]);
    expect(errors[0]?.split(/\r?\n/u)).toHaveLength(1);
    expect(errors[0]).not.toMatch(
      /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/u,
    );
  });

  it("re-throws a non-cancellation, non-gateway error so genuine bugs still surface (#7627)", async () => {
    await expect(
      runOnboardCommand({
        flags: {},
        env: {},
        runOnboard: async () => {
          throw new Error("unexpected boom");
        },
        error: () => {},
        exit: exitWithCode,
      }),
    ).rejects.toThrow("unexpected boom");
  });

  it("returns without rethrowing when a prompt rejects with SIGINT (#7439)", async () => {
    const exit = vi.fn<(code: number) => never>();
    await expect(
      runOnboardCommand({
        flags: {},
        env: {},
        runOnboard: async () => {
          throw Object.assign(new Error("Prompt interrupted"), { code: "SIGINT" });
        },
        error: () => {},
        exit,
      }),
    ).resolves.toBeUndefined();
    expect(exit).not.toHaveBeenCalled();
  });

  it("rethrows non-cancellation onboarding failures unchanged (#5976)", async () => {
    await expect(
      runOnboardCommand({
        flags: {},
        env: {},
        runOnboard: async () => {
          throw new Error("docker is not reachable");
        },
        error: () => {},
        exit: exitWithCode,
      }),
    ).rejects.toThrow("docker is not reachable");
  });

  it("sets the Ollama autostart override before onboarding", async () => {
    const env: NodeJS.ProcessEnv = {};
    let observed: string | undefined;
    await runOnboardCommand({
      flags: { "no-ollama-autostart": true },
      env,
      runOnboard: async () => {
        observed = env.NEMOCLAW_OLLAMA_NO_AUTOSTART;
      },
    });
    expect(observed).toBe("1");
  });
});
