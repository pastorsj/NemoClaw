// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isDeepStrictEqual } from "node:util";

import { type AgentDefinition, getAgentRuntimeKind, loadAgent } from "../agent/defs";
import {
  normalizeSandboxAgentName,
  resolveSandboxAgent,
  type ResolvedSandboxAgent,
} from "../onboard/sandbox-agent";
import type { HarnessPackageIdentity, HarnessPackageMigration } from "./package/types";

export interface SandboxStatusAgentInfo {
  agentName: string;
  agentDisplayName: string;
  agentRuntime: "gateway" | "terminal" | "unknown";
  agentLoadError?: string;
  agentDefinition: AgentDefinition | null;
}

export interface SandboxStatusAgentDeps {
  loadAgentImpl?: typeof loadAgent;
  resolveSandboxAgentImpl?: typeof resolveSandboxAgent;
}

export interface SandboxStatusAgentEntry {
  readonly agent?: string | null;
  readonly harnessPackage?: HarnessPackageIdentity;
  readonly harnessPackageMigration?: HarnessPackageMigration;
}

export type SandboxStatusAgentSource = string | SandboxStatusAgentEntry | null;

export function hasHarnessPackageAuthority(sandbox: SandboxStatusAgentEntry | null): boolean {
  return sandbox?.harnessPackage != null || sandbox?.harnessPackageMigration != null;
}

function resolvedStatusAgentMatchesSandbox(
  sandbox: SandboxStatusAgentEntry,
  selectedAgent: ResolvedSandboxAgent,
): boolean {
  const recordedAgent = sandbox.agent ?? null;
  const effectiveAgentId = normalizeSandboxAgentName(recordedAgent);
  return (
    selectedAgent.recordedAgent === recordedAgent &&
    selectedAgent.effectiveAgentId === effectiveAgentId &&
    selectedAgent.definition.name === effectiveAgentId &&
    isDeepStrictEqual(selectedAgent.harnessPackage, sandbox.harnessPackage ?? null) &&
    isDeepStrictEqual(
      selectedAgent.harnessPackageMigration,
      sandbox.harnessPackageMigration ?? null,
    )
  );
}

function safeAgentLoadError(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return (
    detail
      .replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ")
      .replace(/\s+/gu, " ")
      .trim()
      .slice(0, 240) || "agent definition could not be resolved"
  );
}

/** Resolve receipt-backed status metadata from the exact installed definition. */
export function resolveSandboxStatusAgent(
  source: SandboxStatusAgentSource = "openclaw",
  deps: SandboxStatusAgentDeps = {},
): SandboxStatusAgentInfo {
  const sandbox = typeof source === "string" || source === null ? null : source;
  const agentName =
    typeof source === "string"
      ? normalizeSandboxAgentName(source)
      : normalizeSandboxAgentName(source?.agent);
  const receiptBacked = hasHarnessPackageAuthority(sandbox);
  let agentDisplayName = agentName === "openclaw" ? "OpenClaw" : agentName;
  let agentRuntime: SandboxStatusAgentInfo["agentRuntime"] = "gateway";
  let agentLoadError: string | undefined;
  let agentDefinition: AgentDefinition | null = null;
  try {
    const agent = receiptBacked
      ? (() => {
          if (!sandbox) throw new Error("the sandbox package authority is unavailable");
          const selectedAgent = (deps.resolveSandboxAgentImpl ?? resolveSandboxAgent)(sandbox);
          if (!resolvedStatusAgentMatchesSandbox(sandbox, selectedAgent)) {
            throw new Error(
              "the selected agent definition does not match the sandbox package receipt",
            );
          }
          return selectedAgent.definition;
        })()
      : (deps.loadAgentImpl ?? loadAgent)(agentName);
    agentDisplayName = agent.displayName;
    agentRuntime = getAgentRuntimeKind(agent);
    agentDefinition = receiptBacked || agentName !== "openclaw" ? agent : null;
  } catch (error) {
    if (receiptBacked || agentName !== "openclaw") {
      agentRuntime = "unknown";
      agentLoadError = safeAgentLoadError(error);
    }
  }
  return {
    agentName,
    agentDisplayName,
    agentRuntime,
    ...(agentLoadError ? { agentLoadError } : {}),
    agentDefinition,
  };
}
