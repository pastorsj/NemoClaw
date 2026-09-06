#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""OpenClaw's fixed process, port, and preflight profile for managed control."""

from __future__ import annotations

import os
import stat
import subprocess
import sys


def _system_path(path: str, root: str) -> str:
    return os.path.join(root, path.lstrip("/")) if root else path


def _trusted_regular(path: str, system_root: str) -> bool:
    try:
        metadata = os.lstat(path)
    except OSError:
        return False
    trusted_uid = os.geteuid() if system_root else 0
    return bool(
        stat.S_ISREG(metadata.st_mode)
        and metadata.st_uid == trusted_uid
        and metadata.st_nlink == 1
        and stat.S_IMODE(metadata.st_mode) & 0o022 == 0
    )


def agent_spec(environment: dict[str, str]) -> dict[str, object]:
    raw = environment.get("NEMOCLAW_DASHBOARD_PORT", "").strip()
    if not raw:
        chat_url = environment.get("CHAT_UI_URL", "")
        raw = chat_url.rsplit(":", 1)[-1].split("/", 1)[0] if ":" in chat_url else "18789"
    port = int(raw, 10)
    if port < 1024 or port > 65535:
        raise ValueError("dashboard port is outside the supported range")
    return {"name": "managed-agent", "port": port, "readiness_checks": ()}


def gateway_matches(argv: tuple[bytes, ...], port: int) -> bool:
    if len(argv) == 1 and os.path.basename(argv[0]) in (b"openclaw", b"openclaw-gateway"):
        return True
    command_index = 1 if len(argv) >= 2 and os.path.basename(argv[0]) in (b"node", b"nodejs") else 0
    if command_index >= len(argv) or os.path.basename(argv[command_index]) not in (
        b"openclaw",
        b"openclaw.mjs",
    ):
        return False
    expected_port = str(port).encode("ascii")
    return argv[command_index + 1 :] in (
        (b"gateway", b"run", b"--port", expected_port),
        (b"gateway", b"run", b"--port=" + expected_port),
    )


def preflight(environment: dict[str, str], timeout: float, system_root: str) -> str | None:
    del environment
    guard = _system_path("/usr/local/lib/nemoclaw/openclaw-config-guard.py", system_root)
    config = _system_path("/sandbox/.openclaw", system_root)
    if not _trusted_regular(guard, system_root):
        return "GATEWAY_UNSAFE_CONFIG_PATH"
    result = subprocess.run(
        [sys.executable, "-I", guard, "preflight-restart", "--config-dir", config],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        timeout=timeout,
        check=False,
    )
    return None if result.returncode == 0 else "GATEWAY_UNSAFE_CONFIG_PATH"


DIAGNOSTIC_PATTERNS: tuple[str, ...] = ()
