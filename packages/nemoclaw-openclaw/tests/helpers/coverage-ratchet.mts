// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import path from "node:path";

type CoverageMetric = "lines" | "functions" | "branches" | "statements";

type CoverageSummary = {
  total: Record<CoverageMetric, { pct: number }>;
};

const COVERAGE_METRICS = ["lines", "functions", "branches", "statements"] as const;
const ALLOWED_ROUNDING_DROP = 0.1;
const packageRoot = path.resolve(import.meta.dirname, "../..");

function readJsonDocument(file: string): unknown {
  return JSON.parse(readFileSync(path.join(packageRoot, file), "utf8"));
}

function readCoverageSummary(): CoverageSummary {
  const value = readJsonDocument("coverage/coverage-summary.json");
  if (!value || typeof value !== "object" || !("total" in value)) {
    throw new Error("OpenClaw coverage summary must contain total metrics");
  }
  const total = (value as { total: unknown }).total;
  if (!total || typeof total !== "object") {
    throw new Error("OpenClaw coverage summary must contain total metrics");
  }
  for (const metric of COVERAGE_METRICS) {
    const entry = (total as Record<string, unknown>)[metric];
    if (
      !entry ||
      typeof entry !== "object" ||
      typeof (entry as { pct?: unknown }).pct !== "number"
    ) {
      throw new Error(`OpenClaw coverage summary has no numeric ${metric} percentage`);
    }
  }
  return value as CoverageSummary;
}

function readCoverageThresholds(): Record<CoverageMetric, number> {
  const value = readJsonDocument("coverage-threshold.json");
  if (!value || typeof value !== "object") {
    throw new Error("OpenClaw coverage thresholds must be an object");
  }
  for (const metric of COVERAGE_METRICS) {
    if (typeof (value as Record<string, unknown>)[metric] !== "number") {
      throw new Error(`OpenClaw coverage threshold has no numeric ${metric} value`);
    }
  }
  return value as Record<CoverageMetric, number>;
}

const summary = readCoverageSummary();
const thresholds = readCoverageThresholds();
const failures = COVERAGE_METRICS.flatMap((metric) => {
  const actual = summary.total[metric].pct;
  const threshold = thresholds[metric];
  const floatingPointTolerance =
    Number.EPSILON * Math.max(Math.abs(actual), Math.abs(threshold), 1);
  return threshold - actual - ALLOWED_ROUNDING_DROP > floatingPointTolerance
    ? [`${metric}: ${actual}% < ${threshold}%`]
    : [];
});

if (failures.length > 0) {
  throw new Error(`OpenClaw plugin coverage ratchet failed:\n${failures.join("\n")}`);
}
