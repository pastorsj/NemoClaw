#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Converge OpenClaw pairing after a receipt-backed inference config write."""

from __future__ import annotations

import json
import re
import subprocess
import sys
from collections.abc import Callable

MAX_REQUEST_BYTES = 4096
REQUEST_ID_PATTERN = re.compile(r"^[a-f0-9]{64}$")
RECONCILE_SHELL = r"""
set -eu
PROXY_ENV=/tmp/nemoclaw-proxy-env.sh
[ -e "$PROXY_ENV" ] || [ -L "$PROXY_ENV" ] || exit 1
[ ! -L "$PROXY_ENV" ] && [ -f "$PROXY_ENV" ] || exit 1
perms="$(stat -c '%a' "$PROXY_ENV" 2>/dev/null || echo unsafe)"
owner="$(stat -c '%u' "$PROXY_ENV" 2>/dev/null || echo unsafe)"
current="$(id -u)"
[ "$perms" = 444 ] || exit 1
[ "$owner" = 0 ] || [ "$owner" = "$current" ] || exit 1
. "$PROXY_ENV" >/dev/null 2>&1 || exit 1
OPENCLAW_BIN=/usr/local/bin/openclaw
[ -x "$OPENCLAW_BIN" ] || exit 1
export OPENCLAW_BIN
NEMOCLAW_OPENCLAW_FORCE_DEVICE_PAIRING=1 \
  /usr/bin/timeout 15s "$OPENCLAW_BIN" agent --agent main -m ping \
  --session-id "nemoclaw-inference-reconcile-$$" >/dev/null 2>&1 || true
exec /usr/bin/python3 -I /usr/local/lib/nemoclaw/openclaw-startup/auto-pair.py --once
"""


def read_request(stream: object) -> str | None:
    """Accept one bounded, newline-terminated request with no extra fields."""

    source = stream.buffer.read(MAX_REQUEST_BYTES + 1)  # type: ignore[attr-defined]
    if len(source) > MAX_REQUEST_BYTES or not source.endswith(b"\n") or b"\r" in source:
        return None
    try:
        value = json.loads(source[:-1].decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None
    if not isinstance(value, dict) or set(value) != {"requestId"}:
        return None
    request_id = value.get("requestId")
    return request_id if isinstance(request_id, str) and REQUEST_ID_PATTERN.fullmatch(request_id) else None


def reconcile_pairing(
    run: Callable[..., subprocess.CompletedProcess[bytes]] = subprocess.run,
) -> bool:
    """Run the package-owned, bounded one-shot pairing workflow."""

    try:
        result = run(
            ["/bin/bash", "-c", RECONCILE_SHELL],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=75,
            check=False,
            start_new_session=True,
        )
    except (OSError, subprocess.SubprocessError):
        return False
    return result.returncode == 0


def main() -> int:
    request_id = read_request(sys.stdin)
    if request_id is None or not reconcile_pairing():
        return 1
    print(json.dumps({"status": "converged", "requestId": request_id}, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
