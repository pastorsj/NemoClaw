# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Keep a Pi turn bounded by its Fabric adapter host's lifetime."""

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
    """Decode the fixed private invocation used by the adapter."""

    if len(values) < 4 or values[0] != "--parent-pid" or values[2] != "--":
        raise ValueError("invalid Pi process wrapper invocation")
    try:
        parent_pid = int(values[1])
    except ValueError as error:
        raise ValueError("invalid Pi adapter parent process") from error
    if parent_pid <= 1 or not values[3:]:
        raise ValueError("invalid Pi adapter process command")
    return parent_pid, values[3:]


def _enable_linux_child_subreaper() -> None:
    """Adopt Pi tool processes that outlive their immediate parent."""

    if sys.platform != "linux":
        return
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) != 0:
        error_number = ctypes.get_errno()
        raise OSError(error_number, os.strerror(error_number))


def _direct_linux_children() -> set[int]:
    """Find processes adopted by this Linux child subreaper."""

    children: set[int] = set()
    try:
        entries = os.scandir("/proc")
    except OSError:
        return children
    with entries:
        for entry in entries:
            if not entry.name.isdecimal():
                continue
            try:
                stat = Path(f"/proc/{entry.name}/stat").read_text(encoding="ascii")
                closing = stat.rfind(")")
                fields = stat[closing + 2 :].split()
                if closing != -1 and len(fields) >= 2 and int(fields[1]) == os.getpid():
                    children.add(int(entry.name))
            except (FileNotFoundError, PermissionError, ValueError, OSError):
                continue
    return children


def _reap_exited_children() -> None:
    """Release every exited process adopted by the wrapper."""

    while True:
        try:
            process_id, _status = os.waitpid(-1, os.WNOHANG)
        except ChildProcessError:
            return
        except InterruptedError:
            continue
        if process_id == 0:
            return


def _signal_linux_children(process_ids: set[int], sent_signal: int) -> None:
    """Signal every child currently owned by the wrapper."""

    for process_id in process_ids:
        try:
            os.kill(process_id, sent_signal)
        except (ProcessLookupError, PermissionError):
            pass


def _stop_linux_descendants() -> None:
    """Terminate and reap detached Pi tools before the wrapper exits."""

    deadline = time.monotonic() + DESCENDANT_STOP_GRACE_SECONDS
    signaled: set[int] = set()
    while True:
        _reap_exited_children()
        process_ids = _direct_linux_children()
        if not process_ids:
            return
        new_process_ids = process_ids - signaled
        if new_process_ids:
            _signal_linux_children(new_process_ids, signal.SIGTERM)
            signaled.update(new_process_ids)
        if time.monotonic() >= deadline:
            _signal_linux_children(process_ids, signal.SIGKILL)
            break
        time.sleep(PARENT_CHECK_SECONDS)

    deadline = time.monotonic() + DESCENDANT_STOP_GRACE_SECONDS
    while time.monotonic() < deadline:
        _reap_exited_children()
        process_ids = _direct_linux_children()
        if not process_ids:
            return
        _signal_linux_children(process_ids, signal.SIGKILL)
        time.sleep(PARENT_CHECK_SECONDS)
    _reap_exited_children()


def _stop_direct_child(child: subprocess.Popen[bytes]) -> None:
    """Bound shutdown when Pi does not stop after the wrapper disconnects."""

    if child.poll() is not None:
        return
    child.terminate()
    try:
        child.wait(timeout=DESCENDANT_STOP_GRACE_SECONDS)
    except subprocess.TimeoutExpired:
        child.kill()
        child.wait()


def run(values: list[str]) -> int:
    """Run Pi and stop every tool process before the wrapper exits."""

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
        if child is not None:
            try:
                child.send_signal(sent_signal)
            except ProcessLookupError:
                pass

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
    while child.poll() is None:
        parent_lost = os.getppid() != expected_parent
        if requested_signal is not None or parent_lost:
            _stop_direct_child(child)
            break
        time.sleep(PARENT_CHECK_SECONDS)
    return_code = child.wait()
    try:
        if sys.platform == "linux":
            _stop_linux_descendants()
        elif parent_lost:
            os.killpg(os.getpgrp(), signal.SIGKILL)
    finally:
        for handled_signal, previous_handler in previous_handlers.items():
            signal.signal(handled_signal, previous_handler)

    if parent_lost:
        return PARENT_LOST_EXIT
    if requested_signal is not None:
        return 128 + requested_signal
    assert return_code is not None
    return int(return_code)


def main() -> None:
    """Run the private process wrapper without introducing a shell boundary."""

    raise SystemExit(run(sys.argv[1:]))


if __name__ == "__main__":
    main()
