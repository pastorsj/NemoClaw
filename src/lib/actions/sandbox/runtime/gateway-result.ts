// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { GATEWAY_RESTART_MARKERS as MARKERS } from "../../../agent/gateway-restart-markers";
import { redactFullWithUrls } from "../../../security/redact";
import { PROCESS_LIFECYCLE_UNSUPPORTED_MARKER } from "../process-lifecycle";

export type GatewayRestartCommandResult = {
  status: number;
  stdout: string;
  stderr: string;
};

export const MANAGED_CONTROL_IDENTITY_CHANGED_MARKER = "MANAGED_CONTROL_IDENTITY_CHANGED";

export type ManagedGatewayControlCompletion = {
  disposition: "ok" | "already-running";
  oldPid: number;
  newPid: number;
};

export function parseManagedGatewayControlCompletion(
  result: GatewayRestartCommandResult | null,
  expectedNonce?: string,
): ManagedGatewayControlCompletion | null {
  if (!result || result.status !== 0 || result.stderr.trim()) return null;
  const lines = result.stdout.trim().split(/\r?\n/);
  if (lines.length !== 2) return null;
  const completion = lines[0]?.match(
    /^v1 ([0-9a-f]{64}) complete (ok|already-running) ([0-9]+) ([1-9][0-9]*)$/,
  );
  if (expectedNonce !== undefined && completion?.[1] !== expectedNonce) return null;
  if (completion === null || lines[1] !== `GATEWAY_PID=${completion[4]}`) return null;
  const disposition = completion[2] as ManagedGatewayControlCompletion["disposition"];
  const oldPid = Number.parseInt(completion[3], 10);
  const newPid = Number.parseInt(completion[4], 10);
  if (!Number.isSafeInteger(oldPid) || !Number.isSafeInteger(newPid)) return null;
  return { disposition, oldPid, newPid };
}

export type GatewayRestartFailureLayer =
  | "unsupported agent"
  | "privileged control unavailable"
  | "supervisor not running"
  | "supervisor unavailable"
  | "container identity changed"
  | "secret-boundary refusal"
  | "unsafe config path"
  | "config hash mismatch"
  | "MCP reconciliation refusal"
  | "relaunch quarantined"
  | "launch failure"
  | "health timeout"
  | "forward recovery failure";

// Substrings of the in-sandbox supervisor's quarantine lines. Keep these in
// sync with the managed gateway supervisors and controller allowlist.
const GATEWAY_RELAUNCH_QUARANTINE_MARKERS = [
  "quarantined until sandbox recreation",
  "quarantined until MCP integrity is restored",
  "quarantined without another launch",
  "quarantining the managed startup supervisor",
] as const;

function gatewayRestartOutput(result: GatewayRestartCommandResult): string {
  return [result.stdout, result.stderr].filter(Boolean).join("\n");
}

const ANSI_CONTROL_RE =
  /\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\)|[@-_])|[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

/** Redact controller detail before another gateway workflow can display it. */
export function redactGatewayRestartFailureDetail(detail: string): string {
  return redactFullWithUrls(detail);
}

export function sanitizeGatewayRestartFailureLine(line: string): string {
  const withoutControls = line.replace(ANSI_CONTROL_RE, "");
  return redactGatewayRestartFailureDetail(withoutControls);
}

function sanitizeGatewayRestartFailureDetail(detail: string): string {
  return detail
    .split(/\r?\n/)
    .map((line) => sanitizeGatewayRestartFailureLine(line.trim()))
    .filter(Boolean)
    .join("\n");
}

export function classifyGatewayRestartFailure(
  result: GatewayRestartCommandResult | null,
  { allowLegacyHarnessMarkers = false }: { allowLegacyHarnessMarkers?: boolean } = {},
): {
  layer: GatewayRestartFailureLayer;
  detail: string;
} {
  if (!result) {
    return {
      layer: "privileged control unavailable",
      detail: "privileged gateway supervisor control did not return command output",
    };
  }

  const output = gatewayRestartOutput(result);
  const outputLines = output.split(/\r?\n/);
  const isIdentityChangedMarkerLine = (line: string) =>
    line.trim() === MANAGED_CONTROL_IDENTITY_CHANGED_MARKER;
  const hasIdentityChangedMarker = outputLines.some(isIdentityChangedMarkerLine);
  const detail = sanitizeGatewayRestartFailureDetail(output.trim());
  if (outputLines.some((line) => line.trim() === PROCESS_LIFECYCLE_UNSUPPORTED_MARKER)) {
    return {
      layer: "unsupported agent",
      detail:
        sanitizeGatewayRestartFailureDetail(
          outputLines
            .filter((line) => line.trim() !== PROCESS_LIFECYCLE_UNSUPPORTED_MARKER)
            .join("\n"),
        ) || "the package does not support managed process lifecycle operations",
    };
  }
  if (output.includes("SUPERVISOR_NOT_RUNNING")) {
    return {
      layer: "supervisor not running",
      detail: detail || "the in-sandbox gateway supervisor is not running",
    };
  }
  if (output.includes("SUPERVISOR_DISCOVERY_PENDING")) {
    return {
      layer: "supervisor unavailable",
      detail: detail || "the managed gateway supervisor is still starting",
    };
  }
  if (output.includes("SUPERVISOR_UNAVAILABLE") && output.includes("NEMOCLAW_CONTROL_STAGE=")) {
    return {
      layer: "supervisor unavailable",
      detail: detail || "the managed gateway supervisor became unavailable",
    };
  }
  if (hasIdentityChangedMarker) {
    return {
      layer: "container identity changed",
      detail:
        sanitizeGatewayRestartFailureDetail(
          outputLines
            .filter((line) => !isIdentityChangedMarkerLine(line))
            .join("\n")
            .trim(),
        ) || "the selected container identity changed",
    };
  }
  if (
    output.includes(MARKERS.ROOT_EXEC_UNAVAILABLE) ||
    output.includes("PRIVILEGED_CONTROL_UNAVAILABLE") ||
    output.includes("SUPERVISOR_UNAVAILABLE") ||
    output.includes("SUPERVISOR_REBUILD_REQUIRED") ||
    output.includes("SUPERVISOR_UNSAFE_CONTROL_DIR") ||
    output.includes("SUPERVISOR_BUSY") ||
    output.includes("SUPERVISOR_SIGNAL_FAILED") ||
    output.includes("SUPERVISOR_INVALID_STATUS") ||
    output.includes("PROCESS_LIFECYCLE_INVALID_RESPONSE") ||
    output.includes(MARKERS.GOSU_MISSING) ||
    output.includes(MARKERS.GATEWAY_USER_MISSING)
  ) {
    return {
      layer: "privileged control unavailable",
      detail: detail || "privileged gateway supervisor control unavailable",
    };
  }
  if (output.includes(MARKERS.SECRET_BOUNDARY_REFUSED)) {
    return { layer: "secret-boundary refusal", detail: detail || "boundary refused" };
  }
  if (
    output.includes(MARKERS.GATEWAY_UNSAFE_CONFIG_PATH) ||
    (allowLegacyHarnessMarkers && output.includes("HERMES_UNSAFE_CONFIG_PATH")) ||
    (allowLegacyHarnessMarkers && output.includes(MARKERS.HERMES_RUNTIME_CONFIG_GUARD_MISSING)) ||
    output.includes(MARKERS.SECRET_BOUNDARY_VALIDATOR_MISSING)
  ) {
    return { layer: "unsafe config path", detail: detail || "unsafe config path" };
  }
  if (GATEWAY_RELAUNCH_QUARANTINE_MARKERS.some((marker) => output.includes(marker))) {
    return {
      layer: "relaunch quarantined",
      detail: detail || "the in-sandbox supervisor quarantined gateway relaunch",
    };
  }
  if (
    output.includes("mcp-integrity") ||
    output.includes("mcp-reconcile-required") ||
    (allowLegacyHarnessMarkers && output.includes("HERMES_MCP_CONFIG_DRIFT"))
  ) {
    return {
      layer: "MCP reconciliation refusal",
      detail: detail || "MCP reconciliation refused",
    };
  }
  if (
    output.includes(MARKERS.GATEWAY_CONFIG_HASH_MISMATCH) ||
    (allowLegacyHarnessMarkers && output.includes("HERMES_LOCKED_HASH_MISMATCH")) ||
    (allowLegacyHarnessMarkers && output.includes("HERMES_CONFIG_HASH_MISMATCH"))
  ) {
    return {
      layer: "config hash mismatch",
      detail: detail || "gateway config hash mismatch",
    };
  }
  if (output.includes("GATEWAY_HEALTH_TIMEOUT") || output.includes("SUPERVISOR_TIMEOUT")) {
    return { layer: "health timeout", detail: detail || "gateway health timeout" };
  }
  return { layer: "launch failure", detail: detail || `restart exited ${result.status}` };
}
