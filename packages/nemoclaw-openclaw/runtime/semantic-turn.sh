#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

validate_semantic_turn_environment() {
  local runtime_env="$1"
  if [[ -L "$runtime_env" || ! -f "$runtime_env" ]]; then
    echo "[SECURITY] Semantic-turn runtime environment is unavailable" >&2
    return 126
  fi

  local mode owner_uid current_uid
  mode="$(stat -c '%a' "$runtime_env" 2>/dev/null || stat -f '%Lp' "$runtime_env" 2>/dev/null || echo unknown)"
  owner_uid="$(stat -c '%u' "$runtime_env" 2>/dev/null || stat -f '%u' "$runtime_env" 2>/dev/null || echo unknown)"
  current_uid="$(id -u)"
  # Root-started images leave this file root-owned after privilege drop. The
  # existing non-root image mode creates it as the sandbox user; that weaker
  # ownership model is already the explicit OpenShell non-root limitation.
  if [[ "$mode" != 444 || ("$owner_uid" != 0 && "$owner_uid" != "$current_uid") ]]; then
    echo "[SECURITY] Semantic-turn runtime environment is unsafe" >&2
    return 126
  fi
}

run_openclaw_semantic_turn() {
  local runtime_env=/tmp/nemoclaw-proxy-env.sh
  validate_semantic_turn_environment "$runtime_env"
  # shellcheck source=/dev/null
  source "$runtime_env" >/dev/null 2>&1

  exec /usr/local/bin/node --experimental-strip-types --no-warnings \
    /usr/local/lib/nemoclaw/openclaw-semantic-turn.mts
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  run_openclaw_semantic_turn
fi
