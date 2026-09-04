// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { AgentDefinition } from "../../agent/defs";
import { getAgentCommandShell, getAgentSmokeBoundary } from "./manifest";

type RunCaptureOpenshell = (
  args: string[],
  opts?: { ignoreError?: boolean; timeout?: number },
) => string | { status?: number | null; output?: string | null } | null;

const SMOKE_EXIT_MARKER = "NEMOCLAW_AGENT_SMOKE_EXIT:";
const SMOKE_BEGIN_MARKER = "NEMOCLAW_AGENT_SMOKE_BEGIN";

export type AgentSmokeCommandResult =
  | { ok: true }
  | { ok: false; command: string; output: string | null };

function getSmokeExitCode(output: string | null, requireManagedBoundary: boolean): number | null {
  if (!output) return null;
  const exitMatches = [...output.matchAll(/(?:^|\n)NEMOCLAW_AGENT_SMOKE_EXIT:(\d+)(?=\n|$)/g)];
  if (!requireManagedBoundary) {
    const match = exitMatches[0];
    return match ? Number.parseInt(match[1]!, 10) : null;
  }
  const beginMatches = [...output.matchAll(/(?:^|\n)NEMOCLAW_AGENT_SMOKE_BEGIN(?=\n|$)/g)];
  if (
    beginMatches.length !== 1 ||
    exitMatches.length !== 1 ||
    beginMatches[0]!.index >= exitMatches[0]!.index
  ) {
    return null;
  }
  return Number.parseInt(exitMatches[0]![1]!, 10);
}

function smokeRunner(shellPath: "/bin/sh" | "/bin/bash", login: boolean): string {
  const shellFlag = login ? "-lc" : "-c";
  return `printf '${SMOKE_BEGIN_MARKER}\\n'; ${shellPath} ${shellFlag} "$1"; rc=$?; printf '\\n${SMOKE_EXIT_MARKER}%s\\n' "$rc"; exit 0`;
}

/**
 * A package can select the fixed managed-launcher boundary when its smoke
 * commands must bypass an agent-controlled login profile. The launcher path
 * and isolated HOME stay in that package's manifest; core owns only the typed
 * execution and evidence rules. The default login-shell boundary preserves the
 * existing profile-provided PATH behavior.
 */
export function buildAgentSmokeArgs(
  sandboxName: string,
  agent: AgentDefinition,
  command: string,
  gatewayName?: string,
): string[] {
  const shellPath = getAgentCommandShell(agent);
  const boundary = getAgentSmokeBoundary(agent);
  if (boundary.kind === "managed-launcher") {
    return [
      "sandbox",
      "exec",
      "-n",
      sandboxName,
      ...(gatewayName ? ["-g", gatewayName] : []),
      "--no-tty",
      "--env",
      `HOME=${boundary.home}`,
      "--env",
      "BASH_ENV=",
      "--env",
      "ENV=",
      "--",
      boundary.launcher,
      shellPath,
      "-c",
      smokeRunner(shellPath, false),
      "nemoclaw-agent-smoke",
      command,
    ];
  }
  return [
    "sandbox",
    "exec",
    "-n",
    sandboxName,
    ...(gatewayName ? ["-g", gatewayName] : []),
    "--",
    shellPath,
    "-lc",
    smokeRunner(shellPath, true),
    "nemoclaw-agent-smoke",
    command,
  ];
}

export function runAgentSmokeCommands(
  sandboxName: string,
  agent: AgentDefinition,
  runCaptureOpenshell: RunCaptureOpenshell,
  gatewayName?: string,
): AgentSmokeCommandResult {
  // smoke_commands are shell-form commands from repository-shipped agents/*/manifest.yaml files.
  // Switch to argv-form commands before accepting custom or user-provided manifests here.
  const commands = agent.runtime?.smoke_commands ?? [];
  for (const command of commands) {
    const result = runCaptureOpenshell(
      buildAgentSmokeArgs(sandboxName, agent, command, gatewayName),
      {
        ignoreError: true,
      },
    );
    const output = typeof result === "string" ? result : (result?.output ?? null);
    const requireManagedBoundary = getAgentSmokeBoundary(agent).kind === "managed-launcher";
    const exitCode = getSmokeExitCode(output, requireManagedBoundary);
    const transportFailed =
      requireManagedBoundary && (typeof result === "string" || result?.status !== 0);
    if (exitCode !== 0 || transportFailed) {
      return { ok: false, command, output };
    }
  }
  return { ok: true };
}

/** Build the fail-closed verifier used after an onboarded package is configured. */
export function createAgentSmokeCommandVerifier(
  agent: AgentDefinition,
  runCaptureOpenshell: RunCaptureOpenshell,
  getGatewayName: () => string,
): (sandboxName: string) => void {
  return (sandboxName) => {
    const result = runAgentSmokeCommands(sandboxName, agent, runCaptureOpenshell, getGatewayName());
    if (result.ok) return;
    throw new Error(`${agent.displayName} package smoke command failed: ${result.command}`);
  };
}
