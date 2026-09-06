// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isObjectRecord } from "../../core/json-types";
import type {
  HarnessAgentCommandDeclaration,
  HarnessDevicePairingSettlementDeclaration,
  HarnessProcessLifecycleDeclaration,
  HarnessPromptTransport,
} from "@nvidia/nemoclaw-harness-contract";

export type AgentRuntimeKind = "gateway" | "terminal";

export type AgentCommandShell = "/bin/sh" | "/bin/bash";

export type AgentPromptTransport = HarnessPromptTransport;

export interface LoginShellSmokeBoundary {
  kind: "login-shell";
}

export interface ManagedLauncherSmokeBoundary {
  kind: "managed-launcher";
  launcher: string;
  home: string;
}

export type AgentSmokeBoundary = LoginShellSmokeBoundary | ManagedLauncherSmokeBoundary;

export interface AgentRuntime {
  kind: AgentRuntimeKind;
  interactive_command?: string;
  headless_command?: string;
  prompt_transport?: AgentPromptTransport;
  command_shell?: AgentCommandShell;
  startup_environment?: Readonly<Record<string, string>>;
  headless_environment?: Readonly<Record<string, string>>;
  smoke_commands?: string[];
  smoke_boundary?: AgentSmokeBoundary;
  agent_command?: HarnessAgentCommandDeclaration;
  process_lifecycle?: HarnessProcessLifecycleDeclaration;
  device_pairing_settlement?: HarnessDevicePairingSettlementDeclaration;
}

type RuntimeRecord = { [key: string]: unknown };

function readString(record: RuntimeRecord, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function readStringArray(record: RuntimeRecord, key: string): string[] | undefined {
  const value = record[key];
  if (!Array.isArray(value)) return undefined;
  if (value.some((entry) => typeof entry !== "string")) {
    throw new Error(`Agent manifest field 'runtime.${key}' must be an array of strings`);
  }
  return value as string[];
}

const STARTUP_ENVIRONMENT_KEY = /^[A-Z][A-Z0-9_]{0,127}$/u;
const SECRET_ENVIRONMENT_KEY = /(?:^|_)(?:AUTH|CREDENTIAL|KEY|PASSWORD|SECRET|TOKEN)(?:_|$)/u;
const CORE_ENVIRONMENT_KEYS = new Set([
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
]);

type PublicEnvironmentField = "startup_environment" | "headless_environment";

/** Read public, package-owned constants for one declared runtime boundary. */
function readPublicEnvironment(
  record: RuntimeRecord,
  field: PublicEnvironmentField,
): Readonly<Record<string, string>> | undefined {
  const value = record[field];
  if (value === undefined) return undefined;
  if (!isObjectRecord(value)) {
    throw new Error(`Agent manifest field 'runtime.${field}' must be an object`);
  }

  const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
  for (const [key, rawValue] of entries) {
    if (!STARTUP_ENVIRONMENT_KEY.test(key)) {
      throw new Error(
        `Agent manifest field 'runtime.${field}.${key}' must use an uppercase environment name`,
      );
    }
    if (
      key.startsWith("NEMOCLAW_") ||
      key.startsWith("OPENSHELL_") ||
      CORE_ENVIRONMENT_KEYS.has(key) ||
      SECRET_ENVIRONMENT_KEY.test(key)
    ) {
      throw new Error(
        `Agent manifest field 'runtime.${field}.${key}' cannot replace a core-owned or credential environment value`,
      );
    }
    if (
      typeof rawValue !== "string" ||
      rawValue.length === 0 ||
      rawValue.length > 4096 ||
      /[\0\r\n]/u.test(rawValue)
    ) {
      throw new Error(
        `Agent manifest field 'runtime.${field}.${key}' must be a non-empty single-line string of at most 4096 characters`,
      );
    }
  }
  return Object.freeze(Object.fromEntries(entries) as Record<string, string>);
}

function readCommandShell(record: RuntimeRecord): AgentCommandShell | undefined {
  const value = record.command_shell;
  if (value === undefined) return undefined;
  if (value !== "/bin/sh" && value !== "/bin/bash") {
    throw new Error("Agent manifest field 'runtime.command_shell' must be /bin/sh or /bin/bash");
  }
  return value;
}

function readPromptTransport(record: RuntimeRecord): AgentPromptTransport | undefined {
  const value = record.prompt_transport;
  if (value === undefined) return undefined;
  if (value !== "argv" && value !== "stdin") {
    throw new Error("Agent manifest field 'runtime.prompt_transport' must be argv or stdin");
  }
  return value;
}

const AGENT_COMMAND_OPTION = /^-{1,2}[a-zA-Z0-9][a-zA-Z0-9-]*$/u;

function readAgentCommandStringArray(
  record: RuntimeRecord,
  key: keyof Pick<
    HarnessAgentCommandDeclaration,
    "argv" | "selector_options" | "value_options" | "boolean_options"
  >,
  options: { required?: boolean; optionNames?: boolean } = {},
): readonly string[] | undefined {
  const value = record[key];
  if (value === undefined && !options.required) return undefined;
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > 64 ||
    value.some(
      (entry) =>
        typeof entry !== "string" ||
        entry.length === 0 ||
        entry.length > 1024 ||
        /[\0\r\n]/u.test(entry) ||
        (options.optionNames && !AGENT_COMMAND_OPTION.test(entry)),
    )
  ) {
    const description = options.optionNames ? "command-line option names" : "argv tokens";
    throw new Error(
      `Agent manifest field 'runtime.agent_command.${key}' must be a non-empty array of valid ${description}`,
    );
  }
  if (new Set(value).size !== value.length) {
    throw new Error(
      `Agent manifest field 'runtime.agent_command.${key}' must not contain duplicates`,
    );
  }
  return Object.freeze([...(value as string[])]);
}

function readAgentCommandOption(
  record: RuntimeRecord,
  key: "json_output_option" | "timeout_option",
): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !AGENT_COMMAND_OPTION.test(value)) {
    throw new Error(`Agent manifest field 'runtime.agent_command.${key}' must be an option name`);
  }
  return value;
}

function readAgentCommandDeclaration(
  runtime: RuntimeRecord,
): HarnessAgentCommandDeclaration | undefined {
  const value = runtime.agent_command;
  if (value === undefined) return undefined;
  if (!isObjectRecord(value)) {
    throw new Error("Agent manifest field 'runtime.agent_command' must be an object");
  }
  const knownFields = new Set([
    "argv",
    "output_mode",
    "selector_options",
    "selector_required",
    "value_options",
    "boolean_options",
    "json_output_option",
    "timeout_option",
  ]);
  const unknownField = Object.keys(value).find((key) => !knownFields.has(key));
  if (unknownField) {
    throw new Error(
      `Agent manifest field 'runtime.agent_command.${unknownField}' is not supported`,
    );
  }
  const argv = readAgentCommandStringArray(value, "argv", { required: true });
  const outputMode = value.output_mode;
  if (outputMode !== "direct" && outputMode !== "bounded-text") {
    throw new Error(
      "Agent manifest field 'runtime.agent_command.output_mode' must be direct or bounded-text",
    );
  }
  const selectorOptions = readAgentCommandStringArray(value, "selector_options", {
    optionNames: true,
  });
  const valueOptions = readAgentCommandStringArray(value, "value_options", { optionNames: true });
  const booleanOptions = readAgentCommandStringArray(value, "boolean_options", {
    optionNames: true,
  });
  const selectorRequired = value.selector_required;
  if (selectorRequired !== undefined && typeof selectorRequired !== "boolean") {
    throw new Error(
      "Agent manifest field 'runtime.agent_command.selector_required' must be a boolean",
    );
  }
  if (selectorRequired && !selectorOptions) {
    throw new Error(
      "Agent manifest field 'runtime.agent_command.selector_required' requires selector_options",
    );
  }
  const jsonOutputOption = readAgentCommandOption(value, "json_output_option");
  if (jsonOutputOption && outputMode !== "bounded-text") {
    throw new Error(
      "Agent manifest field 'runtime.agent_command.json_output_option' requires bounded-text output",
    );
  }
  const timeoutOption = readAgentCommandOption(value, "timeout_option");
  if (timeoutOption && !valueOptions?.includes(timeoutOption)) {
    throw new Error(
      "Agent manifest field 'runtime.agent_command.timeout_option' must appear in value_options",
    );
  }
  const allOptions = [
    ...(selectorOptions ?? []),
    ...(valueOptions ?? []),
    ...(booleanOptions ?? []),
    ...(jsonOutputOption ? [jsonOutputOption] : []),
  ];
  if (new Set(allOptions).size !== allOptions.length) {
    throw new Error("Agent manifest field 'runtime.agent_command' option groups must not overlap");
  }
  return Object.freeze({
    argv: argv!,
    output_mode: outputMode,
    ...(selectorOptions ? { selector_options: selectorOptions } : {}),
    ...(selectorRequired !== undefined ? { selector_required: selectorRequired } : {}),
    ...(valueOptions ? { value_options: valueOptions } : {}),
    ...(booleanOptions ? { boolean_options: booleanOptions } : {}),
    ...(jsonOutputOption ? { json_output_option: jsonOutputOption } : {}),
    ...(timeoutOption ? { timeout_option: timeoutOption } : {}),
  });
}

function readFixedRuntimeCommand(
  record: RuntimeRecord,
  field: "process_lifecycle" | "device_pairing_settlement",
): readonly string[] {
  const value = record.command;
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > 16 ||
    value.some(
      (entry) =>
        typeof entry !== "string" ||
        entry.length === 0 ||
        entry.length > 1024 ||
        /[\0\r\n]/u.test(entry),
    )
  ) {
    throw new Error(
      `Agent manifest field 'runtime.${field}.command' must be a non-empty bounded argument array`,
    );
  }
  readCanonicalAbsolutePath(value[0], `runtime.${field}.command[0]`);
  return Object.freeze([...(value as string[])]);
}

function readProcessLifecycleDeclaration(
  runtime: RuntimeRecord,
): HarnessProcessLifecycleDeclaration | undefined {
  const value = runtime.process_lifecycle;
  if (value === undefined) return undefined;
  if (!isObjectRecord(value)) {
    throw new Error("Agent manifest field 'runtime.process_lifecycle' must be an object");
  }
  if (value.support === "managed") {
    const unknownField = Object.keys(value).find(
      (key) => key !== "support" && key !== "command" && key !== "revalidate_running_gateway",
    );
    if (unknownField) {
      throw new Error(
        `Agent manifest field 'runtime.process_lifecycle.${unknownField}' is not supported`,
      );
    }
    if (
      value.revalidate_running_gateway !== undefined &&
      value.revalidate_running_gateway !== true
    ) {
      throw new Error(
        "Agent manifest field 'runtime.process_lifecycle.revalidate_running_gateway' must be true when present",
      );
    }
    return Object.freeze({
      support: "managed",
      command: readFixedRuntimeCommand(value, "process_lifecycle"),
      ...(value.revalidate_running_gateway === true
        ? { revalidate_running_gateway: true as const }
        : {}),
    });
  }
  if (value.support === "unsupported") {
    const unknownField = Object.keys(value).find((key) => key !== "support" && key !== "reason");
    if (unknownField) {
      throw new Error(
        `Agent manifest field 'runtime.process_lifecycle.${unknownField}' is not supported`,
      );
    }
    if (
      typeof value.reason !== "string" ||
      value.reason.length === 0 ||
      value.reason.length > 512 ||
      /[\0\r\n]/u.test(value.reason)
    ) {
      throw new Error(
        "Agent manifest field 'runtime.process_lifecycle.reason' must be a non-empty single-line string of at most 512 characters",
      );
    }
    return Object.freeze({ support: "unsupported", reason: value.reason });
  }
  throw new Error(
    "Agent manifest field 'runtime.process_lifecycle.support' must be managed or unsupported",
  );
}

function readDevicePairingSettlementDeclaration(
  runtime: RuntimeRecord,
): HarnessDevicePairingSettlementDeclaration | undefined {
  const value = runtime.device_pairing_settlement;
  if (value === undefined) return undefined;
  if (!isObjectRecord(value)) {
    throw new Error("Agent manifest field 'runtime.device_pairing_settlement' must be an object");
  }
  const unknownField = Object.keys(value).find(
    (key) => key !== "command" && key !== "timeout_seconds",
  );
  if (unknownField) {
    throw new Error(
      `Agent manifest field 'runtime.device_pairing_settlement.${unknownField}' is not supported`,
    );
  }
  const command = readFixedRuntimeCommand({ command: value.command }, "device_pairing_settlement");
  if (
    !Number.isInteger(value.timeout_seconds) ||
    (value.timeout_seconds as number) < 1 ||
    (value.timeout_seconds as number) > 300
  ) {
    throw new Error(
      "Agent manifest field 'runtime.device_pairing_settlement.timeout_seconds' must be an integer from 1 through 300",
    );
  }
  return Object.freeze({ command, timeout_seconds: value.timeout_seconds as number });
}

function readCanonicalAbsolutePath(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.startsWith("/")) {
    throw new Error(`Agent manifest field '${field}' must be a canonical absolute path`);
  }
  const segments = value.split("/");
  if (
    segments.length < 2 ||
    segments.slice(1).some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error(`Agent manifest field '${field}' must be a canonical absolute path`);
  }
  return value;
}

function readSmokeBoundary(record: RuntimeRecord): AgentSmokeBoundary | undefined {
  const value = record.smoke_boundary;
  if (value === undefined) return undefined;
  if (!isObjectRecord(value)) {
    throw new Error("Agent manifest field 'runtime.smoke_boundary' must be an object");
  }
  if (value.kind === "login-shell") return { kind: "login-shell" };
  if (value.kind !== "managed-launcher") {
    throw new Error(
      "Agent manifest field 'runtime.smoke_boundary.kind' must be login-shell or managed-launcher",
    );
  }
  return {
    kind: "managed-launcher",
    launcher: readCanonicalAbsolutePath(value.launcher, "runtime.smoke_boundary.launcher"),
    home: readCanonicalAbsolutePath(value.home, "runtime.smoke_boundary.home"),
  };
}

export function readAgentRuntime(record: RuntimeRecord): AgentRuntime {
  const runtime = record.runtime;
  if (!isObjectRecord(runtime)) return { kind: "gateway" };

  const rawKind = runtime.kind;
  if (rawKind !== undefined && rawKind !== "gateway" && rawKind !== "terminal") {
    throw new Error("Agent manifest field 'runtime.kind' must be gateway or terminal");
  }

  const kind: AgentRuntimeKind = rawKind === "terminal" ? "terminal" : "gateway";
  const interactiveCommand = readString(runtime, "interactive_command")?.trim();
  const headlessCommand = readString(runtime, "headless_command")?.trim();
  const promptTransport = readPromptTransport(runtime);
  const commandShell = readCommandShell(runtime);
  const startupEnvironment = readPublicEnvironment(runtime, "startup_environment");
  const headlessEnvironment = readPublicEnvironment(runtime, "headless_environment");
  const smokeCommands = readStringArray(runtime, "smoke_commands");
  const smokeBoundary = readSmokeBoundary(runtime);
  const agentCommand = readAgentCommandDeclaration(runtime);
  const processLifecycle = readProcessLifecycleDeclaration(runtime);
  const devicePairingSettlement = readDevicePairingSettlementDeclaration(runtime);

  if (kind === "terminal" && !interactiveCommand && !headlessCommand) {
    throw new Error(
      "Agent manifest field 'runtime' must define interactive_command or headless_command for terminal agents",
    );
  }
  if (headlessEnvironment && !headlessCommand) {
    throw new Error(
      "Agent manifest field 'runtime.headless_environment' requires runtime.headless_command",
    );
  }
  if (promptTransport && !headlessCommand) {
    throw new Error(
      "Agent manifest field 'runtime.prompt_transport' requires runtime.headless_command",
    );
  }
  if (kind === "terminal" && processLifecycle?.support === "managed") {
    throw new Error(
      "Agent manifest field 'runtime.process_lifecycle' cannot be managed for a terminal runtime",
    );
  }

  return {
    kind,
    ...(interactiveCommand ? { interactive_command: interactiveCommand } : {}),
    ...(headlessCommand ? { headless_command: headlessCommand } : {}),
    ...(promptTransport ? { prompt_transport: promptTransport } : {}),
    ...(commandShell ? { command_shell: commandShell } : {}),
    ...(startupEnvironment ? { startup_environment: startupEnvironment } : {}),
    ...(headlessEnvironment ? { headless_environment: headlessEnvironment } : {}),
    ...(smokeCommands && smokeCommands.length > 0 ? { smoke_commands: smokeCommands } : {}),
    ...(smokeBoundary ? { smoke_boundary: smokeBoundary } : {}),
    ...(agentCommand ? { agent_command: agentCommand } : {}),
    ...(processLifecycle ? { process_lifecycle: processLifecycle } : {}),
    ...(devicePairingSettlement ? { device_pairing_settlement: devicePairingSettlement } : {}),
  };
}

/** Resolve the fixed shell boundary used for package-declared runtime commands. */
export function getAgentCommandShell(
  agent: { runtime?: { command_shell?: unknown } | null } | null | undefined,
): AgentCommandShell {
  return agent?.runtime?.command_shell === "/bin/bash" ? "/bin/bash" : "/bin/sh";
}

/** Resolve the fixed smoke boundary, preserving the existing login-shell default. */
export function getAgentSmokeBoundary(
  agent: { runtime?: { smoke_boundary?: AgentSmokeBoundary } | null } | null | undefined,
): AgentSmokeBoundary {
  return agent?.runtime?.smoke_boundary ?? { kind: "login-shell" };
}

export function getAgentRuntimeKind(
  agent: { runtime?: { kind?: unknown } | null } | null | undefined,
): AgentRuntimeKind {
  return agent?.runtime?.kind === "terminal" ? "terminal" : "gateway";
}

export function isTerminalAgent(
  agent: { runtime?: { kind?: unknown } | null } | null | undefined,
): boolean {
  return getAgentRuntimeKind(agent) === "terminal";
}
