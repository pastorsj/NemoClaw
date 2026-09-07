# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Prove the Hermes Fabric lifecycle across separate Python environments."""

from __future__ import annotations

import argparse
import json
import os
import shlex
import shutil
import subprocess
import sys
import tempfile
import venv
from pathlib import Path


RUNNER_DISTRIBUTION = "nemoclaw-fabric"
PROXY_DISTRIBUTION = "nemoclaw-hermes-fabric"
ADAPTER_DISTRIBUTION = "nemo-fabric-adapters-hermes"
ADAPTER_CONTRACT_DISTRIBUTION = "nemo-fabric-adapter-contract"
ADAPTER_COMMON_DISTRIBUTION = "nemo-fabric-adapters-common"


def parse_arguments() -> argparse.Namespace:
    """Read the generic runner source selected by the composed test lane."""

    package_root = Path(__file__).resolve().parents[2]
    default_runner = Path(
        os.environ.get(
            "NEMOCLAW_FABRIC_RUNNER_PATH",
            package_root.parent / "nemoclaw-fabric",
        )
    )
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--runner-source",
        type=Path,
        default=default_runner,
        help="path to the generic nemoclaw-fabric package",
    )
    return parser.parse_args()


def run_checked(
    command: list[str], **options: object
) -> subprocess.CompletedProcess[str]:
    """Run one setup command and retain its output for failure diagnostics."""

    return subprocess.run(
        command,
        check=True,
        text=True,
        **options,
    )


def create_environment(path: Path) -> Path:
    """Create one Python environment and return its interpreter."""

    venv.EnvBuilder(with_pip=True, clear=True).create(path)
    interpreter = path / "bin" / "python"
    if not interpreter.is_file():
        raise AssertionError(f"Python environment has no interpreter: {path}")
    return interpreter


def copy_build_source(source: Path, destination: Path, *, readme: bool) -> None:
    """Copy only the files that define a Python wheel."""

    destination.mkdir(parents=True)
    shutil.copyfile(source / "pyproject.toml", destination / "pyproject.toml")
    shutil.copytree(source / "src", destination / "src")
    if readme:
        shutil.copyfile(source / "README.md", destination / "README.md")


def install_locked(interpreter: Path, requirements: Path) -> None:
    """Install one dependency graph from its hash-locked requirements."""

    run_checked(
        [
            str(interpreter),
            "-m",
            "pip",
            "install",
            "--disable-pip-version-check",
            "--quiet",
            "--require-hashes",
            "--requirement",
            str(requirements),
        ]
    )


def select_wheel(wheel_dir: Path, distribution: str) -> Path:
    """Return the single wheel built for a distribution."""

    wheel_prefix = distribution.replace("-", "_")
    candidates = list(wheel_dir.glob(f"{wheel_prefix}-*.whl"))
    if len(candidates) != 1:
        raise AssertionError(
            f"Expected one {distribution} wheel in {wheel_dir}; found {candidates}"
        )
    return candidates[0]


def build_wheels(
    *,
    build_python: Path,
    build_lock: Path,
    runner_source: Path,
    proxy_source: Path,
    wheel_dir: Path,
) -> tuple[Path, Path]:
    """Build the generic runner and package proxy from disposable sources."""

    install_locked(build_python, build_lock)
    run_checked(
        [
            str(build_python),
            "-m",
            "pip",
            "wheel",
            "--disable-pip-version-check",
            "--quiet",
            "--no-build-isolation",
            "--no-deps",
            "--no-index",
            "--wheel-dir",
            str(wheel_dir),
            str(runner_source),
            str(proxy_source),
        ]
    )
    return (
        select_wheel(wheel_dir, RUNNER_DISTRIBUTION),
        select_wheel(wheel_dir, PROXY_DISTRIBUTION),
    )


def install_wheels(interpreter: Path, wheels: tuple[Path, Path]) -> None:
    """Install the runner and proxy without combining dependency graphs."""

    run_checked(
        [
            str(interpreter),
            "-m",
            "pip",
            "install",
            "--disable-pip-version-check",
            "--quiet",
            "--no-index",
            "--no-deps",
            *(str(wheel) for wheel in wheels),
        ]
    )


def assert_runner_boundary(runner_python: Path, adapter_python: Path) -> None:
    """Verify that only the proxy crosses into the adapter environment."""

    source = f"""
import os
import sys
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path
from unittest.mock import patch

from nemoclaw_hermes_fabric import adapter

assert version({RUNNER_DISTRIBUTION!r}) == "0.1.2"
assert version({PROXY_DISTRIBUTION!r}) == "0.1.0"
try:
    version({ADAPTER_DISTRIBUTION!r})
except PackageNotFoundError:
    pass
else:
    raise AssertionError("the released Hermes adapter leaked into the runner environment")

with patch.object(adapter.subprocess, "Popen") as start_process:
    adapter._start_supervisor()
command = start_process.call_args.args[0]
child_environment = start_process.call_args.kwargs["env"]
adapter_python = str(Path(os.environ["NEMOCLAW_HERMES_ADAPTER_PYTHON"]))
adapter_bin = str(Path(adapter_python).parent)
assert command[0] == sys.executable, (command, sys.executable)
assert command[-3:] == [adapter_python, "-m", adapter.OFFICIAL_ADAPTER_MODULE]
assert child_environment["VIRTUAL_ENV"] == str(Path(adapter_bin).parent)
assert child_environment["PATH"].split(os.pathsep)[0] == adapter_bin
assert "PYTHONHOME" not in child_environment
"""
    environment = {
        **os.environ,
        "NEMOCLAW_HERMES_ADAPTER_PYTHON": str(adapter_python),
    }
    run_checked([str(runner_python), "-I", "-c", source], env=environment)


def assert_adapter_boundary(adapter_python: Path) -> None:
    """Verify that the released adapter cannot import runner components."""

    source = f"""
from importlib.metadata import PackageNotFoundError, version

import nemo_fabric_adapters.hermes.adapter

assert version({ADAPTER_CONTRACT_DISTRIBUTION!r}) == "0.2.0"
assert version({ADAPTER_COMMON_DISTRIBUTION!r}) == "0.2.0"
assert version({ADAPTER_DISTRIBUTION!r}) == "0.2.0"
for distribution_name in ({RUNNER_DISTRIBUTION!r}, {PROXY_DISTRIBUTION!r}):
    try:
        version(distribution_name)
    except PackageNotFoundError:
        continue
    raise AssertionError(f"runner distribution leaked into adapter environment: {{distribution_name}}")
"""
    run_checked([str(adapter_python), "-I", "-c", source])


def write_lifecycle_fixture(case_dir: Path, descriptor_source: Path) -> Path:
    """Create a deterministic Hermes SDK fixture and Fabric configuration."""

    stub_dir = case_dir / "stubs"
    sources = {
        "hermes_cli/__init__.py": "",
        "hermes_cli/config.py": "def load_config():\n    return {}\n",
        "hermes_cli/plugins.py": "def discover_plugins(force=False):\n    return []\n",
        "hermes_state.py": "class SessionDB:\n    def close(self):\n        pass\n",
        "run_agent.py": (
            "class AIAgent:\n"
            "    def __init__(self, session_id=None, **kwargs):\n"
            "        self.session_id = session_id or 'fixture-session'\n"
            "    def run_conversation(self, user_message, **kwargs):\n"
            "        return {'response': 'split-venv-ok', 'completed': True, "
            "'messages': [], 'api_calls': 1}\n"
            "    def close(self):\n"
            "        pass\n"
        ),
    }
    for relative_path, source in sources.items():
        path = stub_dir / relative_path
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(source, encoding="utf-8")

    (case_dir / "workspace").mkdir()
    (case_dir / "artifacts").mkdir()
    shutil.copyfile(descriptor_source, case_dir / "hermes.fabric-adapter.json")
    config = {
        "schema_version": "fabric.agent/v1alpha1",
        "metadata": {"name": "hermes-split-venv"},
        "harness": {
            "adapter_id": "nvidia.nemoclaw.hermes",
            "resolution": "preinstalled",
        },
        "discovery": {"local_paths": ["hermes.fabric-adapter.json"]},
        "runtime": {
            "input_schema": "chat",
            "output_schema": "message",
            "artifacts": "./artifacts",
            "timeout_seconds": 5,
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
                "provider": "custom",
                "model": "fixture",
                "api_key_env": "HERMES_FABRIC_API_KEY",
                "base_url": "http://127.0.0.1:9/v1",
            }
        },
        "tools": {"enabled": [], "blocked": []},
    }
    config_path = case_dir / "fabric.json"
    config_path.write_text(json.dumps(config), encoding="utf-8")
    return config_path


def run_lifecycle(
    *,
    runner_python: Path,
    adapter_python: Path,
    case_dir: Path,
    config_path: Path,
) -> None:
    """Complete one Fabric request through both Python environments."""

    secret = "fixture-only-value"
    environment = {
        **os.environ,
        "PYTHONDONTWRITEBYTECODE": "1",
        "NEMOCLAW_HERMES_ADAPTER_PYTHON": str(adapter_python),
        "PYTHONPATH": str(case_dir / "stubs"),
        "HERMES_FABRIC_API_KEY": secret,
    }
    environment.pop("ADAPTER_PYTHON", None)
    environment.pop("PYTHONHOME", None)
    result = run_checked(
        [
            str(runner_python.parent / "nemoclaw-fabric-run"),
            "--deadline-seconds",
            "10",
            "--kill-grace-seconds",
            "2",
            "--config",
            str(config_path),
            "-m",
            "split-venv-check",
            "--json",
        ],
        env=environment,
        capture_output=True,
    )
    payload = json.loads(result.stdout)
    assert payload["status"] == "succeeded", payload
    assert payload["output"]["response"] == "split-venv-ok", payload
    host_python = shlex.split(payload["metadata"]["host_command"])[0]
    assert Path(host_python).resolve() == runner_python.resolve()
    assert secret not in result.stdout
    assert secret not in result.stderr
    assert list((case_dir / "artifacts").iterdir()) == []


def main() -> None:
    """Build, isolate, and exercise the composed Hermes Fabric path."""

    if sys.version_info[:2] != (3, 13):
        raise SystemExit(
            f"Hermes split-environment tests require Python 3.13; found {sys.version_info.major}.{sys.version_info.minor}"
        )
    arguments = parse_arguments()
    package_root = Path(__file__).resolve().parents[2]
    runner_source = arguments.runner_source.resolve()
    required_runner_files = (
        runner_source / "pyproject.toml",
        runner_source / "build-requirements.lock",
        runner_source / "src",
    )
    if not all(path.exists() for path in required_runner_files):
        raise SystemExit(f"Generic Fabric runner source is incomplete: {runner_source}")

    with tempfile.TemporaryDirectory(
        prefix="nemoclaw-hermes-split-venv-"
    ) as temporary_directory:
        work_dir = Path(temporary_directory)
        runner_build_source = work_dir / "runner-source"
        proxy_build_source = work_dir / "proxy-source"
        wheel_dir = work_dir / "wheels"
        wheel_dir.mkdir()
        copy_build_source(runner_source, runner_build_source, readme=True)
        copy_build_source(package_root / "fabric", proxy_build_source, readme=False)

        build_python = create_environment(work_dir / "build-venv")
        runner_python = create_environment(work_dir / "runner-venv")
        adapter_python = create_environment(work_dir / "adapter-venv")
        wheels = build_wheels(
            build_python=build_python,
            build_lock=runner_source / "build-requirements.lock",
            runner_source=runner_build_source,
            proxy_source=proxy_build_source,
            wheel_dir=wheel_dir,
        )
        install_locked(runner_python, package_root / "fabric/runtime-requirements.lock")
        install_locked(
            adapter_python, package_root / "fabric/adapter-requirements.lock"
        )
        install_wheels(runner_python, wheels)
        run_checked([str(runner_python), "-m", "pip", "check"])
        run_checked([str(adapter_python), "-m", "pip", "check"])

        assert_runner_boundary(runner_python, adapter_python)
        assert_adapter_boundary(adapter_python)
        case_dir = work_dir / "lifecycle"
        case_dir.mkdir()
        config_path = write_lifecycle_fixture(
            case_dir,
            package_root / "fabric/hermes.fabric-adapter.json",
        )
        run_lifecycle(
            runner_python=runner_python,
            adapter_python=adapter_python,
            case_dir=case_dir,
            config_path=config_path,
        )

    print("Hermes split-environment Fabric lifecycle passed.")


if __name__ == "__main__":
    main()
