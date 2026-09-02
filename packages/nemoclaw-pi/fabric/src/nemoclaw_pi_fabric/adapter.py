# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Translate Fabric's lifecycle into Pi's stable headless CLI."""

from __future__ import annotations

import asyncio
import os
import signal
import sys
from pathlib import Path
from typing import Any

from nemo_fabric_adapter_contract.models import AgentConfig
from nemo_fabric_adapter_contract.models import AgentModelConfig
from nemo_fabric_adapter_contract.models import AgentRunError
from nemo_fabric_adapter_contract.models import AgentRunRequest
from nemo_fabric_adapter_contract.models import AgentRunResult
from nemo_fabric_adapter_contract.models import AgentRunStatus
from nemo_fabric_adapter_contract.models import RuntimeContext
from nemo_fabric_adapters.common import lifecycle


ADAPTER_ID = "nvidia.nemoclaw.pi"
PI_COMMAND = "pi"
MANAGED_PROVIDER = "openshell"
MANAGED_BASE_URL = "https://inference.local/v1"
PROCESS_STOP_GRACE_SECONDS = 2.0
PROCESS_STREAM_CAPTURE_LIMIT_BYTES = 1024 * 1024
PROCESS_STREAM_READ_BYTES = 64 * 1024


class _OutputCaptureLimitExceeded(Exception):
    """Mark subprocess output that cannot fit inside the adapter's capture bound."""


def _failed(code: str, message: str) -> AgentRunResult:
    """Return a normalized failure without forwarding subprocess diagnostics."""

    return AgentRunResult(
        status=AgentRunStatus.FAILED,
        output=None,
        error=AgentRunError(code=code, message=message, retryable=False),
    )


def _selected_model(config: AgentConfig) -> AgentModelConfig:
    """Select the default model, or the only model when it is unambiguous."""

    if model := config.models.get("default"):
        return model
    if len(config.models) == 1:
        return next(iter(config.models.values()))
    raise lifecycle.LifecycleError(
        "pi_model_required",
        "Pi requires a default model or exactly one configured model",
    )


def _validate_model(model: AgentModelConfig) -> None:
    """Reject configuration Pi's generated managed catalogue cannot preserve."""

    if model.provider != MANAGED_PROVIDER:
        raise lifecycle.LifecycleError(
            "pi_provider_unsupported",
            f"Pi requires the managed {MANAGED_PROVIDER} provider",
        )
    if model.base_url != MANAGED_BASE_URL:
        raise lifecycle.LifecycleError(
            "pi_base_url_unsupported",
            f"Pi requires the managed {MANAGED_BASE_URL} inference route",
        )
    if not model.api_key_env:
        raise lifecycle.LifecycleError(
            "pi_credential_required",
            "Pi requires a managed inference credential environment name",
        )
    if not os.environ.get(model.api_key_env):
        raise lifecycle.LifecycleError(
            "pi_credential_unavailable",
            "Pi's managed inference credential is unavailable",
        )


async def _stop_process_group(process: asyncio.subprocess.Process) -> None:
    """Stop Pi and every tool process in the session created for its turn."""

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

    # The wrapper can exit before a background Pi tool. Its PID remains the
    # process-group ID, so keep checking that group rather than assuming the
    # reaped leader proves every descendant stopped.
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


async def _write_process_input(stream: asyncio.StreamWriter, payload: bytes) -> None:
    """Send one literal request while output readers keep both pipes draining."""

    try:
        stream.write(payload)
        await stream.drain()
    except (BrokenPipeError, ConnectionResetError):
        pass
    finally:
        stream.close()


async def _capture_bounded_output(
    process: asyncio.subprocess.Process, process_input: bytes
) -> tuple[bytes, bytes]:
    """Exchange input while bounding both child output streams independently."""

    assert process.stdin is not None
    assert process.stdout is not None
    assert process.stderr is not None
    stdout_task = asyncio.create_task(_read_bounded_stream(process.stdout))
    stderr_task = asyncio.create_task(_read_bounded_stream(process.stderr))
    input_task = asyncio.create_task(_write_process_input(process.stdin, process_input))
    tasks = (stdout_task, stderr_task, input_task)
    try:
        completed, _pending = await asyncio.wait(
            tasks,
            return_when=asyncio.FIRST_EXCEPTION,
        )
        for task in completed:
            if error := task.exception():
                raise error
        return stdout_task.result(), stderr_task.result()
    finally:
        for task in tasks:
            if not task.done():
                task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)


class PiRuntime:
    """Own one Fabric runtime while running each request as an ephemeral Pi turn."""

    def __init__(self) -> None:
        self._config: AgentConfig | None = None
        self._base_dir: Path | None = None
        self._model: AgentModelConfig | None = None
        self._process: asyncio.subprocess.Process | None = None

    async def start(self, payload: dict[str, Any]) -> None:
        """Validate the package-generated configuration before Pi can start."""

        if self._config is not None:
            raise lifecycle.LifecycleError(
                "pi_already_started", "Pi's Fabric runtime is already started"
            )
        config = payload.get("config")
        base_dir = payload.get("base_dir")
        if not isinstance(config, AgentConfig) or not isinstance(base_dir, str):
            raise lifecycle.LifecycleError(
                "pi_invalid_start", "Pi received an invalid Fabric start payload"
            )
        model = _selected_model(config)
        _validate_model(model)
        self._config = config
        self._base_dir = Path(base_dir)
        self._model = model

    def _command(self) -> list[str]:
        """Project normalized Fabric options onto Pi's documented CLI."""

        assert self._config is not None and self._model is not None
        command = [
            PI_COMMAND,
            "--no-approve",
            "--print",
            "--no-session",
            "--provider",
            MANAGED_PROVIDER,
            "--model",
            self._model.model,
        ]
        if system := self._config.instructions and self._config.instructions.system:
            command.extend(["--system-prompt", system.content])
        if tools := self._config.tools:
            if tools.enabled == []:
                command.append("--no-tools")
            elif tools.enabled:
                command.extend(["--tools", ",".join(tools.enabled)])
            if tools.blocked:
                command.extend(["--exclude-tools", ",".join(tools.blocked)])
        if skills := self._config.skills:
            for path in skills.paths:
                command.extend(["--skill", str(path)])
        return command

    def _workspace(self, context: RuntimeContext) -> Path:
        """Resolve Fabric's workspace without inventing a second filesystem root."""

        assert self._base_dir is not None
        configured = context.environment.workspace
        workspace = Path(configured) if configured is not None else self._base_dir
        if not workspace.is_absolute():
            workspace = self._base_dir / workspace
        workspace = workspace.resolve()
        if not workspace.is_dir():
            raise lifecycle.LifecycleError(
                "pi_workspace_unavailable", "Pi's Fabric workspace is unavailable"
            )
        return workspace

    async def invoke(
        self, request: AgentRunRequest, context: RuntimeContext
    ) -> AgentRunResult:
        """Run one plain-text request and normalize Pi's final response."""

        if self._config is None:
            raise lifecycle.LifecycleError(
                "pi_not_started", "Pi's Fabric runtime is not started"
            )
        if self._process is not None:
            raise lifecycle.LifecycleError(
                "pi_invocation_active", "Pi already has an active invocation"
            )
        if not isinstance(request.input, str):
            return _failed("pi_unsupported_input", "Pi accepts only plain-text input")

        try:
            process = await asyncio.create_subprocess_exec(
                sys.executable,
                "-m",
                "nemoclaw_pi_fabric.process",
                "--parent-pid",
                str(os.getpid()),
                "--",
                *self._command(),
                cwd=self._workspace(context),
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                start_new_session=True,
            )
        except OSError:
            return _failed("pi_process_unavailable", "Pi could not be started")

        self._process = process
        output_limit_exceeded = False
        stdout = b""
        try:
            stdout, _stderr = await _capture_bounded_output(
                process, request.input.encode("utf-8")
            )
        except _OutputCaptureLimitExceeded:
            output_limit_exceeded = True
            await asyncio.shield(_stop_process_group(process))
        except asyncio.CancelledError:
            await asyncio.shield(_stop_process_group(process))
            raise
        except BaseException:
            # Reader and stdin-writer failures must not detach the process
            # from stop() before the wrapper has reaped every Pi tool.
            await asyncio.shield(_stop_process_group(process))
            raise
        else:
            # Pi may return after starting a background tool. Bound that tool to
            # this turn even though the wrapper process already exited cleanly.
            await _stop_process_group(process)
        finally:
            if self._process is process:
                self._process = None

        if output_limit_exceeded:
            return _failed(
                "pi_output_limit_exceeded",
                "Pi output exceeded the "
                f"{PROCESS_STREAM_CAPTURE_LIMIT_BYTES}-byte stream capture limit",
            )
        if process.returncode != 0:
            return _failed("pi_process_failed", "Pi could not complete the request")
        response = stdout.decode("utf-8", errors="replace").strip()
        if not response:
            return _failed(
                "pi_no_assistant_response",
                "Pi completed without a final assistant response",
            )
        return AgentRunResult(
            status=AgentRunStatus.SUCCEEDED,
            output={"response": response},
        )

    async def stop(self) -> None:
        """Release a running Pi process and clear runtime-owned configuration."""

        process = self._process
        if process is not None:
            await _stop_process_group(process)
            if self._process is process:
                self._process = None
        self._config = None
        self._base_dir = None
        self._model = None


def main() -> None:
    """Serve Fabric's persistent local-host lifecycle protocol."""

    lifecycle.serve(PiRuntime, config_loader=AgentConfig.from_mapping)


if __name__ == "__main__":
    main()
