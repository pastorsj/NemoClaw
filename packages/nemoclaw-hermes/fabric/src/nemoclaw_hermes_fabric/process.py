# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Keep the official Hermes host bounded by its NemoClaw proxy lifetime."""

from __future__ import annotations

import ctypes
import os
import signal
import subprocess
import sys
import time
from pathlib import Path


PARENT_CHECK_SECONDS = 0.05
DESCENDANT_STOP_GRACE_SECONDS = 0.25
PR_SET_CHILD_SUBREAPER = 36
INVALID_USAGE_EXIT = 64
PARENT_LOST_EXIT = 125
PROCESS_UNAVAILABLE_EXIT = 127


def _arguments(values: list[str]) -> tuple[int, list[str]]:
    """Decode the fixed private invocation used by the lifecycle proxy."""

    if len(values) < 4 or values[0] != "--parent-pid" or values[2] != "--":
        raise ValueError("invalid Hermes process wrapper invocation")
    try:
        parent_pid = int(values[1])
    except ValueError as error:
        raise ValueError("invalid Hermes proxy parent process") from error
    if parent_pid <= 1 or not values[3:]:
        raise ValueError("invalid Hermes adapter process command")
    return parent_pid, values[3:]


def _enable_linux_child_subreaper() -> None:
    """Adopt Hermes tool processes when the official host is terminated."""

    if sys.platform != "linux":
        return
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) != 0:
        error_number = ctypes.get_errno()
        raise OSError(error_number, os.strerror(error_number))


def _linux_process_table() -> dict[int, set[int]]:
    """Return Linux child relationships without trusting process command lines."""

    children: dict[int, set[int]] = {}
    try:
        entries = os.scandir("/proc")
    except OSError:
        return children
    with entries:
        for entry in entries:
            if not entry.name.isdecimal():
                continue
            try:
                process_id = int(entry.name)
                process_stat = Path(f"/proc/{entry.name}/stat").read_text(
                    encoding="ascii"
                )
                closing = process_stat.rfind(")")
                fields = process_stat[closing + 2 :].split()
                if closing == -1 or len(fields) < 2:
                    continue
                parent_id = int(fields[1])
            except (FileNotFoundError, PermissionError, ValueError, OSError):
                continue
            children.setdefault(parent_id, set()).add(process_id)
    return children


def _portable_process_table() -> dict[int, set[int]]:
    """Return child relationships on supported non-Linux development hosts."""

    try:
        result = subprocess.run(
            ["ps", "-axo", "pid=,ppid="],
            check=False,
            capture_output=True,
            text=True,
            timeout=1,
        )
    except (OSError, subprocess.TimeoutExpired):
        return {}
    if result.returncode != 0:
        return {}
    children: dict[int, set[int]] = {}
    for line in result.stdout.splitlines():
        try:
            process_id, parent_id = (int(value) for value in line.split())
        except (TypeError, ValueError):
            continue
        children.setdefault(parent_id, set()).add(process_id)
    return children


def _descendants(process_id: int) -> set[int]:
    """Snapshot every descendant, including children in detached sessions."""

    relationships = (
        _linux_process_table() if sys.platform == "linux" else _portable_process_table()
    )
    found: set[int] = set()
    pending = list(relationships.get(process_id, ()))
    while pending:
        child = pending.pop()
        if child in found:
            continue
        found.add(child)
        pending.extend(relationships.get(child, ()))
    return found


def _reap_exited_children() -> None:
    """Release every exited process adopted by the Linux subreaper."""

    while True:
        try:
            process_id, _status = os.waitpid(-1, os.WNOHANG)
        except ChildProcessError:
            return
        except InterruptedError:
            continue
        if process_id == 0:
            return


def _signal_processes(process_ids: set[int], sent_signal: int) -> None:
    """Signal exact observed process IDs without using a shared host group."""

    for process_id in process_ids:
        try:
            os.kill(process_id, sent_signal)
        except (ProcessLookupError, PermissionError, OSError):
            pass


def _stop_linux_adopted_descendants() -> None:
    """Terminate and reap detached tools after the official host exits."""

    deadline = time.monotonic() + DESCENDANT_STOP_GRACE_SECONDS
    signaled: set[int] = set()
    while True:
        _reap_exited_children()
        process_ids = _descendants(os.getpid())
        if not process_ids:
            return
        new_process_ids = process_ids - signaled
        if new_process_ids:
            _signal_processes(new_process_ids, signal.SIGTERM)
            signaled.update(new_process_ids)
        if time.monotonic() >= deadline:
            _signal_processes(process_ids, signal.SIGKILL)
            break
        time.sleep(PARENT_CHECK_SECONDS)

    deadline = time.monotonic() + DESCENDANT_STOP_GRACE_SECONDS
    while time.monotonic() < deadline:
        _reap_exited_children()
        process_ids = _descendants(os.getpid())
        if not process_ids:
            return
        _signal_processes(process_ids, signal.SIGKILL)
        time.sleep(PARENT_CHECK_SECONDS)
    _reap_exited_children()


def _stop_direct_child(
    child: subprocess.Popen[bytes], observed_descendants: set[int]
) -> None:
    """Bound shutdown of the official host and every observed tool process."""

    observed_descendants.update(_descendants(child.pid))
    _signal_processes(observed_descendants, signal.SIGTERM)
    if child.poll() is None:
        try:
            child.terminate()
        except ProcessLookupError:
            pass
    try:
        child.wait(timeout=DESCENDANT_STOP_GRACE_SECONDS)
    except subprocess.TimeoutExpired:
        observed_descendants.update(_descendants(child.pid))
        _signal_processes(observed_descendants, signal.SIGKILL)
        try:
            child.kill()
        except ProcessLookupError:
            pass
        child.wait()
    _signal_processes(observed_descendants, signal.SIGKILL)


def run(values: list[str]) -> int:
    """Run the official adapter and stop every tool before this owner exits."""

    try:
        expected_parent, command = _arguments(values)
    except ValueError:
        return INVALID_USAGE_EXIT
    if os.getppid() != expected_parent:
        return PARENT_LOST_EXIT
    if sys.platform == "linux":
        try:
            _enable_linux_child_subreaper()
        except OSError:
            return PROCESS_UNAVAILABLE_EXIT

    child: subprocess.Popen[bytes] | None = None
    requested_signal: int | None = None

    def request_stop(sent_signal: int, _frame: object) -> None:
        nonlocal requested_signal
        requested_signal = sent_signal

    handled_signals = (signal.SIGHUP, signal.SIGINT, signal.SIGTERM)
    previous_handlers = {
        handled_signal: signal.signal(handled_signal, request_stop)
        for handled_signal in handled_signals
    }
    try:
        child = subprocess.Popen(command)
    except OSError:
        for handled_signal, previous_handler in previous_handlers.items():
            signal.signal(handled_signal, previous_handler)
        return PROCESS_UNAVAILABLE_EXIT

    parent_lost = False
    observed_descendants: set[int] = set()
    while child.poll() is None:
        if sys.platform != "linux":
            observed_descendants.update(_descendants(child.pid))
        parent_lost = os.getppid() != expected_parent
        if requested_signal is not None or parent_lost:
            _stop_direct_child(child, observed_descendants)
            break
        time.sleep(PARENT_CHECK_SECONDS)
    return_code = child.wait()
    try:
        if sys.platform == "linux":
            _stop_linux_adopted_descendants()
        else:
            _signal_processes(observed_descendants, signal.SIGKILL)
    finally:
        for handled_signal, previous_handler in previous_handlers.items():
            signal.signal(handled_signal, previous_handler)

    if parent_lost:
        return PARENT_LOST_EXIT
    if requested_signal is not None:
        return 128 + requested_signal
    return int(return_code)


def main() -> None:
    """Run the private process owner without adding a shell boundary."""

    raise SystemExit(run(sys.argv[1:]))


if __name__ == "__main__":
    main()
