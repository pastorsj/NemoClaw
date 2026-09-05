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

# OpenShell routes inference.local through its HTTP(S) L7 proxy. Remove the
# sandbox-create bypass seed while retaining the proxy URLs that OpenShell owns.
export NO_PROXY=localhost,127.0.0.1,::1
export no_proxy="$NO_PROXY"
unset ALL_PROXY all_proxy OPENAI_PROXY

write_export_if_set() {
  local name="$1"
  local value="${!name:-}"
  [ -n "$value" ] || return 0
  printf 'export %s=%q\n' "$name" "$value"
}

write_runtime_environment() {
  # OpenShell starts PID 1 with the managed proxy environment, but later
  # sandbox execs are independent processes. Persist only public routing and
  # CA values so NemoClaw's generic exec wrapper can recreate that environment.
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
