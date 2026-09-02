# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Verify NemoClaw's Hermes projection against the released Fabric packages."""

from __future__ import annotations

import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from importlib.metadata import distribution
from importlib.metadata import version
from pathlib import Path
from unittest.mock import patch

from nemo_fabric import FabricConfig
from nemo_fabric_adapter_contract.models import AgentConfig
from nemo_fabric_adapters.hermes import adapter
from nemo_fabric_adapters.hermes import configuration
from nemoclaw_hermes_fabric import adapter as proxy_adapter
from nemoclaw_hermes_fabric.adapter import PROCESS_RESPONSE_LIMIT_BYTES


MANAGED_CONFIG = {
    "schema_version": "fabric.agent/v1alpha1",
    "metadata": {
        "name": "nemoclaw-hermes",
        "description": "NemoClaw-managed Hermes headless runtime",
    },
    "harness": {
        "adapter_id": "nvidia.nemoclaw.hermes",
        "resolution": "preinstalled",
    },
    "runtime": {
        "input_schema": "chat",
        "output_schema": "message",
        "artifacts": "/sandbox/.hermes/fabric-artifacts",
        "timeout_seconds": 90,
    },
    "environment": {
        "provider": "local",
        "workspace": "/sandbox",
        "artifacts": "/sandbox/.hermes/fabric-artifacts",
        "ownership": "caller_owned",
        "control_location": "in_env_control",
    },
    "models": {
        "default": {
            "provider": "custom",
            "model": "nvidia/nemotron-3-super-120b-a12b",
            "api_key_env": "HERMES_FABRIC_API_KEY",
            "base_url": "https://inference.local/v1",
        }
    },
}


FAKE_HERMES_AGENT_SOURCE = r"""
import json
import os
from pathlib import Path
import subprocess
import sys
import time


class AIAgent:
    def __init__(self, session_id=None, **_kwargs):
        self.session_id = session_id or "hermes-fixture-session"

    def run_conversation(
        self,
        user_message,
        system_message=None,
        conversation_history=None,
        task_id=None,
        **_kwargs,
    ):
        mode = os.environ.get("NEMOCLAW_FAKE_HERMES_MODE", "success")
        invocation = {"message": user_message, "pid": os.getpid()}
        marker = os.environ.get("NEMOCLAW_FAKE_HERMES_INVOCATION")
        if mode == "failure":
            secret = os.environ.get("HERMES_FABRIC_API_KEY", "missing-secret")
            raise RuntimeError(f"deterministic Hermes failure contained {secret}")
        if mode == "hang":
            child = subprocess.Popen(
                [sys.executable, "-c", "import time; time.sleep(300)"],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                start_new_session=True,
            )
            invocation["child_pid"] = child.pid
            if marker:
                Path(marker).write_text(json.dumps(invocation), encoding="utf-8")
            while True:
                time.sleep(60)
        if mode == "oversized_output":
            secret = os.environ.get("HERMES_FABRIC_API_KEY", "missing-secret")
            output_bytes = int(os.environ["NEMOCLAW_FAKE_HERMES_OUTPUT_BYTES"])
            child = subprocess.Popen(
                [sys.executable, "-c", "import time; time.sleep(300)"],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                start_new_session=True,
            )
            invocation["child_pid"] = child.pid
            print(secret + ("x" * output_bytes))
        if marker:
            Path(marker).write_text(json.dumps(invocation), encoding="utf-8")
        return {
            "response": "deterministic Hermes response",
            "completed": True,
            "messages": [{"role": "assistant", "content": "deterministic Hermes response"}],
            "api_calls": 1,
        }

    def close(self):
        marker = os.environ.get("NEMOCLAW_FAKE_HERMES_CLOSED")
        if marker:
            Path(marker).write_text("closed\n", encoding="utf-8")
"""


def _generic_runner() -> tuple[int, int, object]:
    """Load the generic runner only in the composed test lane."""

    from nemoclaw_fabric.command import EXIT_FAILURE
    from nemoclaw_fabric.command import EXIT_SUCCESS
    from nemoclaw_fabric.command import run_cli

    return EXIT_FAILURE, EXIT_SUCCESS, run_cli


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


def _wait_for_stopped(process_id: int) -> None:
    for _attempt in range(200):
        if not _process_is_active(process_id):
            return
        time.sleep(0.025)
    raise AssertionError(f"Hermes Fabric host process remains active: {process_id}")


class ReleasedHermesAdapterTests(unittest.TestCase):
    """Keep the package projection aligned with the pinned adapter contract."""

    def test_pinned_release_exposes_the_expected_adapter(self) -> None:
        self.assertEqual(version("nemo-fabric"), "0.2.0")
        self.assertEqual(version("nemo-fabric-adapters-hermes"), "0.2.0")
        self.assertEqual(version("nemoclaw-hermes-fabric"), "0.1.0")

        package = distribution("nemo-fabric-adapters-hermes")
        descriptor_files = [
            file
            for file in package.files or ()
            if str(file).endswith("hermes/hermes.fabric-adapter.json")
        ]
        self.assertEqual(len(descriptor_files), 1)
        descriptor = json.loads(
            package.locate_file(descriptor_files[0]).read_text(encoding="utf-8")
        )
        self.assertEqual(descriptor["adapter_id"], "nvidia.fabric.hermes")
        self.assertEqual(
            descriptor["runner"]["module"], "nemo_fabric_adapters.hermes.adapter"
        )
        self.assertTrue(callable(adapter.main))

        wrapper_path = (
            Path(__file__).resolve().parents[2]
            / "fabric"
            / "hermes.fabric-adapter.json"
        )
        wrapper = json.loads(wrapper_path.read_text(encoding="utf-8"))
        expected_wrapper = dict(descriptor)
        expected_wrapper["adapter_id"] = "nvidia.nemoclaw.hermes"
        expected_wrapper["runner"] = {"module": "nemoclaw_hermes_fabric.adapter"}
        wrapper.pop("$comment", None)
        self.assertEqual(wrapper, expected_wrapper)

    def test_managed_config_matches_fabric_and_hermes_models(self) -> None:
        fabric_config = FabricConfig.from_mapping(MANAGED_CONFIG)
        self.assertEqual(
            fabric_config.to_mapping()["harness"], MANAGED_CONFIG["harness"]
        )

        agent_config = AgentConfig.from_mapping({"models": MANAGED_CONFIG["models"]})
        native_config = configuration.build_hermes_config(
            agent_config,
            workspace="/sandbox",
        )
        self.assertEqual(
            native_config["model"],
            {
                "provider": "custom",
                "default": "nvidia/nemotron-3-super-120b-a12b",
                "base_url": "https://inference.local/v1",
            },
        )
        self.assertEqual(native_config["terminal"]["cwd"], "/sandbox")
        self.assertEqual(native_config["terminal"]["timeout"], 60)


class HermesProxyTests(unittest.TestCase):
    """Keep every proxy exit routed through the private process owner."""

    def test_arbitrary_response_io_failure_stops_the_process_owner(self) -> None:
        request_bytes = b'{"operation":"start","payload":{}}\n'
        input_stream = io.TextIOWrapper(io.BytesIO(request_bytes), encoding="utf-8")
        output_stream = io.TextIOWrapper(io.BytesIO(), encoding="utf-8")
        process = type(
            "FixtureProcess",
            (),
            {
                "stdin": io.BytesIO(),
                "stdout": io.BytesIO(),
                "stderr": io.BytesIO(),
            },
        )()

        with (
            patch.object(proxy_adapter, "_start_supervisor", return_value=process),
            patch.object(
                proxy_adapter,
                "_read_bounded_response",
                side_effect=OSError("fixture response transport failed"),
            ),
            patch.object(proxy_adapter, "_stop_supervisor") as stop_supervisor,
            patch.object(sys, "stdin", input_stream),
            patch.object(sys, "stdout", output_stream),
        ):
            with self.assertRaisesRegex(OSError, "fixture response transport failed"):
                proxy_adapter.run()

        stop_supervisor.assert_called_once_with(process)

    @unittest.skipIf(sys.platform == "win32", "Hermes sandboxes use POSIX processes")
    def test_process_owner_reaps_detached_child_after_proxy_loss(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            base_dir = Path(temporary_directory)
            process_marker = base_dir / "hermes-processes.json"
            owner_marker = base_dir / "hermes-owner-pid"
            command_source = "\n".join(
                [
                    "import json, os, subprocess, sys, time",
                    "from pathlib import Path",
                    "child = subprocess.Popen(",
                    "    [sys.executable, '-c', 'import time; time.sleep(300)'],",
                    "    stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,",
                    "    stderr=subprocess.DEVNULL, start_new_session=True,",
                    ")",
                    f"Path({str(process_marker)!r}).write_text(",
                    "    json.dumps({'host': os.getpid(), 'child': child.pid}),",
                    "    encoding='utf-8',",
                    ")",
                    "while True:",
                    "    time.sleep(60)",
                ]
            )
            proxy_source = "\n".join(
                [
                    "import os, subprocess, sys, time",
                    "from pathlib import Path",
                    "owner = subprocess.Popen([",
                    "    sys.executable, '-m', 'nemoclaw_hermes_fabric.process',",
                    "    '--parent-pid', str(os.getpid()), '--',",
                    f"    sys.executable, '-c', {command_source!r},",
                    "], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,",
                    "stderr=subprocess.DEVNULL)",
                    f"Path({str(owner_marker)!r}).write_text(str(owner.pid), encoding='ascii')",
                    f"marker = Path({str(process_marker)!r})",
                    "deadline = time.monotonic() + 5",
                    "while not marker.exists() and time.monotonic() < deadline:",
                    "    time.sleep(0.025)",
                    "os._exit(0)",
                ]
            )

            proxy = subprocess.Popen([sys.executable, "-c", proxy_source])
            self.assertEqual(proxy.wait(timeout=10), 0)
            self.assertTrue(process_marker.is_file())
            self.assertTrue(owner_marker.is_file())
            processes = json.loads(process_marker.read_text(encoding="utf-8"))

            _wait_for_stopped(int(owner_marker.read_text(encoding="ascii")))
            _wait_for_stopped(processes["host"])
            _wait_for_stopped(processes["child"])


class ComposedFabricTests(unittest.TestCase):
    """Exercise the released Hermes adapter through the generic runner."""

    def setUp(self) -> None:
        self._temporary_directory = tempfile.TemporaryDirectory()
        self.addCleanup(self._temporary_directory.cleanup)
        self.base_dir = Path(self._temporary_directory.name)
        self.workspace = self.base_dir / "workspace"
        self.artifacts = self.base_dir / "artifacts"
        self.stub_root = self.base_dir / "hermes-stubs"
        self.workspace.mkdir()
        self.artifacts.mkdir()
        (self.stub_root / "hermes_cli").mkdir(parents=True)
        # The released adapter deliberately does not install Hermes itself; the
        # managed image supplies that SDK. These narrow stubs make the native
        # Hermes boundary deterministic while discovery, lifecycle transport,
        # route translation, errors, and cleanup remain the official adapter.
        (self.stub_root / "hermes_cli" / "__init__.py").write_text("", encoding="utf-8")
        (self.stub_root / "hermes_cli" / "config.py").write_text(
            "def load_config():\n    return {}\n", encoding="utf-8"
        )
        (self.stub_root / "hermes_cli" / "plugins.py").write_text(
            "def discover_plugins(force=False):\n    return []\n", encoding="utf-8"
        )
        (self.stub_root / "hermes_state.py").write_text(
            "class SessionDB:\n    def close(self):\n        pass\n",
            encoding="utf-8",
        )
        (self.stub_root / "run_agent.py").write_text(
            FAKE_HERMES_AGENT_SOURCE, encoding="utf-8"
        )
        descriptor_source = (
            Path(__file__).resolve().parents[2]
            / "fabric"
            / "hermes.fabric-adapter.json"
        )
        self.descriptor = self.base_dir / "hermes.fabric-adapter.json"
        shutil.copyfile(descriptor_source, self.descriptor)
        self.config_path = self.base_dir / "fabric.json"
        self.invocation_marker = self.base_dir / "hermes-invocation.json"
        self.closed_marker = self.base_dir / "hermes-closed.txt"
        self.secret = "nvapi-hermes-composed-redaction-sentinel"
        self.environment = {
            "ADAPTER_PYTHON": sys.executable,
            "HERMES_FABRIC_API_KEY": self.secret,
            "NEMOCLAW_FAKE_HERMES_INVOCATION": str(self.invocation_marker),
            "NEMOCLAW_FAKE_HERMES_CLOSED": str(self.closed_marker),
            "PYTHONPATH": os.pathsep.join(
                filter(
                    None,
                    (str(self.stub_root), os.environ.get("PYTHONPATH", "")),
                )
            ),
            "VIRTUAL_ENV": str(Path(sys.executable).parent.parent),
        }

    def write_config(self, *, timeout_seconds: float = 5) -> Path:
        payload = {
            **MANAGED_CONFIG,
            "metadata": {"name": "nemoclaw-hermes-composed"},
            "discovery": {"local_paths": [self.descriptor.name]},
            "runtime": {
                **MANAGED_CONFIG["runtime"],
                "artifacts": "./artifacts",
                "timeout_seconds": timeout_seconds,
            },
            "environment": {
                **MANAGED_CONFIG["environment"],
                "workspace": "./workspace",
                "artifacts": "./artifacts",
            },
            "tools": {"enabled": [], "blocked": []},
        }
        self.config_path.write_text(json.dumps(payload), encoding="utf-8")
        return self.config_path

    def invoke_cli(self, arguments: list[str]) -> tuple[int, str, str]:
        _exit_failure, _exit_success, run_cli = _generic_runner()
        stdout = io.StringIO()
        stderr = io.StringIO()
        with patch.dict(os.environ, self.environment):
            exit_code = run_cli(
                arguments,
                stdin=io.StringIO(),
                stdout=stdout,
                stderr=stderr,
            )
        return exit_code, stdout.getvalue(), stderr.getvalue()

    def test_runner_discovers_doctors_and_invokes_the_released_adapter(self) -> None:
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
        self.assertEqual(result["harness"], "nvidia.nemoclaw.hermes")
        self.assertEqual(result["adapter_kind"], "python")
        self.assertEqual(result["metadata"]["adapter_runner"], "persistent_local_host")
        self.assertEqual(result["output"]["response"], "deterministic Hermes response")
        self.assertTrue(self.closed_marker.is_file())

    def test_runner_redacts_adapter_failures_and_closes_the_runtime(self) -> None:
        exit_failure, _exit_success, _run_cli = _generic_runner()
        config = self.write_config()
        self.environment["NEMOCLAW_FAKE_HERMES_MODE"] = "failure"

        exit_code, stdout, stderr = self.invoke_cli(
            ["run", "--config", str(config), "-m", self.secret, "--json"]
        )

        self.assertEqual(exit_code, exit_failure, stdout + stderr)
        self.assertEqual(stderr, "")
        self.assertNotIn(self.secret, stdout)
        result = json.loads(stdout)
        self.assertEqual(result["status"], "failed")
        self.assertTrue(result["error"]["code"])
        self.assertTrue(self.closed_marker.is_file())

    def test_runner_timeout_terminates_the_persistent_adapter_host(self) -> None:
        exit_failure, _exit_success, _run_cli = _generic_runner()
        config = self.write_config(timeout_seconds=0.1)
        self.environment["NEMOCLAW_FAKE_HERMES_MODE"] = "hang"

        exit_code, stdout, stderr = self.invoke_cli(
            ["run", "--config", str(config), "-m", "bounded request", "--json"]
        )

        self.assertEqual(exit_code, exit_failure, stdout + stderr)
        self.assertEqual(stderr, "")
        self.assertEqual(json.loads(stdout)["status"], "failed")
        invocation = json.loads(self.invocation_marker.read_text(encoding="utf-8"))
        _wait_for_stopped(invocation["pid"])
        _wait_for_stopped(invocation["child_pid"])

    def test_runner_bounds_oversized_output_and_redacts_credentials(self) -> None:
        exit_failure, _exit_success, _run_cli = _generic_runner()
        config = self.write_config()
        self.environment["NEMOCLAW_FAKE_HERMES_MODE"] = "oversized_output"
        self.environment["NEMOCLAW_FAKE_HERMES_OUTPUT_BYTES"] = str(
            PROCESS_RESPONSE_LIMIT_BYTES + 4096
        )

        exit_code, stdout, stderr = self.invoke_cli(
            ["run", "--config", str(config), "-m", "bounded output", "--json"]
        )

        self.assertEqual(exit_code, exit_failure, stdout + stderr)
        self.assertEqual(stderr, "")
        self.assertLess(len(stdout.encode("utf-8")), PROCESS_RESPONSE_LIMIT_BYTES)
        self.assertNotIn(self.secret, stdout)
        result = json.loads(stdout)
        self.assertEqual(result["status"], "failed")
        invocation = json.loads(self.invocation_marker.read_text(encoding="utf-8"))
        _wait_for_stopped(invocation["pid"])
        _wait_for_stopped(invocation["child_pid"])


if __name__ == "__main__":
    unittest.main()
