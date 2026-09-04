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
