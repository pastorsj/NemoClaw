#!/opt/hermes/.venv/bin/python3 -I
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Seal Hermes files produced by the finite NemoClaw startup workflow."""

from __future__ import annotations

import errno
import importlib.util
import os
import pwd
import signal
import sys
from types import ModuleType


REPLAY_ENV = "NEMOCLAW_MANAGED_STARTUP_REPLAY"
INSTALLED_CONFIG_GUARD = "/usr/local/lib/nemoclaw/hermes-runtime-config-guard.py"
HERMES_DIRECTORY = "/sandbox/.hermes"
STRICT_HASH_PATH = "/etc/nemoclaw/hermes.config-hash"
POLICY_SOURCE_PATH = "/sandbox/.hermes/managed-policy.json"
POLICY_TARGET_PATH = "/usr/local/share/nemoclaw/hermes-managed-policy.json"
MAX_POLICY_BYTES = 4 * 1024 * 1024
DEADLINE_SECONDS = 10 * 60


def load_config_guard(path: str = INSTALLED_CONFIG_GUARD) -> ModuleType:
    """Load the package-owned descriptor primitives from their trusted image path."""
    spec = importlib.util.spec_from_file_location("nemoclaw_hermes_config_guard", path)
    if spec is None or spec.loader is None:
        raise RuntimeError("Hermes runtime config guard could not be loaded")
    guard = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = guard
    spec.loader.exec_module(guard)
    return guard


def replace_managed_file(
    guard: ModuleType,
    path: str,
    data: bytes,
    *,
    mode: int,
    uid: int,
    gid: int,
) -> None:
    """Atomically replace only an absent or expected package-owned seal target."""
    try:
        opened = guard._open_regular(path)
    except FileNotFoundError:
        expected = None
    else:
        try:
            expected = opened.snapshot
        finally:
            opened.close()
        if expected.uid != uid or expected.gid != gid or expected.mode != mode:
            raise guard.UnsafePathError(
                f"refusing unexpected managed startup seal target: {path}"
            )
    guard._atomic_replace(
        path,
        data,
        expected=expected,
        mode=mode,
        uid=uid,
        gid=gid,
    )


def install_managed_policy(
    guard: ModuleType,
    sandbox_uid: int,
    sandbox_gid: int,
) -> None:
    """Promote the generated policy to the fixed root-owned runtime path."""
    opened = guard._open_regular(POLICY_SOURCE_PATH)
    try:
        source_snapshot = opened.snapshot
        if (
            source_snapshot.uid != sandbox_uid
            or source_snapshot.gid != sandbox_gid
            or source_snapshot.mode != 0o600
        ):
            raise guard.UnsafePathError(
                "refusing unexpected Hermes managed policy source"
            )
        policy = opened.read_bytes(MAX_POLICY_BYTES)
    finally:
        opened.close()

    replace_managed_file(
        guard,
        POLICY_TARGET_PATH,
        policy,
        mode=0o444,
        uid=0,
        gid=0,
    )
    source_dir_fd, source_name = guard._open_parent_dir(POLICY_SOURCE_PATH)
    try:
        guard._assert_current_snapshot(
            source_dir_fd,
            source_name,
            POLICY_SOURCE_PATH,
            source_snapshot,
        )
        os.unlink(source_name, dir_fd=source_dir_fd)
        guard._fsync_directory_after_replace(source_dir_fd)
    finally:
        os.close(source_dir_fd)


def normalize_managed_descriptor(
    guard: ModuleType,
    path: str,
    sandbox_uid: int,
    sandbox_gid: int,
    expected_mode: int,
) -> None:
    """Normalize one authenticated sandbox file through its open descriptor."""
    opened = guard._open_regular(path)
    try:
        before = opened.snapshot
        if (
            before.uid != sandbox_uid
            or before.gid != sandbox_gid
            or before.mode not in (0o600, expected_mode)
        ):
            raise guard.UnsafePathError(
                f"refusing unexpected Hermes managed config descriptor {path}"
            )
        if before.mode != expected_mode:
            os.fchmod(opened.fd, expected_mode)
        after = guard.FileSnapshot.from_stat(os.fstat(opened.fd))
        path_after = guard.FileSnapshot.from_stat(os.stat(path, follow_symlinks=False))
        if (
            after != path_after
            or after.dev != before.dev
            or after.ino != before.ino
            or after.uid != sandbox_uid
            or after.gid != sandbox_gid
            or after.mode != expected_mode
            or after.size != before.size
            or after.mtime_ns != before.mtime_ns
        ):
            raise guard.UnsafePathError(
                f"Hermes managed config descriptor changed during normalization: {path}"
            )
    finally:
        opened.close()


def assert_inputs_stable(
    guard: ModuleType,
    paths: tuple[str, str, str],
    expected_snapshots: tuple[object, object, object],
) -> None:
    """Prove the complete generated input set is unchanged between seal writes."""
    current = []
    try:
        for path in paths:
            current.append(guard._open_regular(path))
        if tuple(item.snapshot for item in current) != expected_snapshots:
            raise guard.UnsafePathError(
                "refusing raced Hermes managed config before sealing"
            )
    finally:
        for item in current:
            item.close()


def seal_managed_configuration(guard: ModuleType, replay: bool) -> None:
    """Seal one generated config set or repair its mutable replay modes."""
    if os.geteuid() != 0:
        raise guard.UnsafePathError(
            "Hermes managed startup config sealing requires root"
        )
    sandbox = pwd.getpwnam("sandbox")
    config_path = os.path.join(HERMES_DIRECTORY, "config.yaml")
    env_path = os.path.join(HERMES_DIRECTORY, ".env")
    fabric_path = os.path.join(HERMES_DIRECTORY, "fabric.json")
    compatibility_hash = os.path.join(HERMES_DIRECTORY, ".config-hash")
    input_paths = (config_path, env_path, fabric_path)

    if not replay:
        install_managed_policy(guard, sandbox.pw_uid, sandbox.pw_gid)
        hash_text, config_snapshot, env_snapshot, fabric_snapshot = guard._hash_text(
            config_path, env_path
        )
        snapshots = (config_snapshot, env_snapshot, fabric_snapshot)
        assert_inputs_stable(guard, input_paths, snapshots)
        replace_managed_file(
            guard,
            STRICT_HASH_PATH,
            hash_text.encode("utf-8"),
            mode=0o444,
            uid=0,
            gid=0,
        )
        assert_inputs_stable(guard, input_paths, snapshots)
        replace_managed_file(
            guard,
            compatibility_hash,
            hash_text.encode("utf-8"),
            mode=0o640,
            uid=sandbox.pw_uid,
            gid=sandbox.pw_gid,
        )
        assert_inputs_stable(guard, input_paths, snapshots)

    normalize_managed_descriptor(
        guard, config_path, sandbox.pw_uid, sandbox.pw_gid, 0o640
    )
    normalize_managed_descriptor(guard, env_path, sandbox.pw_uid, sandbox.pw_gid, 0o640)
    normalize_managed_descriptor(
        guard, fabric_path, sandbox.pw_uid, sandbox.pw_gid, 0o600
    )


def _deadline_expired(_signum: int, _frame: object) -> None:
    raise RuntimeError("Hermes managed startup config sealer exceeded its deadline")


def main() -> int:
    if len(sys.argv) != 1:
        print(
            "[SECURITY] Hermes managed config sealer accepts no arguments",
            file=sys.stderr,
        )
        return 1
    replay = os.environ.get(REPLAY_ENV)
    if replay not in ("0", "1"):
        print(f"[SECURITY] {REPLAY_ENV} must be 0 or 1", file=sys.stderr)
        return 1

    guard = load_config_guard()
    previous_alarm_handler = signal.signal(signal.SIGALRM, _deadline_expired)
    signal.alarm(DEADLINE_SECONDS)
    try:
        seal_managed_configuration(guard, replay == "1")
    except (guard.UnsafePathError, RuntimeError) as exc:
        guard._die(str(exc))
    except OSError as exc:
        if exc.errno in (errno.ELOOP, errno.EPERM, errno.EACCES):
            guard._die(f"refusing unsafe Hermes managed startup config path: {exc}")
        raise
    finally:
        signal.alarm(0)
        signal.signal(signal.SIGALRM, previous_alarm_handler)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
