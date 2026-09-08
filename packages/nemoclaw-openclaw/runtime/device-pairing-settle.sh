#!/bin/sh
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -eu

nonce="${1:-}"
case "$nonce" in
  *[!0-9a-f]* | "") exit 2 ;;
esac
[ "${#nonce}" -eq 64 ] || exit 2

openclaw_bin="$(command -v openclaw)"
command -v python3 >/dev/null 2>&1

# OpenShell exec preserves the image's HOME even when it runs this command as
# the sandbox user. Pin every OpenClaw path to the shared persistent state so a
# root-shaped inherited HOME cannot redirect CLI discovery to /root.
export HOME=/sandbox
export OPENCLAW_HOME=/sandbox
export OPENCLAW_STATE_DIR=/sandbox/.openclaw
export OPENCLAW_CONFIG_PATH=/sandbox/.openclaw/openclaw.json
export OPENCLAW_OAUTH_DIR=/sandbox/.openclaw/credentials

unset OPENCLAW_GATEWAY_URL OPENCLAW_GATEWAY_PORT \
  OPENCLAW_GATEWAY_TOKEN OPENCLAW_GATEWAY_PASSWORD \
  NEMOCLAW_OPENCLAW_FORCE_DEVICE_PAIRING \
  NEMOCLAW_OPENCLAW_RESTORED_CLONE_PAIRING \
  NEMOCLAW_OPENCLAW_PAIRING_SETTLEMENT \
  NEMOCLAW_OPENCLAW_BOUNDED_DEVICE_APPROVAL
# The long-running startup watcher is the sole request producer and approver.
# This bounded one-shot is read-only: it uses stored device auth to wait for
# exact canonical convergence without racing another settlement caller.
OPENCLAW_BIN="$openclaw_bin" \
  NEMOCLAW_AUTO_PAIR_DEADLINE_SECS=90 \
  NEMOCLAW_AUTO_PAIR_RUN_TIMEOUT_SECS=10 \
  python3 /usr/local/lib/nemoclaw/openclaw-startup/auto-pair.py --once >/dev/null 2>&1

printf '__NEMOCLAW_DEVICE_PAIRING_SETTLED__=%s\n' "$nonce"
