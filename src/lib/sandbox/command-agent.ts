// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isDeepStrictEqual } from "node:util";

import { loadAgent, type AgentDefinition } from "../agent/defs";
import { resolvePackageBackedSandboxAgent } from "../onboard/package/package-authority";
import { normalizeSandboxAgentName } from "../onboard/sandbox-agent";
import type { SandboxEntry } from "../state/registry";

export interface SandboxCommandAgentDependencies {
  readonly loadAgent: (agentName: string) => AgentDefinition;
  readonly resolvePackageAgent: (entry: SandboxEntry) => { readonly definition: AgentDefinition };
}

const defaultDependencies: SandboxCommandAgentDependencies = {
  loadAgent,
  resolvePackageAgent: resolvePackageBackedSandboxAgent,
};

export interface SandboxCommandAgentAuthority {
  readonly agent: NonNullable<SandboxEntry["agent"]> | null;
  readonly harnessPackage: NonNullable<SandboxEntry["harnessPackage"]> | null;
  readonly harnessPackageMigration: NonNullable<SandboxEntry["harnessPackageMigration"]> | null;
  readonly definition: AgentDefinition;
}

/** Resolve command metadata from exact package authority, retaining only no-receipt compatibility. */
export function resolveSandboxCommandAgent(
  entry: SandboxEntry,
  dependencies: SandboxCommandAgentDependencies = defaultDependencies,
): AgentDefinition {
  return entry.harnessPackage
    ? dependencies.resolvePackageAgent(entry).definition
    : dependencies.loadAgent(normalizeSandboxAgentName(entry.agent));
}

/** Capture the receipt and definition that authorize one sandbox command. */
export function captureSandboxCommandAgentAuthority(
  entry: SandboxEntry,
  dependencies: SandboxCommandAgentDependencies = defaultDependencies,
): SandboxCommandAgentAuthority {
  return Object.freeze({
    agent: entry.agent ?? null,
    harnessPackage: entry.harnessPackage ?? null,
    harnessPackageMigration: entry.harnessPackageMigration ?? null,
    definition: resolveSandboxCommandAgent(entry, dependencies),
  });
}

/** Re-resolve pinned package bytes and reject a changed receipt before mutation. */
export function requireCurrentSandboxCommandAgentAuthority(
  expected: SandboxCommandAgentAuthority,
  currentEntry: SandboxEntry | null,
  dependencies: SandboxCommandAgentDependencies = defaultDependencies,
): SandboxCommandAgentAuthority {
  if (!currentEntry) {
    throw new Error("Sandbox command agent authority is no longer registered");
  }
  const current = captureSandboxCommandAgentAuthority(currentEntry, dependencies);
  if (
    current.agent !== expected.agent ||
    !isDeepStrictEqual(current.harnessPackage, expected.harnessPackage) ||
    !isDeepStrictEqual(current.harnessPackageMigration, expected.harnessPackageMigration)
  ) {
    throw new Error("Sandbox command agent authority changed before mutation");
  }
  if (expected.harnessPackage && !isDeepStrictEqual(current.definition, expected.definition)) {
    throw new Error("Sandbox command agent package changed before mutation");
  }
  return current;
}
