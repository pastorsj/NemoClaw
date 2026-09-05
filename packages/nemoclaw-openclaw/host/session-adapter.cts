// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
"use strict";
function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
function buildSessionListPlan(request) {
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
function balancedJsonFrom(text, start) {
    const stack = [];
    let inString = false;
    let escaped = false;
    for (let index = start; index < text.length; index += 1) {
        const character = text[index];
        if (inString) {
            if (escaped)
                escaped = false;
            else if (character === "\\")
                escaped = true;
            else if (character === '"')
                inString = false;
            continue;
        }
        if (character === '"') {
            inString = true;
        }
        else if (character === "{") {
            stack.push("}");
        }
        else if (character === "[") {
            stack.push("]");
        }
        else if (character === "}" || character === "]") {
            if (stack.pop() !== character)
                return null;
            if (stack.length === 0)
                return text.slice(start, index + 1);
        }
    }
    return null;
}
function balancedJsonCandidates(text) {
    const candidates = [];
    const lineStartJson = /^(\s*)([\[{])/gm;
    let match;
    while ((match = lineStartJson.exec(text)) !== null) {
        const candidate = balancedJsonFrom(text, match.index + match[1].length);
        if (candidate)
            candidates.push(candidate);
    }
    return candidates;
}
function jsonCandidates(output) {
    const trimmed = output.trim();
    if (!trimmed)
        return ["[]"];
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
function parseJsonPayload(output) {
    for (const candidate of jsonCandidates(output)) {
        try {
            return JSON.parse(candidate);
        }
        catch {
            // OpenClaw can prefix or append Node.js warnings around the JSON payload.
        }
    }
    return null;
}
function sessionArray(payload) {
    if (Array.isArray(payload))
        return payload;
    if (!isRecord(payload))
        return null;
    for (const key of ["sessions", "entries", "items"]) {
        if (Array.isArray(payload[key]))
            return payload[key];
    }
    return null;
}
function parseSessionIndex(output) {
    const trimmed = output.trim();
    if (!trimmed)
        return [];
    for (const candidate of jsonCandidates(output)) {
        let parsed;
        try {
            parsed = JSON.parse(candidate);
        }
        catch {
            continue;
        }
        const entries = sessionArray(parsed);
        if (!entries)
            continue;
        if (entries.length === 0)
            return [];
        const index = [];
        for (const entry of entries) {
            if (!isRecord(entry) || typeof entry.key !== "string")
                continue;
            const sessionId = typeof entry.sessionId === "string"
                ? entry.sessionId
                : typeof entry.id === "string"
                    ? entry.id
                    : null;
            if (sessionId)
                index.push({ key: entry.key, sessionId });
        }
        return index.length > 0 ? index : null;
    }
    return null;
}
function entryHasHiddenSessionId(entry, prefix) {
    if (!isRecord(entry))
        return false;
    return [entry.sessionId, entry.id].some((value) => typeof value === "string" && value.startsWith(prefix));
}
function filterSessionArray(entries, prefix) {
    const filtered = entries.filter((entry) => !entryHasHiddenSessionId(entry, prefix));
    return { entries: filtered, removed: entries.length - filtered.length };
}
function filterJsonPayload(payload, prefix) {
    if (Array.isArray(payload))
        return filterSessionArray(payload, prefix).entries;
    if (!isRecord(payload))
        return null;
    let foundSessionArray = false;
    let removedCount = 0;
    const filtered = { ...payload };
    for (const key of ["sessions", "entries", "items"]) {
        const value = payload[key];
        if (!Array.isArray(value))
            continue;
        foundSessionArray = true;
        const result = filterSessionArray(value, prefix);
        filtered[key] = result.entries;
        removedCount += result.removed;
    }
    if (!foundSessionArray)
        return null;
    if (removedCount === 0)
        return payload;
    if (typeof filtered.count === "number") {
        filtered.count = Math.max(0, filtered.count - removedCount);
    }
    if (typeof filtered.totalCount === "number") {
        filtered.totalCount = Math.max(0, filtered.totalCount - removedCount);
    }
    return filtered;
}
function filterSessionListJson(output, prefix) {
    const index = parseSessionIndex(output);
    if (index === null)
        return null;
    const payload = parseJsonPayload(output);
    const filteredPayload = payload === null ? null : filterJsonPayload(payload, prefix);
    if (filteredPayload !== null)
        return JSON.stringify(filteredPayload, null, 2);
    const sessions = index.filter((entry) => !entry.sessionId.startsWith(prefix));
    return JSON.stringify({ count: sessions.length, totalCount: sessions.length, sessions }, null, 2);
}
function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function textRowHasHiddenSessionId(line, prefix) {
    const escapedPrefix = escapeRegExp(prefix);
    const labeledSessionId = new RegExp(`\\b(?:id|sessionId|sid):${escapedPrefix}`);
    const bareSessionIdColumn = new RegExp(`(?:^|\\s)${escapedPrefix}[^\\s]*(?:\\s|$)`);
    return labeledSessionId.test(line) || bareSessionIdColumn.test(line);
}
function filterSessionListText(output, prefix) {
    let removedCount = 0;
    const lines = output.split(/\r?\n/).filter((line) => {
        if (!textRowHasHiddenSessionId(line, prefix))
            return true;
        removedCount += 1;
        return false;
    });
    if (removedCount === 0)
        return output;
    return lines
        .map((line) => line.replace(/^(Sessions listed:\s*)(\d+)(.*)$/, (_match, label, count, suffix) => {
        const visibleCount = Math.max(0, Number.parseInt(count, 10) - removedCount);
        return `${String(label)}${String(visibleCount)}${String(suffix)}`;
    }))
        .join("\n");
}
function interpretSessionListOutput(request) {
    if (!request.jsonOutput) {
        return {
            kind: "output",
            output: filterSessionListText(request.output, request.hiddenSessionIdPrefix),
        };
    }
    const filtered = filterSessionListJson(request.output, request.hiddenSessionIdPrefix);
    if (filtered !== null)
        return { kind: "output", output: filtered };
    if (!request.output.includes(request.hiddenSessionIdPrefix)) {
        return { kind: "output", output: request.output };
    }
    return {
        kind: "refused",
        reason: "Could not parse OpenClaw session-list JSON without exposing an internal onboarding session. Check the OpenClaw version declared by this package.",
    };
}
const AGENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SESSION_KEY_PATTERN = /^[\x20-\x7E]{1,256}$/;
const SESSION_KEY_REJECT_PATTERN = /["'`$\\\n\r\t]/;
const CANONICAL_SESSION_KEY_PATTERN = /^agent:([A-Za-z0-9][A-Za-z0-9._-]{0,63}):/;
function normalizedAgentId(value) {
    const trimmed = value.trim();
    return AGENT_ID_PATTERN.test(trimmed) ? trimmed : null;
}
function normalizedSessionKey(value) {
    const trimmed = value.trim();
    if (trimmed.length === 0 ||
        !SESSION_KEY_PATTERN.test(trimmed) ||
        SESSION_KEY_REJECT_PATTERN.test(trimmed)) {
        return null;
    }
    return trimmed;
}
function sessionKeyAgent(key) {
    return CANONICAL_SESSION_KEY_PATTERN.exec(key)?.[1] ?? null;
}
function canonicalSessionKey(agent, key) {
    if (key.startsWith("agent:"))
        return sessionKeyAgent(key) === null ? null : key;
    return `agent:${agent}:${key}`;
}
function buildSessionMutationPlan(request) {
    const rawKey = normalizedSessionKey(request.key);
    if (rawKey === null) {
        return {
            kind: "refused",
            reason: `Invalid session key '${request.key}'. Pass a printable key without quotes, control characters, '$', or backslashes.`,
        };
    }
    const requestedAgent = request.agent === null ? null : normalizedAgentId(request.agent);
    if (request.agent !== null && requestedAgent === null) {
        return { kind: "refused", reason: `Invalid agent id '${request.agent}'.` };
    }
    const keyAgent = sessionKeyAgent(rawKey);
    if (rawKey.startsWith("agent:") && keyAgent === null) {
        return {
            kind: "refused",
            reason: `Invalid canonical session key '${request.key}'. Expected 'agent:<id>:<rest>'.`,
        };
    }
    if (requestedAgent !== null && keyAgent !== null && requestedAgent !== keyAgent) {
        return {
            kind: "refused",
            reason: `Refusing sessions.${request.operation}: session key '${rawKey}' is scoped to agent '${keyAgent}', not '${requestedAgent}'.`,
        };
    }
    const resolvedAgent = keyAgent ?? requestedAgent ?? "main";
    const key = canonicalSessionKey(resolvedAgent, rawKey);
    if (key === null) {
        return { kind: "refused", reason: `Invalid canonical session key '${request.key}'.` };
    }
    return request.operation === "delete"
        ? {
            kind: "admin-rpc",
            method: "sessions.delete",
            params: { key, deleteTranscript: !request.keepTranscript },
        }
        : {
            kind: "admin-rpc",
            method: "sessions.reset",
            params: { key, reason: request.reason },
        };
}
function gatewayFailureReason(operation, key, payload) {
    const error = isRecord(payload.error) ? payload.error : null;
    if (payload.ok !== false && error === null)
        return null;
    const code = error?.code ?? "unknown";
    const message = error?.message ?? "no message";
    return `Gateway refused sessions.${operation} for '${key}': [${String(code)}] ${String(message)}`;
}
function interpretSessionMutationOutput(input) {
    if (!isRecord(input.payload)) {
        return {
            kind: "refused",
            reason: `Gateway returned an unexpected sessions.${input.request.operation} payload.`,
        };
    }
    const plannedKey = typeof input.plan.params.key === "string" ? input.plan.params.key : input.request.key;
    const failure = gatewayFailureReason(input.request.operation, plannedKey, input.payload);
    if (failure !== null)
        return { kind: "refused", reason: failure };
    if (input.payload.ok !== true || typeof input.payload.key !== "string") {
        return {
            kind: "refused",
            reason: `Gateway returned an unexpected sessions.${input.request.operation} payload.`,
        };
    }
    if (input.request.operation === "delete") {
        return {
            kind: "completed",
            operation: "delete",
            key: input.payload.key,
            removedTranscript: typeof input.payload.removedTranscript === "boolean"
                ? input.payload.removedTranscript
                : !input.request.keepTranscript,
            entry: input.payload.entry ?? null,
        };
    }
    return {
        kind: "completed",
        operation: "reset",
        key: input.payload.key,
        reason: input.request.reason,
        entry: input.payload.entry ?? null,
    };
}
function buildSessionExportPlan(request) {
    const normalizedKeys = [];
    for (const candidate of request.keys) {
        const key = normalizedSessionKey(candidate);
        if (key === null) {
            return { kind: "refused", reason: `Invalid session key '${candidate}'.` };
        }
        normalizedKeys.push(key);
    }
    let agent = request.agent === null ? null : normalizedAgentId(request.agent);
    if (request.agent !== null && agent === null) {
        return { kind: "refused", reason: `Invalid agent id '${request.agent}'.` };
    }
    if (agent === null) {
        for (const key of normalizedKeys) {
            const parsed = sessionKeyAgent(key);
            if (parsed !== null) {
                agent = parsed;
                break;
            }
        }
    }
    agent ??= "main";
    for (const key of normalizedKeys) {
        const parsed = sessionKeyAgent(key);
        if (parsed !== null && parsed !== agent) {
            return {
                kind: "refused",
                reason: `Refusing to export: session key '${key}' is scoped to agent '${parsed}', not '${agent}'.`,
            };
        }
    }
    return {
        kind: "indexed-files",
        agent,
        format: request.format,
        selectedKeys: normalizedKeys.length === 0 ? "all" : normalizedKeys,
        sourceDirectory: `/sandbox/.openclaw/agents/${agent}/sessions`,
        indexCommand: ["openclaw", "sessions", "list", "--agent", agent, "--json"],
    };
}
function interpretSessionExportIndex(request) {
    const index = parseSessionIndex(request.output);
    if (index === null) {
        return {
            kind: "refused",
            reason: "Could not parse the native session list output as a session index. Check the OpenClaw version declared by this package.",
        };
    }
    const byKey = new Map();
    for (const entry of index)
        byKey.set(entry.key, entry.sessionId);
    const candidates = [];
    if (request.selectedKeys === "all") {
        for (const entry of index) {
            if (!entry.sessionId.startsWith(request.hiddenSessionIdPrefix))
                candidates.push(entry);
        }
    }
    else {
        const missing = [];
        for (const key of request.selectedKeys) {
            const canonical = key.startsWith("agent:") ? key : `agent:${request.agent}:${key}`;
            const sessionId = byKey.get(key) ?? byKey.get(canonical);
            if (sessionId === undefined)
                missing.push(key);
            else
                candidates.push({ key, sessionId });
        }
        if (missing.length > 0) {
            return {
                kind: "refused",
                reason: `Refusing to export: no entries found in agent '${request.agent}' for key(s): ${missing.join(", ")}.`,
            };
        }
    }
    const seen = new Set();
    const sessions = [];
    const relativeFiles = [];
    for (const entry of candidates) {
        if (seen.has(entry.sessionId))
            continue;
        seen.add(entry.sessionId);
        sessions.push(entry);
        relativeFiles.push(`${entry.sessionId}.jsonl`);
        if (request.includeTrajectory)
            relativeFiles.push(`${entry.sessionId}.trajectory.jsonl`);
    }
    return { kind: "selection", sessions, relativeFiles };
}
const sessionAdapter = {
    buildSessionListPlan,
    interpretSessionListOutput,
    buildSessionMutationPlan,
    interpretSessionMutationOutput,
    buildSessionExportPlan,
    interpretSessionExportIndex,
};
module.exports = sessionAdapter;
