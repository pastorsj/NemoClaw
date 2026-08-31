# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
# shellcheck shell=bash

_PORTABLE_OPENCLAW_GATEWAY_STARTUP_TIMING_PATH="/tmp/nemoclaw-openclaw-gateway-startup-timing"

# Best-effort: this fixed-schema record contains timing values only. The host
# lifecycle validates correlation before it emits the credential-free receipt.
record_portable_openclaw_gateway_startup_timing() {
  local value
  for value in \
    "${_NEMOCLAW_GATEWAY_STARTUP_ENTRY_EPOCH:-}" \
    "${_NEMOCLAW_GATEWAY_CONFIG_STARTED_EPOCH:-}" \
    "${_NEMOCLAW_GATEWAY_CONFIG_FINISHED_EPOCH:-}" \
    "${_NEMOCLAW_GATEWAY_PROVIDER_FINISHED_EPOCH:-}" \
    "${_NEMOCLAW_GATEWAY_TOKEN_FINISHED_EPOCH:-}" \
    "${_NEMOCLAW_GATEWAY_MESSAGING_FINISHED_EPOCH:-}" \
    "${_NEMOCLAW_GATEWAY_WORKSPACE_FINISHED_EPOCH:-}" \
    "${_NEMOCLAW_GATEWAY_SPAWN_FINISHED_EPOCH:-}"; do
    [ -n "$value" ] || return 0
  done

  printf '%s\n' \
    "schema=1 entry=${_NEMOCLAW_GATEWAY_STARTUP_ENTRY_EPOCH} configStart=${_NEMOCLAW_GATEWAY_CONFIG_STARTED_EPOCH} configEnd=${_NEMOCLAW_GATEWAY_CONFIG_FINISHED_EPOCH} providerEnd=${_NEMOCLAW_GATEWAY_PROVIDER_FINISHED_EPOCH} tokenEnd=${_NEMOCLAW_GATEWAY_TOKEN_FINISHED_EPOCH} messagingEnd=${_NEMOCLAW_GATEWAY_MESSAGING_FINISHED_EPOCH} workspaceEnd=${_NEMOCLAW_GATEWAY_WORKSPACE_FINISHED_EPOCH} spawnEnd=${_NEMOCLAW_GATEWAY_SPAWN_FINISHED_EPOCH}" \
    | _nemoclaw_safe_replace_tmp_file \
      "$_PORTABLE_OPENCLAW_GATEWAY_STARTUP_TIMING_PATH" 600 "" best-effort \
      2>/dev/null || true
}
