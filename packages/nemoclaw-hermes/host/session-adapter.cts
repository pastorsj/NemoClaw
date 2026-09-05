// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
"use strict";
function buildSessionListPlan(request) {
    return {
        kind: "stream",
        command: ["hermes", "sessions", "list", ...request.arguments],
    };
}
function interpretSessionListOutput(request) {
    return { kind: "output", output: request.output };
}
function buildSessionMutationPlan(request) {
    if (request.operation === "reset") {
        return {
            kind: "unsupported",
            reason: "Hermes does not expose session reset through NemoClaw.",
        };
    }
    if (request.agent !== null) {
        return {
            kind: "refused",
            reason: `Refusing to delete: --agent ${request.agent} is not supported by Hermes. Omit the flag.`,
        };
    }
    if (request.keepTranscript) {
        return {
            kind: "refused",
            reason: "Refusing to delete: --keep-transcript is not supported by Hermes. Omit the flag.",
        };
    }
    if (request.jsonOutput || request.verboseOutput) {
        return {
            kind: "refused",
            reason: "Refusing to delete: --json and --verbose are not supported by the native Hermes session command. Omit the flags.",
        };
    }
    const sessionId = request.key.trim();
    if (sessionId.length === 0 || sessionId.startsWith("-") || /\s/.test(sessionId)) {
        return {
            kind: "refused",
            reason: `Refusing to delete: '${request.key}' is not a valid Hermes session id. Pass a native id from sessions list.`,
        };
    }
    return { kind: "stream", command: ["hermes", "sessions", "delete", sessionId, "--yes"] };
}
function interpretSessionMutationOutput(_request) {
    return {
        kind: "refused",
        reason: "Hermes session deletion streams its native result and has no captured output.",
    };
}
function buildSessionExportPlan(request) {
    if (request.agent !== null && request.agent !== "hermes") {
        return {
            kind: "refused",
            reason: `Refusing to export: --agent ${request.agent} is not supported by Hermes. Pass --agent hermes or omit the flag.`,
        };
    }
    if (request.keys.length > 0) {
        return {
            kind: "refused",
            reason: "Refusing to export: positional session keys are not supported by Hermes. Hermes exports the full session store.",
        };
    }
    if (request.includeTrajectory) {
        return {
            kind: "refused",
            reason: "Refusing to export: --include-trajectory is not supported by Hermes.",
        };
    }
    if (request.format === "tar") {
        return {
            kind: "refused",
            reason: "Refusing to export: --format tar is not supported by Hermes. Hermes exports one JSONL file.",
        };
    }
    return {
        kind: "native-file",
        agent: "hermes",
        format: "jsonl",
        selectedKeys: "all",
        remoteFile: request.stagingFiles.jsonl,
        command: ["hermes", "sessions", "export", request.stagingFiles.jsonl],
        allowEmpty: true,
    };
}
function interpretSessionExportIndex(_request) {
    return {
        kind: "refused",
        reason: "Hermes exports a native JSONL file and does not expose an indexed-file plan.",
    };
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
