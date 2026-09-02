# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Own the hard deadline and cleanup boundary around one Fabric run."""

from __future__ import annotations

import argparse
import math
import os
import signal
import subprocess
import sys
import time
from collections.abc import Sequence
from pathlib import Path

from nemo_fabric import FabricConfigError

from nemoclaw_fabric.config import (
    SUPERVISOR_CONFIG_SHA256_ENV,
    FabricConfigLoadError,
    load_fabric_config,
)
from nemoclaw_fabric.runner import (
    remove_process_artifacts,
    resolve_fabric_artifact_root,
)


EXIT_FAILURE = 1
EXIT_USAGE = 2
EXIT_TIMEOUT = 124
EXIT_UNAVAILABLE = 127


class SupervisorArgumentParser(argparse.ArgumentParser):
    """Reject invalid fixed options without echoing caller-controlled values."""

    def error(self, _message: str) -> None:
        raise ValueError("invalid bounded-run arguments")


def _positive_seconds(value: str) -> float:
    try:
        seconds = float(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError("expected seconds") from error
    if not math.isfinite(seconds) or seconds <= 0:
        raise argparse.ArgumentTypeError("expected positive finite seconds")
    return seconds


def _option_count(arguments: Sequence[str], option: str) -> int:
    return sum(argument == option or argument.startswith(f"{option}=") for argument in arguments)


def build_parser() -> argparse.ArgumentParser:
    """Build the fixed supervisor options; remaining arguments belong to `run`."""

    parser = SupervisorArgumentParser(
        prog="nemoclaw-fabric-run",
        description="Run one Fabric request with a hard deadline and parent-owned cleanup.",
    )
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--deadline-seconds", type=_positive_seconds, required=True)
    parser.add_argument("--kill-grace-seconds", type=_positive_seconds, required=True)
    return parser


def _signal_process_group(process: subprocess.Popen[bytes], selected_signal: int) -> None:
    try:
        os.killpg(process.pid, selected_signal)
    except OSError:
        try:
            process.send_signal(selected_signal)
        except OSError:
            pass


def _process_group_exists(process_group_id: int) -> bool:
    try:
        os.killpg(process_group_id, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def _wait_for_process_tree(
    process: subprocess.Popen[bytes],
    deadline: float,
) -> bool:
    """Wait until the worker is reaped and its process group is gone."""

    while time.monotonic() < deadline:
        worker_stopped = process.poll() is not None
        process_group_stopped = not _process_group_exists(process.pid)
        if worker_stopped and process_group_stopped:
            return True
        time.sleep(0.025)
    return process.poll() is not None and not _process_group_exists(process.pid)


def _stop_process(process: subprocess.Popen[bytes], grace_seconds: float) -> None:
    """Stop the worker's complete process group before artifact cleanup."""

    _signal_process_group(process, signal.SIGTERM)
    if _wait_for_process_tree(process, time.monotonic() + grace_seconds):
        return
    _signal_process_group(process, signal.SIGKILL)
    final_wait_seconds = max(0.25, min(grace_seconds, 2.0))
    if not _wait_for_process_tree(process, time.monotonic() + final_wait_seconds):
        raise RuntimeError("Fabric worker process group did not stop")


def _process_exit_code(return_code: int) -> int:
    return 128 + abs(return_code) if return_code < 0 else return_code


def run_supervised(arguments: Sequence[str]) -> int:
    """Run the worker and remove its artifacts even after a forced stop."""

    reserved = ("--config", "--deadline-seconds", "--kill-grace-seconds")
    if any(_option_count(arguments, option) != 1 for option in reserved):
        return EXIT_USAGE
    try:
        options, worker_arguments = build_parser().parse_known_args(list(arguments))
        loaded = load_fabric_config(options.config)
        artifact_root = resolve_fabric_artifact_root(loaded.config, loaded.base_dir)
    except (FabricConfigError, FabricConfigLoadError, OSError, RuntimeError, ValueError):
        return EXIT_USAGE

    command = [
        sys.executable,
        "-m",
        "nemoclaw_fabric",
        "run",
        "--config",
        str(loaded.path),
        *worker_arguments,
    ]
    worker_environment = os.environ.copy()
    worker_environment[SUPERVISOR_CONFIG_SHA256_ENV] = loaded.content_sha256
    received_signal: int | None = None
    previous_handlers: dict[int, object] = {}

    def remember_signal(signal_number: int, _frame: object) -> None:
        nonlocal received_signal
        if received_signal is None:
            received_signal = signal_number

    for signal_number in (signal.SIGINT, signal.SIGTERM):
        previous_handlers[signal_number] = signal.getsignal(signal_number)
        signal.signal(signal_number, remember_signal)

    exit_code = EXIT_FAILURE
    try:
        try:
            process = subprocess.Popen(
                command,
                env=worker_environment,
                start_new_session=True,
            )
        except OSError:
            return EXIT_UNAVAILABLE
        deadline = time.monotonic() + options.deadline_seconds
        while process.poll() is None and received_signal is None:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            try:
                process.wait(timeout=min(remaining, 0.1))
            except subprocess.TimeoutExpired:
                continue

        if process.poll() is not None:
            exit_code = _process_exit_code(process.returncode)
        else:
            exit_code = (
                128 + received_signal if received_signal is not None else EXIT_TIMEOUT
            )
    finally:
        if "process" in locals():
            try:
                _stop_process(process, options.kill_grace_seconds)
                remove_process_artifacts(artifact_root, process.pid)
            except (OSError, RuntimeError):
                print(
                    "nemoclaw-fabric-run: failed to remove private Fabric request artifacts",
                    file=sys.stderr,
                )
                exit_code = EXIT_FAILURE
        for signal_number, previous_handler in previous_handlers.items():
            signal.signal(signal_number, previous_handler)
    return exit_code


def main() -> None:
    """Run the installed supervisor command."""

    raise SystemExit(run_supervised(sys.argv[1:]))


if __name__ == "__main__":
    main()
