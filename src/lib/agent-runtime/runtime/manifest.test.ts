// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { readAgentRuntime } from "./manifest";

describe("agent runtime startup environment", () => {
  it("reads sorted public constants for the initial agent process", () => {
    const runtime = readAgentRuntime({
      runtime: {
        startup_environment: {
          HERMES_HOME: "/sandbox/.hermes",
          HERMES_BUNDLED_PLUGINS: "/opt/hermes/plugins",
        },
      },
    });

    expect(runtime.startup_environment).toEqual({
      HERMES_BUNDLED_PLUGINS: "/opt/hermes/plugins",
      HERMES_HOME: "/sandbox/.hermes",
    });
    expect(Object.isFrozen(runtime.startup_environment)).toBe(true);
  });

  it.each(["NEMOCLAW_SANDBOX_NAME", "OPENSHELL_SANDBOX", "HTTPS_PROXY", "AGENT_TOKEN"])(
    "rejects the core-owned or credential environment key %s",
    (key) => {
      expect(() =>
        readAgentRuntime({ runtime: { startup_environment: { [key]: "unsafe" } } }),
      ).toThrow("cannot replace a core-owned or credential environment value");
    },
  );

  it.each(["", "line one\nline two", "x".repeat(4097)])(
    "rejects the invalid startup environment value %#",
    (value) => {
      expect(() =>
        readAgentRuntime({ runtime: { startup_environment: { AGENT_HOME: value } } }),
      ).toThrow("must be a non-empty single-line string");
    },
  );
});
