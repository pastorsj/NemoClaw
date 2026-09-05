// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
"use strict";
const CONFIG_DIRECTORY = "/sandbox/.openclaw";
const CONFIG_FILE = "openclaw.json";
const CONFIG_GUARD = "/usr/local/lib/nemoclaw/openclaw-config-guard.py";
const CONFIG_NORMALIZER = "/usr/local/lib/nemoclaw/normalize_mutable_config_perms.py";
const MAX_CONFIG_BYTES = 16 * 1024 * 1024;
function shellQuote(value) {
    return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}
function requireTarget(target) {
    if (target.directory !== CONFIG_DIRECTORY ||
        target.file !== CONFIG_FILE ||
        target.format !== "json") {
        throw new Error("OpenClaw configuration target does not match its package manifest");
    }
}
function validationCommand(target) {
    const candidateTemplate = `${target.directory}/.nemoclaw-openclaw-config.XXXXXX`;
    const script = [
        "set -eu",
        "umask 077",
        `candidate="$(mktemp ${shellQuote(candidateTemplate)})"`,
        `trap 'rm -f -- "$candidate"' EXIT HUP INT TERM`,
        `head -c ${String(MAX_CONFIG_BYTES + 1)} > "$candidate"`,
        'candidate_size="$(wc -c < "$candidate")"',
        `test "$candidate_size" -le ${String(MAX_CONFIG_BYTES)}`,
        'HOME=/sandbox OPENCLAW_CONFIG_PATH="$candidate" /usr/local/bin/openclaw config validate --json',
    ].join("\n");
    return {
        command: [
            "timeout",
            "--signal=TERM",
            "--kill-after=5s",
            "30s",
            "/usr/bin/setpriv",
            "--reuid=gateway",
            "--regid=gateway",
            "--init-groups",
            "--",
            "sh",
            "-c",
            script,
        ],
        timeoutSeconds: 360,
        failureMessage: "OpenClaw rejected the configuration candidate; the existing configuration was not changed.",
        success: { kind: "exit-zero" },
    };
}
function writeCommand(target, expectedConfigSha256) {
    return {
        command: [
            "timeout",
            "--signal=TERM",
            "--kill-after=5s",
            "5m",
            "python3",
            "-I",
            CONFIG_GUARD,
            "write-config",
            "--config-dir",
            target.directory,
            "--expected-config-sha256",
            expectedConfigSha256,
        ],
        timeoutSeconds: 360,
        failureMessage: "OpenClaw could not commit the validated configuration transaction.",
        recoveryGuidance: [
            "Rebuild the sandbox if its installed OpenClaw configuration guard is unavailable.",
        ],
        success: {
            kind: "config-transaction",
            action: "write-config",
            configDirectory: target.directory,
            protectedFiles: [target.file, ".config-hash", "fabric.json"],
        },
    };
}
function mutableConfigRepair(request) {
    if (request.sandboxUid === null || request.sandboxGid === null)
        return null;
    return {
        command: [
            "/usr/bin/timeout",
            "--signal=TERM",
            "--kill-after=5s",
            "15s",
            "/usr/bin/python3",
            "-I",
            CONFIG_NORMALIZER,
            request.target.directory,
            request.sandboxUid,
            request.sandboxGid,
        ],
        timeoutSeconds: 25,
        failureMessage: "OpenClaw mutable configuration permissions could not be repaired.",
        success: { kind: "exit-zero" },
    };
}
const configAdapter = {
    describeInferenceConfig(request) {
        requireTarget(request.target);
        return { kind: "mutable" };
    },
    prepareConfigUpdate(request) {
        requireTarget(request.target);
        return {
            kind: "transaction",
            content: request.serializedConfig,
            validation: validationCommand(request.target),
            write: writeCommand(request.target, request.expectedConfigSha256),
            restart: {
                kind: "managed",
                guidance: ["Some configuration changes require a sandbox restart to take effect."],
            },
        };
    },
    classifyConfigUrl(request) {
        const segments = [...request.key.split("."), ...request.relativePath];
        const safe = !segments.some((segment) => ["__proto__", "constructor", "prototype", "toString", "hasOwnProperty"].includes(segment));
        return {
            allowPrivateUrls: false,
            allowOpenShellBridge: safe &&
                segments.length === 4 &&
                segments[0] === "models" &&
                segments[1] === "providers" &&
                segments[2].length > 0 &&
                !/^\d+$/.test(segments[2]) &&
                segments[3] === "baseUrl",
        };
    },
    describeMutableConfig(request) {
        requireTarget(request.target);
        return {
            kind: "stat",
            directoryMode: "2770",
            directoryOwner: "sandbox:sandbox",
            fileMode: "660",
            fileOwner: "sandbox:sandbox",
            repair: mutableConfigRepair(request),
        };
    },
};
module.exports = configAdapter;
