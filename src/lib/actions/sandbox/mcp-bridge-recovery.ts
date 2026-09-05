// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { redactFull } from "../../security/redact";
import type { McpBridgeEntry } from "../../state/registry";
import {
  type AgentMcpRuntimeIntentInspection,
  inspectAgentMcpRuntimeIntent,
} from "./mcp-bridge-adapters";
import { redactBridgeSecretsForDisplay } from "./mcp-bridge-output";
import type { McpProviderInspectionRuntimeSelection } from "./mcp-bridge-provider-inspection";
import {
  bridgeState,
  findRegisteredSandbox,
  getBridgeAdapter,
  getSandboxAgent,
} from "./mcp-bridge-state";

const MCP_RUNTIME_INTENT_FAILURE =
  "Managed MCP runtime does not match the persisted package-owned intent";
const ANSI_OR_UNSAFE_CONTROL_RE =
  /\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\)|[@-_])|[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g;
const DISPLAY_LINE_BREAK_RE = /[\r\n\u2028\u2029]+/g;

export type McpRuntimeIntentResult =
  | { ok: true; state: "matched" | "not-applicable" }
  | { ok: false; state: "mismatch" | "error"; detail: string };

export type McpReconciliationRefusalRecoveryResult = {
  checked: true;
  wasRunning: boolean;
  recovered: false;
  forwardRecovered: false;
  forwardRecoveryFailed?: undefined;
  forwardRecoveryFailureDetail?: undefined;
  mcpReconciliationRefused: true;
  mcpReconciliationReason: string;
};

type InspectMcpRuntimeIntent = (sandboxName: string) => McpRuntimeIntentResult;

/** Keep operator recovery finite and independent of any package implementation. */
export function mcpRuntimeIntentRemediationLines(sandboxName: string): readonly string[] {
  return [
    `Run \`nemoclaw ${sandboxName} mcp restart\` to restore the managed MCP configuration, then retry.`,
    `If the package runtime is unavailable or its metadata is stale, run \`nemoclaw ${sandboxName} rebuild --yes\` instead.`,
  ];
}

/** Sanitize package-owned inspection detail before it crosses the host terminal boundary. */
export function sanitizeMcpRuntimeIntentDetail(
  detail: string,
  entries: readonly McpBridgeEntry[] = [],
): string {
  let sanitized = String(detail || "").replace(ANSI_OR_UNSAFE_CONTROL_RE, "");
  for (const entry of entries) {
    const envValues = Object.fromEntries(
      entry.env.flatMap((name) => (process.env[name] ? [[name, process.env[name]]] : [])),
    );
    sanitized = redactBridgeSecretsForDisplay(sanitized, entry, envValues);
  }
  return (
    redactFull(sanitized).replace(DISPLAY_LINE_BREAK_RE, " ").replace(/\s+/g, " ").trim() ||
    MCP_RUNTIME_INTENT_FAILURE
  );
}

/**
 * Inspect package-owned MCP intent after gateway recovery. Sandboxes without
 * managed MCP state need no package operation; every MCP-bearing sandbox must
 * resolve its installed package and adapter before inspection.
 */
export function inspectMcpRuntimeIntent(
  sandboxName: string,
  runtimeSelection?: McpProviderInspectionRuntimeSelection,
): McpRuntimeIntentResult {
  const sandbox = findRegisteredSandbox(sandboxName);
  if (!sandbox) {
    return {
      ok: false,
      state: "error",
      detail: sanitizeMcpRuntimeIntentDetail(`Sandbox '${sandboxName}' not found.`),
    };
  }
  if (sandbox.name !== sandboxName) {
    return {
      ok: false,
      state: "error",
      detail: sanitizeMcpRuntimeIntentDetail(
        `Registry entry name mismatch for sandbox '${sandboxName}'.`,
      ),
    };
  }
  if (!sandbox.mcp) return { ok: true, state: "not-applicable" };

  const entries = Object.values(bridgeState(sandbox));
  try {
    const adapter = getBridgeAdapter(getSandboxAgent(sandbox));
    const inspection: AgentMcpRuntimeIntentInspection | undefined = inspectAgentMcpRuntimeIntent(
      sandboxName,
      adapter,
      { entries, runtimeSelection },
    );
    if (!inspection) return { ok: true, state: "not-applicable" };
    if (inspection.ok) return inspection;
    return {
      ...inspection,
      detail: sanitizeMcpRuntimeIntentDetail(inspection.detail, entries),
    };
  } catch (error) {
    return {
      ok: false,
      state: "error",
      detail: sanitizeMcpRuntimeIntentDetail(
        error instanceof Error ? error.message : String(error),
        entries,
      ),
    };
  }
}

export function inspectMcpRuntimeIntentRefusal(
  sandboxName: string,
  inspect: InspectMcpRuntimeIntent = inspectMcpRuntimeIntent,
  runtimeSelection?: McpProviderInspectionRuntimeSelection,
): { detail: string } | null {
  const inspection =
    inspect === inspectMcpRuntimeIntent
      ? inspectMcpRuntimeIntent(sandboxName, runtimeSelection)
      : inspect(sandboxName);
  if (inspection.ok) return null;
  return { detail: sanitizeMcpRuntimeIntentDetail(inspection.detail) };
}

export function processRecoveryMcpReconciliationRefusal(
  sandboxName: string,
  wasRunning: boolean,
  inspect: InspectMcpRuntimeIntent = inspectMcpRuntimeIntent,
  runtimeSelection?: McpProviderInspectionRuntimeSelection,
): McpReconciliationRefusalRecoveryResult | null {
  const refusal = inspectMcpRuntimeIntentRefusal(sandboxName, inspect, runtimeSelection);
  if (!refusal) return null;
  return {
    checked: true,
    wasRunning,
    recovered: false,
    forwardRecovered: false,
    mcpReconciliationRefused: true,
    mcpReconciliationReason: refusal.detail,
  };
}
