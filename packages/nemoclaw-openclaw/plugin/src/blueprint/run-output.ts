// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";

export function writeRunLog(message: string): void {
  process.stdout.write(`${message}\n`);
}

export function writeRunProgress(percent: number, label: string): void {
  process.stdout.write(`PROGRESS:${String(percent)}:${label}\n`);
}

export function emitRunId(): string {
  const now = new Date();
  const timestamp = now
    .toISOString()
    .replace(/[-:T]/g, "")
    .slice(0, 14)
    .replace(/^(\d{8})(\d{6})/, "$1-$2");
  const runId = `nc-${timestamp}-${randomUUID().replace(/-/g, "").slice(0, 8)}`;
  process.stdout.write(`RUN_ID:${runId}\n`);
  return runId;
}
