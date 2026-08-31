// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Shell-harness helpers shared by the gateway lifecycle suites. Package tests
// exercise OpenClaw startup directly; composed tests also load NemoClaw's
// gateway supervisor to prove the two sides still agree on PID identity.

import * as fs from "node:fs";
import * as path from "node:path";

import { expect } from "vitest";

export const START_SCRIPT = path.join(import.meta.dirname, "..", "..", "start.sh");
export const GATEWAY_SUPERVISOR = path.join(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "..",
  "scripts",
  "lib",
  "gateway-supervisor.sh",
);

// Read a file that may legitimately be absent without a check-then-read
// race (CodeQL js/file-system-race): attempt the read and treat a missing
// file as null.
export function readFileIfPresent(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}

export function extractShellFunction(src: string, name: string): string {
  const header = `${name}() {`;
  const start = src.indexOf(header);
  expect(start, `Expected ${name} in packages/nemoclaw-openclaw/start.sh`).not.toBe(-1);
  const bodyStart = start + header.length;
  const body = src.slice(bodyStart);
  const closing = body.match(/^}$/m);
  expect(
    closing,
    `Expected closing brace for ${name} in packages/nemoclaw-openclaw/start.sh`,
  ).not.toBeNull();
  return `${name}() {${body.slice(0, closing?.index ?? 0)}\n}`;
}

export function extractGatewayLogAppendFunction(src: string, gatewayLog: string): string {
  const functionSource = extractShellFunction(src, "append_openclaw_gateway_log_line");
  const marker = '  local log_file="/tmp/gateway.log"';
  expect(functionSource).toContain(marker);
  return functionSource.replace(marker, `  local log_file=${JSON.stringify(gatewayLog)}`);
}

export function safeTmpHelpers(src: string): string {
  const start = src.indexOf("_nemoclaw_safe_replace_tmp_file() {");
  const end = src.indexOf("_START_LOG=", Math.max(start, 0));
  expect(start, "Expected safe temp helpers in packages/nemoclaw-openclaw/start.sh").not.toBe(-1);
  expect(end, "Expected safe temp helpers in packages/nemoclaw-openclaw/start.sh").toBeGreaterThan(
    start,
  );
  return src.slice(start, end);
}

export function pidIdentityFunctions(src: string): string {
  const supervisor = fs.readFileSync(GATEWAY_SUPERVISOR, "utf-8");
  return [
    extractShellFunction(src, "openclaw_load_pid_identity"),
    extractShellFunction(src, "openclaw_pid_start_identity"),
    extractShellFunction(src, "capture_openclaw_pid_start_identity"),
    extractShellFunction(src, "openclaw_supervised_pid_is_live"),
    extractShellFunction(supervisor, "gateway_control_proc_root"),
    extractShellFunction(supervisor, "gateway_control_proc_root_is_explicit"),
    extractShellFunction(supervisor, "gateway_control_pid_state"),
    extractShellFunction(supervisor, "gateway_control_pid_is_live"),
  ].join("\n");
}

export function gatewayMarkerFunction(src: string, name: string, markerPath: string): string {
  return extractShellFunction(src, name).replaceAll("/tmp/nemoclaw-gateway-local", markerPath);
}

export function rootGatewayLifecycleFunctions(src: string, gatewayLog: string): string {
  return [
    pidIdentityFunctions(src),
    extractShellFunction(src, "arm_openclaw_gateway_supervisor_cleanup"),
    extractShellFunction(src, "launch_openclaw_gateway_process").replaceAll(
      "/tmp/gateway.log",
      gatewayLog,
    ),
    extractShellFunction(src, "launch_openclaw_gateway").replaceAll("/tmp/gateway.log", gatewayLog),
    extractShellFunction(src, "openclaw_supervised_aux_pid_is_live"),
    extractShellFunction(src, "stop_openclaw_supervised_gateway"),
    extractShellFunction(src, "refresh_openclaw_supervised_child_pids"),
    extractShellFunction(src, "mark_openclaw_gateway_stopped"),
    extractShellFunction(src, "stop_openclaw_gateway_fail_closed"),
    extractShellFunction(src, "openclaw_reap_exited_gateway"),
  ].join("\n");
}

export function gatewayLaunchBlock(
  src: string,
  kind: "non-root" | "root",
  gatewayLog: string,
): string {
  const startMarker =
    kind === "non-root"
      ? "# Start gateway in background, auto-pair, then wait"
      : "# Start the gateway as the 'gateway' user.";
  const start = src.indexOf(startMarker);
  const end = src.indexOf('SANDBOX_WAIT_PID="$GATEWAY_PID"', start);
  expect(
    start,
    `Expected ${kind} gateway launch block in packages/nemoclaw-openclaw/start.sh`,
  ).not.toBe(-1);
  expect(
    end,
    `Expected ${kind} gateway launch block in packages/nemoclaw-openclaw/start.sh`,
  ).not.toBe(-1);
  return src.slice(start, src.indexOf("\n", end)).replaceAll("/tmp/gateway.log", gatewayLog);
}

export const writeProcStatFunction = [
  "write_proc_stat() {",
  '  local pid="$1" parent="$2" start="$3"',
  '  printf \'%s (test-process) S %s\' "$pid" "$parent"',
  "  for _ in {1..17}; do printf ' 0'; done",
  "  printf ' %s\\n' \"$start\"",
  "}",
].join("\n");
