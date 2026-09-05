// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

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

/** Resolve command metadata from exact package authority, retaining only no-receipt compatibility. */
export function resolveSandboxCommandAgent(
  entry: SandboxEntry,
  dependencies: SandboxCommandAgentDependencies = defaultDependencies,
): AgentDefinition {
  return entry.harnessPackage
    ? dependencies.resolvePackageAgent(entry).definition
    : dependencies.loadAgent(normalizeSandboxAgentName(entry.agent));
}
