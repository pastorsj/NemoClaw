// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import type { HarnessConfigCommand } from "../agent-runtime/config-module";

export interface PackageConfigCommandResult {
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: string;
}

/** Validate only the finite success claims described by the package contract. */
export function validatePackageConfigCommandResult(
  command: HarnessConfigCommand,
  content: string,
  result: PackageConfigCommandResult,
): boolean {
  if (result.status !== 0 || result.signal !== null || result.error) return false;
  if (command.success.kind === "exit-zero") return true;
  if (result.stderr.trim()) return false;

  const records: Record<string, unknown>[] = [];
  for (const line of result.stdout.split("\n")) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return false;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    records.push(parsed as Record<string, unknown>);
  }
  if (records.length !== 1) return false;

  const summary = records[0];
  const expectedDigest = createHash("sha256").update(content).digest("hex");
  return (
    summary.type === "result" &&
    summary.action === command.success.action &&
    summary.status === "ok" &&
    summary.configDir === command.success.configDirectory &&
    isDeepStrictEqual(summary.files, command.success.protectedFiles) &&
    summary.configSha256 === expectedDigest
  );
}
