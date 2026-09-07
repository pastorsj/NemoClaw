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

readonly HAYSTACK_STATE_ROOT="/sandbox/.haystack-agent"
readonly MANAGED_PROXY_HOST_FILE="/usr/local/share/nemoclaw/haystack-proxy-host"
readonly MANAGED_PROXY_PORT_FILE="/usr/local/share/nemoclaw/haystack-proxy-port"
readonly MANAGED_FILE_OWNER_UID=0

managed_file_metadata() {
  local file="$1"
  local metadata
  if metadata="$(stat -c '%u:%a' "$file" 2>/dev/null)"; then
    printf '%s' "$metadata"
  else
    stat -f '%u:%Lp' "$file" 2>/dev/null
  fi
}

read_managed_proxy_value() {
  local file="$1"
  local name="$2"
  local metadata
  if [ ! -f "$file" ] || [ -L "$file" ] || [ ! -r "$file" ]; then
    printf 'Missing or unsafe trusted managed proxy %s file.\n' "$name" >&2
    return 1
  fi
  metadata="$(managed_file_metadata "$file")" || {
    printf 'Cannot inspect trusted managed proxy %s file.\n' "$name" >&2
    return 1
  }
  if [ "$metadata" != "${MANAGED_FILE_OWNER_UID}:444" ]; then
    printf 'Unsafe ownership or mode on trusted managed proxy %s file.\n' "$name" >&2
    return 1
  fi
  printf '%s' "$(<"$file")"
}

if [ ! -d "$HAYSTACK_STATE_ROOT" ] || [ -L "$HAYSTACK_STATE_ROOT" ]; then
  printf '%s\n' '[SECURITY] Haystack Agent state root is missing or unsafe.' >&2
  exit 1
fi

# The package's fixed root entrypoint repairs mounted-state ownership, then
# immediately re-enters as the sandbox user. A direct build may still select
# the sandbox user and must pass the same state and proxy checks below.
if [ "$(id -u)" -eq 0 ]; then
  chown root:sandbox /sandbox
  chmod 1775 /sandbox
  chown -R sandbox:sandbox "$HAYSTACK_STATE_ROOT"
  chmod 0700 "$HAYSTACK_STATE_ROOT"
  exec /usr/bin/setpriv --reuid=sandbox --regid=sandbox --init-groups -- \
    /usr/local/bin/nemoclaw-start "$@"
fi

is_valid_proxy_host() {
  [[ "$1" =~ ^[A-Za-z0-9._-]+$ ]]
}

is_valid_proxy_port() {
  [[ "$1" =~ ^[0-9]{1,5}$ ]] || return 1
  ((10#$1 >= 1 && 10#$1 <= 65535))
}

# Reconstruct the credential-free OpenShell proxy URL from the two root-owned,
# package-planned values. Never trust an ambient proxy URL, which could contain
# host credentials. inference.local must not appear in NO_PROXY.
PROXY_HOST="$(read_managed_proxy_value "$MANAGED_PROXY_HOST_FILE" "host")"
PROXY_PORT="$(read_managed_proxy_value "$MANAGED_PROXY_PORT_FILE" "port")"
unset NEMOCLAW_PROXY_HOST NEMOCLAW_PROXY_PORT
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
