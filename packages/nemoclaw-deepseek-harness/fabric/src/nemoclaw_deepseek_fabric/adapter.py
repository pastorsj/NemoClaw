# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Translate Fabric's lifecycle into one bounded DeepSeek Harness SDK turn."""

from __future__ import annotations

import asyncio
import json
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


ADAPTER_ID = "nvidia.nemoclaw.deepseek-harness"
API_KEY_ENV = "DEEPSEEK_FABRIC_API_KEY"
MANAGED_PROVIDER = "openshell"
MANAGED_BASE_URL = "https://inference.local/v1"
PROCESS_MODULE = "nemoclaw_deepseek_fabric.process"
DSH_HOME = "/sandbox/.deepseek-harness"
PROCESS_STOP_GRACE_SECONDS = 2.0
PROCESS_STREAM_CAPTURE_LIMIT_BYTES = 1024 * 1024
PROCESS_STREAM_READ_BYTES = 64 * 1024


class _OutputCaptureLimitExceeded(Exception):
    """Mark subprocess output that cannot fit inside the adapter's bound."""


def _failed(code: str, message: str) -> AgentRunResult:
    """Return one normalized failure without forwarding SDK diagnostics."""

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
        "deepseek_model_required",
        "DeepSeek Harness requires a default model or exactly one configured model",
    )


def _managed_credential(model: AgentModelConfig) -> str:
    """Validate the managed route and resolve its runtime-only credential."""

    if model.provider != MANAGED_PROVIDER:
        raise lifecycle.LifecycleError(
            "deepseek_provider_unsupported",
            f"DeepSeek Harness requires the managed {MANAGED_PROVIDER} provider",
        )
    if model.base_url != MANAGED_BASE_URL:
        raise lifecycle.LifecycleError(
            "deepseek_base_url_unsupported",
            f"DeepSeek Harness requires the managed {MANAGED_BASE_URL} inference route",
        )
    if model.api_key_env != API_KEY_ENV:
        raise lifecycle.LifecycleError(
            "deepseek_credential_unsupported",
            f"DeepSeek Harness requires the managed {API_KEY_ENV} credential",
        )
    credential = os.environ.get(API_KEY_ENV)
    if not credential:
        raise lifecycle.LifecycleError(
            "deepseek_credential_unavailable",
            "DeepSeek Harness managed inference credential is unavailable",
        )
    return credential


async def _wait_for_process_exit(process: asyncio.subprocess.Process) -> None:
    """Publish the direct child's exit status before releasing ownership."""

    if process.returncode is None:
        await process.wait()


async def _stop_process_group(process: asyncio.subprocess.Process) -> None:
    """Stop the SDK worker and every tool process created for its turn."""

    process_group = process.pid
    try:
        os.killpg(process_group, signal.SIGTERM)
    except ProcessLookupError:
        await _wait_for_process_exit(process)
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
        except ProcessLookupError:
            await _wait_for_process_exit(process)
            return
        except PermissionError:
            if sys.platform != "darwin" or process.returncode is None:
                raise
            return
        await asyncio.sleep(0.025)

    try:
        os.killpg(process_group, signal.SIGKILL)
    except ProcessLookupError:
        await _wait_for_process_exit(process)
        return
    await _wait_for_process_exit(process)


async def _read_bounded_stream(stream: asyncio.StreamReader) -> bytes:
    """Read one child stream without retaining bytes beyond the limit."""

    captured = bytearray()
    while chunk := await stream.read(PROCESS_STREAM_READ_BYTES):
        if len(captured) + len(chunk) > PROCESS_STREAM_CAPTURE_LIMIT_BYTES:
            raise _OutputCaptureLimitExceeded
        captured.extend(chunk)
    return bytes(captured)


async def _write_process_input(stream: asyncio.StreamWriter, payload: bytes) -> None:
    """Send the private SDK request through stdin, never argv or a file."""

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
    """Exchange input while draining and bounding both output streams."""

    assert process.stdin is not None
    assert process.stdout is not None
    assert process.stderr is not None
    stdout_task = asyncio.create_task(_read_bounded_stream(process.stdout))
    stderr_task = asyncio.create_task(_read_bounded_stream(process.stderr))
    input_task = asyncio.create_task(_write_process_input(process.stdin, process_input))
    tasks = (stdout_task, stderr_task, input_task)
    try:
        completed, _pending = await asyncio.wait(
            tasks, return_when=asyncio.FIRST_EXCEPTION
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


async def _drain_stopped_process_pipes(process: asyncio.subprocess.Process) -> None:
    """Release pipe transports after cancellation has stopped their readers."""

    async def discard(stream: asyncio.StreamReader | None) -> None:
        if stream is None:
            return
        while await stream.read(PROCESS_STREAM_READ_BYTES):
            pass

    await asyncio.gather(discard(process.stdout), discard(process.stderr))
    await asyncio.sleep(0)


def _worker_environment() -> dict[str, str]:
    """Keep routing state while withholding credentials from inherited env."""

    environment = dict(os.environ)
    for name in (
        API_KEY_ENV,
        "DEEPSEEK_API_KEY",
        "NVIDIA_API_KEY",
        "OPENAI_API_KEY",
        "ANTHROPIC_API_KEY",
        "OPENROUTER_API_KEY",
        "DSH_SYSTEM_PROMPT",
    ):
        environment.pop(name, None)
    environment["DSH_TELEMETRY_MODE"] = "DISABLED"
    environment["DSH_TELEMETRY_DISABLED"] = "1"
    return environment


def _dsh_home() -> str:
    """Resolve the explicit SDK state root established by the package runtime."""

    state_root = Path(os.environ.get("DSH_HOME", DSH_HOME))
    if not state_root.is_absolute():
        raise lifecycle.LifecycleError(
            "deepseek_state_root_invalid",
            "DeepSeek Harness requires an absolute DSH_HOME",
        )
    return str(state_root)


class DeepSeekHarnessRuntime:
    """Own one Fabric runtime and one ephemeral SDK process per request."""

    def __init__(self) -> None:
        self._config: AgentConfig | None = None
        self._base_dir: Path | None = None
        self._model: AgentModelConfig | None = None
        self._process: asyncio.subprocess.Process | None = None

    async def start(self, payload: dict[str, Any]) -> None:
        """Validate the generated configuration before accepting requests."""

        if self._config is not None:
            raise lifecycle.LifecycleError(
                "deepseek_already_started",
                "DeepSeek Harness Fabric runtime is already started",
            )
        config = payload.get("config")
        base_dir = payload.get("base_dir")
        if not isinstance(config, AgentConfig) or not isinstance(base_dir, str):
            raise lifecycle.LifecycleError(
                "deepseek_invalid_start",
                "DeepSeek Harness received an invalid Fabric start payload",
            )
        model = _selected_model(config)
        _managed_credential(model)
        self._config = config
        self._base_dir = Path(base_dir)
        self._model = model

    def _workspace(self, context: RuntimeContext) -> Path:
        """Resolve Fabric's workspace without inventing another root."""

        assert self._base_dir is not None
        configured = context.environment.workspace
        workspace = Path(configured) if configured is not None else self._base_dir
        if not workspace.is_absolute():
            workspace = self._base_dir / workspace
        workspace = workspace.resolve()
        if not workspace.is_dir():
            raise lifecycle.LifecycleError(
                "deepseek_workspace_unavailable",
                "DeepSeek Harness Fabric workspace is unavailable",
            )
        return workspace

    def _process_request(self, prompt: str, workspace: Path) -> bytes:
        """Build the package-private SDK request carried only over stdin."""

        assert self._config is not None
        assert self._model is not None
        system = self._config.instructions and self._config.instructions.system
        payload = {
            "prompt": prompt,
            "model": self._model.model,
            "base_url": self._model.base_url,
            "api_key": _managed_credential(self._model),
            "workspace": str(workspace),
            "dsh_home": _dsh_home(),
            "system_prompt": system.content if system else None,
        }
        return (json.dumps(payload, separators=(",", ":")) + "\n").encode("utf-8")

    async def invoke(
        self, request: AgentRunRequest, context: RuntimeContext
    ) -> AgentRunResult:
        """Run one plain-text request and normalize its final response."""

        if self._config is None:
            raise lifecycle.LifecycleError(
                "deepseek_not_started",
                "DeepSeek Harness Fabric runtime is not started",
            )
        if self._process is not None:
            raise lifecycle.LifecycleError(
                "deepseek_invocation_active",
                "DeepSeek Harness already has an active invocation",
            )
        if not isinstance(request.input, str):
            return _failed(
                "deepseek_unsupported_input",
                "DeepSeek Harness accepts only plain-text input",
            )

        process_input = self._process_request(request.input, self._workspace(context))
        try:
            process = await asyncio.create_subprocess_exec(
                sys.executable,
                "-m",
                PROCESS_MODULE,
                "--parent-pid",
                str(os.getpid()),
                cwd=self._base_dir,
                env=_worker_environment(),
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                start_new_session=True,
            )
        except OSError:
            return _failed(
                "deepseek_process_unavailable",
                "DeepSeek Harness SDK worker could not be started",
            )

        self._process = process
        cleanup_complete = False
        stdout = b""
        try:
            stdout, _stderr = await _capture_bounded_output(process, process_input)
        except _OutputCaptureLimitExceeded:
            await asyncio.shield(_stop_process_group(process))
            await asyncio.shield(_drain_stopped_process_pipes(process))
            cleanup_complete = True
            return _failed(
                "deepseek_output_limit_exceeded",
                "DeepSeek Harness output exceeded the adapter capture limit",
            )
        except asyncio.CancelledError:
            await asyncio.shield(_stop_process_group(process))
            await asyncio.shield(_drain_stopped_process_pipes(process))
            cleanup_complete = True
            raise
        except BaseException:
            await asyncio.shield(_stop_process_group(process))
            await asyncio.shield(_drain_stopped_process_pipes(process))
            cleanup_complete = True
            raise
        else:
            await _stop_process_group(process)
            cleanup_complete = True
        finally:
            if cleanup_complete and self._process is process:
                self._process = None

        if process.returncode != 0:
            return _failed(
                "deepseek_process_failed",
                "DeepSeek Harness could not complete the request",
            )
        try:
            worker_result = json.loads(stdout.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            return _failed(
                "deepseek_protocol_failed",
                "DeepSeek Harness returned an invalid SDK response",
            )
        if (
            not isinstance(worker_result, dict)
            or worker_result.get("status") != "succeeded"
        ):
            return _failed(
                "deepseek_sdk_failed",
                "DeepSeek Harness SDK could not complete the request",
            )
        response = worker_result.get("response")
        if not isinstance(response, str) or not response.strip():
            return _failed(
                "deepseek_no_assistant_response",
                "DeepSeek Harness completed without a final assistant response",
            )
        return AgentRunResult(
            status=AgentRunStatus.SUCCEEDED,
            output={"response": response.strip()},
        )

    async def stop(self) -> None:
        """Release an active process and all runtime-owned references."""

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

    lifecycle.serve(DeepSeekHarnessRuntime, config_loader=AgentConfig.from_mapping)


if __name__ == "__main__":
    main()
