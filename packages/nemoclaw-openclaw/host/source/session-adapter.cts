// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  HarnessSessionAdapterModule,
  HarnessSessionListOutput,
  HarnessSessionListOutputRequest,
  HarnessSessionListPlan,
  HarnessSessionListPlanRequest,
} from "@nvidia/nemoclaw-harness-contract";

interface SessionIndexEntry {
  readonly key: string;
  readonly sessionId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function buildSessionListPlan(request: HarnessSessionListPlanRequest): HarnessSessionListPlan {
  return {
    kind: "capture",
    command: [
      "openclaw",
      "sessions",
      ...(request.useListSubcommand ? ["list"] : []),
      ...request.arguments,
    ],
  };
}

function balancedJsonFrom(text: string, start: number): string | null {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
    } else if (character === "{") {
      stack.push("}");
    } else if (character === "[") {
      stack.push("]");
    } else if (character === "}" || character === "]") {
      if (stack.pop() !== character) return null;
      if (stack.length === 0) return text.slice(start, index + 1);
    }
  }
  return null;
}

function balancedJsonCandidates(text: string): string[] {
  const candidates: string[] = [];
  const lineStartJson = /^(\s*)([\[{])/gm;
  let match: RegExpExecArray | null;
  while ((match = lineStartJson.exec(text)) !== null) {
    const candidate = balancedJsonFrom(text, match.index + match[1].length);
    if (candidate) candidates.push(candidate);
  }
  return candidates;
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
      // OpenClaw can prefix or append Node.js warnings around the JSON payload.
    }
  }
  return null;
}

function sessionArray(payload: unknown): unknown[] | null {
  if (Array.isArray(payload)) return payload;
  if (!isRecord(payload)) return null;
  for (const key of ["sessions", "entries", "items"]) {
    if (Array.isArray(payload[key])) return payload[key];
  }
  return null;
}

function parseSessionIndex(output: string): SessionIndexEntry[] | null {
  const trimmed = output.trim();
  if (!trimmed) return [];
  for (const candidate of jsonCandidates(output)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate) as unknown;
    } catch {
      continue;
    }
    const entries = sessionArray(parsed);
    if (!entries) continue;
    if (entries.length === 0) return [];
    const index: SessionIndexEntry[] = [];
    for (const entry of entries) {
      if (!isRecord(entry) || typeof entry.key !== "string") continue;
      const sessionId =
        typeof entry.sessionId === "string"
          ? entry.sessionId
          : typeof entry.id === "string"
            ? entry.id
            : null;
      if (sessionId) index.push({ key: entry.key, sessionId });
    }
    return index.length > 0 ? index : null;
  }
  return null;
}

function entryHasHiddenSessionId(entry: unknown, prefix: string): boolean {
  if (!isRecord(entry)) return false;
  return [entry.sessionId, entry.id].some(
    (value) => typeof value === "string" && value.startsWith(prefix),
  );
}

function filterSessionArray(
  entries: unknown[],
  prefix: string,
): {
  readonly entries: unknown[];
  readonly removed: number;
} {
  const filtered = entries.filter((entry) => !entryHasHiddenSessionId(entry, prefix));
  return { entries: filtered, removed: entries.length - filtered.length };
}

function filterJsonPayload(payload: unknown, prefix: string): unknown | null {
  if (Array.isArray(payload)) return filterSessionArray(payload, prefix).entries;
  if (!isRecord(payload)) return null;

  let foundSessionArray = false;
  let removedCount = 0;
  const filtered: Record<string, unknown> = { ...payload };
  for (const key of ["sessions", "entries", "items"]) {
    const value = payload[key];
    if (!Array.isArray(value)) continue;
    foundSessionArray = true;
    const result = filterSessionArray(value, prefix);
    filtered[key] = result.entries;
    removedCount += result.removed;
  }
  if (!foundSessionArray) return null;
  if (removedCount === 0) return payload;
  if (typeof filtered.count === "number") {
    filtered.count = Math.max(0, filtered.count - removedCount);
  }
  if (typeof filtered.totalCount === "number") {
    filtered.totalCount = Math.max(0, filtered.totalCount - removedCount);
  }
  return filtered;
}

function filterSessionListJson(output: string, prefix: string): string | null {
  const index = parseSessionIndex(output);
  if (index === null) return null;

  const payload = parseJsonPayload(output);
  const filteredPayload = payload === null ? null : filterJsonPayload(payload, prefix);
  if (filteredPayload !== null) return JSON.stringify(filteredPayload, null, 2);

  const sessions = index.filter((entry) => !entry.sessionId.startsWith(prefix));
  return JSON.stringify({ count: sessions.length, totalCount: sessions.length, sessions }, null, 2);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function textRowHasHiddenSessionId(line: string, prefix: string): boolean {
  const escapedPrefix = escapeRegExp(prefix);
  const labeledSessionId = new RegExp(`\\b(?:id|sessionId|sid):${escapedPrefix}`);
  const bareSessionIdColumn = new RegExp(`(?:^|\\s)${escapedPrefix}[^\\s]*(?:\\s|$)`);
  return labeledSessionId.test(line) || bareSessionIdColumn.test(line);
}

function filterSessionListText(output: string, prefix: string): string {
  let removedCount = 0;
  const lines = output.split(/\r?\n/).filter((line) => {
    if (!textRowHasHiddenSessionId(line, prefix)) return true;
    removedCount += 1;
    return false;
  });
  if (removedCount === 0) return output;
  return lines
    .map((line) =>
      line.replace(/^(Sessions listed:\s*)(\d+)(.*)$/, (_match, label, count, suffix) => {
        const visibleCount = Math.max(0, Number.parseInt(count, 10) - removedCount);
        return `${String(label)}${String(visibleCount)}${String(suffix)}`;
      }),
    )
    .join("\n");
}

function interpretSessionListOutput(
  request: HarnessSessionListOutputRequest,
): HarnessSessionListOutput {
  if (!request.jsonOutput) {
    return {
      kind: "output",
      output: filterSessionListText(request.output, request.hiddenSessionIdPrefix),
    };
  }

  const filtered = filterSessionListJson(request.output, request.hiddenSessionIdPrefix);
  if (filtered !== null) return { kind: "output", output: filtered };
  if (!request.output.includes(request.hiddenSessionIdPrefix)) {
    return { kind: "output", output: request.output };
  }
  return {
    kind: "refused",
    reason:
      "Could not parse OpenClaw session-list JSON without exposing an internal onboarding session. Check the OpenClaw version declared by this package.",
  };
}

const sessionAdapter: HarnessSessionAdapterModule = {
  buildSessionListPlan,
  interpretSessionListOutput,
};

export = sessionAdapter;
