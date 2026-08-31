// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { join } from "node:path";
import { expect } from "vitest";

import { readOpenClawStartupSource } from "./startup";

const REPOSITORY_ROOT = join(import.meta.dirname, "../../../..");
const ENTRYPOINT_ENV_WRAPPER = join(REPOSITORY_ROOT, "scripts/lib/entrypoint-env-wrapper.sh");
const RC_CLEAN_SCRIPT = join(import.meta.dirname, "../..", "compat/shell-env.py");

export function rcShimWrapperHeader(): string {
  return `export NEMOCLAW_RC_CLEAN_SCRIPT=${JSON.stringify(RC_CLEAN_SCRIPT)}`;
}

export function extractRuntimeShellEnvSnippet() {
  const src = readOpenClawStartupSource();
  const start = src.indexOf("write_runtime_shell_env() {");
  const end = src.indexOf("# cleanup_on_signal", start);
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(
      "Failed to extract write_runtime_shell_env from packages/nemoclaw-openclaw/start.sh — " +
        "the runtime shell env function may have been moved or renamed",
    );
  }
  return `${src.slice(start, end).trimEnd()}\nwrite_runtime_shell_env`;
}

export function extractOpenClawBootstrapEnvSnippet() {
  const src = readOpenClawStartupSource();
  const entrypointStart = src.indexOf("# managed-entrypoint-env-wrapper begin");
  const entrypointEndMarker = "# managed-entrypoint-env-wrapper end";
  const entrypointEnd = src.indexOf(entrypointEndMarker, entrypointStart);
  const environmentStart = src.indexOf('NEMOCLAW_CMD=("$@")');
  const environmentEnd = src.indexOf(
    "# Marker file the Docker HEALTHCHECK reads",
    environmentStart,
  );
  const extractionFailure =
    "Failed to extract OpenClaw bootstrap environment normalization from " +
    "packages/nemoclaw-openclaw/start.sh";
  expect(entrypointStart, extractionFailure).not.toBe(-1);
  expect(entrypointEnd, extractionFailure).toBeGreaterThan(entrypointStart);
  expect(environmentStart, extractionFailure).not.toBe(-1);
  expect(environmentEnd, extractionFailure).toBeGreaterThan(environmentStart);
  const entrypoint = src
    .slice(entrypointStart, entrypointEnd + entrypointEndMarker.length)
    .replace("/usr/local/lib/nemoclaw/entrypoint-env-wrapper.sh", ENTRYPOINT_ENV_WRAPPER);
  return `${entrypoint}\n${src.slice(environmentStart, environmentEnd).trimEnd()}`;
}

export function extractRuntimeShellEnvShimSnippet() {
  const src = readOpenClawStartupSource();
  const start = src.indexOf("ensure_runtime_shell_env_shim() {");
  const end = src.indexOf("# ── Legacy layout migration", start);
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(
      "Failed to extract ensure_runtime_shell_env_shim from packages/nemoclaw-openclaw/start.sh — " +
        "the rc shim helper may have been moved or renamed",
    );
  }
  return `${src.slice(start, end).trimEnd()}\nensure_runtime_shell_env_shim`;
}

export function extractToolRedirectsSnippet() {
  const src = readOpenClawStartupSource();
  const start = src.indexOf("_TOOL_REDIRECTS=(");
  const loop = src.indexOf("for _redir", start);
  const endMarker = "\ndone";
  const end = src.indexOf(endMarker, loop);
  if (start === -1 || loop === -1 || end === -1 || end <= loop) {
    throw new Error(
      "Failed to extract _TOOL_REDIRECTS from packages/nemoclaw-openclaw/start.sh — " +
        "the array may have been moved or renamed",
    );
  }
  return src.slice(start, end + endMarker.length);
}

export function extractProxyVarsSnippet() {
  const src = readOpenClawStartupSource();
  const start = src.indexOf("PROXY_HOST=");
  const endMarker = 'export no_proxy="$_NO_PROXY_VAL"';
  const end = src.indexOf(endMarker, start);
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(
      "Failed to extract proxy configuration from packages/nemoclaw-openclaw/start.sh — " +
        "the PROXY_HOST..no_proxy block may have been moved or renamed",
    );
  }
  return src.slice(start, end + endMarker.length);
}
