// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { AgentDefinition } from "../../agent/defs";
import {
  hasHarnessPackageAuthority,
  resolveSandboxStatusAgent,
  type SandboxStatusAgentInfo,
} from "../../agent-runtime/status-agent";
import type { SandboxEntry } from "../../state/registry";

export { hasHarnessPackageAuthority };

export type DoctorAgentAuthority =
  | { readonly kind: "legacy" }
  | {
      readonly kind: "resolved";
      readonly definition: AgentDefinition;
      readonly runtimeKind: "gateway" | "terminal";
    }
  | { readonly kind: "unsupported"; readonly reason: string };

export interface DoctorAgentAuthorityDeps {
  resolveStatusAgent?: (entry: SandboxEntry) => SandboxStatusAgentInfo;
}

function safeReason(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return (
    detail
      .replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ")
      .replace(/\s+/gu, " ")
      .trim()
      .slice(0, 240) || "the installed harness package could not be resolved"
  );
}

/** Resolve only exact package authority; legacy doctor behavior stays with its existing caller. */
export function resolveDoctorAgentAuthority(
  entry: SandboxEntry | null | undefined,
  deps: DoctorAgentAuthorityDeps = {},
): DoctorAgentAuthority {
  if (!entry || !hasHarnessPackageAuthority(entry)) return { kind: "legacy" };

  let statusAgent: SandboxStatusAgentInfo;
  try {
    statusAgent = (deps.resolveStatusAgent ?? resolveSandboxStatusAgent)(entry);
  } catch (error) {
    return { kind: "unsupported", reason: safeReason(error) };
  }
  if (
    statusAgent.packageAuthorityInvalid ||
    !statusAgent.agentDefinition ||
    statusAgent.agentRuntime === "unknown"
  ) {
    return {
      kind: "unsupported",
      reason: safeReason(
        statusAgent.agentLoadError ?? "the installed harness package could not be resolved",
      ),
    };
  }
  return {
    kind: "resolved",
    definition: statusAgent.agentDefinition,
    runtimeKind: statusAgent.agentRuntime,
  };
}
