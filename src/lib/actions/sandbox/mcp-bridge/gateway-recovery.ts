// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  classifyGatewayRestartFailure,
  type GatewayRestartCommandResult,
  type GatewayRestartFailureLayer,
  parseManagedGatewayControlCompletion,
  redactGatewayRestartFailureDetail,
} from "../runtime/gateway-result";
import type { OpenShellCommandResult } from "../mcp-bridge-output";

const TERMINAL_RECOVERY_LAYERS = new Set<GatewayRestartFailureLayer>([
  "secret-boundary refusal",
  "unsafe config path",
  "config hash mismatch",
  "relaunch quarantined",
  "health timeout",
]);

const TERMINAL_RECOVERY_MARKERS = [
  "SUPERVISOR_REBUILD_REQUIRED",
  "SUPERVISOR_UNSAFE_CONTROL_DIR",
  "SUPERVISOR_BUSY",
  "SUPERVISOR_INVALID_",
  "GATEWAY_GUARDS_MISSING",
] as const;

export interface ManagedMcpGatewayRecoveryInspection {
  readonly completed: boolean;
  readonly terminal: boolean;
  readonly detail: string;
  readonly layer: GatewayRestartFailureLayer | null;
}

function commandStream(value: OpenShellCommandResult["stdout"]): string {
  return typeof value === "string" ? value : (value?.toString() ?? "");
}

function normalizeGatewayResult(
  result: OpenShellCommandResult | null,
): GatewayRestartCommandResult | null {
  if (result === null || result.status === null) return null;
  return {
    status: result.status,
    stdout: commandStream(result.stdout),
    stderr: commandStream(result.stderr),
  };
}

/**
 * Classify a managed gateway recovery result before an MCP transaction resumes.
 * A later package probe proves readiness, but it cannot override an integrity refusal.
 */
export function inspectManagedMcpGatewayRecovery(
  result: OpenShellCommandResult | null,
  failureDetail = "",
): ManagedMcpGatewayRecoveryInspection {
  const normalizedResult = normalizeGatewayResult(result);
  if (parseManagedGatewayControlCompletion(normalizedResult) !== null) {
    return Object.freeze({ completed: true, terminal: false, detail: "", layer: null });
  }

  const classification = classifyGatewayRestartFailure(normalizedResult);
  const stdout = commandStream(result?.stdout);
  const stderr = commandStream(result?.stderr);
  const markerSource = [failureDetail, stderr, stdout].join("\n");
  const detail = failureDetail
    ? redactGatewayRestartFailureDetail(failureDetail)
    : classification.detail || "no controller result";
  const claimsInvalidCompletion =
    result !== null && (result.status === 0 || stdout.trim().length > 0);
  const terminal =
    claimsInvalidCompletion ||
    TERMINAL_RECOVERY_LAYERS.has(classification.layer) ||
    TERMINAL_RECOVERY_MARKERS.some((marker) => markerSource.includes(marker));

  return Object.freeze({
    completed: false,
    terminal,
    detail,
    layer: classification.layer,
  });
}
