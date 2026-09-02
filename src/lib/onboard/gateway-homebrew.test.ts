// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  type SpawnSyncLikeResult,
  startOpenShellGatewayUserService,
} from "./docker-driver-gateway-service";

function brewResult(status = 0, stderr = "", stdout = ""): SpawnSyncLikeResult {
  return { status, stderr, stdout };
}

describe("Homebrew gateway service", () => {
  it("rejects a private HOME before changing the account service (#6903)", () => {
    const events: string[] = [];
    const brew = vi.fn((_command: string, args: string[]) => {
      events.push(args.join(" "));
      return args[0] === "info"
        ? brewResult(
            0,
            "",
            JSON.stringify({ formulae: [{ name: "openshell", tap: "nvidia/openshell" }] }),
          )
        : brewResult();
    });

    expect(() =>
      startOpenShellGatewayUserService({
        accountHome: "/Users/tester",
        commandExists: (command) => command === "brew",
        env: {
          HOME: "/Users/tester/.nemoclaw-e2e-home",
          XDG_CONFIG_HOME: "/Users/tester/.nemoclaw-e2e-home/.config",
        },
        home: "/Users/tester/.nemoclaw-e2e-home",
        homebrewFormulaOperation: (args) => brew("brew", args),
        platform: "darwin",
        preparePortForServiceStart: () => events.push("prepare-port"),
        prepareServiceEnv: () => events.push("prepare-env"),
        spawnSyncImpl: brew,
        validatePortOwnerForServiceStart: () => events.push("validate-port"),
      }),
    ).toThrow("Use a non-default NEMOCLAW_GATEWAY_PORT for an isolated HOME");
    expect(events).toEqual(["list --formula openshell", "info --json=v2 openshell"]);
  });
});
