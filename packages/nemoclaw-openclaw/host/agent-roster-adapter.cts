// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
"use strict";
const MAIN_AGENT_ID = "main";
const AGENT_ID_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/u;
const ALLOWED_MANIFEST_KEYS = new Set(["agents", "defaults", "main"]);
const ALLOWED_AGENT_KEYS = new Set([
    "agentDir",
    "description",
    "id",
    "model",
    "subagents",
    "tools",
    "workspace",
]);
function isObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
function hasContent(value) {
    if (value === null || value === undefined)
        return false;
    if (Array.isArray(value))
        return value.length > 0;
    return typeof value === "object" ? Object.keys(value).length > 0 : false;
}
function expectedAgentPath(kind, id) {
    const segment = kind === "workspace" ? `workspace-${id}` : `agents/${id}`;
    return `/sandbox/.openclaw/${segment}`;
}
function normalizeManifest(manifest) {
    const unknownKeys = Object.keys(manifest).filter((key) => !ALLOWED_MANIFEST_KEYS.has(key));
    if (unknownKeys.length > 0) {
        throw new Error(`agents manifest contains unsupported top-level field "${unknownKeys.sort()[0]}". Allowed: agents, defaults, main`);
    }
    const rawAgents = manifest.agents ?? [];
    if (!Array.isArray(rawAgents))
        throw new Error("agents manifest 'agents' must be a list");
    const seen = new Set();
    const agents = rawAgents.map((rawEntry, index) => {
        const label = `agents[${String(index)}]`;
        if (!isObject(rawEntry))
            throw new Error(`${label} must be a YAML mapping (object)`);
        const entry = { ...rawEntry };
        const id = entry.id;
        if (typeof id !== "string" || !AGENT_ID_PATTERN.test(id)) {
            throw new Error(`${label}.id ${JSON.stringify(id)} must match ${String(AGENT_ID_PATTERN)} (1-32 chars, lowercase alphanumeric, dash, underscore; must start with a letter)`);
        }
        if (id === MAIN_AGENT_ID) {
            throw new Error(`${label}.id "main" is reserved for the primary agent; use a different id`);
        }
        if (seen.has(id))
            throw new Error(`${label}.id "${id}" is duplicated; agent ids must be unique`);
        seen.add(id);
        for (const key of Object.keys(entry)) {
            if (!ALLOWED_AGENT_KEYS.has(key)) {
                throw new Error(`${label} contains unsupported field "${key}". Allowed: ${[...ALLOWED_AGENT_KEYS].sort().join(", ")}.`);
            }
        }
        for (const pathKey of ["workspace", "agentDir"]) {
            const expected = expectedAgentPath(pathKey, id);
            if (entry[pathKey] === undefined)
                entry[pathKey] = expected;
            if (entry[pathKey] !== expected) {
                throw new Error(`${label}.${pathKey} must equal "${expected}" for agent id "${id}", got "${String(entry[pathKey])}"`);
            }
        }
        return entry;
    });
    return {
        agents,
        ...(manifest.defaults === undefined ? {} : { defaults: manifest.defaults }),
        ...(manifest.main === undefined ? {} : { main: manifest.main }),
    };
}
function parseJsonFromOutput(output) {
    const text = output.trim();
    for (let index = 0; index < text.length; index += 1) {
        const character = text[index];
        if (character !== "[" && character !== "{")
            continue;
        try {
            return JSON.parse(text.slice(index));
        }
        catch {
            // Native warnings may contain brackets, so continue to the next candidate.
        }
    }
    return JSON.parse(text || "[]");
}
function parseCurrentAgents(output) {
    const parsed = parseJsonFromOutput(output);
    const entries = Array.isArray(parsed)
        ? parsed
        : isObject(parsed) && Array.isArray(parsed.agents)
            ? parsed.agents
            : null;
    if (!entries)
        throw new Error("openclaw agents list --json did not return a JSON array");
    return entries.flatMap((entry) => {
        if (!isObject(entry) || typeof entry.id !== "string")
            return [];
        return [
            {
                id: entry.id,
                ...(typeof entry.workspace === "string" ? { workspace: entry.workspace } : {}),
            },
        ];
    });
}
function rebuildOnlyFields(manifest) {
    const fields = [];
    if (hasContent(manifest.defaults))
        fields.push("defaults");
    if (hasContent(manifest.main))
        fields.push("main");
    for (const entry of manifest.agents) {
        const id = String(entry.id);
        if (entry.model !== undefined)
            fields.push(`agents[${id}].model`);
        if (hasContent(entry.subagents))
            fields.push(`agents[${id}].subagents`);
        if (hasContent(entry.tools))
            fields.push(`agents[${id}].tools`);
    }
    return fields;
}
function applyPlan(manifestValue, currentOutput) {
    try {
        const manifest = normalizeManifest(manifestValue);
        const current = parseCurrentAgents(currentOutput);
        const currentIds = new Set(current.map((entry) => entry.id));
        const desiredIds = new Set(manifest.agents.map((entry) => String(entry.id)));
        const additions = manifest.agents
            .filter((entry) => !currentIds.has(String(entry.id)))
            .map((entry) => {
            const agentId = String(entry.id);
            return {
                agent_id: agentId,
                command: [
                    "openclaw",
                    "agents",
                    "add",
                    agentId,
                    "--non-interactive",
                    "--workspace",
                    String(entry.workspace),
                ],
            };
        });
        const deletions = current
            .filter((entry) => entry.id !== MAIN_AGENT_ID && !desiredIds.has(entry.id))
            .map((entry) => ({
            agent_id: entry.id,
            command: ["openclaw", "agents", "delete", entry.id, "--force"],
        }));
        const notices = additions.flatMap((addition) => {
            const declared = manifest.agents.find((entry) => entry.id === addition.agent_id);
            if (!hasContent(declared?.tools))
                return [];
            return [
                {
                    message: `Manifest declares tools for "${addition.agent_id}"; the live add cannot bake a tool policy. Rerun \`nemoclaw onboard --agents <file> --recreate-sandbox\` to apply it.`,
                },
            ];
        });
        return {
            kind: "ready",
            current_count: current.length,
            additions,
            deletions,
            rebuild_only_fields: rebuildOnlyFields(manifest),
            notices,
        };
    }
    catch (error) {
        return { kind: "refused", reason: error instanceof Error ? error.message : String(error) };
    }
}
const agentRosterAdapter = {
    buildAgentRosterCommand(request) {
        return {
            kind: "stream",
            command: ["openclaw", "agents", request.operation, ...request.arguments],
        };
    },
    buildAgentRosterInspection(request) {
        try {
            normalizeManifest(request.manifest);
            return { kind: "capture", command: ["openclaw", "agents", "list", "--json"] };
        }
        catch (error) {
            return { kind: "refused", reason: error instanceof Error ? error.message : String(error) };
        }
    },
    buildAgentRosterApplyPlan(request) {
        return applyPlan(request.manifest, request.current_output);
    },
};
module.exports = agentRosterAdapter;
