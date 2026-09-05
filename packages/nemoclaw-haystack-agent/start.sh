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
export HAYSTACK_FABRIC_API_KEY=nemoclaw-managed-inference

# OpenShell routes inference.local through its HTTP(S) L7 proxy. Remove the
# sandbox-create bypass seed while retaining the proxy URLs that OpenShell owns.
export NO_PROXY=localhost,127.0.0.1,::1
export no_proxy="$NO_PROXY"
unset ALL_PROXY all_proxy OPENAI_PROXY

if [ "$#" -gt 0 ]; then
  exec "$@"
fi

terminate=0
trap 'terminate=1' TERM INT
while [ "$terminate" -eq 0 ]; do
  sleep 1 &
  wait "$!" || true
done
