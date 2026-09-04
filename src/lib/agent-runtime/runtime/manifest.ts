// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isObjectRecord } from "../../core/json-types";

export type AgentRuntimeKind = "gateway" | "terminal";

export type AgentCommandShell = "/bin/sh" | "/bin/bash";

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
  command_shell?: AgentCommandShell;
  startup_environment?: Readonly<Record<string, string>>;
  smoke_commands?: string[];
  smoke_boundary?: AgentSmokeBoundary;
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

/** Read public, package-owned constants needed before the agent entrypoint starts. */
function readStartupEnvironment(
  record: RuntimeRecord,
): Readonly<Record<string, string>> | undefined {
  const value = record.startup_environment;
  if (value === undefined) return undefined;
  if (!isObjectRecord(value)) {
    throw new Error("Agent manifest field 'runtime.startup_environment' must be an object");
  }

  const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
  for (const [key, rawValue] of entries) {
    if (!STARTUP_ENVIRONMENT_KEY.test(key)) {
      throw new Error(
        `Agent manifest field 'runtime.startup_environment.${key}' must use an uppercase environment name`,
      );
    }
    if (
      key.startsWith("NEMOCLAW_") ||
      key.startsWith("OPENSHELL_") ||
      CORE_ENVIRONMENT_KEYS.has(key) ||
      SECRET_ENVIRONMENT_KEY.test(key)
    ) {
      throw new Error(
        `Agent manifest field 'runtime.startup_environment.${key}' cannot replace a core-owned or credential environment value`,
      );
    }
    if (
      typeof rawValue !== "string" ||
      rawValue.length === 0 ||
      rawValue.length > 4096 ||
      /[\0\r\n]/u.test(rawValue)
    ) {
      throw new Error(
        `Agent manifest field 'runtime.startup_environment.${key}' must be a non-empty single-line string of at most 4096 characters`,
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
  const commandShell = readCommandShell(runtime);
  const startupEnvironment = readStartupEnvironment(runtime);
  const smokeCommands = readStringArray(runtime, "smoke_commands");
  const smokeBoundary = readSmokeBoundary(runtime);

  if (kind === "terminal" && !interactiveCommand && !headlessCommand) {
    throw new Error(
      "Agent manifest field 'runtime' must define interactive_command or headless_command for terminal agents",
    );
  }

  return {
    kind,
    ...(interactiveCommand ? { interactive_command: interactiveCommand } : {}),
    ...(headlessCommand ? { headless_command: headlessCommand } : {}),
    ...(commandShell ? { command_shell: commandShell } : {}),
    ...(startupEnvironment ? { startup_environment: startupEnvironment } : {}),
    ...(smokeCommands && smokeCommands.length > 0 ? { smoke_commands: smokeCommands } : {}),
    ...(smokeBoundary ? { smoke_boundary: smokeBoundary } : {}),
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
