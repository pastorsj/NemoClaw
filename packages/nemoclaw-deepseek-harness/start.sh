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

# inference.local is an OpenShell L7 route and must traverse the sandbox proxy.
# Keep loopback bypasses for local tools without inheriting an ambient bypass
# for the managed inference hostname.
export NO_PROXY=localhost,127.0.0.1,::1
export no_proxy="$NO_PROXY"

if [ "$#" -eq 0 ]; then
  printf '%s\n' 'Setting up NemoClaw DeepSeek Harness runtime...'
  exec -a nemoclaw-deepseek-entrypoint tail -f /dev/null
fi

exec "$@"
