// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { readAgentRuntime } from "./manifest";

describe("agent runtime gateway log source", () => {
  it("reads a package-owned canonical gateway log path", () => {
    expect(
      readAgentRuntime({
        runtime: {
          kind: "gateway",
          gateway_log_path: "/var/log/future-agent/gateway.log",
        },
      }).gateway_log_path,
    ).toBe("/var/log/future-agent/gateway.log");
  });

  it.each(["relative/gateway.log", "/var/log/../secret", "/var//log/gateway.log"])(
    "rejects the non-canonical gateway log path %s",
    (gatewayLogPath) => {
      expect(() =>
        readAgentRuntime({
          runtime: { kind: "gateway", gateway_log_path: gatewayLogPath },
        }),
      ).toThrow("must be a canonical absolute path");
    },
  );

  it("rejects a gateway log path for a terminal runtime", () => {
    expect(() =>
      readAgentRuntime({
        runtime: {
          kind: "terminal",
          interactive_command: "future-agent",
          gateway_log_path: "/var/log/future-agent/gateway.log",
        },
      }),
    ).toThrow("requires runtime.kind gateway");
  });
});

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

  it.each(["fabric-cli", "raw-stdin"] as const)(
    "reads the explicit %s prompt protocol",
    (promptProtocol) => {
      expect(
        readAgentRuntime({
          runtime: {
            headless_command: "example-agent run",
            prompt_transport: "stdin",
            prompt_protocol: promptProtocol,
          },
        }).prompt_protocol,
      ).toBe(promptProtocol);
    },
  );

  it("rejects a prompt protocol without stdin transport", () => {
    expect(() =>
      readAgentRuntime({
        runtime: {
          headless_command: "example-agent run",
          prompt_transport: "argv",
          prompt_protocol: "fabric-cli",
        },
      }),
    ).toThrow("runtime.prompt_protocol' requires runtime.prompt_transport to be stdin");
  });
});

describe("agent runtime native command declaration", () => {
  it("reads and freezes a finite package-owned argv grammar", () => {
    const runtime = readAgentRuntime({
      runtime: {
        agent_command: {
          argv: ["future-agent", "run"],
          output_mode: "bounded-text",
          output_interpretation: "structured-turn-envelope",
          selector_options: ["--session"],
          selector_required: true,
          value_options: ["--message", "--timeout"],
          boolean_options: ["--deliver"],
          json_output_option: "--json",
          timeout_option: "--timeout",
        },
      },
    });

    expect(runtime.agent_command).toEqual({
      argv: ["future-agent", "run"],
      output_mode: "bounded-text",
      output_interpretation: "structured-turn-envelope",
      selector_options: ["--session"],
      selector_required: true,
      value_options: ["--message", "--timeout"],
      boolean_options: ["--deliver"],
      json_output_option: "--json",
      timeout_option: "--timeout",
    });
    expect(Object.isFrozen(runtime.agent_command)).toBe(true);
    expect(Object.isFrozen(runtime.agent_command?.argv)).toBe(true);
  });

  it.each([
    [{ argv: [], output_mode: "direct" }, "argv"],
    [{ argv: ["agent"], output_mode: "stream" }, "output_mode"],
    [
      { argv: ["agent"], output_mode: "direct", output_interpretation: "structured-turn-envelope" },
      "output_interpretation",
    ],
    [
      { argv: ["agent"], output_mode: "direct", selector_required: true },
      "requires selector_options",
    ],
    [
      {
        argv: ["agent"],
        output_mode: "direct",
        json_output_option: "--json",
      },
      "requires bounded-text output",
    ],
    [
      {
        argv: ["agent"],
        output_mode: "bounded-text",
        value_options: ["--message"],
        timeout_option: "--timeout",
      },
      "must appear in value_options",
    ],
  ] as const)("rejects an invalid native command declaration %#", (agentCommand, message) => {
    expect(() => readAgentRuntime({ runtime: { agent_command: agentCommand } })).toThrow(message);
  });
});

describe("agent runtime process lifecycle declaration", () => {
  it("reads and freezes a package-owned managed controller command", () => {
    const runtime = readAgentRuntime({
      runtime: {
        process_lifecycle: {
          support: "managed",
          command: ["/usr/local/bin/future-process-control", "--structured"],
          revalidate_running_gateway: true,
        },
      },
    });

    expect(runtime.process_lifecycle).toEqual({
      support: "managed",
      command: ["/usr/local/bin/future-process-control", "--structured"],
      revalidate_running_gateway: true,
    });
    expect(Object.isFrozen(runtime.process_lifecycle)).toBe(true);
    expect(Object.isFrozen(runtime.process_lifecycle?.command)).toBe(true);
  });

  it("preserves a bounded typed unsupported reason", () => {
    expect(
      readAgentRuntime({
        runtime: {
          process_lifecycle: {
            support: "unsupported",
            reason: "The harness uses an external process manager.",
          },
        },
      }).process_lifecycle,
    ).toEqual({
      support: "unsupported",
      reason: "The harness uses an external process manager.",
    });
  });

  it.each([
    [{ support: "managed", command: ["relative-command"] }, "canonical absolute path"],
    [
      { support: "managed", command: ["/sandbox/future-process-control"] },
      "immutable image-owned executable path",
    ],
    [
      { support: "managed", command: ["/usr/local/bin/../sandbox/process-control"] },
      "canonical absolute path",
    ],
    [
      { support: "managed", command: ["/usr/local/bin/future\\process-control"] },
      "immutable image-owned executable path",
    ],
    [
      { support: "managed", command: ["/usr/local/bin/future\u001b-process-control"] },
      "immutable image-owned executable path",
    ],
    [{ support: "managed", command: [] }, "non-empty bounded argument array"],
    [{ support: "unsupported", reason: "line one\nline two" }, "single-line string"],
    [{ support: "automatic" }, "must be managed or unsupported"],
  ] as const)("rejects an invalid process lifecycle declaration %#", (declaration, message) => {
    expect(() => readAgentRuntime({ runtime: { process_lifecycle: declaration } })).toThrow(
      message,
    );
  });

  it("rejects managed gateway lifecycle control for a terminal runtime", () => {
    expect(() =>
      readAgentRuntime({
        runtime: {
          kind: "terminal",
          interactive_command: "future-terminal",
          process_lifecycle: {
            support: "managed",
            command: ["/usr/local/bin/future-process-control"],
          },
        },
      }),
    ).toThrow("cannot be managed for a terminal runtime");
  });
});

describe("agent runtime device-pairing settlement declaration", () => {
  it("reads a fixed package command with a bounded timeout", () => {
    const runtime = readAgentRuntime({
      runtime: {
        device_pairing_settlement: {
          command: ["/opt/future/pairing-settle", "--quiet"],
          timeout_seconds: 45,
        },
      },
    });

    expect(runtime.device_pairing_settlement).toEqual({
      command: ["/opt/future/pairing-settle", "--quiet"],
      timeout_seconds: 45,
    });
    expect(Object.isFrozen(runtime.device_pairing_settlement)).toBe(true);
    expect(Object.isFrozen(runtime.device_pairing_settlement?.command)).toBe(true);
  });

  it.each([
    [{ command: ["relative-command"], timeout_seconds: 45 }, "canonical absolute path"],
    [{ command: [], timeout_seconds: 45 }, "non-empty bounded argument array"],
    [{ command: ["/opt/future/pairing-settle"], timeout_seconds: 0 }, "integer from 1 through 300"],
  ] as const)("rejects an invalid device-pairing declaration %#", (declaration, message) => {
    expect(() => readAgentRuntime({ runtime: { device_pairing_settlement: declaration } })).toThrow(
      message,
    );
  });
});

describe("agent runtime semantic-turn declaration", () => {
  it("reads and freezes a managed semantic-turn command", () => {
    const runtime = readAgentRuntime({
      runtime: {
        semantic_turn: {
          support: "managed",
          command: ["/usr/local/bin/future-semantic-turn"],
          timeout_seconds: 120,
          protocol: "semantic-turn-ndjson",
        },
      },
    });

    expect(runtime.semantic_turn).toEqual({
      support: "managed",
      command: ["/usr/local/bin/future-semantic-turn"],
      timeout_seconds: 120,
      protocol: "semantic-turn-ndjson",
    });
    expect(Object.isFrozen(runtime.semantic_turn)).toBe(true);
    expect(
      runtime.semantic_turn?.support === "managed" &&
        Object.isFrozen(runtime.semantic_turn.command),
    ).toBe(true);
  });

  it("preserves an explicit unsupported declaration", () => {
    expect(
      readAgentRuntime({
        runtime: {
          semantic_turn: {
            support: "unsupported",
            reason: "This runtime does not accept semantic turns.",
          },
        },
      }).semantic_turn,
    ).toEqual({
      support: "unsupported",
      reason: "This runtime does not accept semantic turns.",
    });
  });

  it.each([
    [
      {
        support: "managed",
        command: ["relative-semantic-turn"],
        timeout_seconds: 120,
        protocol: "semantic-turn-ndjson",
      },
      "canonical absolute path",
    ],
    [
      {
        support: "managed",
        command: ["/sandbox/semantic-turn"],
        timeout_seconds: 120,
        protocol: "semantic-turn-ndjson",
      },
      "immutable image-owned executable path",
    ],
    [
      {
        support: "managed",
        command: ["/usr/local/bin/future-semantic-turn"],
        timeout_seconds: 0,
        protocol: "semantic-turn-ndjson",
      },
      "integer from 1 through 300",
    ],
    [
      {
        support: "managed",
        command: ["/usr/local/bin/future-semantic-turn"],
        timeout_seconds: 120,
        protocol: "native-events",
      },
      "must be semantic-turn-ndjson",
    ],
    [{ support: "unsupported", reason: "line one\nline two" }, "single-line string"],
  ] as const)("rejects an invalid semantic-turn declaration %#", (declaration, message) => {
    expect(() => readAgentRuntime({ runtime: { semantic_turn: declaration } })).toThrow(message);
  });
});
