// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const DEFAULT_TEST_TIMEOUT_MS = 5_000;

function parsePositiveInteger(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : null;
}

export function testTimeoutOptions(defaultMs = DEFAULT_TEST_TIMEOUT_MS): { timeout: number } {
  const override = parsePositiveInteger(process.env.NEMOCLAW_TEST_TIMEOUT);
  return { timeout: override === null ? defaultMs : Math.max(defaultMs, override) };
}
