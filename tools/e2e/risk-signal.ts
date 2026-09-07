// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { readPrivateRegularFile, writePrivateRegularFile } from "./private-file.mts";

export const RISK_SIGNAL_FILE = "risk-signal.json";

export type E2eRiskSignal = {
  version: 1;
  jobId: string;
  shardId: string;
  expectedSha: string;
  testedSha: string;
  correlationId: string;
  passed: number;
  failed: number;
  skipped: number;
  pending: number;
  unhandledErrors: number;
  runReason: "passed" | "failed" | "interrupted";
};

export type RiskSignalEnvironment = {
  artifactDir: string;
  jobId: string;
  shardId: string;
  expectedSha: string;
  testedSha: string;
  correlationId: string;
};

export type RiskSignalCounts = Pick<
  E2eRiskSignal,
  "passed" | "failed" | "skipped" | "pending" | "unhandledErrors" | "runReason"
>;

const SHA_PATTERN = /^[a-f0-9]{40}$/u;
const CORRELATION_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const JOB_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/u;
const SHARD_PATTERN = /^(?:default|[A-Za-z0-9][A-Za-z0-9_-]*)$/u;

function checkedOutSha(workspace: string): string {
  return execFileSync("git", ["rev-parse", "--verify", "HEAD"], {
    cwd: workspace,
    encoding: "utf8",
    killSignal: "SIGKILL",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 5_000,
  }).trim();
}

export function configuredRiskSignalEnvironment(
  env: NodeJS.ProcessEnv,
  resolveHead: (workspace: string) => string = checkedOutSha,
): RiskSignalEnvironment | null {
  const expectedSha =
    env.NEMOCLAW_E2E_RISK_SIGNAL_EXPECTED_SHA === undefined
      ? env.NEMOCLAW_E2E_EXPECTED_SHA
      : env.NEMOCLAW_E2E_RISK_SIGNAL_EXPECTED_SHA;
  if (!expectedSha) return null;
  const values = {
    artifactDir: env.E2E_ARTIFACT_DIR ?? "",
    jobId: env.E2E_TARGET_ID ?? "",
    shardId: env.NEMOCLAW_E2E_SHARD ?? "",
    expectedSha,
    correlationId: env.NEMOCLAW_E2E_CORRELATION_ID ?? "",
  };
  if (!values.artifactDir) throw new Error("risk signal requires E2E_ARTIFACT_DIR");
  if (!JOB_PATTERN.test(values.jobId)) throw new Error("risk signal requires a safe E2E_TARGET_ID");
  if (!SHARD_PATTERN.test(values.shardId)) {
    throw new Error("risk signal requires a safe shard id");
  }
  if (!SHA_PATTERN.test(values.expectedSha)) {
    throw new Error("risk signal requires a 40-character lowercase expected SHA");
  }
  if (!CORRELATION_PATTERN.test(values.correlationId)) {
    throw new Error("risk signal requires a lowercase UUIDv4 correlation id");
  }
  const testedRoot = env.NEMOCLAW_E2E_TESTED_ROOT ?? env.GITHUB_WORKSPACE ?? process.cwd();
  if (!path.isAbsolute(testedRoot)) {
    throw new Error("risk signal requires an absolute tested root");
  }
  const testedSha = resolveHead(testedRoot);
  if (!SHA_PATTERN.test(testedSha) || testedSha !== values.expectedSha) {
    throw new Error("risk signal checked-out HEAD does not match the expected SHA");
  }
  return { ...values, testedSha };
}

export function buildRiskSignal(
  environment: RiskSignalEnvironment,
  counts: RiskSignalCounts,
): E2eRiskSignal {
  return {
    version: 1,
    jobId: environment.jobId,
    shardId: environment.shardId,
    expectedSha: environment.expectedSha,
    testedSha: environment.testedSha,
    correlationId: environment.correlationId,
    ...counts,
  };
}

function mergeRiskSignals(previous: E2eRiskSignal | null, current: E2eRiskSignal): E2eRiskSignal {
  if (!previous) return current;
  if (
    previous.version !== current.version ||
    previous.jobId !== current.jobId ||
    previous.shardId !== current.shardId ||
    previous.expectedSha !== current.expectedSha ||
    previous.testedSha !== current.testedSha ||
    previous.correlationId !== current.correlationId
  ) {
    throw new Error("risk signal metadata changed between executions");
  }
  return {
    ...current,
    passed: previous.passed + current.passed,
    failed: previous.failed + current.failed,
    skipped: previous.skipped + current.skipped,
    pending: previous.pending + current.pending,
    unhandledErrors: previous.unhandledErrors + current.unhandledErrors,
    runReason:
      previous.runReason === "failed" || current.runReason === "failed"
        ? "failed"
        : previous.runReason === "interrupted" || current.runReason === "interrupted"
          ? "interrupted"
          : "passed",
  };
}

/** Write one validated, private risk-signal update for Vitest or a standalone runner. */
export function writeRiskSignalCounts(
  environment: RiskSignalEnvironment,
  counts: RiskSignalCounts,
): E2eRiskSignal {
  const signal = buildRiskSignal(environment, counts);
  fs.mkdirSync(environment.artifactDir, { recursive: true, mode: 0o700 });
  const file = path.join(environment.artifactDir, RISK_SIGNAL_FILE);
  const previousSource = readPrivateRegularFile(file, { allowMissing: true, maxBytes: 64 * 1024 });
  const previous = previousSource === null ? null : (JSON.parse(previousSource) as E2eRiskSignal);
  const merged = mergeRiskSignals(previous, signal);
  writePrivateRegularFile(file, `${JSON.stringify(merged, null, 2)}\n`);
  return merged;
}
