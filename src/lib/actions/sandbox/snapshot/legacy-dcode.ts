// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { captureOpenshell } from "../../../adapters/openshell/runtime";
import { OPENSHELL_PROBE_TIMEOUT_MS } from "../../../adapters/openshell/timeouts";
import { readRegisteredSandboxAuthority } from "../../../onboard/package/package-authority";
import {
  DCODE_AGENT_NAME,
  DCODE_BUSY_PROBE_SCRIPT,
  DCODE_PROBE_STATE,
  parseDcodeProbeState,
} from "../dcode-activity-probe";
import {
  buildSandboxExecMarkedCommand,
  createSandboxExecMarker,
  extractSandboxExecCommandStdoutFromStreams,
} from "../sandbox-exec-output";

/** Exact-ID compatibility for old sandboxes without a package receipt. */
export function legacySandboxRequiresDcodeActivityProbe(sandboxName: string): boolean {
  const entry = readRegisteredSandboxAuthority(sandboxName);
  return !entry || (!entry.harnessPackage && entry.agent === DCODE_AGENT_NAME);
}

/** Run the historical inline DCode probe only for an explicitly no-receipt row. */
export function inspectLegacyDcodeBackupQuiescence(sandboxName: string): boolean {
  const execMarker = createSandboxExecMarker();
  const probe = captureOpenshell(
    [
      "sandbox",
      "exec",
      "--name",
      sandboxName,
      "--",
      "sh",
      "-c",
      buildSandboxExecMarkedCommand(DCODE_BUSY_PROBE_SCRIPT, execMarker),
    ],
    {
      ignoreError: true,
      includeStreams: true,
      timeout: OPENSHELL_PROBE_TIMEOUT_MS,
    },
  );
  const completed = probe.status === 0 && !probe.error && !probe.signal;
  const stdout = completed
    ? extractSandboxExecCommandStdoutFromStreams(
        { stdout: probe.stdout, stderr: probe.stderr },
        execMarker,
      )
    : null;
  const state = stdout === null ? null : parseDcodeProbeState(stdout);
  if (state === DCODE_PROBE_STATE.idleDcodeRuntime || state === DCODE_PROBE_STATE.noDcodeRuntime) {
    return true;
  }
  if (state === DCODE_PROBE_STATE.active) {
    console.error(
      "  Sandbox is actively running a dcode task. Please retry after the task completes.",
    );
    return false;
  }
  console.error(
    `  Cannot verify whether sandbox '${sandboxName}' is actively running a dcode task. Refusing to create snapshot.`,
  );
  return false;
}
