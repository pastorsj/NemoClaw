#!/bin/sh
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -eu

nonce="${1:-}"
case "$nonce" in
  *[!0-9a-f]* | "") exit 2 ;;
esac
[ "${#nonce}" -eq 64 ] || exit 2

# Managed onboarding currently builds OpenClaw with device authentication
# disabled. There is no native pairing state to settle in that configuration,
# so validate the immutable image intent against the live native config before
# acknowledging the core nonce. The package owns this distinction; NemoClaw
# core only validates the completion record declared by the package contract.
case "${NEMOCLAW_DISABLE_DEVICE_AUTH:-0}" in
  1)
    auth_state_helper="$(dirname "$0")/auth-state.py"
    if [ ! -f "$auth_state_helper" ]; then
      auth_state_helper=/usr/local/lib/nemoclaw/openclaw-auth-state.py
    fi
    python3 "$auth_state_helper" >/dev/null
    printf '__NEMOCLAW_DEVICE_PAIRING_SETTLED__=%s\n' "$nonce"
    exit 0
    ;;
  0) ;;
  *) exit 1 ;;
esac

openclaw_bin="$(command -v openclaw)"
command -v python3 >/dev/null 2>&1

# Ask the canonical CLI identity for write scope. A non-zero result is expected
# while the package-owned watcher holds the approval request.
unset OPENCLAW_GATEWAY_URL OPENCLAW_GATEWAY_PORT \
  OPENCLAW_GATEWAY_TOKEN OPENCLAW_GATEWAY_PASSWORD \
  NEMOCLAW_OPENCLAW_RESTORED_CLONE_PAIRING \
  NEMOCLAW_OPENCLAW_PAIRING_SETTLEMENT
session_key="agent:main:nemoclaw-onboard-warmup-$$-$(date +%s)"
params="$(printf '{\"key\":\"%s\",\"agentId\":\"main\"}' "$session_key")"
OPENCLAW_BIN="$openclaw_bin" NEMOCLAW_OPENCLAW_FORCE_DEVICE_PAIRING=1 \
  python3 - "$params" <<'PYPROBE'
import os
import subprocess
import sys

try:
    subprocess.run(
        [
            os.environ['OPENCLAW_BIN'], 'gateway', 'call', 'sessions.create',
            '--params', sys.argv[1], '--json',
        ],
        capture_output=True,
        text=True,
        timeout=10,
        env=dict(os.environ),
        check=False,
    )
except (OSError, subprocess.TimeoutExpired):
    pass
PYPROBE

# The one-shot package watcher exits successfully only after its canonical CLI
# identity has the exact pairing/read/write scope set and no pending request.
OPENCLAW_BIN="$openclaw_bin" \
  NEMOCLAW_AUTO_PAIR_DEADLINE_SECS=60 \
  NEMOCLAW_AUTO_PAIR_RUN_TIMEOUT_SECS=10 \
  python3 /usr/local/lib/nemoclaw/openclaw-startup/auto-pair.py --once >/dev/null 2>&1

printf '__NEMOCLAW_DEVICE_PAIRING_SETTLED__=%s\n' "$nonce"
