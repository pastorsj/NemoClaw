#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

proxy_env=/tmp/nemoclaw-proxy-env.sh
if [[ -e "$proxy_env" || -L "$proxy_env" ]]; then
  if [[ -L "$proxy_env" || ! -f "$proxy_env" ]]; then
    echo "[SECURITY] $proxy_env is unsafe (expected regular root-owned mode 444 file)" >&2
    exit 126
  fi
  perms="$(stat -c '%a' "$proxy_env" 2>/dev/null || stat -f '%Lp' "$proxy_env" 2>/dev/null || echo unknown)"
  owner="$(stat -c '%U' "$proxy_env" 2>/dev/null || stat -f '%Su' "$proxy_env" 2>/dev/null || echo unknown)"
  if [[ "$(id -u)" -eq 0 ]]; then
    if [[ "$owner" != root || "$perms" != 444 ]]; then
      echo "[SECURITY] $proxy_env has unsafe permissions: owner=$owner mode=$perms (expected root:444)" >&2
      exit 126
    fi
  elif [[ "$perms" != 444 ]]; then
    echo "[SECURITY] $proxy_env has unsafe permissions: mode=$perms (expected 444)" >&2
    exit 126
  fi
  # shellcheck source=/dev/null
  if ! source "$proxy_env" >/dev/null 2>&1; then
    echo "[SECURITY] $proxy_env could not be sourced safely" >&2
    exit 126
  fi
fi

exec /usr/local/bin/node --experimental-strip-types --no-warnings /usr/local/lib/nemoclaw/openclaw-session-admin.mts "$@"
