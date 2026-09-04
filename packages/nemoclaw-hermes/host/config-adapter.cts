// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const CONFIG_DIRECTORY = "/sandbox/.hermes";
const CONFIG_FILE = "config.yaml";
const CONFIG_GUARD = "/usr/local/lib/nemoclaw/hermes-runtime-config-guard.py";
const CONFIG_HASH = "/etc/nemoclaw/hermes.config-hash";
const RESTART_STATE = "/run/nemoclaw/hermes-restart-seal.json";
const HEADER_VALUE_MAX_LENGTH = 128;

function requireTarget(target) {
  if (
    target.directory !== CONFIG_DIRECTORY ||
    target.file !== CONFIG_FILE ||
    target.format !== "yaml"
  ) {
    throw new Error("Hermes configuration target does not match its package manifest");
  }
}

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizeHeaderValue(value) {
  const stripped = value.replace(/[\x00-\x1F\x7F-\x9F]/g, "");
  return stripped.length > HEADER_VALUE_MAX_LENGTH
    ? stripped.slice(0, HEADER_VALUE_MAX_LENGTH)
    : stripped;
}

function buildUpstreamHeader(config) {
  const upstream = config._nemoclaw_upstream;
  if (!isObject(upstream)) return "";
  const provider = sanitizeHeaderValue(
    typeof upstream.provider === "string" ? upstream.provider : "",
  );
  const model = sanitizeHeaderValue(typeof upstream.model === "string" ? upstream.model : "");
  if (!provider && !model) return "";
  const lines = ["# Managed by NemoClaw — Hermes configuration"];
  if (provider) lines.push(`# Upstream provider: ${provider}`);
  if (model) lines.push(`# Upstream model: ${model}`);
  lines.push("# OpenShell rewrites model.base_url to the upstream endpoint at request time.");
  return `${lines.join("\n")}\n`;
}

function prepareConfigUpdate(request) {
  requireTarget(request.target);
  return {
    kind: "transaction",
    content: `${buildUpstreamHeader(request.config)}${request.serializedConfig}`,
    validation: null,
    write: {
      command: [
        "timeout",
        "--signal=TERM",
        "--kill-after=5s",
        "2m",
        "/opt/hermes/.venv/bin/python",
        "-I",
        CONFIG_GUARD,
        "write-config",
        "--hermes-dir",
        request.target.directory,
        "--hash-file",
        CONFIG_HASH,
        "--state-file",
        RESTART_STATE,
        "--expected-config-sha256",
        request.expectedConfigSha256,
      ],
      timeoutSeconds: 150,
      failureMessage: "Hermes could not commit the configuration transaction.",
      recoveryGuidance: [
        "If Hermes reports an integrity metadata mismatch, run the sandbox recovery command before retrying.",
      ],
      success: { kind: "exit-zero" },
    },
    restart: {
      kind: "managed",
      guidance: ["Hermes may restart its gateway when it applies this configuration."],
    },
  };
}

function classifyConfigUrl(request) {
  const security = isObject(request.config.security) ? request.config.security : {};
  const segments = [...request.key.split("."), ...request.relativePath];
  const safe = !segments.some((segment) =>
    ["__proto__", "constructor", "prototype", "toString", "hasOwnProperty"].includes(segment),
  );
  return {
    allowPrivateUrls: security.allow_private_urls === true,
    allowOpenShellBridge:
      safe && segments.length === 2 && segments[0] === "model" && segments[1] === "base_url",
  };
}

const MUTABLE_CONFIG_PROBE = String.raw`
import os
import stat
import sys
import uuid

config_dir = os.path.normpath(sys.argv[1])
config_paths = [os.path.normpath(value) for value in sys.argv[2:]]
if not os.path.isabs(config_dir) or not config_paths:
    raise RuntimeError("Hermes mutable config probe requires absolute paths")

directory_flags = os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW | os.O_DIRECTORY
file_flags = os.O_WRONLY | os.O_APPEND | os.O_CLOEXEC | os.O_NOFOLLOW
directory_fd = os.open(config_dir, directory_flags)
try:
    directory = os.fstat(directory_fd)
    if not stat.S_ISDIR(directory.st_mode):
        raise RuntimeError("Hermes config root is not a directory")
    if directory.st_uid != os.geteuid() or directory.st_gid != os.getegid():
        raise RuntimeError("Hermes config root is not owned by the sandbox identity")
    if stat.S_IMODE(directory.st_mode) != 0o3770:
        raise RuntimeError("Hermes config root does not have mode 3770")

    for config_path in config_paths:
        if os.path.dirname(config_path) != config_dir:
            raise RuntimeError("Hermes config artifact escaped the config root")
        descriptor = os.open(os.path.basename(config_path), file_flags, dir_fd=directory_fd)
        try:
            artifact = os.fstat(descriptor)
            if not stat.S_ISREG(artifact.st_mode) or artifact.st_nlink != 1:
                raise RuntimeError("Hermes config artifact is not a singly linked regular file")
            if artifact.st_uid != os.geteuid() or artifact.st_gid != os.getegid():
                raise RuntimeError("Hermes config artifact is not owned by the sandbox identity")
            if stat.S_IMODE(artifact.st_mode) != 0o640:
                raise RuntimeError("Hermes config artifact does not have mode 0640")
        finally:
            os.close(descriptor)

    probe_name = ".nemoclaw-mutable-posture-" + uuid.uuid4().hex
    created = False
    try:
        os.mkdir(probe_name, 0o700, dir_fd=directory_fd)
        created = True
    finally:
        if created:
            os.rmdir(probe_name, dir_fd=directory_fd)
finally:
    os.close(directory_fd)
`;

function describeMutableConfig(request) {
  requireTarget(request.target);
  return {
    kind: "probe",
    probe: {
      command: [
        "/usr/bin/setpriv",
        "--reuid=sandbox",
        "--regid=sandbox",
        "--init-groups",
        "--",
        "/usr/bin/python3",
        "-I",
        "-c",
        MUTABLE_CONFIG_PROBE,
        request.target.directory,
        `${request.target.directory}/${request.target.file}`,
        ...request.target.sensitiveFiles,
      ],
      timeoutSeconds: 20,
      failureMessage: "Hermes mutable configuration posture could not be verified.",
      success: { kind: "exit-zero" },
    },
  };
}

module.exports = {
  classifyConfigUrl,
  describeMutableConfig,
  prepareConfigUpdate,
};
