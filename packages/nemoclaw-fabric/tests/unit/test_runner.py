# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Tests for the generic Fabric execution environment boundary."""

from __future__ import annotations

import asyncio
import os
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from unittest.mock import patch

from nemoclaw_fabric.runner import check_fabric_requirements


class EnvironmentCapturingClient:
    """Capture the process environment observed by a Fabric SDK call."""

    def __init__(self) -> None:
        self.virtual_env: str | None = None
        self.path: str | None = None
        self.python_home: str | None = None

    async def doctor(self, _config: Any, *, base_dir: Path) -> Any:
        del base_dir
        self.virtual_env = os.environ.get("VIRTUAL_ENV")
        self.path = os.environ.get("PATH")
        self.python_home = os.environ.get("PYTHONHOME")
        return SimpleNamespace(status="pass", checks=[])


class DoctorRaisingClient(EnvironmentCapturingClient):
    """Capture the runner environment, then fail the Fabric preflight."""

    async def doctor(self, config: Any, *, base_dir: Path) -> Any:
        await super().doctor(config, base_dir=base_dir)
        raise RuntimeError("doctor failed")


class FabricRunnerEnvironmentTests(unittest.TestCase):
    """Keep adapter discovery on the runner graph and restore caller state."""

    def test_wrong_ambient_virtualenv_cannot_select_another_adapter_graph(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            wrong_virtualenv = str(Path(temporary_directory) / "dcode-venv")
            wrong_path = str(Path(temporary_directory) / "dcode-bin")
            wrong_python_home = str(Path(temporary_directory) / "python-home")
            client = EnvironmentCapturingClient()

            with patch.dict(
                os.environ,
                {
                    "VIRTUAL_ENV": wrong_virtualenv,
                    "PATH": wrong_path,
                    "PYTHONHOME": wrong_python_home,
                },
            ):
                asyncio.run(
                    check_fabric_requirements(
                        client,
                        object(),
                        base_dir=Path(temporary_directory),
                    )
                )
                self.assertEqual(os.environ["VIRTUAL_ENV"], wrong_virtualenv)
                self.assertEqual(os.environ["PATH"], wrong_path)
                self.assertEqual(os.environ["PYTHONHOME"], wrong_python_home)

        runner_bin = str(Path(sys.executable).parent)
        self.assertEqual(client.virtual_env, str(Path(sys.prefix).resolve()))
        self.assertEqual(client.path, f"{runner_bin}{os.pathsep}{wrong_path}")
        self.assertIsNone(client.python_home)

    def test_symlinked_python_keeps_the_runner_environment_bin_on_path(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            base_dir = Path(temporary_directory)
            runner_bin = base_dir / "runner-venv" / "bin"
            real_bin = base_dir / "base-python" / "bin"
            runner_bin.mkdir(parents=True)
            real_bin.mkdir(parents=True)
            real_python = real_bin / "python3"
            real_python.touch()
            runner_python = runner_bin / "python3"
            runner_python.symlink_to(real_python)
            ambient_bin = str(base_dir / "ambient-bin")
            client = EnvironmentCapturingClient()

            with (
                patch("nemoclaw_fabric.runner.sys.executable", str(runner_python)),
                patch.dict(os.environ, {"PATH": ambient_bin}),
            ):
                asyncio.run(
                    check_fabric_requirements(
                        client,
                        object(),
                        base_dir=base_dir,
                    )
                )

        self.assertEqual(client.path, f"{runner_bin}{os.pathsep}{ambient_bin}")
        self.assertNotIn(str(real_bin), client.path or "")

    def test_doctor_exception_restores_present_and_absent_caller_environment(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            base_dir = Path(temporary_directory)
            cases = {
                "variables-present": {
                    "VIRTUAL_ENV": str(base_dir / "caller-venv"),
                    "PATH": str(base_dir / "caller-bin"),
                    "PYTHONHOME": str(base_dir / "caller-python-home"),
                    "UNCHANGED": "caller-value",
                },
                "variables-absent": {
                    "UNCHANGED": "caller-value",
                },
            }

            for case_name, caller_environment in cases.items():
                with self.subTest(case_name=case_name):
                    client = DoctorRaisingClient()
                    with patch.dict(os.environ, caller_environment, clear=True):
                        environment_before_doctor = dict(os.environ)

                        with self.assertRaisesRegex(RuntimeError, "doctor failed"):
                            asyncio.run(
                                check_fabric_requirements(
                                    client,
                                    object(),
                                    base_dir=base_dir,
                                )
                            )

                        self.assertEqual(dict(os.environ), environment_before_doctor)

                    runner_bin = str(Path(sys.executable).parent)
                    expected_caller_path = caller_environment.get("PATH")
                    expected_runner_path = (
                        f"{runner_bin}{os.pathsep}{expected_caller_path}"
                        if expected_caller_path
                        else runner_bin
                    )
                    self.assertEqual(client.virtual_env, str(Path(sys.prefix).resolve()))
                    self.assertEqual(client.path, expected_runner_path)
                    self.assertIsNone(client.python_home)


if __name__ == "__main__":
    unittest.main()
