# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Translate Fabric's lifecycle into OpenClaw's gateway-backed agent command."""

from __future__ import annotations

import asyncio
import json
import os
import signal
import stat
import sys
import tempfile
import uuid
from pathlib import Path
from typing import Any

from nemo_fabric_adapter_contract.models import AgentConfig
from nemo_fabric_adapter_contract.models import AgentRunError
from nemo_fabric_adapter_contract.models import AgentRunRequest
from nemo_fabric_adapter_contract.models import AgentRunResult
from nemo_fabric_adapter_contract.models import AgentRunStatus
from nemo_fabric_adapter_contract.models import RuntimeContext
from nemo_fabric_adapters.common import lifecycle


ADAPTER_ID = "nvidia.nemoclaw.openclaw"
OPENCLAW_COMMAND = "openclaw"
OPENCLAW_AGENT_ID = "main"
OPENCLAW_TIMEOUT_SECONDS = 80
PROCESS_STOP_GRACE_SECONDS = 2.0
PROCESS_STREAM_CAPTURE_LIMIT_BYTES = 1024 * 1024
PROCESS_STREAM_READ_BYTES = 64 * 1024
SESSION_PREFIX = "nemoclaw-fabric-"


class _OutputCaptureLimitExceeded(Exception):
    """Mark subprocess output that cannot fit inside the adapter's capture bound."""


def _failed(code: str, message: str) -> AgentRunResult:
    """Return a normalized failure without forwarding subprocess diagnostics."""

    return AgentRunResult(
        status=AgentRunStatus.FAILED,
        output=None,
        error=AgentRunError(code=code, message=message, retryable=False),
    )


def _normalized(value: object) -> str:
    """Normalize one OpenClaw completion marker."""

    return str(value or "").strip().lower().replace("_", "-")


def _completed_response(stdout: bytes) -> str | None:
    """Extract text only from OpenClaw's completed gateway response envelope."""

    try:
        document = json.loads(stdout.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None
    if not isinstance(document, dict):
        return None
    if (
        "event" in document
        or not isinstance(document.get("runId"), str)
        or not document["runId"].strip()
        or document.get("status") != "ok"
        or document.get("summary") != "completed"
    ):
        return None

    result = document.get("result")
    if not isinstance(result, dict):
        return None
    payloads = result.get("payloads")
    metadata = result.get("meta")
    if not isinstance(payloads, list) or not isinstance(metadata, dict):
        return None

    incomplete = (
        metadata.get("aborted") is True
        or metadata.get("error") is not None
        or metadata.get("replayInvalid") is True
        or _normalized(metadata.get("livenessState")) == "abandoned"
        or _normalized(metadata.get("stopReason")) in {"error", "timeout", "aborted"}
        or (
            isinstance(metadata.get("timeoutPhase"), str)
            and bool(metadata["timeoutPhase"].strip())
        )
    )
    if incomplete:
        return None

    parts: list[str] = []
    for payload in payloads:
        if not isinstance(payload, dict):
            return None
        if payload.get("isError") is True:
            return None
        text = payload.get("text")
        if text is None:
            continue
        if not isinstance(text, str):
            return None
        if cleaned := text.strip():
            parts.append(cleaned)
    return "\n".join(parts) or None


def _write_prompt(workspace: Path, prompt: str) -> Path:
    """Write one private prompt file for OpenClaw's literal file input."""

    descriptor, raw_path = tempfile.mkstemp(
        prefix=".nemoclaw-openclaw-prompt-",
        suffix=".txt",
        dir=workspace,
    )
    path = Path(raw_path)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="") as stream:
            stream.write(prompt)
        path.chmod(stat.S_IRUSR | stat.S_IWUSR)
    except BaseException:
        path.unlink(missing_ok=True)
        raise
    return path


async def _stop_process_group(process: asyncio.subprocess.Process) -> None:
    """Stop the OpenClaw CLI and every process created for its turn."""

    process_group = process.pid
    try:
        os.killpg(process_group, signal.SIGTERM)
    except (ProcessLookupError, PermissionError):
        return

    deadline = asyncio.get_running_loop().time() + PROCESS_STOP_GRACE_SECONDS
    if process.returncode is None:
        try:
            await asyncio.wait_for(process.wait(), PROCESS_STOP_GRACE_SECONDS)
        except TimeoutError:
            pass

    while asyncio.get_running_loop().time() < deadline:
        try:
            os.killpg(process_group, 0)
        except (ProcessLookupError, PermissionError):
            return
        await asyncio.sleep(0.025)

    try:
        os.killpg(process_group, signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        return
    if process.returncode is None:
        await process.wait()


async def _read_bounded_stream(stream: asyncio.StreamReader) -> bytes:
    """Read one child stream without retaining bytes beyond its capture limit."""

    captured = bytearray()
    while chunk := await stream.read(PROCESS_STREAM_READ_BYTES):
        if len(captured) + len(chunk) > PROCESS_STREAM_CAPTURE_LIMIT_BYTES:
            raise _OutputCaptureLimitExceeded
        captured.extend(chunk)
    return bytes(captured)


async def _capture_bounded_output(
    process: asyncio.subprocess.Process,
) -> tuple[bytes, bytes]:
    """Capture both child streams and cancel both readers when either one fails."""

    assert process.stdout is not None
    assert process.stderr is not None
    stdout_task = asyncio.create_task(_read_bounded_stream(process.stdout))
    stderr_task = asyncio.create_task(_read_bounded_stream(process.stderr))
    tasks = (stdout_task, stderr_task)
    try:
        completed, _pending = await asyncio.wait(
            tasks,
            return_when=asyncio.FIRST_EXCEPTION,
        )
        for task in completed:
            if error := task.exception():
                raise error
        stdout, stderr = await asyncio.gather(*tasks)
        return stdout, stderr
    finally:
        for task in tasks:
            if not task.done():
                task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)


class OpenClawRuntime:
    """Own one Fabric runtime and run each request as an isolated OpenClaw turn."""

    def __init__(self) -> None:
        self._config: AgentConfig | None = None
        self._base_dir: Path | None = None
        self._process: asyncio.subprocess.Process | None = None

    async def start(self, payload: dict[str, Any]) -> None:
        """Validate the package-generated configuration before OpenClaw can start."""

        if self._config is not None:
            raise lifecycle.LifecycleError(
                "openclaw_already_started",
                "OpenClaw's Fabric runtime is already started",
            )
        config = payload.get("config")
        base_dir = payload.get("base_dir")
        if not isinstance(config, AgentConfig) or not isinstance(base_dir, str):
            raise lifecycle.LifecycleError(
                "openclaw_invalid_start",
                "OpenClaw received an invalid Fabric start payload",
            )
        self._config = config
        self._base_dir = Path(base_dir)

    def _workspace(self, context: RuntimeContext) -> Path:
        """Resolve Fabric's workspace without adding a second filesystem root."""

        assert self._base_dir is not None
        configured = context.environment.workspace
        workspace = Path(configured) if configured is not None else self._base_dir
        if not workspace.is_absolute():
            workspace = self._base_dir / workspace
        workspace = workspace.resolve()
        if not workspace.is_dir():
            raise lifecycle.LifecycleError(
                "openclaw_workspace_unavailable",
                "OpenClaw's Fabric workspace is unavailable",
            )
        return workspace

    def _command(self, prompt_path: Path) -> list[str]:
        """Build OpenClaw's bounded gateway command for one Fabric request."""

        return [
            OPENCLAW_COMMAND,
            "agent",
            "--agent",
            OPENCLAW_AGENT_ID,
            "--json",
            "--thinking",
            "off",
            "--session-id",
            f"{SESSION_PREFIX}{uuid.uuid4().hex}",
            "--timeout",
            str(OPENCLAW_TIMEOUT_SECONDS),
            "--message-file",
            str(prompt_path),
        ]

    async def invoke(
        self, request: AgentRunRequest, context: RuntimeContext
    ) -> AgentRunResult:
        """Run one plain-text request and return its completed assistant response."""

        if self._config is None:
            raise lifecycle.LifecycleError(
                "openclaw_not_started",
                "OpenClaw's Fabric runtime is not started",
            )
        if self._process is not None:
            raise lifecycle.LifecycleError(
                "openclaw_invocation_active",
                "OpenClaw already has an active invocation",
            )
        if not isinstance(request.input, str):
            return _failed(
                "openclaw_unsupported_input",
                "OpenClaw accepts only plain-text input",
            )
        if not request.input.strip():
            return _failed("openclaw_empty_input", "OpenClaw requires a non-empty request")

        workspace = self._workspace(context)
        try:
            prompt_path = _write_prompt(workspace, request.input)
        except OSError:
            return _failed(
                "openclaw_prompt_unavailable",
                "OpenClaw's private prompt file could not be created",
            )

        try:
            process = await asyncio.create_subprocess_exec(
                sys.executable,
                "-m",
                "nemoclaw_openclaw_fabric.process",
                "--parent-pid",
                str(os.getpid()),
                "--cleanup-path",
                str(prompt_path),
                "--",
                *self._command(prompt_path),
                cwd=workspace,
                stdin=asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                start_new_session=True,
            )
        except OSError:
            prompt_path.unlink(missing_ok=True)
            return _failed("openclaw_process_unavailable", "OpenClaw could not be started")
        except BaseException:
            # Cancellation can arrive while the subprocess transport is still
            # being created, before a process exists for the cleanup path below.
            prompt_path.unlink(missing_ok=True)
            raise

        self._process = process
        output_limit_exceeded = False
        stdout = b""
        try:
            stdout, _stderr = await _capture_bounded_output(process)
        except _OutputCaptureLimitExceeded:
            output_limit_exceeded = True
            await asyncio.shield(_stop_process_group(process))
        except asyncio.CancelledError:
            await asyncio.shield(_stop_process_group(process))
            raise
        except BaseException:
            # Capture failures must not detach the process from stop() before
            # the wrapper has reaped the complete OpenClaw process tree.
            await asyncio.shield(_stop_process_group(process))
            raise
        else:
            await _stop_process_group(process)
        finally:
            prompt_path.unlink(missing_ok=True)
            if self._process is process:
                self._process = None

        if output_limit_exceeded:
            return _failed(
                "openclaw_output_limit_exceeded",
                "OpenClaw output exceeded the "
                f"{PROCESS_STREAM_CAPTURE_LIMIT_BYTES}-byte stream capture limit",
            )
        if process.returncode != 0:
            return _failed(
                "openclaw_process_failed",
                "OpenClaw could not complete the request",
            )
        response = _completed_response(stdout)
        if response is None:
            return _failed(
                "openclaw_response_invalid",
                "OpenClaw did not return a completed assistant response",
            )
        return AgentRunResult(
            status=AgentRunStatus.SUCCEEDED,
            output={"response": response},
        )

    async def stop(self) -> None:
        """Release a running OpenClaw process and clear runtime-owned state."""

        process = self._process
        if process is not None:
            await _stop_process_group(process)
            if self._process is process:
                self._process = None
        self._config = None
        self._base_dir = None


def main() -> None:
    """Serve Fabric's persistent local-host lifecycle protocol."""

    lifecycle.serve(OpenClawRuntime, config_loader=AgentConfig.from_mapping)


if __name__ == "__main__":
    main()
