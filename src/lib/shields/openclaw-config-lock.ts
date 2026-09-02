// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import type { PrivilegedExec, PrivilegedExecResult } from "./state-dir-lock";

// OpenClaw's top-level config and trust anchor need a stronger transition than
// pathname chmod/chown can provide. The root-only helper resolves the exact
// directory through descriptors, rejects link/race substitutions, and swaps
// both files onto fresh inodes so writable descriptors opened before shields
// up cannot alter the trusted path afterward.

export const OPENCLAW_CONFIG_DIR = "/sandbox/.openclaw";
export const OPENCLAW_CONFIG_PATH = `${OPENCLAW_CONFIG_DIR}/openclaw.json`;
export const OPENCLAW_CONFIG_HASH_PATH = `${OPENCLAW_CONFIG_DIR}/.config-hash`;

const CONTAINER_HELPER = "/usr/local/lib/nemoclaw/openclaw-config-guard.py";
const HOST_HELPER = path.resolve(
  __dirname,
  "../../../packages/nemoclaw-openclaw/runtime/config-guard.py",
);
const CONTAINER_TIMEOUT = ["timeout", "--signal=TERM", "--kill-after=5s", "5m"];
// Must exceed STATE_DIR_GUARD_TIMEOUT_SECONDS (22m) in
// packages/nemoclaw-openclaw/runtime/config-guard.py, which is the guard's whole-action budget
// for the unseal and its rollback together. The outer docker client timeout in
// shields/index.ts must exceed this timeout plus its termination grace.
const RECOVERY_CONTAINER_TIMEOUT = ["timeout", "--signal=TERM", "--kill-after=5s", "25m"];
const SCHEMA_VALIDATION_TIMEOUT = ["timeout", "--signal=TERM", "--kill-after=5s", "30s"];
const MAX_SCHEMA_CANDIDATE_BYTES = 16 * 1024 * 1024;
// OpenClaw resolves relative includes from the config file's directory.
const SCHEMA_VALIDATION_SCRIPT = `set -eu
umask 077
candidate="$(mktemp "${OPENCLAW_CONFIG_DIR}/.nemoclaw-openclaw-config.XXXXXX")"
trap 'rm -f -- "$candidate"' EXIT HUP INT TERM
head -c ${MAX_SCHEMA_CANDIDATE_BYTES + 1} > "$candidate"
candidate_size="$(wc -c < "$candidate")"
test "$candidate_size" -le ${MAX_SCHEMA_CANDIDATE_BYTES}
HOME=/sandbox OPENCLAW_CONFIG_PATH="$candidate" /usr/local/bin/openclaw config validate --json`;

export type OpenClawConfigGuardAction =
  | "preflight"
  | "preflight-restart"
  | "lock"
  | "unlock"
  | "seal-restart"
  | "unseal-restart"
  | "write-config"
  | "recover"
  | "revoke-startup-ready"
  | "publish-startup-ready"
  | "unlock-failed-startup";

export type OpenClawConfigGuardOptions = {
  expectedConfigSha256?: string;
  input?: string;
  startupOwner?: boolean;
  /** Exact manifest-declared file names the guard must report protecting. */
  protectedFiles?: readonly string[];
  /** Agent state lock plan, required by `unlock-failed-startup`. */
  planJson?: string;
};

type GuardIssue = {
  type: "issue";
  code: string;
  path: string;
  detail: string;
};

type GuardSummary = {
  type: "result";
  action: OpenClawConfigGuardAction;
  status: "ok" | "failed";
  configDir?: string;
  files?: string[];
  chattrApplied?: boolean;
  configSha256?: string;
  hashSynthesized?: boolean;
  resealedDrift?: boolean;
  recovery?: string;
  originalLocked?: boolean;
};

export type OpenClawConfigGuardResult = {
  issues: string[];
  issueCodes?: string[];
  chattrApplied: boolean;
  configSha256?: string;
  hashSynthesized?: boolean;
  resealedDrift?: boolean;
  recovery?: string;
  originalLocked?: boolean;
};

const GUARD_ACTIONS = new Set<OpenClawConfigGuardAction>([
  "preflight",
  "preflight-restart",
  "lock",
  "unlock",
  "seal-restart",
  "unseal-restart",
  "write-config",
  "recover",
  "revoke-startup-ready",
  "publish-startup-ready",
  "unlock-failed-startup",
]);
const DEFAULT_PROTECTED_FILES = ["openclaw.json", ".config-hash"] as const;

function protectedFilesContractIssue(files: readonly string[]): string | null {
  if (
    files.length < 2 ||
    files[0] !== DEFAULT_PROTECTED_FILES[0] ||
    files[1] !== DEFAULT_PROTECTED_FILES[1]
  ) {
    return "must begin with openclaw.json and .config-hash";
  }
  const unique = new Set<string>();
  for (const file of files) {
    if (
      file.length === 0 ||
      file !== path.posix.basename(file) ||
      file.includes("\\") ||
      /[\x00-\x1f\x7f]/.test(file)
    ) {
      return "must contain only direct canonical file names";
    }
    if (unique.has(file)) return "must not contain duplicate file names";
    unique.add(file);
  }
  return null;
}

function sameProtectedFiles(actual: readonly string[], expected: readonly string[]): boolean {
  return (
    actual.length === expected.length && actual.every((file, index) => file === expected[index])
  );
}

function executionFailure(label: string, result: PrivilegedExecResult): string {
  const details = [result.error, result.stderr.trim(), result.stdout.trim()]
    .filter((value): value is string => Boolean(value))
    .join("; ");
  const termination =
    result.signal !== null ? `signal ${result.signal}` : `status ${String(result.status)}`;
  return `${label} (${termination})${details ? `: ${details}` : ""}`;
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function printableExcerpt(value: string, maxLength: number): string {
  return [...value.slice(0, maxLength)]
    .map((character) => (/^[\x20-\x7e]$/.test(character) ? character : " "))
    .join("")
    .trim();
}

function schemaIssuePaths(payload: unknown): string[] {
  if (!payload || typeof payload !== "object") return [];
  const issues = (payload as { issues?: unknown }).issues;
  if (!Array.isArray(issues)) return [];
  const paths: string[] = [];
  for (const issue of issues.slice(0, 8)) {
    if (!issue || typeof issue !== "object") continue;
    const path = (issue as { path?: unknown }).path;
    if (typeof path !== "string") continue;
    const sanitized = printableExcerpt(path, 256);
    if (sanitized && !paths.includes(sanitized)) paths.push(sanitized);
  }
  return paths;
}

function hasSchemaIssues(payload: unknown): boolean {
  return (
    !!payload &&
    typeof payload === "object" &&
    Array.isArray((payload as { issues?: unknown }).issues)
  );
}

export function validateOpenClawConfigCandidate(
  privileged: PrivilegedExec,
  input: string,
): string[] {
  if (Buffer.byteLength(input, "utf8") > MAX_SCHEMA_CANDIDATE_BYTES) {
    return [
      "OpenClaw config candidate exceeds the 16 MiB size limit; existing config was not changed",
    ];
  }
  const result = privileged.run(
    [
      ...SCHEMA_VALIDATION_TIMEOUT,
      "/usr/bin/setpriv",
      "--reuid=gateway",
      "--regid=gateway",
      "--init-groups",
      "--",
      "sh",
      "-c",
      SCHEMA_VALIDATION_SCRIPT,
    ],
    input,
  );
  let payload: unknown;
  try {
    payload = JSON.parse(result.stdout.trim());
  } catch {
    payload = null;
  }
  const validatorCompleted = result.signal === null && !result.error;
  if (
    validatorCompleted &&
    result.status === 0 &&
    payload &&
    typeof payload === "object" &&
    (payload as { valid?: unknown }).valid === true
  ) {
    return [];
  }

  const paths = schemaIssuePaths(payload);
  if (
    validatorCompleted &&
    result.status === 1 &&
    payload &&
    typeof payload === "object" &&
    (payload as { valid?: unknown }).valid === false &&
    hasSchemaIssues(payload)
  ) {
    const location = paths.length > 0 ? ` at ${paths.join(", ")}` : "";
    return [
      `OpenClaw config schema rejected the candidate${location}; existing config was not changed`,
    ];
  }

  const reason =
    result.signal !== null || result.status === 124 || result.status === 137
      ? "timed out or was terminated"
      : "could not run";
  return [
    `OpenClaw config schema validation ${reason}; existing config was not changed. Rebuild the sandbox if its OpenClaw runtime does not support config validate --json`,
  ];
}

export function parseOpenClawConfigGuardOutput(
  action: OpenClawConfigGuardAction,
  result: PrivilegedExecResult,
  protectedFiles: readonly string[] = DEFAULT_PROTECTED_FILES,
): OpenClawConfigGuardResult {
  const issues: GuardIssue[] = [];
  const summaries: GuardSummary[] = [];
  const contractIssues: string[] = [];
  const protectedFilesIssue = protectedFilesContractIssue(protectedFiles);
  if (protectedFilesIssue) {
    contractIssues.push(`OpenClaw config guard protectedFiles ${protectedFilesIssue}`);
  }

  for (const line of result.stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let value: unknown;
    try {
      value = JSON.parse(trimmed);
    } catch {
      contractIssues.push(`OpenClaw config guard returned non-JSON output: ${trimmed}`);
      continue;
    }
    if (!value || typeof value !== "object") {
      contractIssues.push(`OpenClaw config guard returned an invalid record: ${trimmed}`);
      continue;
    }
    const record = value as Record<string, unknown>;
    if (
      record.type === "issue" &&
      typeof record.code === "string" &&
      typeof record.path === "string" &&
      typeof record.detail === "string"
    ) {
      issues.push(record as GuardIssue);
      continue;
    }
    if (
      record.type === "result" &&
      typeof record.action === "string" &&
      GUARD_ACTIONS.has(record.action as OpenClawConfigGuardAction) &&
      (record.status === "ok" || record.status === "failed") &&
      (record.configDir === undefined || typeof record.configDir === "string") &&
      (record.files === undefined || stringArray(record.files)) &&
      (record.chattrApplied === undefined || typeof record.chattrApplied === "boolean") &&
      (record.configSha256 === undefined || typeof record.configSha256 === "string") &&
      (record.hashSynthesized === undefined || typeof record.hashSynthesized === "boolean") &&
      (record.resealedDrift === undefined || typeof record.resealedDrift === "boolean") &&
      (record.recovery === undefined || typeof record.recovery === "string") &&
      (record.originalLocked === undefined || typeof record.originalLocked === "boolean")
    ) {
      summaries.push(record as GuardSummary);
      continue;
    }
    contractIssues.push(`OpenClaw config guard returned an unknown record: ${trimmed}`);
  }

  if (summaries.length !== 1) {
    contractIssues.push(
      `OpenClaw config guard returned ${String(summaries.length)} result records`,
    );
  }
  const summary = summaries[0];
  if (summary && summary.action !== action) {
    contractIssues.push(
      `OpenClaw config guard result action=${summary.action} (expected ${action})`,
    );
  }
  if (summary?.status === "ok") {
    if (issues.length > 0 || result.status !== 0) {
      contractIssues.push("OpenClaw config guard reported success with issues or a non-zero exit");
    }
    if (summary.configDir !== OPENCLAW_CONFIG_DIR) {
      contractIssues.push(
        `OpenClaw config guard result configDir=${String(summary.configDir)} (expected ${OPENCLAW_CONFIG_DIR})`,
      );
    }
    const startupAction = action === "revoke-startup-ready" || action === "publish-startup-ready";
    if (
      !startupAction &&
      !protectedFilesIssue &&
      (!summary.files || !sameProtectedFiles(summary.files, protectedFiles))
    ) {
      contractIssues.push("OpenClaw config guard returned an unexpected protected-file set");
    }
    if (summary.configSha256 !== undefined && !/^[0-9a-f]{64}$/.test(summary.configSha256)) {
      contractIssues.push("OpenClaw config guard returned an invalid configSha256");
    }
  }
  if (summary?.status === "failed" && result.status === 0) {
    contractIssues.push("OpenClaw config guard reported failure with a zero exit");
  }
  if (result.status === null || result.signal !== null || result.error) {
    contractIssues.push(executionFailure("OpenClaw config guard execution failed", result));
  } else if (result.status !== 0 && issues.length === 0) {
    contractIssues.push(
      executionFailure("OpenClaw config guard failed without a diagnostic", result),
    );
  }
  if (result.stderr.trim()) {
    contractIssues.push(`OpenClaw config guard wrote unexpected stderr: ${result.stderr.trim()}`);
  }

  return {
    issues: [
      ...issues.map(
        (issue) =>
          `OpenClaw config guard ${action} [${printableExcerpt(issue.code, 64)}] ${printableExcerpt(issue.path, 256)}: ${printableExcerpt(issue.detail, 2048)}`,
      ),
      ...contractIssues,
    ],
    ...(issues.length > 0
      ? { issueCodes: issues.map((issue) => printableExcerpt(issue.code, 64)) }
      : {}),
    chattrApplied: summary?.status === "ok" && summary.chattrApplied === true,
    ...(summary?.status === "ok" && summary.configSha256
      ? { configSha256: summary.configSha256 }
      : {}),
    ...(summary?.status === "ok" && summary.hashSynthesized === true
      ? { hashSynthesized: true }
      : {}),
    ...(summary?.status === "ok" && summary.resealedDrift === true ? { resealedDrift: true } : {}),
    ...(summary?.status === "ok" && summary.recovery ? { recovery: summary.recovery } : {}),
    ...(summary?.status === "ok" && typeof summary.originalLocked === "boolean"
      ? { originalLocked: summary.originalLocked }
      : {}),
  };
}

let cachedHostHelper: string | null = null;

function readHostHelper(): string {
  if (cachedHostHelper !== null) return cachedHostHelper;
  cachedHostHelper = fs.readFileSync(HOST_HELPER, "utf-8");
  return cachedHostHelper;
}

export function runOpenClawConfigGuard(
  privileged: PrivilegedExec,
  action: OpenClawConfigGuardAction,
  options: OpenClawConfigGuardOptions = {},
): OpenClawConfigGuardResult {
  const protectedFiles = options.protectedFiles ?? DEFAULT_PROTECTED_FILES;
  const protectedFilesIssue = protectedFilesContractIssue(protectedFiles);
  if (protectedFilesIssue) {
    return {
      issues: [`OpenClaw config guard protectedFiles ${protectedFilesIssue}`],
      chattrApplied: false,
    };
  }
  if (
    options.expectedConfigSha256 !== undefined &&
    !/^[0-9a-f]{64}$/.test(options.expectedConfigSha256)
  ) {
    return {
      issues: ["OpenClaw config guard expectedConfigSha256 must be 64 lowercase hex characters"],
      chattrApplied: false,
    };
  }
  if (action === "write-config" && !options.expectedConfigSha256) {
    return {
      issues: ["OpenClaw config guard write-config requires expectedConfigSha256"],
      chattrApplied: false,
    };
  }
  if (action === "unlock-failed-startup" && !options.planJson) {
    return {
      issues: ["OpenClaw config guard unlock-failed-startup requires planJson"],
      chattrApplied: false,
    };
  }

  const capability = privileged.run(["test", "-r", CONTAINER_HELPER]);
  const timeoutPrefix =
    action === "unlock-failed-startup" ? RECOVERY_CONTAINER_TIMEOUT : CONTAINER_TIMEOUT;
  let command: string[];
  let input: string | undefined;
  let expectedProtectedFiles = protectedFiles;
  let installedHelperSupportsFileSets = true;
  if (
    capability.status === 0 &&
    capability.signal === null &&
    !capability.error &&
    !sameProtectedFiles(protectedFiles, DEFAULT_PROTECTED_FILES)
  ) {
    const helperHelp = privileged.run([
      ...SCHEMA_VALIDATION_TIMEOUT,
      "python3",
      "-I",
      CONTAINER_HELPER,
      "--help",
    ]);
    if (
      helperHelp.status !== 0 ||
      helperHelp.signal !== null ||
      helperHelp.error ||
      helperHelp.stderr.trim()
    ) {
      return {
        issues: [executionFailure("OpenClaw config guard feature probe failed", helperHelp)],
        chattrApplied: false,
      };
    }
    installedHelperSupportsFileSets = helperHelp.stdout.includes("--config-file-set");
    if (!installedHelperSupportsFileSets) {
      // Retained pre-Fabric images can have a valid older helper that owns only
      // openclaw.json and .config-hash. Use the current trusted helper against
      // that exact old contract until the sandbox is rebuilt.
      expectedProtectedFiles = DEFAULT_PROTECTED_FILES;
    }
  }

  if (
    capability.status === 0 &&
    capability.signal === null &&
    !capability.error &&
    installedHelperSupportsFileSets
  ) {
    command = [
      ...timeoutPrefix,
      "python3",
      "-I",
      CONTAINER_HELPER,
      action,
      "--config-dir",
      OPENCLAW_CONFIG_DIR,
    ];
    input = options.input;
  } else if (
    (capability.status === 1 && capability.signal === null && !capability.error) ||
    (capability.status === 0 &&
      capability.signal === null &&
      !capability.error &&
      !installedHelperSupportsFileSets)
  ) {
    // Keep rebuild and shields recovery usable against older images without
    // returning to unsafe pathname mutation: inject the exact helper shipped
    // with this CLI over authenticated privileged-exec stdin.
    const helperCondition =
      capability.status === 0 ? "does not support the current file contract" : "is absent";
    if (action === "write-config") {
      return {
        issues: [
          `OpenClaw config guard ${helperCondition} in the sandbox; rebuild before writing config transactionally`,
        ],
        chattrApplied: false,
      };
    }
    if (action === "unlock-failed-startup") {
      // Needs the in-image state guard and the installed helper. An injected
      // copy satisfies neither, so refuse instead of half-running it.
      return {
        issues: [
          `OpenClaw config guard ${helperCondition} in the sandbox; rebuild before recovering a failed startup`,
        ],
        chattrApplied: false,
      };
    }
    try {
      input = readHostHelper();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        issues: [
          `OpenClaw config guard is absent in the sandbox and host helper cannot be read: ${message}`,
        ],
        chattrApplied: false,
      };
    }
    command = [...timeoutPrefix, "python3", "-I", "-", action, "--config-dir", OPENCLAW_CONFIG_DIR];
    if (sameProtectedFiles(expectedProtectedFiles, DEFAULT_PROTECTED_FILES)) {
      // Retained pre-Fabric package manifests own only the native config and
      // hash. Tell the injected current helper to preserve that exact contract
      // instead of requiring or creating a Fabric sidecar in the old image.
      command.push("--config-file-set", "native");
    }
  } else {
    return {
      issues: [executionFailure("OpenClaw config guard capability probe failed", capability)],
      chattrApplied: false,
    };
  }

  if (options.expectedConfigSha256) {
    command.push("--expected-config-sha256", options.expectedConfigSha256);
  }
  if (options.startupOwner) command.push("--startup-owner");
  if (options.planJson) command.push("--plan-json", options.planJson);

  return parseOpenClawConfigGuardOutput(
    action,
    privileged.run(command, input),
    expectedProtectedFiles,
  );
}
