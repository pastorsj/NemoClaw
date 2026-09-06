// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import os from "node:os";

/** Normalize Node exit values while failing closed for present malformed values. */
export function normalizeProcessExitCode(
  value: number | string | null | undefined,
  absentExitCode = 0,
): number {
  if (value === null || value === undefined) return absentExitCode;
  if (value === "") return 1;
  const exitCode = Number(value);
  return Number.isInteger(exitCode) ? exitCode : 1;
}

/** Convert a child-process status or signal into its conventional numeric exit code. */
export function spawnExitCode(result: {
  status: number | null;
  signal?: NodeJS.Signals | null;
}): number {
  if (result.status !== null) return result.status;
  if (!result.signal) return 1;
  const signalNumber = os.constants.signals[result.signal];
  return signalNumber ? 128 + signalNumber : 1;
}
