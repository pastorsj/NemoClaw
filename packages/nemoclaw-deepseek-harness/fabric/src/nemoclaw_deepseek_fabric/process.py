# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Supervise one synchronous SDK worker and every process it creates."""

from __future__ import annotations

import ctypes
import json
import os
import signal
import subprocess
import sys
import time
import uuid
from pathlib import Path
from typing import IO


PARENT_CHECK_SECONDS = 0.05
DESCENDANT_STOP_GRACE_SECONDS = 0.25
PR_SET_CHILD_SUBREAPER = 36
INVALID_USAGE_EXIT = 64
PARENT_LOST_EXIT = 125
PROCESS_UNAVAILABLE_EXIT = 127
MAX_WORKER_REQUEST_BYTES = 1024 * 1024
PROCESS_MODULE = "nemoclaw_deepseek_fabric.process"


def _expected_parent(values: list[str]) -> int:
    """Decode the fixed private supervisor invocation used by the adapter."""

    if len(values) != 2 or values[0] != "--parent-pid":
        raise ValueError("invalid DeepSeek Harness process invocation")
    try:
        parent_pid = int(values[1])
    except ValueError as error:
        raise ValueError("invalid DeepSeek Harness adapter parent") from error
    if parent_pid <= 1:
        raise ValueError("invalid DeepSeek Harness adapter parent")
    return parent_pid


def _enable_linux_child_subreaper() -> None:
    """Adopt SDK tool processes that outlive their immediate parent."""

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
                text = Path(f"/proc/{entry.name}/stat").read_text(encoding="ascii")
                closing = text.rfind(")")
                fields = text[closing + 2 :].split()
                if closing != -1 and len(fields) >= 2 and int(fields[1]) == os.getpid():
                    children.add(int(entry.name))
            except (FileNotFoundError, PermissionError, ValueError, OSError):
                continue
    return children


def _reap_exited_children() -> None:
    """Release every exited process adopted by the supervisor."""

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
    for process_id in process_ids:
        try:
            os.kill(process_id, sent_signal)
        except (ProcessLookupError, PermissionError):
            pass


def _stop_linux_descendants() -> None:
    """Terminate and reap detached SDK tools before the supervisor exits."""

    deadline = time.monotonic() + DESCENDANT_STOP_GRACE_SECONDS
    signaled: set[int] = set()
    while True:
        _reap_exited_children()
        process_ids = _direct_linux_children()
        if not process_ids:
            return
        new_process_ids = process_ids - signaled
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
    """Bound shutdown when the synchronous SDK worker does not return."""

    if child.poll() is not None:
        return
    child.terminate()
    try:
        child.wait(timeout=DESCENDANT_STOP_GRACE_SECONDS)
    except subprocess.TimeoutExpired:
        child.kill()
        child.wait()


def _read_worker_request(stream: IO[str]) -> dict[str, object]:
    """Read and validate the bounded package-private SDK request."""

    raw = stream.read(MAX_WORKER_REQUEST_BYTES + 1)
    if len(raw.encode("utf-8")) > MAX_WORKER_REQUEST_BYTES:
        raise ValueError("DeepSeek Harness SDK request is too large")
    value = json.loads(raw)
    required_strings = (
        "prompt",
        "model",
        "base_url",
        "api_key",
        "workspace",
        "dsh_home",
    )
    if not isinstance(value, dict) or any(
        not isinstance(value.get(name), str) or not value[name]
        for name in required_strings
    ):
        raise ValueError("DeepSeek Harness SDK request is invalid")
    system_prompt = value.get("system_prompt")
    if system_prompt is not None and not isinstance(system_prompt, str):
        raise ValueError("DeepSeek Harness system prompt is invalid")
    return value


def _run_sdk_worker(input_stream: IO[str], output_stream: IO[str]) -> int:
    """Invoke only the published SDK-minimal profile and normalize its result."""

    try:
        request = _read_worker_request(input_stream)
        workspace = Path(str(request["workspace"])).resolve()
        dsh_home = Path(str(request["dsh_home"]))
        if not workspace.is_dir() or not dsh_home.is_absolute():
            raise ValueError("DeepSeek Harness SDK paths are invalid")
        dsh_home.mkdir(parents=True, exist_ok=True, mode=0o700)
        dsh_home.chmod(0o700)

        from deepseek_harness import DeepSeekHarness

        sdk_environment = {
            "DSH_TELEMETRY_MODE": "DISABLED",
            "DSH_TELEMETRY_DISABLED": "1",
        }
        system_prompt = request.get("system_prompt")
        if isinstance(system_prompt, str) and system_prompt:
            sdk_environment["DSH_SYSTEM_PROMPT"] = system_prompt
        with DeepSeekHarness(
            profile="sdk-minimal",
            patches=(),
            dsh_home=str(dsh_home),
            cwd=str(workspace),
            runtime_cwd=str(workspace),
            provider="deepseek-official",
            model=str(request["model"]),
            base_url=str(request["base_url"]),
            api_key=str(request["api_key"]),
            env=sdk_environment,
            initialize_timeout_seconds=20,
            request_timeout_seconds=60,
            shutdown_timeout_seconds=1,
        ) as harness:
            result = harness.run(
                str(request["prompt"]),
                session_id=f"nemoclaw-{uuid.uuid4().hex}",
            )
        response = result.final_response
        if not isinstance(response, str) or not response.strip():
            payload = {"status": "failed", "code": "deepseek_no_assistant_response"}
        else:
            payload = {
                "status": "succeeded",
                "response": response,
                "finish_reason": result.finish_reason,
            }
    except Exception:
        # SDK diagnostics can contain prompts, credentials, or provider output.
        # The adapter owns stable operator-facing errors, so disclose none here.
        payload = {"status": "failed", "code": "deepseek_sdk_failed"}
    output_stream.write(json.dumps(payload, separators=(",", ":")) + "\n")
    output_stream.flush()
    return 0


def run_supervisor(values: list[str]) -> int:
    """Run one worker and stop every descendant before returning."""

    try:
        expected_parent = _expected_parent(values)
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
        child = subprocess.Popen([sys.executable, "-m", PROCESS_MODULE, "--worker"])
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
    return int(return_code)


def main() -> None:
    """Select the private worker or its parent-lifetime supervisor."""

    if sys.argv[1:] == ["--worker"]:
        raise SystemExit(_run_sdk_worker(sys.stdin, sys.stdout))
    raise SystemExit(run_supervisor(sys.argv[1:]))


if __name__ == "__main__":
    main()
