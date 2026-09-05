#!/bin/bash -p
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail
unset BASH_ENV ENV PYTHONHOME PYTHONPATH
umask 077

export HOME=/sandbox
export PATH=/usr/local/bin:/opt/nemoclaw-fabric-venv/bin:/usr/bin:/bin
export HAYSTACK_TELEMETRY_ENABLED=false
export HAYSTACK_AUTO_TRACE_ENABLED=false
export HAYSTACK_CONTENT_TRACING_ENABLED=false

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
    printf '%s\n' 'export PATH="/usr/local/bin:/opt/nemoclaw-fabric-venv/bin:/usr/bin:/bin"'
    printf '%s\n' 'export HAYSTACK_TELEMETRY_ENABLED=false'
    printf '%s\n' 'export HAYSTACK_AUTO_TRACE_ENABLED=false'
    printf '%s\n' 'export HAYSTACK_CONTENT_TRACING_ENABLED=false'
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

if [ "$#" -gt 0 ]; then
  exec "$@"
fi

terminate=0
trap 'terminate=1' TERM INT
while [ "$terminate" -eq 0 ]; do
  sleep 1 &
  wait "$!" || true
done
