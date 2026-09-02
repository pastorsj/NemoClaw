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

from nemo_fabric import FabricConfig, FabricConfigError, FabricError, RunResult

from nemoclaw_fabric.runner import FabricDoctorFailure
from nemoclaw_fabric.runner import check_fabric_requirements
from nemoclaw_fabric.runner import remove_process_artifacts
from nemoclaw_fabric.runner import run_fabric_request


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


def fabric_config(base_dir: Path, artifact_name: str = "artifacts") -> FabricConfig:
    """Build one complete package-owned runner configuration."""

    return FabricConfig.from_mapping(
        {
            "metadata": {"name": "runner-test"},
            "harness": {"adapter_id": "test.runner.adapter"},
            "runtime": {
                "artifacts": f"./{artifact_name}",
                "timeout_seconds": 30,
            },
            "environment": {
                "provider": "local",
                "workspace": "./workspace",
                "artifacts": f"./{artifact_name}",
            },
        }
    )


def prepared_fabric_config(base_dir: Path) -> FabricConfig:
    """Create the package-owned paths required by a doctor-only test."""

    (base_dir / "workspace").mkdir(exist_ok=True)
    (base_dir / "artifacts").mkdir(mode=0o700, exist_ok=True)
    return fabric_config(base_dir)


def fabric_result(invocation_root: Path) -> RunResult:
    """Return a real Fabric result containing each ephemeral path shape."""

    root_text = str(invocation_root)
    return RunResult.from_mapping(
        {
            "agent_name": "runner-test",
            "harness": "test.runner.adapter",
            "adapter_kind": "python",
            "adapter_id": "test.runner.adapter",
            "runtime_id": "runtime-test",
            "invocation_id": "invocation-test",
            "request_id": "request-test",
            "status": "succeeded",
            "output": {
                "response": "ok",
                "adapter_home": f"{root_text}/adapter-home",
                "nested": [f"prefix {root_text}/nested", f"{root_text}/drop"],
            },
            "error": None,
            "artifacts": {"root": root_text, "artifacts": []},
            "telemetry": [],
            "events": [],
            "metadata": {
                "fabric_home": f"{root_text}/.fabric",
                f"{root_text}/ephemeral-key": "drop-key",
                "workspace": "/real/workspace",
            },
        }
    )


class ArtifactWritingClient:
    """Write request data where Fabric 0.2 normally retains invocation records."""

    def __init__(self, *, failure: Exception | None = None) -> None:
        self.failure = failure
        self.invocation_roots: list[Path] = []
        self.invocation_modes: list[int] = []

    async def doctor(self, config: FabricConfig, *, base_dir: Path) -> Any:
        del base_dir
        invocation_root = Path(config.runtime.artifacts)
        self.invocation_roots.append(invocation_root)
        self.invocation_modes.append(invocation_root.stat().st_mode & 0o777)
        return SimpleNamespace(status="pass", checks=[])

    async def run(
        self,
        config: FabricConfig,
        *,
        base_dir: Path,
        request: Any,
    ) -> RunResult:
        del base_dir
        invocation_root = Path(config.runtime.artifacts)
        retained = invocation_root / ".fabric" / "runtime-test" / "invocation-test"
        retained.mkdir(parents=True)
        (retained / "adapter-invocation.json").write_text(
            request.input,
            encoding="utf-8",
        )
        if self.failure is not None:
            raise self.failure
        return fabric_result(invocation_root)


class BlockingArtifactClient(ArtifactWritingClient):
    """Hold one invocation open so cancellation and concurrency can be observed."""

    def __init__(self) -> None:
        super().__init__()
        self.started = asyncio.Event()
        self.release = asyncio.Event()

    async def run(
        self,
        config: FabricConfig,
        *,
        base_dir: Path,
        request: Any,
    ) -> RunResult:
        invocation_root = Path(config.runtime.artifacts)
        retained = invocation_root / "retained.txt"
        retained.write_text(request.input, encoding="utf-8")
        self.invocation_roots.append(invocation_root)
        self.started.set()
        await self.release.wait()
        return fabric_result(invocation_root)


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
                        prepared_fabric_config(Path(temporary_directory)),
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
                        prepared_fabric_config(base_dir),
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
                                    prepared_fabric_config(base_dir),
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


class FabricArtifactLifecycleTests(unittest.TestCase):
    """Keep every prompt-bearing Fabric request artifact private and temporary."""

    def setUp(self) -> None:
        self._temporary_directory = tempfile.TemporaryDirectory()
        self.addCleanup(self._temporary_directory.cleanup)
        self.base_dir = Path(self._temporary_directory.name)
        self.workspace = self.base_dir / "workspace"
        self.artifacts = self.base_dir / "artifacts"
        self.workspace.mkdir(mode=0o700)
        self.artifacts.mkdir(mode=0o700)

    def assert_artifact_root_empty(self) -> None:
        self.assertEqual(list(self.artifacts.iterdir()), [])

    def test_success_removes_request_bytes_and_stale_result_paths(self) -> None:
        prompt = "private prompt retention sentinel"
        client = ArtifactWritingClient()

        result = asyncio.run(
            run_fabric_request(
                client,
                fabric_config(self.base_dir),
                base_dir=self.base_dir,
                prompt=prompt,
            )
        )

        self.assert_artifact_root_empty()
        self.assertEqual(len(client.invocation_roots), 1)
        self.assertEqual(client.invocation_modes, [0o700])
        invocation_root = client.invocation_roots[0]
        self.assertFalse(invocation_root.exists())
        rendered = str(result.to_mapping())
        self.assertNotIn(str(invocation_root), rendered)
        self.assertNotIn(prompt, rendered)
        self.assertIsNone(result.artifacts.root)
        self.assertEqual(tuple(result.artifacts.artifacts), ())
        self.assertNotIn("adapter_home", result.output)
        self.assertEqual(result.output["nested"], ["prefix <ephemeral-artifacts>/nested"])
        self.assertEqual(result.metadata, {"workspace": "/real/workspace"})

    def test_exception_removes_request_bytes(self) -> None:
        client = ArtifactWritingClient(failure=RuntimeError("adapter failed"))

        with self.assertRaisesRegex(RuntimeError, "adapter failed"):
            asyncio.run(
                run_fabric_request(
                    client,
                    fabric_config(self.base_dir),
                    base_dir=self.base_dir,
                    prompt="failure prompt sentinel",
                )
            )

        self.assert_artifact_root_empty()

    def test_doctor_failure_removes_the_private_invocation_directory(self) -> None:
        class FailingDoctorClient(ArtifactWritingClient):
            async def doctor(self, config: FabricConfig, *, base_dir: Path) -> Any:
                del base_dir
                invocation_root = Path(config.runtime.artifacts)
                (invocation_root / "doctor.txt").write_text(
                    "doctor prompt sentinel",
                    encoding="utf-8",
                )
                return SimpleNamespace(status="fail", checks=[])

        with self.assertRaises(FabricDoctorFailure):
            asyncio.run(
                run_fabric_request(
                    FailingDoctorClient(),
                    fabric_config(self.base_dir),
                    base_dir=self.base_dir,
                    prompt="unused prompt",
                )
            )

        self.assert_artifact_root_empty()

    def test_cancellation_removes_request_bytes(self) -> None:
        async def cancel_active_request() -> None:
            client = BlockingArtifactClient()
            task = asyncio.create_task(
                run_fabric_request(
                    client,
                    fabric_config(self.base_dir),
                    base_dir=self.base_dir,
                    prompt="cancelled prompt sentinel",
                )
            )
            await client.started.wait()
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task

        asyncio.run(cancel_active_request())
        self.assert_artifact_root_empty()

    def test_concurrent_request_is_rejected_without_environment_corruption(self) -> None:
        async def run_concurrent() -> None:
            first = BlockingArtifactClient()
            second = BlockingArtifactClient()
            first_task = asyncio.create_task(
                run_fabric_request(
                    first,
                    fabric_config(self.base_dir),
                    base_dir=self.base_dir,
                    prompt="first concurrent prompt",
                )
            )
            await first.started.wait()
            try:
                with self.assertRaisesRegex(
                    FabricError,
                    "concurrent Fabric SDK calls in one process are unsupported",
                ):
                    await run_fabric_request(
                        second,
                        fabric_config(self.base_dir),
                        base_dir=self.base_dir,
                        prompt="second concurrent prompt",
                    )
            finally:
                first.release.set()
                await first_task

        caller_environment = {
            "VIRTUAL_ENV": "caller-venv",
            "PATH": "caller-path",
            "PYTHONHOME": "caller-python-home",
            "UNCHANGED": "caller-value",
        }
        with patch.dict(os.environ, caller_environment, clear=True):
            asyncio.run(run_concurrent())
            self.assertEqual(dict(os.environ), caller_environment)

        self.assert_artifact_root_empty()

    def test_world_accessible_parent_still_creates_private_invocations(self) -> None:
        self.artifacts.chmod(0o777)
        client = ArtifactWritingClient()

        asyncio.run(
            run_fabric_request(
                client,
                fabric_config(self.base_dir),
                base_dir=self.base_dir,
                prompt="darwin compatibility prompt",
            )
        )

        self.assert_artifact_root_empty()

    def test_creates_a_missing_direct_child_with_private_permissions(self) -> None:
        missing = self.base_dir / "missing-artifacts"

        asyncio.run(
            run_fabric_request(
                ArtifactWritingClient(),
                fabric_config(self.base_dir, missing.name),
                base_dir=self.base_dir,
                prompt="first package request",
            )
        )

        self.assertTrue(missing.is_dir())
        self.assertEqual(missing.stat().st_mode & 0o777, 0o700)
        self.assertEqual(list(missing.iterdir()), [])

    def test_process_cleanup_removes_only_the_finished_process_directories(self) -> None:
        selected = self.artifacts / f".nemoclaw-run-{os.getpid()}-selected"
        other = self.artifacts / f".nemoclaw-run-{os.getpid() + 1}-preserved"
        ordinary = self.artifacts / "operator-artifact"
        selected.mkdir()
        other.mkdir()
        ordinary.mkdir()

        removed = remove_process_artifacts(self.artifacts, os.getpid())

        self.assertEqual(removed, 1)
        self.assertFalse(selected.exists())
        self.assertTrue(other.is_dir())
        self.assertTrue(ordinary.is_dir())

    def test_rejects_mismatched_outside_symlinked_and_file_artifact_roots(self) -> None:
        other = self.base_dir / "other-artifacts"
        other.mkdir(mode=0o700)
        outside = self.base_dir / "outside"
        outside.mkdir(mode=0o700)
        alias = self.base_dir / "artifact-alias"
        alias.symlink_to(outside, target_is_directory=True)
        regular_file = self.base_dir / "artifact-file"
        regular_file.write_text("not a directory", encoding="utf-8")
        cases = {
            "outside": fabric_config(self.base_dir, "../outside"),
            "symlink": fabric_config(self.base_dir, alias.name),
            "file": fabric_config(self.base_dir, regular_file.name),
        }
        mismatched_payload = fabric_config(self.base_dir).to_mapping()
        mismatched_payload["environment"]["artifacts"] = "./other-artifacts"
        cases["mismatched"] = FabricConfig.from_mapping(mismatched_payload)

        for case_name, config in cases.items():
            with self.subTest(case_name=case_name):
                with self.assertRaises(FabricConfigError):
                    asyncio.run(
                        run_fabric_request(
                            ArtifactWritingClient(),
                            config,
                            base_dir=self.base_dir,
                            prompt="rejected prompt",
                        )
                    )

        self.assert_artifact_root_empty()


if __name__ == "__main__":
    unittest.main()
