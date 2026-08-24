// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const HERMES_MCP_RUNTIME_PROBE_OK = "nemoclaw-hermes-mcp-runtime-ok";
const HERMES_BASE_IMAGE_PROBE_GUARDS = [
  "--network",
  "none",
  "--cap-drop",
  "ALL",
  "--security-opt",
  "no-new-privileges",
  "--read-only",
  "--user",
  "sandbox",
];
const HERMES_OFFICIAL_BASE_DIGEST_REF =
  /^ghcr\.io\/nvidia\/nemoclaw\/hermes-sandbox-base@sha256:[0-9a-f]{64}$/;
const HERMES_REPOSITORY_BASE_REF =
  /^nemoclaw-hermes-(?:root-entrypoint-base|sandbox-base-local|secret-boundary-base|stale-openclaw-dir-base|stale-openclaw-link-base):[^\s]+$/;

function createHermesBaseImageQualificationProbe(imageRef) {
  return {
    args: [
      "run",
      "--rm",
      ...HERMES_BASE_IMAGE_PROBE_GUARDS,
      "--entrypoint",
      "/opt/hermes/.venv/bin/python",
      imageRef,
      "-I",
      "-c",
      `import importlib.metadata as metadata; import sys; import acp; import mcp; from acp_adapter.server import HermesACPAgent; from tools import mcp_tool; metadata.version("agent-client-protocol") == "0.9.0" or sys.exit(1); getattr(mcp_tool, "_MCP_AVAILABLE", False) or sys.exit(1); getattr(mcp_tool, "_MCP_HTTP_AVAILABLE", False) or sys.exit(1); print("${HERMES_MCP_RUNTIME_PROBE_OK}")`,
    ],
    expectedOutput: HERMES_MCP_RUNTIME_PROBE_OK,
  };
}

function isHermesOfficialBaseDigestRef(imageRef) {
  return HERMES_OFFICIAL_BASE_DIGEST_REF.test(imageRef);
}

function isHermesRepositoryBaseRef(imageRef) {
  return imageRef === "nemoclaw-hermes-base-local" || HERMES_REPOSITORY_BASE_REF.test(imageRef);
}

function parseHermesPinnedRemoteBaseRef(dockerfile) {
  const declarations = [...dockerfile.matchAll(/^ARG BASE_IMAGE=(\S+)$/gm)].map(
    (match) => match[1],
  );
  const pinnedRef = declarations.length === 1 ? declarations[0] : null;
  return pinnedRef && isHermesOfficialBaseDigestRef(pinnedRef) ? pinnedRef : null;
}

function hermesFinalBaseAcceptsResolution({
  imageRef,
  pinnedRemoteRef,
  source,
  trackedPinnedRemoteRef,
}) {
  if (
    source === "pinned" &&
    pinnedRemoteRef === trackedPinnedRemoteRef &&
    isHermesOfficialBaseDigestRef(imageRef)
  ) {
    return true;
  }
  return imageRef === trackedPinnedRemoteRef;
}

module.exports = {
  createHermesBaseImageQualificationProbe,
  hermesFinalBaseAcceptsResolution,
  isHermesOfficialBaseDigestRef,
  isHermesRepositoryBaseRef,
  parseHermesPinnedRemoteBaseRef,
};
