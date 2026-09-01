# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Exercise the package-owned Pi adapter through direct and generic boundaries."""

from __future__ import annotations

import asyncio
import io
import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch


PI_ROOT = Path(__file__).resolve().parents[2]
FABRIC_SOURCE = PI_ROOT / "fabric" / "src"
sys.path.insert(0, str(FABRIC_SOURCE))

from nemo_fabric_adapter_contract.models import AgentConfig  # noqa: E402
from nemo_fabric_adapter_contract.models import AgentRunRequest  # noqa: E402
from nemo_fabric_adapter_contract.models import AgentRunStatus  # noqa: E402
from nemo_fabric_adapter_contract.models import RuntimeContext  # noqa: E402
from nemo_fabric_adapters.common.lifecycle import LifecycleError  # noqa: E402
from nemoclaw_fabric.command import EXIT_FAILURE  # noqa: E402
from nemoclaw_fabric.command import EXIT_SUCCESS  # noqa: E402
from nemoclaw_fabric.command import run_cli  # noqa: E402
from nemoclaw_pi_fabric.adapter import ADAPTER_ID  # noqa: E402
from nemoclaw_pi_fabric.adapter import PiRuntime  # noqa: E402


CREDENTIAL_NAME = "PI_NEMOCLAW_INFERENCE_API_KEY"
CREDENTIAL_VALUE = "nemoclaw-managed-inference"
FAKE_PI_SOURCE = r'''#!/usr/bin/env python3
import json
import os
from pathlib import Path
import subprocess
import sys
import time

mode = os.environ.get("NEMOCLAW_FAKE_PI_MODE", "success")
args_marker = os.environ.get("NEMOCLAW_FAKE_PI_ARGS")
if args_marker:
    Path(args_marker).write_text(json.dumps(sys.argv[1:]), encoding="utf-8")
input_marker = os.environ.get("NEMOCLAW_FAKE_PI_INPUT")
prompt = sys.stdin.read()
if input_marker:
    Path(input_marker).write_text(prompt, encoding="utf-8")

if mode == "success":
    print(os.environ.get("NEMOCLAW_FAKE_PI_RESPONSE", "deterministic Pi response"))
    raise SystemExit(0)
if mode == "empty":
    raise SystemExit(0)
if mode == "failure":
    secret = os.environ.get("NEMOCLAW_FAKE_PI_SECRET", "missing-secret")
    print(f"fake Pi failed with {secret}", file=sys.stderr)
    raise SystemExit(23)
if mode == "hang":
    child = subprocess.Popen(
        [sys.executable, "-c", "import time; time.sleep(300)"],
        start_new_session=sys.platform.startswith("linux"),
    )
    marker = os.environ.get("NEMOCLAW_FAKE_PI_PIDS")
    if marker:
        Path(marker).write_text(
            json.dumps({
                "parent": os.getpid(),
                "parent_group": os.getpgrp(),
                "child": child.pid,
                "child_group": os.getpgid(child.pid),
            }),
            encoding="utf-8",
        )
    while True:
        time.sleep(60)
if mode == "background":
    child = subprocess.Popen(
        [sys.executable, "-c", "import time; time.sleep(300)"],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=sys.platform.startswith("linux"),
    )
    marker = os.environ.get("NEMOCLAW_FAKE_PI_PIDS")
    if marker:
        Path(marker).write_text(
            json.dumps({
                "parent": os.getpid(),
                "parent_group": os.getpgrp(),
                "child": child.pid,
                "child_group": os.getpgid(child.pid),
            }),
            encoding="utf-8",
        )
    print("deterministic Pi response")
    raise SystemExit(0)
raise SystemExit(64)
'''


def _agent_config() -> AgentConfig:
    return AgentConfig.from_mapping(
        {
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
            "tools": {"enabled": ["read", "write"], "blocked": ["bash"]},
            "skills": {"paths": ["skills/review"]},
        }
    )


def _runtime_context(workspace: Path, artifacts: Path) -> RuntimeContext:
    return RuntimeContext.from_mapping(
        {
            "runtime_id": "pi-runtime",
            "invocation_id": "pi-invocation",
            "request_id": "pi-request",
            "environment": {
                "environment_id": "pi-local",
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
            suffix = Path(f"/proc/{process_id}/stat").read_text(
                encoding="ascii"
            ).rsplit(")", 1)[1].strip()
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
    active = [process_id for process_id in process_ids if _process_is_active(process_id)]
    raise AssertionError(f"Pi fixture processes remain active: {active}")


class PiFixtureMixin:
    """Create one fake Pi executable and normalized Fabric inputs."""

    def setUp(self) -> None:
        super().setUp()  # type: ignore[misc]
        self._temporary_directory = tempfile.TemporaryDirectory()
        self.addCleanup(self._temporary_directory.cleanup)
        self.base_dir = Path(self._temporary_directory.name)
        self.workspace = self.base_dir / "workspace"
        self.artifacts = self.base_dir / "artifacts"
        self.fake_bin = self.base_dir / "bin"
        self.workspace.mkdir()
        self.artifacts.mkdir()
        self.fake_bin.mkdir()
        self.fake_pi = self.fake_bin / "pi"
        self.fake_pi.write_text(FAKE_PI_SOURCE, encoding="utf-8")
        self.fake_pi.chmod(
            self.fake_pi.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH
        )
        self.args_marker = self.base_dir / "pi-args.json"
        self.input_marker = self.base_dir / "pi-input.txt"
        self.pid_marker = self.base_dir / "pi-pids.json"
        self.environment = {
            "PATH": f"{self.fake_bin}{os.pathsep}{os.environ.get('PATH', '')}",
            CREDENTIAL_NAME: CREDENTIAL_VALUE,
            "NEMOCLAW_FAKE_PI_ARGS": str(self.args_marker),
            "NEMOCLAW_FAKE_PI_INPUT": str(self.input_marker),
            "NEMOCLAW_FAKE_PI_PIDS": str(self.pid_marker),
        }

    async def start_runtime(self) -> PiRuntime:
        runtime = PiRuntime()
        await runtime.start(
            {
                "agent_name": "pi-test",
                "base_dir": str(self.base_dir),
                "config": _agent_config(),
                "runtime_context": _runtime_context(self.workspace, self.artifacts),
            }
        )
        return runtime

    async def wait_for_pid_marker(self) -> list[int]:
        for _attempt in range(200):
            if self.pid_marker.exists():
                payload = json.loads(self.pid_marker.read_text(encoding="utf-8"))
                if sys.platform.startswith("linux"):
                    self.assertEqual(payload["child_group"], payload["child"])
                    self.assertNotEqual(
                        payload["child_group"], payload["parent_group"]
                    )
                return [payload["parent"], payload["child"]]
            await asyncio.sleep(0.025)
        self.fail("fake Pi did not record its process group")  # type: ignore[attr-defined]


class PiRuntimeTests(PiFixtureMixin, unittest.IsolatedAsyncioTestCase):
    """Verify direct translation, failures, and subprocess ownership."""

    async def test_success_projects_configured_options_onto_pi(self) -> None:
        with patch.dict(os.environ, self.environment):
            runtime = await self.start_runtime()
            result = await runtime.invoke(
                _request(), _runtime_context(self.workspace, self.artifacts)
            )
            await runtime.stop()

        self.assertIs(result.status, AgentRunStatus.SUCCEEDED)
        self.assertEqual(result.output, {"response": "deterministic Pi response"})
        arguments = json.loads(self.args_marker.read_text(encoding="utf-8"))
        self.assertEqual(self.input_marker.read_text(encoding="utf-8"), "Review the workspace")
        self.assertNotIn("Review the workspace", arguments)
        self.assertIn("--no-approve", arguments)
        self.assertIn("--no-session", arguments)
        self.assertEqual(arguments[arguments.index("--provider") + 1], "openshell")
        self.assertEqual(
            arguments[arguments.index("--model") + 1],
            "nvidia/nemotron-3-super-120b-a12b",
        )
        self.assertEqual(
            arguments[arguments.index("--system-prompt") + 1],
            "Use the managed workspace.",
        )
        self.assertEqual(arguments[arguments.index("--tools") + 1], "read,write")
        self.assertEqual(arguments[arguments.index("--exclude-tools") + 1], "bash")
        self.assertEqual(arguments[arguments.index("--skill") + 1], "skills/review")

    async def test_option_and_file_shaped_requests_are_literal_standard_input(self) -> None:
        secret_file = self.workspace / "secret"
        secret_file.write_text("must-not-be-expanded", encoding="utf-8")
        for request_text in ("--version", "@workspace/secret"):
            with self.subTest(request_text=request_text):
                self.args_marker.unlink(missing_ok=True)
                self.input_marker.unlink(missing_ok=True)
                with patch.dict(os.environ, self.environment):
                    runtime = await self.start_runtime()
                    result = await runtime.invoke(
                        _request(request_text),
                        _runtime_context(self.workspace, self.artifacts),
                    )
                    await runtime.stop()

                self.assertIs(result.status, AgentRunStatus.SUCCEEDED)
                self.assertEqual(self.input_marker.read_text(encoding="utf-8"), request_text)
                arguments = json.loads(self.args_marker.read_text(encoding="utf-8"))
                self.assertNotIn(request_text, arguments)
                self.assertNotIn("must-not-be-expanded", json.dumps(result.to_mapping()))

    async def test_failure_discards_pi_diagnostics_and_credentials(self) -> None:
        secret = "nvapi-pi-adapter-redaction-sentinel"
        environment = {
            **self.environment,
            "NEMOCLAW_FAKE_PI_MODE": "failure",
            "NEMOCLAW_FAKE_PI_SECRET": secret,
        }
        with patch.dict(os.environ, environment):
            runtime = await self.start_runtime()
            result = await runtime.invoke(
                _request(), _runtime_context(self.workspace, self.artifacts)
            )
            await runtime.stop()

        self.assertIs(result.status, AgentRunStatus.FAILED)
        self.assertEqual(result.error.code, "pi_process_failed")
        self.assertNotIn(secret, json.dumps(result.to_mapping()))

    async def test_non_text_input_is_a_normalized_failure(self) -> None:
        with patch.dict(os.environ, self.environment):
            runtime = await self.start_runtime()
            result = await runtime.invoke(
                _request({"messages": []}),
                _runtime_context(self.workspace, self.artifacts),
            )
            await runtime.stop()

        self.assertIs(result.status, AgentRunStatus.FAILED)
        self.assertEqual(result.error.code, "pi_unsupported_input")
        self.assertFalse(self.args_marker.exists())

    async def test_timeout_cancels_pi_and_its_detached_tool(self) -> None:
        environment = {**self.environment, "NEMOCLAW_FAKE_PI_MODE": "hang"}
        with patch.dict(os.environ, environment):
            runtime = await self.start_runtime()
            task = asyncio.create_task(
                runtime.invoke(
                    _request(), _runtime_context(self.workspace, self.artifacts)
                )
            )
            process_ids = await self.wait_for_pid_marker()
            with self.assertRaises(TimeoutError):
                await asyncio.wait_for(task, timeout=0.05)
            await runtime.stop()

        _wait_for_stopped(process_ids)

    async def test_explicit_cancellation_cleans_up_before_it_returns(self) -> None:
        environment = {**self.environment, "NEMOCLAW_FAKE_PI_MODE": "hang"}
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

    async def test_success_cleans_up_a_detached_tool_after_pi_exits(self) -> None:
        environment = {**self.environment, "NEMOCLAW_FAKE_PI_MODE": "background"}
        with patch.dict(os.environ, environment):
            runtime = await self.start_runtime()
            result = await runtime.invoke(
                _request(), _runtime_context(self.workspace, self.artifacts)
            )
            process_ids = await self.wait_for_pid_marker()
            await runtime.stop()

        self.assertIs(result.status, AgentRunStatus.SUCCEEDED)
        self.assertEqual(result.output, {"response": "deterministic Pi response"})
        _wait_for_stopped(process_ids)

    @unittest.skipUnless(sys.platform.startswith("linux"), "Pi sandboxes run on Linux")
    async def test_adapter_host_loss_cleans_up_pi_and_its_detached_tool(self) -> None:
        wrapper_marker = self.base_dir / "wrapper-pid"
        host_source = "\n".join(
            [
                "import os, subprocess, sys, time",
                "from pathlib import Path",
                "wrapper = subprocess.Popen([",
                "    sys.executable, '-m', 'nemoclaw_pi_fabric.process',",
                "    '--parent-pid', str(os.getpid()), '--', 'pi',",
                "], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)",
                f"Path({str(wrapper_marker)!r}).write_text(str(wrapper.pid), encoding='ascii')",
                f"marker = Path({str(self.pid_marker)!r})",
                "deadline = time.monotonic() + 5",
                "while not marker.exists() and time.monotonic() < deadline:",
                "    time.sleep(0.025)",
                "os._exit(0)",
            ]
        )
        environment = {
            **os.environ,
            **self.environment,
            "NEMOCLAW_FAKE_PI_MODE": "hang",
            "PYTHONPATH": f"{FABRIC_SOURCE}{os.pathsep}{os.environ.get('PYTHONPATH', '')}",
        }
        host = subprocess.Popen([sys.executable, "-c", host_source], env=environment)
        self.assertEqual(host.wait(timeout=10), 0)
        self.assertTrue(wrapper_marker.exists())
        process_ids = await self.wait_for_pid_marker()
        process_ids.append(int(wrapper_marker.read_text(encoding="ascii")))

        _wait_for_stopped(process_ids)

    async def test_start_rejects_missing_managed_credential(self) -> None:
        environment = {**self.environment}
        environment.pop(CREDENTIAL_NAME)
        with patch.dict(os.environ, environment, clear=True):
            with self.assertRaisesRegex(
                LifecycleError, "managed inference credential is unavailable"
            ):
                await self.start_runtime()


class GenericRunnerTests(PiFixtureMixin, unittest.TestCase):
    """Run doctor and invoke through the real generic NemoClaw Fabric runner."""

    def setUp(self) -> None:
        super().setUp()
        self.descriptor = self.base_dir / "pi.fabric-adapter.json"
        shutil.copyfile(PI_ROOT / "fabric" / self.descriptor.name, self.descriptor)
        self.config_path = self.base_dir / "fabric.json"

    def write_config(self, *, timeout_seconds: float = 5) -> Path:
        payload = {
            "schema_version": "fabric.agent/v1alpha1",
            "metadata": {"name": "nemoclaw-pi-fixture"},
            "harness": {"adapter_id": ADAPTER_ID, "resolution": "preinstalled"},
            "discovery": {"local_paths": [self.descriptor.name]},
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
            },
            "models": {
                "default": {
                    "provider": "openshell",
                    "model": "nvidia/nemotron-3-super-120b-a12b",
                    "api_key_env": CREDENTIAL_NAME,
                    "base_url": "https://inference.local/v1",
                }
            },
        }
        self.config_path.write_text(json.dumps(payload), encoding="utf-8")
        return self.config_path

    def invoke_cli(self, arguments: list[str]) -> tuple[int, str, str]:
        stdout = io.StringIO()
        stderr = io.StringIO()
        virtual_env = str(Path(sys.executable).parent.parent)
        with patch.dict(
            os.environ,
            {**self.environment, "VIRTUAL_ENV": virtual_env},
        ):
            exit_code = run_cli(
                arguments,
                stdin=io.StringIO(),
                stdout=stdout,
                stderr=stderr,
            )
        return exit_code, stdout.getvalue(), stderr.getvalue()

    def test_doctor_and_run_use_the_real_released_fabric_lifecycle(self) -> None:
        config = self.write_config()
        doctor_exit, doctor_stdout, doctor_stderr = self.invoke_cli(
            ["doctor", "--config", str(config), "--json"]
        )
        run_exit, run_stdout, run_stderr = self.invoke_cli(
            ["run", "--config", str(config), "-m", "hello from Fabric", "--json"]
        )

        self.assertEqual(doctor_exit, EXIT_SUCCESS, doctor_stdout + doctor_stderr)
        self.assertEqual(doctor_stderr, "")
        self.assertIn(json.loads(doctor_stdout)["status"], {"pass", "warn"})
        self.assertEqual(run_exit, EXIT_SUCCESS, run_stdout + run_stderr)
        self.assertEqual(run_stderr, "")
        result = json.loads(run_stdout)
        self.assertEqual(result["status"], "succeeded")
        self.assertEqual(result["harness"], ADAPTER_ID)
        self.assertEqual(result["adapter_kind"], "python")
        self.assertEqual(result["output"], {"response": "deterministic Pi response"})

    def test_runner_failure_never_returns_pi_stderr_or_credential(self) -> None:
        secret = "nvapi-runner-redaction-sentinel"
        config = self.write_config()
        self.environment.update(
            {
                "NEMOCLAW_FAKE_PI_MODE": "failure",
                "NEMOCLAW_FAKE_PI_SECRET": secret,
            }
        )
        exit_code, stdout, stderr = self.invoke_cli(
            ["run", "--config", str(config), "-m", secret, "--json"]
        )

        self.assertEqual(exit_code, EXIT_FAILURE, stdout + stderr)
        self.assertEqual(stderr, "")
        self.assertNotIn(secret, stdout)
        result = json.loads(stdout)
        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["error"]["code"], "pi_process_failed")

    def test_runner_timeout_stops_pi_and_its_detached_tool(self) -> None:
        config = self.write_config(timeout_seconds=0.1)
        self.environment["NEMOCLAW_FAKE_PI_MODE"] = "hang"
        exit_code, stdout, stderr = self.invoke_cli(
            ["run", "--config", str(config), "-m", "bounded request", "--json"]
        )

        self.assertEqual(exit_code, EXIT_FAILURE, stdout + stderr)
        self.assertEqual(stderr, "")
        result = json.loads(stdout)
        self.assertEqual(result["status"], "failed")
        self.assertTrue(self.pid_marker.exists())
        payload = json.loads(self.pid_marker.read_text(encoding="utf-8"))
        if sys.platform.startswith("linux"):
            self.assertEqual(payload["child_group"], payload["child"])
            self.assertNotEqual(payload["child_group"], payload["parent_group"])
        _wait_for_stopped([payload["parent"], payload["child"]])


if __name__ == "__main__":
    unittest.main()
