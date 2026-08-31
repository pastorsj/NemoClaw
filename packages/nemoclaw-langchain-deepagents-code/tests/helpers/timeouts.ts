// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const DEFAULT_EXEC_TIMEOUT_MS = 10_000;
const DEFAULT_TEST_TIMEOUT_MS = 5_000;

function parsePositiveInt(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : null;
}

function environmentTimeout(name: string, defaultMs: number): number {
  const override = parsePositiveInt(process.env[name]);
  return override === null ? defaultMs : Math.max(defaultMs, override);
}

export function execTimeout(defaultMs = DEFAULT_EXEC_TIMEOUT_MS): number {
  return environmentTimeout("NEMOCLAW_EXEC_TIMEOUT", defaultMs);
}

function testTimeout(defaultMs = DEFAULT_TEST_TIMEOUT_MS): number {
  return environmentTimeout("NEMOCLAW_TEST_TIMEOUT", defaultMs);
}

export function testTimeoutOptions(defaultMs = DEFAULT_TEST_TIMEOUT_MS): { timeout: number } {
  return { timeout: testTimeout(defaultMs) };
}
