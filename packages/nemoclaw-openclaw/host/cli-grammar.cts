// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const FAILURE_STATUS_VALUES = new Set(["error", "errored", "failed", "failure"]);
const UNTRUSTED_CHILD_BEGIN = "BEGIN_UNTRUSTED_CHILD_RESULT";
const UNTRUSTED_CHILD_END = "END_UNTRUSTED_CHILD_RESULT";
const ANSI_OSC_PATTERN = /\x1B\][\s\S]*?(?:\x07|\x1B\\|$)/gu;
const ANSI_CSI_PATTERN = /\x1B\[[0-?]*[ -/]*[@-~]/gu;
const CONTROL_PATTERN = /[\u0000-\u0007\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu;
const MAX_PROVENANCE_WALK_NODES = 10_000;
const MAX_PROVENANCE_WALK_DEPTH = 80;

function isObjectRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function snippet(value, sanitizeDetail, limit = 300) {
  const sanitized = value
    .replace(ANSI_OSC_PATTERN, "")
    .replace(ANSI_CSI_PATTERN, "")
    .replace(/\r|\u0008/gu, "")
    .replace(CONTROL_PATTERN, "");
  const squashed = sanitizeDetail(sanitized).replace(/\s+/gu, " ").trim();
  return squashed.length <= limit ? squashed : `${squashed.slice(0, limit - 3)}...`;
}

function strings(value) {
  const result = [];
  const seen = new WeakSet();
  const stack = [{ value, depth: 0 }];
  let visited = 0;
  while (stack.length > 0 && visited < MAX_PROVENANCE_WALK_NODES) {
    const entry = stack.pop();
    if (!entry) break;
    visited += 1;
    if (entry.depth > MAX_PROVENANCE_WALK_DEPTH) continue;
    if (typeof entry.value === "string") {
      result.push(entry.value);
      continue;
    }
    const children = Array.isArray(entry.value)
      ? entry.value
      : isObjectRecord(entry.value)
        ? Object.values(entry.value)
        : [];
    if (children.length === 0) continue;
    const objectValue = entry.value;
    if (seen.has(objectValue)) continue;
    seen.add(objectValue);
    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push({ value: children[index], depth: entry.depth + 1 });
    }
  }
  return result;
}

function detailFromValue(value, sanitizeDetail) {
  if (typeof value === "string") return snippet(value, sanitizeDetail);
  if (Array.isArray(value) || isObjectRecord(value)) {
    const nested = strings(value)
      .map((part) => snippet(part, sanitizeDetail))
      .filter(Boolean);
    if (nested.length > 0) return snippet(nested.join("; "), sanitizeDetail);
    try {
      return snippet(JSON.stringify(value), sanitizeDetail);
    } catch {
      return snippet(String(value), sanitizeDetail);
    }
  }
  if (value === null || value === undefined) return null;
  return snippet(String(value), sanitizeDetail);
}

function firstDetail(record, sanitizeDetail) {
  for (const key of [
    "text",
    "content",
    "message",
    "error",
    "stderr",
    "stdout",
    "output",
    "result",
  ]) {
    if (Object.hasOwn(record, key)) {
      const detail = detailFromValue(record[key], sanitizeDetail);
      if (detail) return detail;
    }
  }
  return null;
}

function normalized(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replaceAll("_", "-");
}

function isToolLike(record) {
  const role = normalized(record.role);
  const type = normalized(record.type);
  return (
    role === "toolresult" ||
    role === "tool-result" ||
    type === "toolresult" ||
    type === "tool-result" ||
    ["toolCallId", "tool_call_id", "toolName", "tool_name", "tool"].some((key) =>
      Object.hasOwn(record, key),
    )
  );
}

function hasFailureStatus(record) {
  if (record.isError === true || record.is_error === true) return true;
  for (const key of ["status", "state", "finalStatus"]) {
    if (FAILURE_STATUS_VALUES.has(normalized(record[key]))) return true;
  }
  return record.ok === false || record.success === false;
}

function toolLabel(record) {
  const tool = record.toolName ?? record.tool_name ?? record.name ?? record.tool;
  const callId = record.toolCallId ?? record.tool_call_id ?? record.id;
  const parts = [tool, callId].map((part) => String(part || "").trim()).filter(Boolean);
  return parts.length > 0 ? parts.join(" ") : "unknown tool";
}

function toolFailureLine(record, sanitizeDetail) {
  if (!isToolLike(record) || !hasFailureStatus(record)) return null;
  const detail = firstDetail(record, sanitizeDetail) ?? "no failure detail provided";
  return `[openclaw provenance] failed tool result (${toolLabel(record)}): ${detail}`;
}

function collectToolFailureProvenance(value, sanitizeDetail) {
  const lines = [];
  const seen = new WeakSet();
  const stack = [{ value, depth: 0 }];
  let visited = 0;
  while (stack.length > 0 && visited < MAX_PROVENANCE_WALK_NODES) {
    const entry = stack.pop();
    if (!entry) break;
    visited += 1;
    if (entry.depth > MAX_PROVENANCE_WALK_DEPTH) continue;
    let children;
    let recordValue = null;
    if (Array.isArray(entry.value)) children = entry.value;
    else if (isObjectRecord(entry.value)) {
      recordValue = entry.value;
      children = Object.values(recordValue);
    } else continue;
    const objectValue = entry.value;
    if (seen.has(objectValue)) continue;
    seen.add(objectValue);
    if (recordValue) {
      const line = toolFailureLine(recordValue, sanitizeDetail);
      if (line) lines.push(line);
    }
    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push({ value: children[index], depth: entry.depth + 1 });
    }
  }
  return lines;
}

function untrustedChildExcerpt(value, sanitizeDetail) {
  const start = value.indexOf(UNTRUSTED_CHILD_BEGIN);
  if (start < 0) return null;
  let body = value.slice(start + UNTRUSTED_CHILD_BEGIN.length);
  const end = body.indexOf(UNTRUSTED_CHILD_END);
  if (end >= 0) body = body.slice(0, end);
  body = body.replace(/^[<>\s]+|[<>\s]+$/gu, "");
  return body ? snippet(body, sanitizeDetail) : null;
}

function collectUntrustedChildProvenance(raw, docs, sanitizeDetail) {
  const candidates = [...docs.flatMap(strings), raw];
  if (!candidates.some((candidate) => candidate.includes(UNTRUSTED_CHILD_BEGIN))) return [];
  const lines = [
    "[openclaw provenance] untrusted child result present; verify child-sourced data before treating it as confirmed.",
  ];
  for (const candidate of candidates) {
    const excerpt = untrustedChildExcerpt(candidate, sanitizeDetail);
    if (excerpt) {
      lines.push(`[openclaw provenance] untrusted child excerpt: ${excerpt}`);
      break;
    }
  }
  return lines;
}

function parseLogPrefixedJsonDocs(raw) {
  const docs = [];
  let start = null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (depth > 0 && char === '"') inString = true;
    else if (char === "{") {
      if (depth === 0) start = index;
      depth += 1;
    } else if (depth > 0 && char === "}") {
      depth -= 1;
      if (depth === 0 && start !== null) {
        try {
          const parsed = JSON.parse(raw.slice(start, index + 1));
          docs.push(...(Array.isArray(parsed) ? parsed : [parsed]));
        } catch {
          // Continue with the next balanced candidate object.
        }
        start = null;
      }
    }
  }
  return docs;
}

function parseOpenClawJsonDocs(raw) {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return parseLogPrefixedJsonDocs(raw);
  }
}

function dedupe(lines) {
  return Array.from(new Set(lines));
}

function openClawAgentJsonProvenanceLines(raw, sanitizeDetail) {
  const docs = parseOpenClawJsonDocs(raw);
  if (docs.length === 0) return [];
  return dedupe([
    ...collectUntrustedChildProvenance(raw, docs, sanitizeDetail),
    ...docs.flatMap((doc) => collectToolFailureProvenance(doc, sanitizeDetail)),
  ]);
}

const ABANDONED_LIVENESS_VALUE = "abandoned";
const INCOMPLETE_TURN_ERROR_KIND = "incomplete-turn";

// Read completion markers only from declared run metadata. Tool results and
// arguments are untrusted; treating their content as a failed turn could make
// a caller retry an already-completed side effect.
function agentResponseMetaRecord(doc) {
  if (!isObjectRecord(doc)) return null;
  const result = doc.result;
  if (
    typeof doc.status === "string" &&
    isObjectRecord(result) &&
    (!Object.hasOwn(result, "payloads") || Array.isArray(result.payloads)) &&
    isObjectRecord(result.meta)
  ) {
    return result.meta;
  }
  if (
    !Object.hasOwn(doc, "event") &&
    (!Object.hasOwn(doc, "payloads") || Array.isArray(doc.payloads)) &&
    isObjectRecord(doc.meta)
  ) {
    return doc.meta;
  }
  return null;
}

function finalAgentResponseMetaRecord(docs) {
  for (let index = docs.length - 1; index >= 0; index -= 1) {
    const meta = agentResponseMetaRecord(docs[index]);
    if (meta) return meta;
  }
  return null;
}

function timedOutPhase(meta) {
  const phase = meta.timeoutPhase;
  if (typeof phase !== "string") return null;
  const trimmed = phase.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function turnMetaMarkers(meta) {
  const markers = [];
  if (meta.replayInvalid === true) markers.push("replayInvalid=true");
  if (normalized(meta.livenessState) === ABANDONED_LIVENESS_VALUE) {
    markers.push(`livenessState=${String(meta.livenessState)}`);
  }
  const timeoutPhase = timedOutPhase(meta);
  if (timeoutPhase) markers.push(`timeoutPhase=${timeoutPhase}`);
  const error = meta.error;
  if (isObjectRecord(error) && normalized(error.kind) === INCOMPLETE_TURN_ERROR_KIND) {
    markers.push(`error.kind=${String(error.kind)}`);
  }
  return markers;
}

function openClawAgentIncompleteTurnSignal(raw) {
  const docs = parseOpenClawJsonDocs(raw);
  if (docs.length === 0) return null;
  const meta = finalAgentResponseMetaRecord(docs);
  if (!meta) return null;
  const markers = dedupe(turnMetaMarkers(meta));
  if (markers.length === 0) return null;
  const timeoutPhase = timedOutPhase(meta);
  return timeoutPhase ? { markers, timeoutPhase } : { markers };
}

module.exports = {
  openClawAgentIncompleteTurnSignal,
  openClawAgentJsonProvenanceLines,
};
