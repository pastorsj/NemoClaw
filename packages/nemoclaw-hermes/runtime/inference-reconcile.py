#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Converge Hermes package state after a receipt-backed inference config write."""

from __future__ import annotations

import json
import os
import re
import stat
import subprocess
import sys
from collections.abc import Callable

MAX_REQUEST_BYTES = 4096
REQUEST_ID_PATTERN = re.compile(r"^[a-f0-9]{64}$")
CURRENT_DASHBOARD_HOME = "/sandbox/.hermes/profiles/dashboard-home"
LEGACY_DASHBOARD_HOME = "/sandbox/.hermes/dashboard-home"
PYTHON = "/opt/hermes/.venv/bin/python3"
SEEDER = "/usr/local/lib/nemoclaw/seed-hermes-dashboard-config.py"
POLICY = "/usr/local/share/nemoclaw/hermes-managed-policy.json"
GATEWAY_CONFIG = "/sandbox/.hermes/config.yaml"
GATEWAY_ENV = "/sandbox/.hermes/.env"


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


def safe_directory_state(path: str) -> str:
    """Classify a dashboard path without following its final component."""

    try:
        metadata = os.lstat(path)
    except FileNotFoundError:
        return "absent"
    except OSError:
        return "unsafe"
    return "directory" if stat.S_ISDIR(metadata.st_mode) else "unsafe"


def reconcile_dashboard(
    run: Callable[..., subprocess.CompletedProcess[bytes]] = subprocess.run,
) -> bool:
    """Seed an enabled dashboard profile and prove the seeder reported convergence."""

    current_state = safe_directory_state(CURRENT_DASHBOARD_HOME)
    legacy_state = safe_directory_state(LEGACY_DASHBOARD_HOME)
    if "unsafe" in (current_state, legacy_state):
        return False
    if current_state == "absent" and legacy_state == "absent":
        return True
    destination = f"{CURRENT_DASHBOARD_HOME}/config.yaml"
    try:
        result = run(
            [
                PYTHON,
                "-I",
                SEEDER,
                POLICY,
                GATEWAY_CONFIG,
                destination,
                GATEWAY_ENV,
                f"{CURRENT_DASHBOARD_HOME}/.env",
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            timeout=20,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return False
    expected = f"[dashboard] seeded model routing and reviewed policy into {destination}".encode()
    return result.returncode == 0 and expected in result.stderr.splitlines()


def main() -> int:
    request_id = read_request(sys.stdin)
    if request_id is None or not reconcile_dashboard():
        return 1
    print(json.dumps({"status": "converged", "requestId": request_id}, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
