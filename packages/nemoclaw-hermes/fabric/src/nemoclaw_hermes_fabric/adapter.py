# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Bound and supervise the released Hermes Fabric lifecycle host."""

from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
import threading
from typing import BinaryIO


OFFICIAL_ADAPTER_MODULE = "nemo_fabric_adapters.hermes.adapter"
PROCESS_RESPONSE_LIMIT_BYTES = 1024 * 1024
PROCESS_STOP_GRACE_SECONDS = 2.0
OUTPUT_LIMIT_EXIT = 74
PROCESS_UNAVAILABLE_EXIT = 127


class _ResponseLimitExceeded(RuntimeError):
    """The released adapter produced a lifecycle record that is too large."""


def _hermes_adapter_python() -> str:
    """Return the interpreter that contains Hermes and its released adapter."""

    return os.environ.get("ADAPTER_PYTHON") or sys.executable


def _request_operation(request: bytes) -> str | None:
    """Read only the operation needed to end the proxy after a stop response."""

    try:
        value = json.loads(request)
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None
    if not isinstance(value, dict):
        return None
    operation = value.get("operation")
    return operation if isinstance(operation, str) else None


def _read_bounded_response(stream: BinaryIO) -> bytes:
    """Read one lifecycle response without retaining more than its hard limit."""

    response = stream.readline(PROCESS_RESPONSE_LIMIT_BYTES + 1)
    if len(response) > PROCESS_RESPONSE_LIMIT_BYTES:
        raise _ResponseLimitExceeded
    return response


def _discard_adapter_stderr(stream: BinaryIO) -> None:
    """Keep the official host unblocked without exposing unredacted diagnostics."""

    try:
        while stream.read(8192):
            pass
    except OSError:
        pass
    finally:
        try:
            stream.close()
        except OSError:
            pass


def _stop_supervisor(process: subprocess.Popen[bytes]) -> None:
    """Ask the private supervisor to clean the official host and its descendants."""

    # Signal the process owner before closing the protocol pipe. Closing stdin
    # first lets the official host observe EOF and exit before non-Linux hosts
    # can snapshot detached tool children for cleanup.
    if process.poll() is None:
        try:
            process.terminate()
        except OSError:
            pass
        try:
            process.wait(timeout=PROCESS_STOP_GRACE_SECONDS)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except OSError:
                try:
                    process.kill()
                except OSError:
                    pass
            try:
                process.wait(timeout=PROCESS_STOP_GRACE_SECONDS)
            except subprocess.TimeoutExpired:
                pass
    if process.stdin is not None:
        try:
            process.stdin.close()
        except OSError:
            pass


def _start_supervisor() -> subprocess.Popen[bytes]:
    """Start the released adapter behind NemoClaw's process owner."""

    return subprocess.Popen(
        [
            sys.executable,
            "-m",
            "nemoclaw_hermes_fabric.process",
            "--parent-pid",
            str(os.getpid()),
            "--",
            _hermes_adapter_python(),
            "-m",
            OFFICIAL_ADAPTER_MODULE,
        ],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        start_new_session=True,
    )


def run() -> int:
    """Relay the lifecycle protocol while keeping output and processes bounded."""

    try:
        process = _start_supervisor()
    except OSError:
        return PROCESS_UNAVAILABLE_EXIT
    assert process.stdin is not None
    assert process.stdout is not None
    assert process.stderr is not None
    stderr_thread = threading.Thread(
        target=_discard_adapter_stderr,
        args=(process.stderr,),
        daemon=True,
        name="hermes-fabric-stderr",
    )
    stderr_started = False
    exit_code = 0
    try:
        stderr_thread.start()
        stderr_started = True
        for request in sys.stdin.buffer:
            try:
                process.stdin.write(request)
                process.stdin.flush()
            except (BrokenPipeError, OSError):
                exit_code = process.poll() or PROCESS_UNAVAILABLE_EXIT
                break
            try:
                response = _read_bounded_response(process.stdout)
            except _ResponseLimitExceeded:
                sys.stderr.write(
                    "Hermes Fabric lifecycle response exceeded the 1 MiB limit\n"
                )
                sys.stderr.flush()
                exit_code = OUTPUT_LIMIT_EXIT
                break
            if not response:
                exit_code = process.poll() or PROCESS_UNAVAILABLE_EXIT
                break
            try:
                sys.stdout.buffer.write(response)
                sys.stdout.buffer.flush()
            except (BrokenPipeError, OSError):
                break
            if _request_operation(request) == "stop":
                break
    finally:
        _stop_supervisor(process)
        if stderr_started:
            stderr_thread.join(timeout=PROCESS_STOP_GRACE_SECONDS)
    return exit_code


def main() -> None:
    """Run the package-owned host selected by the Hermes descriptor."""

    raise SystemExit(run())


if __name__ == "__main__":
    main()
