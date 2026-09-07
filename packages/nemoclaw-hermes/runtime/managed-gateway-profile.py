#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Hermes' fixed process, readiness, and secret-boundary managed-control profile."""

from __future__ import annotations

import hashlib
import importlib.util
import os
import re
import stat
import subprocess
import sys

MAX_CONFIG_BYTES = 16 * 1024 * 1024
MAX_ENV_BYTES = 4 * 1024 * 1024
MAX_HASH_BYTES = 64 * 1024
SHA256_RE = re.compile(r"[0-9a-f]{64}\Z")
MCP_STATE_RE = re.compile(
    r"# nemoclaw-hermes-mcp-state-v1 intended=[0-9a-f]{64} applied=[0-9a-f]{64}\Z"
)


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
    raw = environment.get("NEMOCLAW_HERMES_API_PORT", "").strip() or "8642"
    if re.fullmatch(r"[0-9]+", raw) is None:
        raise ValueError("invalid API port")
    port = int(raw, 10)
    if port < 8642 or port > 8652:
        raise ValueError("API port is outside the supported range")
    return {"name": "managed-agent", "port": 18642, "readiness_checks": ((port, "/health"),)}


def gateway_matches(argv: tuple[bytes, ...], port: int) -> bool:
    del port
    commands = (b"/usr/local/bin/hermes", b"/usr/local/bin/hermes.real")
    if len(argv) == 3:
        return argv[0] in commands and argv[1:] == (b"gateway", b"run")
    return bool(
        len(argv) == 4
        and os.path.basename(argv[0]) in (b"python", b"python3")
        and argv[1] in commands
        and argv[2:] == (b"gateway", b"run")
    )


def _read_regular(path: str, limit: int) -> tuple[bytes, os.stat_result]:
    descriptor = os.open(
        path,
        os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_CLOEXEC", 0),
    )
    try:
        before = os.fstat(descriptor)
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_size > limit:
            raise ValueError("unsafe managed configuration")
        content = b""
        while len(content) <= limit:
            chunk = os.read(descriptor, min(65536, limit + 1 - len(content)))
            if not chunk:
                break
            content += chunk
        after = os.fstat(descriptor)
        if len(content) > limit or (
            before.st_dev,
            before.st_ino,
            before.st_size,
            before.st_mtime_ns,
        ) != (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns):
            raise ValueError("unstable managed configuration")
        return content, before
    finally:
        os.close(descriptor)


def _parse_hash_file(content: bytes) -> dict[str, str]:
    records: dict[str, str] = {}
    metadata_seen = False
    for line in content.decode("ascii").splitlines():
        if line.startswith("#"):
            if metadata_seen or MCP_STATE_RE.fullmatch(line) is None:
                raise ValueError("invalid MCP state metadata")
            metadata_seen = True
            continue
        if metadata_seen:
            raise ValueError("MCP state metadata must be terminal")
        digest, pathname = line.split(maxsplit=1)
        if pathname in records:
            raise ValueError("duplicate config hash path")
        records[pathname] = digest.lower()
    return records


def _verify_locked_hash(system_root: str) -> str | None:
    config_name = "/sandbox/.hermes/config.yaml"
    env_name = "/sandbox/.hermes/.env"
    try:
        config, config_stat = _read_regular(_system_path(config_name, system_root), MAX_CONFIG_BYTES)
        env, env_stat = _read_regular(_system_path(env_name, system_root), MAX_ENV_BYTES)
    except (OSError, ValueError):
        return "GATEWAY_UNSAFE_CONFIG_PATH"
    locked = tuple(item.st_uid == 0 and stat.S_IMODE(item.st_mode) & 0o222 == 0 for item in (config_stat, env_stat))
    if locked == (False, False):
        return None
    if locked != (True, True):
        return "GATEWAY_UNSAFE_CONFIG_PATH"
    try:
        strict, strict_stat = _read_regular(
            _system_path("/etc/nemoclaw/hermes.config-hash", system_root), MAX_HASH_BYTES
        )
        if strict_stat.st_uid != 0 or stat.S_IMODE(strict_stat.st_mode) & 0o022:
            return "GATEWAY_UNSAFE_CONFIG_PATH"
        records = _parse_hash_file(strict)
    except (OSError, UnicodeDecodeError, ValueError):
        return "GATEWAY_CONFIG_HASH_MISMATCH"
    expected = {
        config_name: hashlib.sha256(config).hexdigest(),
        env_name: hashlib.sha256(env).hexdigest(),
    }
    if set(records) != set(expected) or any(
        SHA256_RE.fullmatch(records[path]) is None or records[path] != digest
        for path, digest in expected.items()
    ):
        return "GATEWAY_CONFIG_HASH_MISMATCH"
    return None


def preflight(environment: dict[str, str], timeout: float, system_root: str) -> str | None:
    validator = _system_path(
        "/usr/local/lib/nemoclaw/validate-hermes-env-secret-boundary.py", system_root
    )
    env_file = _system_path("/sandbox/.hermes/.env", system_root)
    if not _trusted_regular(validator, system_root):
        return "SECRET_BOUNDARY_VALIDATOR_MISSING"
    result = subprocess.run(
        [sys.executable, "-I", validator, "env-file", env_file],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        timeout=timeout,
        check=False,
    )
    if result.returncode != 0:
        return "SECRET_BOUNDARY_REFUSED"
    spec = importlib.util.spec_from_file_location("_nemoclaw_boundary_validator", validator)
    if spec is None or spec.loader is None:
        return "SECRET_BOUNDARY_VALIDATOR_MISSING"
    module = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(module)
        if module.validate_managed_gateway_env(environment) != 0:
            return "SECRET_BOUNDARY_REFUSED"
    except (AttributeError, ImportError, OSError, RuntimeError):
        return "SECRET_BOUNDARY_REFUSED"
    return _verify_locked_hash(system_root)


DIAGNOSTIC_PATTERNS = (
    r"\[gateway\] Hermes runtime preparation refused automatic respawn; retrying in 5s",
    r"\[gateway\] Hermes gateway launch failed; retrying under the same supervisor",
    r"\[gateway\] Hermes pre-launch layout repair failed at (?:gateway state directory|runtime state directory|history file)",
    r"\[gateway\] Hermes auxiliary repair failed; retrying while the exact gateway remains healthy",
    r"\[gateway\] Hermes auxiliary repair failed; retrying while the exact gateway remains supervised",
    r"\[gateway\] Hermes replacement gateway failed listener or health validation; stopping the exact child",
    r"\[gateway\] Hermes replacement gateway lost its listener or health endpoint during auxiliary validation; stopping the exact child",
    r"\[gateway\] CRITICAL: Hermes gateway lost its listener or health endpoint; stopping the exact child for recovery",
    r"\[gateway\] Hermes gateway pid [1-9][0-9]* exited \(rc=[0-9]+; authenticated host authorization\); respawning without charging crash quarantine in 2s",
    r"\[gateway\] Hermes gateway respawned \(pid [1-9][0-9]*\)",
    r"\[gateway\] Hermes runtime preparation failed after 5 consecutive attempts; supervisor exiting without launching a gateway; correct the reported failure, then stop and start the sandbox",
    r"\[gateway\] CRITICAL: [1-9][0-9]* exits in 60s window — Hermes relaunch is stopped for this supervisor instance; correct the reported failure, then stop and start the sandbox; check /tmp/gateway\.log",
    r"\[gateway\] CRITICAL: (?:exact Hermes replacement|unhealthy Hermes gateway|initial Hermes gateway) could not be stopped; managed supervisor is quarantined without another launch",
    r"\[CRITICAL\] Newly launched Hermes (?:gateway|gateway-log|dashboard|dashboard-log|api-socat|dashboard-socat) pid [1-9][0-9]* failed exact role identity capture; quarantining the managed startup supervisor without signaling the unproven child",
    r"\[CRITICAL\] Unproven Hermes (?:gateway|gateway-log|dashboard|dashboard-log|api-socat|dashboard-socat) child exited; relaunch is stopped for this supervisor instance; correct the reported failure, then stop and start the sandbox",
)
