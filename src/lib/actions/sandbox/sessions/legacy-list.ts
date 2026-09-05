// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { captureOpenshell } from "../../../adapters/openshell/runtime";
import { deferSandboxLifecycleExit } from "../../../core/process-exit";
import { buildOpenshellExecArgs, computeExitCode, execSandbox } from "../exec";
import { isWarmupSessionId, WARMUP_SESSION_ID_PREFIX } from "../warmup-session";
import { balancedJsonCandidates, parseSessionIndex } from "./session-index";

const LEGACY_SESSION_LIST_CAPTURE_MAX_BUFFER_BYTES = 64 * 1024 * 1024;

interface LegacySessionListOptions {
  readonly useListSubcommand: boolean;
  readonly arguments: readonly string[];
}

function writeWithTrailingNewline(stream: NodeJS.WriteStream, value: string | undefined): void {
  if (!value) return;
  stream.write(value.endsWith("\n") ? value : `${value}\n`);
}

function sessionEntryIsWarmup(entry: unknown): boolean {
  if (!entry || typeof entry !== "object") return false;
  const record = entry as Record<string, unknown>;
  return [record.sessionId, record.id].some(
    (value) => typeof value === "string" && isWarmupSessionId(value),
  );
}

function filterWarmupArray(entries: unknown[]): {
  readonly entries: unknown[];
  readonly removed: number;
} {
  const filtered = entries.filter((entry) => !sessionEntryIsWarmup(entry));
  return { entries: filtered, removed: entries.length - filtered.length };
}

function jsonCandidates(output: string): string[] {
  const trimmed = output.trim();
  if (!trimmed) return ["[]"];
  const candidates = balancedJsonCandidates(trimmed);
  const lines = trimmed.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const candidate = lines[index]?.trim();
    if (candidate && (candidate.startsWith("[") || candidate.startsWith("{"))) {
      candidates.push(candidate);
    }
  }
  candidates.push(trimmed);
  return candidates;
}

function parseJsonPayload(output: string): unknown | null {
  for (const candidate of jsonCandidates(output)) {
    try {
      return JSON.parse(candidate) as unknown;
    } catch {
      // This decoder exists only for pre-receipt OpenClaw sandboxes.
    }
  }
  return null;
}

function filterWarmupSessionsListPayload(parsed: unknown): unknown | null {
  if (Array.isArray(parsed)) return filterWarmupArray(parsed).entries;
  if (!parsed || typeof parsed !== "object") return null;

  const record = parsed as Record<string, unknown>;
  const filtered: Record<string, unknown> = { ...record };
  let foundSessionArray = false;
  let removedCount = 0;
  for (const key of ["sessions", "entries", "items"]) {
    const value = record[key];
    if (!Array.isArray(value)) continue;
    foundSessionArray = true;
    const result = filterWarmupArray(value);
    filtered[key] = result.entries;
    removedCount += result.removed;
  }
  if (!foundSessionArray) return null;
  if (removedCount === 0) return parsed;
  if (typeof filtered.count === "number")
    filtered.count = Math.max(0, filtered.count - removedCount);
  if (typeof filtered.totalCount === "number") {
    filtered.totalCount = Math.max(0, filtered.totalCount - removedCount);
  }
  return filtered;
}

function filterWarmupSessionsListJson(output: string): string | null {
  const parsedIndex = parseSessionIndex(output);
  if (parsedIndex === null) return null;

  const parsedPayload = parseJsonPayload(output);
  const filteredPayload =
    parsedPayload === null ? null : filterWarmupSessionsListPayload(parsedPayload);
  if (filteredPayload !== null) return JSON.stringify(filteredPayload, null, 2);

  const sessions = parsedIndex.filter((entry) => !isWarmupSessionId(entry.sessionId));
  return JSON.stringify({ count: sessions.length, totalCount: sessions.length, sessions }, null, 2);
}

function warmupIdInTextRow(line: string): boolean {
  const escapedPrefix = WARMUP_SESSION_ID_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const labeledSessionId = new RegExp(`\\b(?:id|sessionId|sid):${escapedPrefix}`);
  const bareSessionIdColumn = new RegExp(`(?:^|\\s)${escapedPrefix}[^\\s]*(?:\\s|$)`);
  return labeledSessionId.test(line) || bareSessionIdColumn.test(line);
}

function filterWarmupSessionsListText(output: string): string {
  let removedCount = 0;
  const filtered = output.split(/\r?\n/).filter((line) => {
    if (!warmupIdInTextRow(line)) return true;
    removedCount += 1;
    return false;
  });
  if (removedCount === 0) return output;
  return filtered
    .map((line) =>
      line.replace(/^(Sessions listed:\s*)(\d+)(.*)$/, (_match, label, count, suffix) => {
        const visibleCount = Math.max(0, Number.parseInt(count, 10) - removedCount);
        return `${String(label)}${String(visibleCount)}${String(suffix)}`;
      }),
    )
    .join("\n");
}

/** Decode session listing for registry rows created before package receipts existed. */
export async function runLegacySessionList(
  sandboxName: string,
  recordedAgent: string | null | undefined,
  options: LegacySessionListOptions,
): Promise<void> {
  const binary = recordedAgent === "hermes" ? "hermes" : "openclaw";
  const command = [binary, "sessions"];
  if (options.useListSubcommand || binary === "hermes") command.push("list");
  command.push(...options.arguments);

  if (binary === "hermes") {
    await execSandbox(sandboxName, command, {}, { exit: deferSandboxLifecycleExit });
    return;
  }

  const result = captureOpenshell(buildOpenshellExecArgs(sandboxName, command), {
    ignoreError: true,
    includeStreams: true,
    maxBuffer: LEGACY_SESSION_LIST_CAPTURE_MAX_BUFFER_BYTES,
  });
  const { code, errorMessage } = computeExitCode(result);
  const stdout = typeof result.stdout === "string" ? result.stdout.trim() : result.output;
  const stderr = typeof result.stderr === "string" ? result.stderr.trim() : "";
  if (code !== 0) {
    writeWithTrailingNewline(process.stdout, stdout);
    writeWithTrailingNewline(process.stderr, stderr);
    if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ENOBUFS") {
      console.error("  Legacy session-list output exceeded NemoClaw's 64 MiB filtering buffer.");
    } else if (errorMessage) {
      console.error(`  Failed to invoke openshell: ${errorMessage}`);
    }
    deferSandboxLifecycleExit(code);
  }

  if (options.arguments.includes("--json")) {
    const filtered = filterWarmupSessionsListJson(stdout);
    if (filtered === null && stdout.includes(WARMUP_SESSION_ID_PREFIX)) {
      console.error("  Could not safely parse the legacy OpenClaw session-list JSON output.");
      deferSandboxLifecycleExit(1);
    }
    writeWithTrailingNewline(process.stdout, filtered ?? stdout);
  } else {
    writeWithTrailingNewline(process.stdout, filterWarmupSessionsListText(stdout));
  }
  writeWithTrailingNewline(process.stderr, stderr);
}
