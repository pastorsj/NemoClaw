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

describe("agent runtime headless environment", () => {
  it("reads sorted public constants for each headless command", () => {
    const runtime = readAgentRuntime({
      runtime: {
        headless_command: "example-agent run",
        headless_environment: {
          SECOND_ROUTE_MARKER: "second",
          FIRST_ROUTE_MARKER: "first",
        },
      },
    });

    expect(runtime.headless_environment).toEqual({
      FIRST_ROUTE_MARKER: "first",
      SECOND_ROUTE_MARKER: "second",
    });
    expect(Object.isFrozen(runtime.headless_environment)).toBe(true);
  });

  it.each(["NEMOCLAW_MODEL", "OPENSHELL_SANDBOX", "HTTPS_PROXY", "AGENT_API_KEY"])(
    "rejects the core-owned or credential environment key %s",
    (key) => {
      expect(() =>
        readAgentRuntime({ runtime: { headless_environment: { [key]: "unsafe" } } }),
      ).toThrow("cannot replace a core-owned or credential environment value");
    },
  );

  it("rejects headless environment without a headless command", () => {
    expect(() =>
      readAgentRuntime({
        runtime: {
          interactive_command: "example-agent",
          headless_environment: { EXAMPLE_ROUTE_MARKER: "managed-route" },
        },
      }),
    ).toThrow("requires runtime.headless_command");
  });
});

describe("agent runtime prompt transport", () => {
  it.each(["argv", "stdin"] as const)("reads the explicit %s transport", (promptTransport) => {
    expect(
      readAgentRuntime({
        runtime: {
          headless_command: "example-agent run",
          prompt_transport: promptTransport,
        },
      }).prompt_transport,
    ).toBe(promptTransport);
  });

  it("rejects an unknown transport", () => {
    expect(() =>
      readAgentRuntime({
        runtime: {
          headless_command: "example-agent run",
          prompt_transport: "automatic",
        },
      }),
    ).toThrow("runtime.prompt_transport' must be argv or stdin");
  });

  it("rejects prompt transport without a headless command", () => {
    expect(() =>
      readAgentRuntime({
        runtime: {
          interactive_command: "example-agent",
          prompt_transport: "stdin",
        },
      }),
    ).toThrow("runtime.prompt_transport' requires runtime.headless_command");
  });
});
