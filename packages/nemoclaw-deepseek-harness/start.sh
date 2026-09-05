#!/bin/bash -p
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Establish the small runtime boundary that every terminal and headless turn
# inherits. Harness behavior itself stays behind the package's Fabric adapter.
set -euo pipefail
unset BASH_ENV ENV
umask 077

export HOME=/sandbox
export PATH="/usr/local/bin:/opt/nemoclaw-fabric-venv/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin"
export DSH_HOME=/sandbox/.deepseek-harness
export DSH_TELEMETRY_MODE=DISABLED
export DSH_TELEMETRY_DISABLED=1

verify_state_root() {
  [ -d "$DSH_HOME" ] && [ ! -L "$DSH_HOME" ]
}

if [ "$(id -u)" -eq 0 ]; then
  verify_state_root || {
    printf '%s\n' '[SECURITY] DeepSeek Harness state root is missing or unsafe.' >&2
    exit 1
  }
  chown root:sandbox /sandbox
  chmod 1775 /sandbox
  chown -R sandbox:sandbox "$DSH_HOME"
  chmod 0700 "$DSH_HOME"
  exec /usr/bin/setpriv --reuid=sandbox --regid=sandbox --init-groups -- \
    /usr/local/bin/nemoclaw-start "$@"
fi

verify_state_root || {
  printf '%s\n' '[SECURITY] DeepSeek Harness state root is missing or unsafe.' >&2
  exit 1
}

is_valid_proxy_host() {
  [[ "$1" =~ ^[A-Za-z0-9._-]+$ ]]
}

is_valid_proxy_port() {
  [[ "$1" =~ ^[0-9]{1,5}$ ]] || return 1
  ((10#$1 >= 1 && 10#$1 <= 65535))
}

# Reconstruct the credential-free OpenShell proxy URL from the two typed,
# validated startup values. Never persist an ambient proxy URL, which could
# contain host credentials. inference.local must not appear in NO_PROXY.
PROXY_HOST="${NEMOCLAW_PROXY_HOST:-}"
PROXY_PORT="${NEMOCLAW_PROXY_PORT:-}"
if ! is_valid_proxy_host "$PROXY_HOST" || ! is_valid_proxy_port "$PROXY_PORT"; then
  printf '%s\n' '[SECURITY] Missing or invalid managed proxy route.' >&2
  exit 1
fi
PROXY_URL="http://${PROXY_HOST}:${PROXY_PORT}"
export HTTP_PROXY="$PROXY_URL"
export HTTPS_PROXY="$PROXY_URL"
export NO_PROXY="localhost,127.0.0.1,::1,${PROXY_HOST}"
export http_proxy="$PROXY_URL"
export https_proxy="$PROXY_URL"
export no_proxy="$NO_PROXY"
unset ALL_PROXY all_proxy OPENAI_PROXY NEMOCLAW_PROXY_HOST NEMOCLAW_PROXY_PORT

write_export_if_set() {
  local name="$1"
  local value="${!name:-}"
  [ -n "$value" ] || return 0
  printf 'export %s=%q\n' "$name" "$value"
}

write_runtime_environment() {
  # Later sandbox execs are independent processes. Persist only public routing
  # and CA values so NemoClaw's generic exec wrapper can recreate the route.
  local target=/tmp/nemoclaw-proxy-env.sh
  local staged
  staged="$(mktemp /tmp/nemoclaw-proxy-env.XXXXXX)"
  {
    printf '%s\n' 'export HOME=/sandbox'
    printf '%s\n' 'export PATH="/usr/local/bin:/opt/nemoclaw-fabric-venv/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin"'
    printf '%s\n' 'export DSH_HOME=/sandbox/.deepseek-harness'
    printf '%s\n' 'export DSH_TELEMETRY_MODE=DISABLED'
    printf '%s\n' 'export DSH_TELEMETRY_DISABLED=1'
    printf '%s\n' 'unset ALL_PROXY all_proxy OPENAI_PROXY'
    write_export_if_set HTTP_PROXY
    write_export_if_set HTTPS_PROXY
    write_export_if_set NO_PROXY
    write_export_if_set http_proxy
    write_export_if_set https_proxy
    write_export_if_set no_proxy
    write_export_if_set SSL_CERT_FILE
    write_export_if_set CURL_CA_BUNDLE
    write_export_if_set REQUESTS_CA_BUNDLE
    write_export_if_set GIT_SSL_CAINFO
    write_export_if_set NODE_EXTRA_CA_CERTS
  } >"$staged"
  chmod 0444 "$staged"
  mv -f "$staged" "$target"
}

write_runtime_environment

if [ "$#" -eq 0 ]; then
  printf '%s\n' 'Setting up NemoClaw DeepSeek Harness runtime...'
  exec -a nemoclaw-deepseek-entrypoint tail -f /dev/null
fi

exec "$@"
