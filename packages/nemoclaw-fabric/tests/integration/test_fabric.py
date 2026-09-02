# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Network-free integration tests against the released Fabric 0.2 SDK."""

from __future__ import annotations

import asyncio
import importlib.metadata
import io
import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from nemo_fabric import Fabric

from nemoclaw_fabric.command import EXIT_FAILURE
from nemoclaw_fabric.command import EXIT_SUCCESS
from nemoclaw_fabric.command import EXIT_USAGE
from nemoclaw_fabric.command import run_cli
from nemoclaw_fabric.config import load_fabric_config


PACKAGE_ROOT = Path(__file__).resolve().parents[2]
ECHO_FIXTURE = PACKAGE_ROOT / "tests" / "fixtures" / "echo"
FABRIC_RUN_SUPERVISOR = shutil.which("nemoclaw-fabric-run")


def process_exists(process_id: int) -> bool:
    """Return whether a process is still addressable by this user."""

    try:
        os.kill(process_id, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


class ReleasedFabricIntegrationTests(unittest.TestCase):
    """Verify real plan, doctor, start, invoke, stop, and failure behavior."""

    @classmethod
    def setUpClass(cls) -> None:
        expected_versions = {
            "nemo-fabric": "0.2.0",
            "nemo-fabric-runtime": "0.2.0",
            "nemo-fabric-adapter-contract": "0.2.0",
            "nemo-fabric-adapters-common": "0.2.0",
        }
        for distribution, expected in expected_versions.items():
            actual = importlib.metadata.version(distribution)
            if actual != expected:
                raise AssertionError(
                    f"released SDK integration requires {distribution}=={expected}; found {actual}"
                )

    def setUp(self) -> None:
        self._temporary_directory = tempfile.TemporaryDirectory()
        self.addCleanup(self._temporary_directory.cleanup)
        self.base_dir = Path(self._temporary_directory.name)
        shutil.copytree(ECHO_FIXTURE, self.base_dir, dirs_exist_ok=True)
        (self.base_dir / "workspace").mkdir()
        (self.base_dir / "artifacts").mkdir()
        self.config_path = self.base_dir / "fabric.json"
        self.event_marker = self.base_dir / "events.txt"
        self.pid_marker = self.base_dir / "adapter.pid"
        self._virtual_env = Path(sys.executable).parent.parent
        self._original_path = os.environ.get("PATH", "")
        self._test_path = f"{Path(sys.executable).parent}{os.pathsep}{self._original_path}"

    def write_config(
        self,
        mode: str = "success",
        *,
        delay_seconds: float = 0.25,
        secret_environment_name: str = "TEST_API_KEY",
        timeout_seconds: float = 5,
    ) -> Path:
        payload = {
            "schema_version": "fabric.agent/v1alpha1",
            "metadata": {"name": f"echo-{mode}"},
            "harness": {
                "adapter_id": "test.nemoclaw.echo",
                "resolution": "preinstalled",
                "settings": {
                    "mode": mode,
                    "delay_seconds": delay_seconds,
                    "event_marker": str(self.event_marker),
                    "pid_marker": str(self.pid_marker),
                    "secret_env": secret_environment_name,
                },
            },
            "discovery": {"local_paths": ["echo.fabric-adapter.json"]},
            "runtime": {
                "input_schema": "text",
                "output_schema": "text",
                "artifacts": "./artifacts",
                "timeout_seconds": timeout_seconds,
            },
            "environment": {
                "provider": "local",
                "workspace": "./workspace",
                "artifacts": "./artifacts",
            },
        }
        self.config_path.write_text(json.dumps(payload), encoding="utf-8")
        return self.config_path

    def invoke_cli(self, arguments: list[str]) -> tuple[int, str, str]:
        stdout = io.StringIO()
        stderr = io.StringIO()
        with patch.dict(
            os.environ,
            {"PATH": self._test_path, "VIRTUAL_ENV": str(self._virtual_env)},
        ):
            exit_code = run_cli(
                arguments,
                stdin=io.StringIO(),
                stdout=stdout,
                stderr=stderr,
            )
        return exit_code, stdout.getvalue(), stderr.getvalue()

    def read_events(self) -> list[str]:
        return self.event_marker.read_text(encoding="utf-8").splitlines()

    def assert_adapter_process_stopped(self) -> None:
        if not self.pid_marker.exists():
            return
        process_id = int(self.pid_marker.read_text(encoding="utf-8"))
        for _attempt in range(40):
            if not process_exists(process_id):
                return
            time.sleep(0.025)
        self.fail(f"adapter process {process_id} still exists")

    def wait_for_event(self, expected: str, timeout_seconds: float = 5) -> None:
        deadline = time.monotonic() + timeout_seconds
        while time.monotonic() < deadline:
            if self.event_marker.exists() and expected in self.read_events():
                return
            time.sleep(0.025)
        self.fail(f"adapter event {expected!r} was not written")

    def test_cli_doctor_and_run_use_the_released_sdk_lifecycle(self) -> None:
        config_path = self.write_config()

        doctor_exit, doctor_stdout, doctor_stderr = self.invoke_cli(
            ["doctor", "--config", str(config_path), "--json"]
        )
        run_exit, run_stdout, run_stderr = self.invoke_cli(
            ["run", "--config", str(config_path), "-m", "hello", "--json"]
        )

        self.assertEqual(doctor_exit, EXIT_SUCCESS, doctor_stderr)
        self.assertEqual(doctor_stderr, "")
        self.assertIn(json.loads(doctor_stdout)["status"], {"pass", "warn"})
        self.assertEqual(run_exit, EXIT_SUCCESS, run_stderr)
        self.assertEqual(run_stderr, "")
        result = json.loads(run_stdout)
        self.assertEqual(result["status"], "succeeded")
        self.assertEqual(result["harness"], "test.nemoclaw.echo")
        self.assertEqual(result["adapter_kind"], "python")
        self.assertEqual(result["metadata"]["adapter_runner"], "persistent_local_host")
        self.assertEqual(result["output"]["response"], "echo:hello")
        self.assertEqual(result["output"]["turn"], 1)
        self.assertEqual(self.read_events(), ["start", "invoke:1", "stop"])
        self.assert_adapter_process_stopped()

    def test_unknown_adapter_fails_doctor_and_run_without_starting_a_process(self) -> None:
        config_path = self.write_config()
        payload = json.loads(config_path.read_text(encoding="utf-8"))
        payload["harness"]["adapter_id"] = "test.nemoclaw.unknown"
        config_path.write_text(json.dumps(payload), encoding="utf-8")

        doctor_exit, doctor_stdout, doctor_stderr = self.invoke_cli(
            ["doctor", "--config", str(config_path), "--json"]
        )
        run_exit, run_stdout, run_stderr = self.invoke_cli(
            ["run", "--config", str(config_path), "-m", "hello", "--json"]
        )

        self.assertEqual(doctor_exit, EXIT_USAGE, doctor_stdout)
        self.assertEqual(doctor_stderr, "")
        self.assertNotIn("Traceback", doctor_stdout)
        doctor_result = json.loads(doctor_stdout)
        self.assertEqual(doctor_result["status"], "failed")
        self.assertTrue(doctor_result["error"]["stage"])
        self.assertTrue(doctor_result["error"]["code"])

        self.assertEqual(run_exit, EXIT_USAGE, run_stdout)
        self.assertEqual(run_stderr, "")
        self.assertNotIn("Traceback", run_stdout)
        run_result = json.loads(run_stdout)
        self.assertEqual(run_result["status"], "failed")
        self.assertEqual(run_result["error"], doctor_result["error"])
        self.assertFalse(self.event_marker.exists())
        self.assertFalse(self.pid_marker.exists())

    def test_released_sdk_runtime_retains_state_across_two_invocations(self) -> None:
        loaded = load_fabric_config(self.write_config())

        async def invoke_twice() -> tuple[object, object, str]:
            client = Fabric()
            async with await client.start_runtime(
                loaded.config,
                base_dir=loaded.base_dir,
            ) as runtime:
                first = await runtime.invoke(input="one")
                second = await runtime.invoke(input="two")
                runtime_id = runtime.handle.runtime_id
            return first, second, runtime_id

        with patch.dict(
            os.environ,
            {"PATH": self._test_path, "VIRTUAL_ENV": str(self._virtual_env)},
        ):
            first, second, runtime_id = asyncio.run(invoke_twice())

        self.assertEqual(first.status, "succeeded")
        self.assertEqual(second.status, "succeeded")
        self.assertEqual(first.output["response"], "echo:one")
        self.assertEqual(second.output["response"], "echo:two")
        self.assertEqual(first.output["turn"], 1)
        self.assertEqual(second.output["turn"], 2)
        self.assertEqual(first.output["runtime_id"], runtime_id)
        self.assertEqual(second.output["runtime_id"], runtime_id)
        self.assertEqual(self.read_events(), ["start", "invoke:1", "invoke:2", "stop"])
        self.assert_adapter_process_stopped()

    def test_failures_have_stable_exit_and_redacted_diagnostics(self) -> None:
        secret = "integration-secret-value"
        expected = {
            "fail": ("invoke", "echo_requested_failure", ["start", "invoke:1", "stop"]),
            "malformed": ("run", "fabric_error", ["start", "invoke:1", "stop"]),
            "crash": ("run", "fabric_error", ["start", "invoke:1"]),
            "start_error": ("run", "fabric_error", ["start", "stop"]),
            "stop_error": ("stop", "runtime_stop_failed", ["start", "invoke:1", "stop"]),
        }
        for mode, (stage, code, events) in expected.items():
            with self.subTest(mode=mode):
                self.event_marker.unlink(missing_ok=True)
                self.pid_marker.unlink(missing_ok=True)
                config_path = self.write_config(mode)
                with patch.dict(os.environ, {"TEST_API_KEY": secret}):
                    exit_code, stdout, stderr = self.invoke_cli(
                        ["run", "--config", str(config_path), "-m", "hello", "--json"]
                    )

                self.assertEqual(exit_code, EXIT_FAILURE, (mode, stdout, stderr))
                self.assertEqual(stderr, "")
                payload = json.loads(stdout)
                self.assertEqual(payload["status"], "failed")
                self.assertEqual(payload["error"]["stage"], stage)
                self.assertEqual(payload["error"]["code"], code)
                self.assertNotIn(secret, stdout)
                self.assertNotIn("hello", stdout)
                self.assertEqual(self.read_events(), events)
                self.assert_adapter_process_stopped()

    def test_runtime_timeout_has_bounded_failure_and_stops_adapter(self) -> None:
        config_path = self.write_config(
            "delay",
            delay_seconds=1,
            timeout_seconds=0.1,
        )

        started_at = time.monotonic()
        exit_code, stdout, stderr = self.invoke_cli(
            ["run", "--config", str(config_path), "-m", "timeout prompt", "--json"]
        )
        elapsed_seconds = time.monotonic() - started_at

        self.assertEqual(exit_code, EXIT_FAILURE, (stdout, stderr))
        self.assertEqual(stderr, "")
        self.assertLess(elapsed_seconds, 5)
        self.assertNotIn("Traceback", stdout)
        self.assertNotIn("timeout prompt", stdout)
        payload = json.loads(stdout)
        self.assertEqual(payload["status"], "failed")
        self.assertEqual(payload["error"]["stage"], "run")
        self.assertEqual(payload["error"]["code"], "fabric_error")
        self.assertEqual(self.read_events(), ["start", "invoke:1"])
        self.assert_adapter_process_stopped()

    @unittest.skipUnless(
        FABRIC_RUN_SUPERVISOR,
        "the installed Fabric run supervisor is required for the hard-deadline contract",
    )
    def test_supervisor_deadline_cleans_a_nonreturning_adapter_process(self) -> None:
        config_path = self.write_config("block", timeout_seconds=60)
        environment = os.environ.copy()
        environment["PATH"] = self._test_path
        environment["VIRTUAL_ENV"] = str(self._virtual_env)
        package_path = str(PACKAGE_ROOT / "src")
        existing_python_path = environment.get("PYTHONPATH")
        environment["PYTHONPATH"] = (
            f"{package_path}{os.pathsep}{existing_python_path}"
            if existing_python_path
            else package_path
        )
        started_at = time.monotonic()
        process = subprocess.Popen(
            [
                str(FABRIC_RUN_SUPERVISOR),
                "--deadline-seconds",
                "1",
                "--kill-grace-seconds",
                "0.5",
                "--config",
                str(config_path),
                "-m",
                "hard deadline",
                "--json",
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            env=environment,
        )
        try:
            self.wait_for_event("invoke:1")
            stdout, stderr = process.communicate(timeout=5)
        finally:
            if process.poll() is None:
                process.kill()
                stdout, stderr = process.communicate(timeout=5)
        elapsed_seconds = time.monotonic() - started_at

        self.assertEqual(process.returncode, 124, (stdout, stderr))
        self.assertLess(elapsed_seconds, 5)
        self.assertNotIn("hard deadline", f"{stdout}\n{stderr}")
        self.assertEqual(self.read_events(), ["start", "invoke:1"])
        self.assert_adapter_process_stopped()
        self.assertEqual(list((self.base_dir / "artifacts").iterdir()), [])

    @unittest.skipUnless(os.name == "posix", "process signals require POSIX")
    def test_signals_wait_for_adapter_cleanup_before_exit(self) -> None:
        for selected_signal in (signal.SIGINT, signal.SIGTERM):
            for output_arguments in ((), ("--json",)):
                with self.subTest(signal=selected_signal, arguments=output_arguments):
                    self.event_marker.unlink(missing_ok=True)
                    self.pid_marker.unlink(missing_ok=True)
                    config_path = self.write_config("delay", delay_seconds=0.75)
                    environment = os.environ.copy()
                    environment["PATH"] = self._test_path
                    environment["VIRTUAL_ENV"] = str(self._virtual_env)
                    package_path = str(PACKAGE_ROOT / "src")
                    existing_python_path = environment.get("PYTHONPATH")
                    environment["PYTHONPATH"] = (
                        f"{package_path}{os.pathsep}{existing_python_path}"
                        if existing_python_path
                        else package_path
                    )
                    process = subprocess.Popen(
                        [
                            sys.executable,
                            "-m",
                            "nemoclaw_fabric",
                            "run",
                            "--config",
                            str(config_path),
                            "-m",
                            "wait for cleanup",
                            *output_arguments,
                        ],
                        stdout=subprocess.PIPE,
                        stderr=subprocess.PIPE,
                        text=True,
                        env=environment,
                    )
                    try:
                        self.wait_for_event("invoke:1")
                        process.send_signal(selected_signal)
                        stdout, stderr = process.communicate(timeout=10)
                    finally:
                        if process.poll() is None:
                            process.kill()
                            stdout, stderr = process.communicate(timeout=5)

                    self.assertEqual(process.returncode, 128 + selected_signal)
                    self.assertNotIn("wait for cleanup", f"{stdout}\n{stderr}")
                    self.assertNotIn("Traceback", f"{stdout}\n{stderr}")
                    if output_arguments:
                        self.assertEqual(stderr, "")
                        payload = json.loads(stdout)
                        self.assertEqual(payload["status"], "failed")
                        self.assertEqual(payload["error"]["stage"], "signal")
                        self.assertEqual(payload["error"]["code"], "interrupted")
                    else:
                        self.assertEqual(stdout, "")
                        self.assertIn(f"interrupted by signal {selected_signal}", stderr)
                    self.assertEqual(self.read_events(), ["start", "invoke:1", "stop"])
                    self.assert_adapter_process_stopped()


if __name__ == "__main__":
    unittest.main()
