// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { CaptureOpenshellOptions, CaptureOpenshellResult } from "../adapters/openshell/client";
import { OPENSHELL_OPERATION_TIMEOUT_MS } from "../adapters/openshell/timeouts";
import { redactFull } from "../security/redact";
import type { AgentConfigTarget } from "./agent-config";

// Absolute paths installed by the Hermes package image. This module is the
// isolated compatibility boundary for pre-package dashboard reconciliation.
const HERMES_DASHBOARD_SEEDER_PATH = "/usr/local/lib/nemoclaw/seed-hermes-dashboard-config.py";
const HERMES_MANAGED_POLICY_PATH = "/usr/local/share/nemoclaw/hermes-managed-policy.json";
const HERMES_TRUSTED_PYTHON3 = [
  "/opt/hermes/.venv/bin/python3",
  "/usr/local/bin/python3",
  "/usr/bin/python3",
] as const;
const HERMES_DASHBOARD_PATH_ABSENT_STATUS = 3;
const DASHBOARD_CAPTURE_MAX_BUFFER = 17 * 1024 * 1024;
const HERMES_DASHBOARD_RESEED_DIAGNOSTIC_MAX_CHARS = 800;

// OpenShell rejects CR/LF in argv, so encode the multiline program inside a
// single-line Python expression.
const HERMES_DASHBOARD_PATH_INSPECTION = `exec(${JSON.stringify(
  [
    "import os",
    "import stat",
    "import sys",
    "try:",
    "    mode = os.lstat(sys.argv[1]).st_mode",
    "except FileNotFoundError:",
    `    raise SystemExit(${HERMES_DASHBOARD_PATH_ABSENT_STATUS})`,
    "except OSError as exc:",
    '    print(f"unable to inspect Hermes dashboard path: {exc}", file=sys.stderr)',
    "    raise SystemExit(2)",
    "raise SystemExit(0 if stat.S_ISDIR(mode) else 2)",
  ].join("\n"),
)})`;

export type HermesDashboardReseedResult = "converged" | "absent" | "failed";

export interface HermesDashboardReseedDeps {
  getOpenshellBinary: () => string;
  captureOpenshellCommand: (
    binary: string,
    args: string[],
    options: CaptureOpenshellOptions,
  ) => CaptureOpenshellResult;
  reportFailure?: (stage: "python" | "inspection" | "seed", detail: string) => void;
}

function hermesDashboardReseedFailureDetail(result: CaptureOpenshellResult): string {
  const raw =
    result.error?.message || result.stderr?.trim() || result.output.trim() || result.stdout?.trim();
  const detail = redactFull(raw || "no command output")
    .replace(/\s+/gu, " ")
    .trim();
  const bounded = detail.slice(0, HERMES_DASHBOARD_RESEED_DIAGNOSTIC_MAX_CHARS);
  return [
    `status=${result.status === null ? "null" : result.status}`,
    result.signal ? `signal=${result.signal}` : "",
    bounded ? `detail=${bounded}` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

/** Reconcile the dashboard profile after an in-place legacy Hermes config change. */
export function runHermesDashboardConfigSeed(
  sandboxName: string,
  target: AgentConfigTarget,
  mergeLegacy: boolean,
  deps: HermesDashboardReseedDeps,
): HermesDashboardReseedResult {
  const dashboardHome = `${target.configDir}/profiles/dashboard-home`;
  const legacyDashboardHome = `${target.configDir}/dashboard-home`;
  const binary = deps.getOpenshellBinary();
  const capture = (command: string[]) =>
    deps.captureOpenshellCommand(
      binary,
      ["sandbox", "exec", "--name", sandboxName, "--", ...command],
      {
        ignoreError: true,
        includeStreams: true,
        maxBuffer: DASHBOARD_CAPTURE_MAX_BUFFER,
        timeout: OPENSHELL_OPERATION_TIMEOUT_MS,
      },
    );
  const failed = (result: CaptureOpenshellResult) =>
    Boolean(result.error || result.signal || result.status !== 0);
  const reportFailure = (
    stage: "python" | "inspection" | "seed",
    result: CaptureOpenshellResult,
  ) => {
    const detail = hermesDashboardReseedFailureDetail(result);
    if (deps.reportFailure) {
      deps.reportFailure(stage, detail);
      return;
    }
    console.error(`  Hermes dashboard reseed ${stage} failed: ${detail}`);
  };

  let python: (typeof HERMES_TRUSTED_PYTHON3)[number] | null = null;
  let lastPythonFailure: CaptureOpenshellResult | undefined;
  for (const candidate of HERMES_TRUSTED_PYTHON3) {
    const probe = capture([candidate, "-c", ""]);
    if (!failed(probe)) {
      python = candidate;
      break;
    }
    lastPythonFailure = probe;
  }
  if (!python) {
    if (lastPythonFailure) reportFailure("python", lastPythonFailure);
    return "failed";
  }

  // lstat distinguishes an absent profile from a file, symlink, or inspection
  // error. Only absence is a clean no-op.
  let inspection = capture([python, "-c", HERMES_DASHBOARD_PATH_INSPECTION, dashboardHome]);
  if (
    !inspection.error &&
    !inspection.signal &&
    inspection.status === HERMES_DASHBOARD_PATH_ABSENT_STATUS
  ) {
    inspection = capture([python, "-c", HERMES_DASHBOARD_PATH_INSPECTION, legacyDashboardHome]);
    if (
      !inspection.error &&
      !inspection.signal &&
      inspection.status === HERMES_DASHBOARD_PATH_ABSENT_STATUS
    ) {
      return "absent";
    }
  }
  if (failed(inspection)) {
    reportFailure("inspection", inspection);
    return "failed";
  }

  const dashboardConfigPath = `${dashboardHome}/config.yaml`;
  const seed = capture([
    python,
    HERMES_DASHBOARD_SEEDER_PATH,
    ...(mergeLegacy ? ["--merge-legacy"] : []),
    HERMES_MANAGED_POLICY_PATH,
    target.configPath,
    dashboardConfigPath,
    `${target.configDir}/.env`,
    `${dashboardHome}/.env`,
  ]);
  if (failed(seed)) {
    reportFailure("seed", seed);
    return "failed";
  }
  const seededMarker = `[dashboard] seeded model routing and reviewed policy into ${dashboardConfigPath}`;
  if (
    !String(seed.stderr ?? "")
      .split(/\r?\n/u)
      .includes(seededMarker)
  ) {
    reportFailure("seed", seed);
    return "failed";
  }
  return "converged";
}
