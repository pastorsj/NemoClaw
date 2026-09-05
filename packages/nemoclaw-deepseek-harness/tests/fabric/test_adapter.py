# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Exercise the DeepSeek adapter directly and through the generic runner."""

from __future__ import annotations

import asyncio
import io
import json
import os
import shutil
import subprocess
import sys
import sysconfig
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

PACKAGE_ROOT = Path(__file__).resolve().parents[2]
FABRIC_SOURCE = PACKAGE_ROOT / "fabric" / "src"
sys.path.insert(0, str(FABRIC_SOURCE))

from nemo_fabric_adapter_contract.models import (
    AgentConfig,
    AgentRunRequest,
    AgentRunStatus,
    RuntimeContext,
)
from nemo_fabric_adapters.common.lifecycle import LifecycleError
from nemoclaw_deepseek_fabric import process as deepseek_process
from nemoclaw_deepseek_fabric.adapter import (
    ADAPTER_ID,
    DeepSeekHarnessRuntime,
)

CREDENTIAL_NAME = "DEEPSEEK_MANAGED_INFERENCE_ROUTE"
CREDENTIAL_VALUE = "nemoclaw-managed-inference"


FAKE_SDK_SOURCE = r"""# Test fixture loaded before the installed SDK.
import json
import os
from pathlib import Path
import subprocess
import sys
import time
from types import SimpleNamespace

class DeepSeekHarness:
    def __init__(self, **kwargs):
        self.kwargs = kwargs
        marker = os.environ.get("NEMOCLAW_FAKE_SDK_CONFIG")
        if marker:
            Path(marker).write_text(json.dumps({
                "profile": kwargs.get("profile"),
                "patches": kwargs.get("patches"),
                "provider": kwargs.get("provider"),
                "model": kwargs.get("model"),
                "base_url": kwargs.get("base_url"),
                "api_key_present": bool(kwargs.get("api_key")),
                "inherited_route_marker": "DEEPSEEK_MANAGED_INFERENCE_ROUTE" in os.environ,
                "inherited_provider_key": "DEEPSEEK_API_KEY" in os.environ,
                "inherited_python_path": "PYTHONPATH" in os.environ,
                "telemetry_mode": kwargs.get("env", {}).get("DSH_TELEMETRY_MODE"),
                "telemetry_disabled": kwargs.get("env", {}).get("DSH_TELEMETRY_DISABLED"),
                "system_prompt": kwargs.get("env", {}).get("DSH_SYSTEM_PROMPT"),
                "request_timeout_seconds": kwargs.get("request_timeout_seconds"),
            }), encoding="utf-8")

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return None

    def run(self, prompt, *, session_id):
        prompt_marker = os.environ.get("NEMOCLAW_FAKE_SDK_PROMPT")
        if prompt_marker:
            Path(prompt_marker).write_text(prompt, encoding="utf-8")
        mode = os.environ.get("NEMOCLAW_FAKE_SDK_MODE", "success")
        if mode == "failure":
            raise RuntimeError(os.environ.get("NEMOCLAW_FAKE_SDK_SECRET", "secret"))
        if mode in {"hang", "background"}:
            child = subprocess.Popen(
                [sys.executable, "-c", "import time; time.sleep(300)"],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                start_new_session=sys.platform.startswith("linux"),
            )
            pid_marker = os.environ.get("NEMOCLAW_FAKE_SDK_PIDS")
            if pid_marker:
                Path(pid_marker).write_text(json.dumps({
                    "worker": os.getpid(),
                    "worker_group": os.getpgrp(),
                    "child": child.pid,
                    "child_group": os.getpgid(child.pid),
                }), encoding="utf-8")
            if mode == "hang":
                while True:
                    time.sleep(60)
        response = "X" * (2 * 1024 * 1024) if mode == "oversized" else "deterministic DeepSeek response"
        return SimpleNamespace(final_response=response, finish_reason="completed")
"""


def _generic_runner() -> tuple[int, int, object]:
    from nemoclaw_fabric.command import EXIT_FAILURE, EXIT_SUCCESS, run_cli

    return EXIT_FAILURE, EXIT_SUCCESS, run_cli


def _agent_config(
    *,
    provider: str = "openshell",
    base_url: str = "https://inference.local/v1",
    api_key_env: str = CREDENTIAL_NAME,
) -> AgentConfig:
    return AgentConfig.from_mapping(
        {
            "models": {
                "default": {
                    "provider": provider,
                    "model": "nvidia/nemotron-3-super-120b-a12b",
                    "api_key_env": api_key_env,
                    "base_url": base_url,
                }
            },
            "instructions": {
                "system": {"content": "Use the managed workspace.", "mode": "replace"}
            },
        }
    )


def _runtime_context(workspace: Path, artifacts: Path) -> RuntimeContext:
    return RuntimeContext.from_mapping(
        {
            "runtime_id": "deepseek-runtime",
            "invocation_id": "deepseek-invocation",
            "request_id": "deepseek-request",
            "environment": {
                "environment_id": "deepseek-local",
                "provider": "local",
                "control_location": "in_env_control",
                "workspace": str(workspace),
                "artifacts": str(artifacts),
                "ownership": "caller_owned",
            },
            "artifacts": {"root": str(artifacts), "artifacts": []},
        }
    )


def _request(value: object = "Review the workspace") -> AgentRunRequest:
    return AgentRunRequest.from_mapping({"input": value, "context": {}})


def _process_is_active(process_id: int) -> bool:
    if sys.platform.startswith("linux"):
        try:
            suffix = (
                Path(f"/proc/{process_id}/stat")
                .read_text(encoding="ascii")
                .rsplit(")", 1)[1]
                .strip()
            )
        except (IndexError, OSError):
            return False
        return bool(suffix) and suffix.split(maxsplit=1)[0] != "Z"
    result = subprocess.run(
        ["ps", "-o", "stat=", "-p", str(process_id)],
        check=False,
        capture_output=True,
        text=True,
    )
    state = result.stdout.strip()
    return result.returncode == 0 and bool(state) and not state.startswith("Z")


def _wait_for_stopped(process_ids: list[int]) -> None:
    for _attempt in range(200):
        if all(not _process_is_active(process_id) for process_id in process_ids):
            return
        time.sleep(0.025)
    active = [
        process_id for process_id in process_ids if _process_is_active(process_id)
    ]
    raise AssertionError(f"DeepSeek fixture processes remain active: {active}")


class DeepSeekFixtureMixin:
    """Create a fake SDK while retaining the real adapter and supervisor."""

    def setUp(self) -> None:
        super().setUp()  # type: ignore[misc]
        self._temporary_directory = tempfile.TemporaryDirectory()
        self.addCleanup(self._temporary_directory.cleanup)
        self.base_dir = Path(self._temporary_directory.name)
        self.workspace = self.base_dir / "workspace"
        self.artifacts = self.base_dir / "artifacts"
        self.state_root = self.base_dir / "dsh-home"
        self.fake_root = self.base_dir / "fake-sdk"
        self.fake_package = self.fake_root / "deepseek_harness"
        for directory in (
            self.workspace,
            self.artifacts,
            self.state_root,
            self.fake_package,
        ):
            directory.mkdir(parents=True)
        (self.fake_package / "__init__.py").write_text(
            FAKE_SDK_SOURCE, encoding="utf-8"
        )
        # The production worker uses isolated Python. A temporary site hook in
        # uv's disposable test environment supplies the fake SDK without
        # weakening the subprocess command or relying on PYTHONPATH.
        self.fake_site_hook = (
            Path(sysconfig.get_path("purelib")) / "000_nemoclaw_fake_deepseek_sdk.pth"
        )
        self.fake_site_hook.write_text(
            f"import sys; sys.path.insert(0, {str(self.fake_root)!r})\n",
            encoding="utf-8",
        )
        self.addCleanup(self.fake_site_hook.unlink, missing_ok=True)
        self.config_marker = self.base_dir / "sdk-config.json"
        self.prompt_marker = self.base_dir / "sdk-prompt.txt"
        self.pid_marker = self.base_dir / "sdk-pids.json"
        self.environment = {
            CREDENTIAL_NAME: CREDENTIAL_VALUE,
            "DEEPSEEK_API_KEY": "ambient-provider-key-must-not-be-inherited",
            "DSH_HOME": str(self.state_root),
            "NEMOCLAW_FAKE_SDK_CONFIG": str(self.config_marker),
            "NEMOCLAW_FAKE_SDK_PROMPT": str(self.prompt_marker),
            "NEMOCLAW_FAKE_SDK_PIDS": str(self.pid_marker),
        }

    async def start_runtime(
        self, config: AgentConfig | None = None
    ) -> DeepSeekHarnessRuntime:
        runtime = DeepSeekHarnessRuntime()
        await runtime.start(
            {
                "agent_name": "deepseek-test",
                "base_dir": str(self.base_dir),
                "config": config or _agent_config(),
                "runtime_context": _runtime_context(self.workspace, self.artifacts),
            }
        )
        return runtime

    async def wait_for_pid_marker(self) -> list[int]:
        for _attempt in range(200):
            if self.pid_marker.exists():
                payload = json.loads(self.pid_marker.read_text(encoding="utf-8"))
                if sys.platform.startswith("linux"):
                    self.assertNotEqual(payload["worker_group"], payload["child_group"])
                return [payload["worker"], payload["child"]]
            await asyncio.sleep(0.025)
        self.fail("fake DeepSeek SDK did not record its process tree")  # type: ignore[attr-defined]


class DeepSeekRuntimeTests(DeepSeekFixtureMixin, unittest.IsolatedAsyncioTestCase):
    """Verify SDK projection, validation, redaction, and process ownership."""

    async def test_success_uses_only_sdk_minimal_and_private_stdin(self) -> None:
        spawn_arguments: tuple[object, ...] = ()
        real_spawn = asyncio.create_subprocess_exec

        async def capture_spawn(*args: object, **kwargs: object):
            nonlocal spawn_arguments
            spawn_arguments = args
            return await real_spawn(*args, **kwargs)

        secret_prompt = "private prompt that must not enter argv"
        with (
            patch.dict(os.environ, self.environment),
            patch.object(asyncio, "create_subprocess_exec", capture_spawn),
        ):
            runtime = await self.start_runtime()
            result = await runtime.invoke(
                _request(secret_prompt),
                _runtime_context(self.workspace, self.artifacts),
            )
            await runtime.stop()

        self.assertIs(result.status, AgentRunStatus.SUCCEEDED)
        self.assertEqual(result.output, {"response": "deterministic DeepSeek response"})
        self.assertNotIn(
            secret_prompt, " ".join(str(value) for value in spawn_arguments)
        )
        self.assertNotIn(
            CREDENTIAL_VALUE, " ".join(str(value) for value in spawn_arguments)
        )
        self.assertEqual(
            spawn_arguments[1:4], ("-I", "-m", deepseek_process.PROCESS_MODULE)
        )
        self.assertEqual(self.prompt_marker.read_text(encoding="utf-8"), secret_prompt)
        config = json.loads(self.config_marker.read_text(encoding="utf-8"))
        self.assertEqual(
            config,
            {
                "profile": "sdk-minimal",
                "patches": [],
                "provider": "deepseek-official",
                "model": "nvidia/nemotron-3-super-120b-a12b",
                "base_url": "https://inference.local/v1",
                "api_key_present": True,
                "inherited_route_marker": False,
                "inherited_provider_key": False,
                "inherited_python_path": False,
                "telemetry_mode": "DISABLED",
                "telemetry_disabled": "1",
                "system_prompt": "Use the managed workspace.",
                "request_timeout_seconds": 60,
            },
        )

    async def test_start_rejects_every_unmanaged_model_surface(self) -> None:
        with patch.dict(os.environ, self.environment):
            cases = (
                (_agent_config(provider="deepseek"), "managed openshell provider"),
                (
                    _agent_config(base_url="https://api.deepseek.com/v1"),
                    "inference.local",
                ),
                (_agent_config(api_key_env="OTHER_API_KEY"), CREDENTIAL_NAME),
            )
            for config, message in cases:
                with self.assertRaisesRegex(LifecycleError, message):
                    await self.start_runtime(config)

        environment = dict(self.environment)
        environment.pop(CREDENTIAL_NAME)
        with (
            patch.dict(os.environ, environment, clear=True),
            self.assertRaisesRegex(LifecycleError, "route marker is unavailable"),
        ):
            await self.start_runtime()

    async def test_rejects_non_text_without_starting_the_sdk(self) -> None:
        with patch.dict(os.environ, self.environment):
            runtime = await self.start_runtime()
            result = await runtime.invoke(
                _request({"prompt": "structured"}),
                _runtime_context(self.workspace, self.artifacts),
            )
            await runtime.stop()
        self.assertIs(result.status, AgentRunStatus.FAILED)
        self.assertEqual(result.error.code, "deepseek_unsupported_input")
        self.assertFalse(self.config_marker.exists())

    async def test_sdk_failure_redacts_prompt_provider_error_and_credential(
        self,
    ) -> None:
        secret = "nvapi-deepseek-redaction-sentinel"
        environment = {
            **self.environment,
            "NEMOCLAW_FAKE_SDK_MODE": "failure",
            "NEMOCLAW_FAKE_SDK_SECRET": secret,
        }
        with patch.dict(os.environ, environment):
            runtime = await self.start_runtime()
            result = await runtime.invoke(
                _request(secret), _runtime_context(self.workspace, self.artifacts)
            )
            await runtime.stop()
        serialized = repr(result)
        self.assertIs(result.status, AgentRunStatus.FAILED)
        self.assertEqual(result.error.code, "deepseek_sdk_failed")
        self.assertNotIn(secret, serialized)
        self.assertNotIn(CREDENTIAL_VALUE, serialized)

    async def test_cancellation_reaps_worker_and_detached_tool(self) -> None:
        environment = {**self.environment, "NEMOCLAW_FAKE_SDK_MODE": "hang"}
        with patch.dict(os.environ, environment):
            runtime = await self.start_runtime()
            task = asyncio.create_task(
                runtime.invoke(
                    _request(), _runtime_context(self.workspace, self.artifacts)
                )
            )
            process_ids = await self.wait_for_pid_marker()
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task
            await runtime.stop()
        _wait_for_stopped(process_ids)

    async def test_normal_completion_reaps_background_tool(self) -> None:
        environment = {**self.environment, "NEMOCLAW_FAKE_SDK_MODE": "background"}
        with patch.dict(os.environ, environment):
            runtime = await self.start_runtime()
            result = await runtime.invoke(
                _request(), _runtime_context(self.workspace, self.artifacts)
            )
            process_ids = await self.wait_for_pid_marker()
            await runtime.stop()
        self.assertIs(result.status, AgentRunStatus.SUCCEEDED)
        _wait_for_stopped(process_ids)

    async def test_oversized_sdk_output_is_bounded_and_cleaned_up(self) -> None:
        environment = {**self.environment, "NEMOCLAW_FAKE_SDK_MODE": "oversized"}
        with patch.dict(os.environ, environment):
            runtime = await self.start_runtime()
            result = await runtime.invoke(
                _request(), _runtime_context(self.workspace, self.artifacts)
            )
            await runtime.stop()
        self.assertIs(result.status, AgentRunStatus.FAILED)
        self.assertEqual(result.error.code, "deepseek_output_limit_exceeded")


class ProcessWorkerTests(unittest.TestCase):
    """Verify private protocol failures stay stable and credential-free."""

    def test_worker_rejects_invalid_private_request_without_diagnostics(self) -> None:
        secret = "private-malformed-value"
        output = io.StringIO()
        exit_code = deepseek_process._run_sdk_worker(io.StringIO(secret), output)
        self.assertEqual(exit_code, 0)
        result = json.loads(output.getvalue())
        self.assertEqual(result, {"status": "failed", "code": "deepseek_sdk_failed"})
        self.assertNotIn(secret, output.getvalue())

    def test_supervisor_rejects_arbitrary_commands(self) -> None:
        self.assertEqual(deepseek_process.run_supervisor(["--", "echo", "unsafe"]), 64)


class GenericRunnerTests(DeepSeekFixtureMixin, unittest.TestCase):
    """Run the package through the released generic Fabric lifecycle."""

    def setUp(self) -> None:
        super().setUp()
        self.descriptor = self.base_dir / "deepseek.fabric-adapter.json"
        shutil.copyfile(PACKAGE_ROOT / "fabric" / self.descriptor.name, self.descriptor)
        self.config_path = self.base_dir / "fabric.json"

    def write_config(self, *, timeout_seconds: float = 5) -> Path:
        payload = {
            "schema_version": "fabric.agent/v1alpha1",
            "metadata": {"name": "nemoclaw-deepseek-fixture"},
            "harness": {"adapter_id": ADAPTER_ID, "resolution": "preinstalled"},
            "discovery": {"local_paths": [str(self.descriptor)]},
            "runtime": {
                "input_schema": "text",
                "output_schema": "message",
                "artifacts": "./artifacts",
                "timeout_seconds": timeout_seconds,
            },
            "environment": {
                "provider": "local",
                "workspace": "./workspace",
                "artifacts": "./artifacts",
                "ownership": "caller_owned",
                "control_location": "in_env_control",
            },
            "models": {
                "default": {
                    "provider": "openshell",
                    "model": "nvidia/nemotron-3-super-120b-a12b",
                    "api_key_env": CREDENTIAL_NAME,
                    "base_url": "https://inference.local/v1",
                }
            },
            "instructions": {
                "system": {"content": "Use the managed workspace.", "mode": "replace"}
            },
        }
        self.config_path.write_text(json.dumps(payload), encoding="utf-8")
        return self.config_path

    def invoke_cli(self, arguments: list[str]) -> tuple[int, str, str]:
        _exit_failure, _exit_success, run_cli = _generic_runner()
        stdout = io.StringIO()
        stderr = io.StringIO()
        environment = {
            **self.environment,
            "VIRTUAL_ENV": str(Path(sys.executable).parent.parent),
        }
        with patch.dict(os.environ, environment):
            exit_code = run_cli(
                arguments,
                stdin=io.StringIO(),
                stdout=stdout,
                stderr=stderr,
            )
        return exit_code, stdout.getvalue(), stderr.getvalue()

    def test_doctor_and_run_use_the_released_generic_lifecycle(self) -> None:
        _exit_failure, exit_success, _run_cli = _generic_runner()
        config = self.write_config()
        doctor_exit, doctor_stdout, doctor_stderr = self.invoke_cli(
            ["doctor", "--config", str(config), "--json"]
        )
        run_exit, run_stdout, run_stderr = self.invoke_cli(
            ["run", "--config", str(config), "-m", "hello from Fabric", "--json"]
        )
        self.assertEqual(doctor_exit, exit_success, doctor_stdout + doctor_stderr)
        self.assertEqual(doctor_stderr, "")
        self.assertIn(json.loads(doctor_stdout)["status"], {"pass", "warn"})
        self.assertEqual(run_exit, exit_success, run_stdout + run_stderr)
        self.assertEqual(run_stderr, "")
        result = json.loads(run_stdout)
        self.assertEqual(result["status"], "succeeded")
        self.assertEqual(result["harness"], ADAPTER_ID)
        self.assertEqual(
            result["output"], {"response": "deterministic DeepSeek response"}
        )

    def test_runner_timeout_reaps_the_sdk_process_tree(self) -> None:
        exit_failure, _exit_success, _run_cli = _generic_runner()
        config = self.write_config(timeout_seconds=0.1)
        self.environment["NEMOCLAW_FAKE_SDK_MODE"] = "hang"
        exit_code, stdout, stderr = self.invoke_cli(
            ["run", "--config", str(config), "-m", "bounded request", "--json"]
        )
        self.assertEqual(exit_code, exit_failure, stdout + stderr)
        self.assertEqual(stderr, "")
        self.assertEqual(json.loads(stdout)["status"], "failed")
        self.assertTrue(self.pid_marker.exists())
        payload = json.loads(self.pid_marker.read_text(encoding="utf-8"))
        _wait_for_stopped([payload["worker"], payload["child"]])

    def test_runner_failure_does_not_return_sdk_or_prompt_secrets(self) -> None:
        exit_failure, _exit_success, _run_cli = _generic_runner()
        secret = "nvapi-generic-runner-secret"
        config = self.write_config()
        self.environment.update(
            {
                "NEMOCLAW_FAKE_SDK_MODE": "failure",
                "NEMOCLAW_FAKE_SDK_SECRET": secret,
            }
        )
        exit_code, stdout, stderr = self.invoke_cli(
            ["run", "--config", str(config), "-m", secret, "--json"]
        )
        self.assertEqual(exit_code, exit_failure, stdout + stderr)
        self.assertEqual(stderr, "")
        self.assertNotIn(secret, stdout)
        self.assertNotIn(CREDENTIAL_VALUE, stdout)
        self.assertEqual(json.loads(stdout)["error"]["code"], "deepseek_sdk_failed")


if __name__ == "__main__":
    unittest.main()
