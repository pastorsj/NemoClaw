#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
python_command="${PYTHON_313:-python3.13}"
fabric_lock="${repository_root}/packages/nemoclaw-langchain-deepagents-code/fabric/requirements.lock"
runner_source="${repository_root}/packages/nemoclaw-fabric"
runner_build_lock="${runner_source}/build-requirements.lock"
pi_adapter_source="${repository_root}/packages/nemoclaw-pi/fabric"
openclaw_adapter_source="${repository_root}/packages/nemoclaw-openclaw/fabric"
hermes_proxy_source="${repository_root}/packages/nemoclaw-hermes/fabric"
hermes_adapter_lock="${repository_root}/packages/nemoclaw-hermes/fabric/adapter-requirements.lock"

if ! command -v "${python_command}" >/dev/null 2>&1; then
  echo "Python 3.13 is required. Set PYTHON_313 to its executable path." >&2
  exit 2
fi

python_version="$(
  "${python_command}" -c \
    'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")'
)"
if [[ "${python_version}" != "3.13" ]]; then
  echo "${python_command} must run Python 3.13; found ${python_version}." >&2
  exit 2
fi

work_dir="$(mktemp -d "${TMPDIR:-/tmp}/nemoclaw-fabric-tests.XXXXXX")"
cleanup() {
  rm -rf -- "${work_dir}"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

venv_dir="${work_dir}/venv"
hermes_runner_venv="${work_dir}/hermes-runner-venv"
hermes_adapter_venv="${work_dir}/hermes-adapter-venv"
wheel_dir="${work_dir}/wheels"
runner_build_source="${work_dir}/runner-source"
pi_adapter_build_source="${work_dir}/pi-adapter-source"
openclaw_adapter_build_source="${work_dir}/openclaw-adapter-source"
hermes_proxy_build_source="${work_dir}/hermes-proxy-source"
"${python_command}" -m venv "${venv_dir}"
mkdir -p "${wheel_dir}"
mkdir -p "${runner_build_source}"
mkdir -p "${pi_adapter_build_source}"
mkdir -p "${openclaw_adapter_build_source}"
mkdir -p "${hermes_proxy_build_source}"
cp "${runner_source}/README.md" "${runner_source}/pyproject.toml" "${runner_build_source}/"
cp -R "${runner_source}/src" "${runner_build_source}/src"
cp "${pi_adapter_source}/pyproject.toml" "${pi_adapter_build_source}/"
cp -R "${pi_adapter_source}/src" "${pi_adapter_build_source}/src"
cp "${openclaw_adapter_source}/pyproject.toml" "${openclaw_adapter_build_source}/"
cp -R "${openclaw_adapter_source}/src" "${openclaw_adapter_build_source}/src"
cp "${hermes_proxy_source}/pyproject.toml" "${hermes_proxy_build_source}/"
cp -R "${hermes_proxy_source}/src" "${hermes_proxy_build_source}/src"
venv_python="${venv_dir}/bin/python"

"${venv_python}" -m pip install \
  --disable-pip-version-check \
  --quiet \
  --require-hashes \
  --requirement "${runner_build_lock}"
"${venv_python}" -m pip wheel \
  --disable-pip-version-check \
  --quiet \
  --no-build-isolation \
  --no-deps \
  --no-index \
  --wheel-dir "${wheel_dir}" \
  "${runner_build_source}" \
  "${pi_adapter_build_source}" \
  "${openclaw_adapter_build_source}" \
  "${hermes_proxy_build_source}"
"${venv_python}" -m pip install \
  --disable-pip-version-check \
  --quiet \
  --require-hashes \
  --requirement "${fabric_lock}"
"${venv_python}" -m pip install \
  --disable-pip-version-check \
  --quiet \
  --require-hashes \
  --requirement "${hermes_adapter_lock}"

runner_wheel="$(find "${wheel_dir}" -maxdepth 1 -type f -name 'nemoclaw_fabric-*.whl' -print)"
if [[ -z "${runner_wheel}" || "${runner_wheel}" == *$'\n'* ]]; then
  echo "Expected one nemoclaw-fabric wheel in ${wheel_dir}." >&2
  exit 1
fi
pi_adapter_wheel="$(find "${wheel_dir}" -maxdepth 1 -type f -name 'nemoclaw_pi_fabric-*.whl' -print)"
if [[ -z "${pi_adapter_wheel}" || "${pi_adapter_wheel}" == *$'\n'* ]]; then
  echo "Expected one nemoclaw-pi-fabric wheel in ${wheel_dir}." >&2
  exit 1
fi
openclaw_adapter_wheel="$(find "${wheel_dir}" -maxdepth 1 -type f -name 'nemoclaw_openclaw_fabric-*.whl' -print)"
if [[ -z "${openclaw_adapter_wheel}" || "${openclaw_adapter_wheel}" == *$'\n'* ]]; then
  echo "Expected one nemoclaw-openclaw-fabric wheel in ${wheel_dir}." >&2
  exit 1
fi
hermes_proxy_wheel="$(find "${wheel_dir}" -maxdepth 1 -type f -name 'nemoclaw_hermes_fabric-*.whl' -print)"
if [[ -z "${hermes_proxy_wheel}" || "${hermes_proxy_wheel}" == *$'\n'* ]]; then
  echo "Expected one nemoclaw-hermes-fabric wheel in ${wheel_dir}." >&2
  exit 1
fi
"${venv_python}" -m pip install \
  --disable-pip-version-check \
  --quiet \
  --no-index \
  --no-deps \
  "${runner_wheel}" \
  "${pi_adapter_wheel}" \
  "${openclaw_adapter_wheel}" \
  "${hermes_proxy_wheel}"
"${venv_python}" -I - <<'PY'
from importlib.metadata import metadata, requires, version

assert version("nemoclaw-fabric") == "0.1.2"
assert version("nemoclaw-pi-fabric") == "0.1.0"
assert version("nemoclaw-openclaw-fabric") == "0.1.0"
assert version("nemoclaw-hermes-fabric") == "0.1.0"
assert version("nemo-fabric-adapters-hermes") == "0.2.0"
assert requires("nemoclaw-hermes-fabric") in (None, [])
assert metadata("nemoclaw-fabric")["Requires-Python"] == "<3.14,>=3.13"
declared = [item.replace(" ", "") for item in (requires("nemoclaw-fabric") or [])]
runtime = [item for item in declared if ";extra==" not in item]
optional = sorted(item for item in declared if ";extra==" in item)
assert runtime == ["nemo-fabric==0.2.0"], declared
assert optional == [
    'nemo-fabric-adapter-contract==0.2.0;extra=="test"',
    'nemo-fabric-adapters-common==0.2.0;extra=="test"',
], declared
PY

# Reproduce the managed Hermes image's intentional two-environment boundary.
# The generic runner must import the package proxy, while the released adapter
# and Hermes SDK remain behind the package-owned interpreter boundary.
"${python_command}" -m venv "${hermes_runner_venv}"
"${python_command}" -m venv "${hermes_adapter_venv}"
hermes_runner_python="${hermes_runner_venv}/bin/python"
hermes_adapter_python="${hermes_adapter_venv}/bin/python"
"${hermes_runner_python}" -m pip install \
  --disable-pip-version-check \
  --quiet \
  --require-hashes \
  --requirement "${repository_root}/packages/nemoclaw-hermes/fabric/runtime-requirements.lock"
"${hermes_adapter_python}" -m pip install \
  --disable-pip-version-check \
  --quiet \
  --require-hashes \
  --requirement "${hermes_adapter_lock}"
"${hermes_runner_python}" -m pip install \
  --disable-pip-version-check \
  --quiet \
  --no-index \
  --no-deps \
  "${runner_wheel}" \
  "${hermes_proxy_wheel}"
"${hermes_runner_python}" -m pip check
"${hermes_adapter_python}" -m pip check
NEMOCLAW_HERMES_ADAPTER_PYTHON="${hermes_adapter_python}" "${hermes_runner_python}" -I - <<'PY'
import os
import sys
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path
from unittest.mock import patch

from nemoclaw_hermes_fabric import adapter


def assert_missing(distribution_name: str) -> None:
    try:
        version(distribution_name)
    except PackageNotFoundError:
        return
    raise AssertionError(f"unexpected runner distribution: {distribution_name}")


assert version("nemoclaw-fabric") == "0.1.2"
assert version("nemoclaw-hermes-fabric") == "0.1.0"
assert_missing("nemo-fabric-adapters-hermes")
with patch.object(adapter.subprocess, "Popen") as start_process:
    adapter._start_supervisor()
command = start_process.call_args.args[0]
child_environment = start_process.call_args.kwargs["env"]
adapter_python = str(Path(os.environ["NEMOCLAW_HERMES_ADAPTER_PYTHON"]))
adapter_bin = str(Path(adapter_python).parent)
assert command[0] == sys.executable, (command, sys.executable)
assert command[-3:] == [
    adapter_python,
    "-m",
    adapter.OFFICIAL_ADAPTER_MODULE,
], command
assert child_environment["VIRTUAL_ENV"] == os.path.dirname(adapter_bin)
assert child_environment["PATH"].split(os.pathsep)[0] == adapter_bin
assert "PYTHONHOME" not in child_environment
PY
"${hermes_adapter_python}" -I - <<'PY'
from importlib.metadata import PackageNotFoundError, version

import nemo_fabric_adapters.hermes.adapter


def assert_missing(distribution_name: str) -> None:
    try:
        version(distribution_name)
    except PackageNotFoundError:
        return
    raise AssertionError(f"unexpected adapter distribution: {distribution_name}")


assert version("nemo-fabric-adapter-contract") == "0.2.0"
assert version("nemo-fabric-adapters-common") == "0.2.0"
assert version("nemo-fabric-adapters-hermes") == "0.2.0"
assert_missing("nemoclaw-fabric")
assert_missing("nemoclaw-hermes-fabric")
PY

hermes_lifecycle_dir="${work_dir}/hermes-split-lifecycle"
hermes_stub_dir="${hermes_lifecycle_dir}/stubs"
"${python_command}" - \
  "${hermes_lifecycle_dir}" \
  "${hermes_stub_dir}" \
  "${hermes_proxy_source}/hermes.fabric-adapter.json" <<'PY'
import json
import shutil
import sys
from pathlib import Path

case_dir = Path(sys.argv[1])
stub_dir = Path(sys.argv[2])
for relative, source in {
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
}.items():
    path = stub_dir / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(source, encoding="utf-8")
(case_dir / "workspace").mkdir(parents=True)
(case_dir / "artifacts").mkdir()
shutil.copyfile(sys.argv[3], case_dir / "hermes.fabric-adapter.json")
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
(case_dir / "fabric.json").write_text(json.dumps(config), encoding="utf-8")
PY
hermes_lifecycle_output="$(
  env -u ADAPTER_PYTHON -u PYTHONHOME \
    PYTHONDONTWRITEBYTECODE=1 \
    NEMOCLAW_HERMES_ADAPTER_PYTHON="${hermes_adapter_python}" \
    PYTHONPATH="${hermes_stub_dir}" \
    HERMES_FABRIC_API_KEY=fixture-only-value \
    "${hermes_runner_venv}/bin/nemoclaw-fabric-run" \
    --deadline-seconds 10 --kill-grace-seconds 2 \
    --config "${hermes_lifecycle_dir}/fabric.json" \
    -m split-venv-check --json
)"
HERMES_LIFECYCLE_OUTPUT="${hermes_lifecycle_output}" \
  HERMES_RUNNER_PYTHON="${hermes_runner_python}" \
  "${hermes_runner_python}" -I - <<'PY'
import json
import os
import shlex
from pathlib import Path

raw = os.environ["HERMES_LIFECYCLE_OUTPUT"]
result = json.loads(raw)
assert result["status"] == "succeeded", result
assert result["output"]["response"] == "split-venv-ok", result
host_python = shlex.split(result["metadata"]["host_command"])[0]
assert Path(host_python).resolve() == Path(os.environ["HERMES_RUNNER_PYTHON"]).resolve()
assert "fixture-only-value" not in raw
PY

for installed_command in nemoclaw-fabric nemoclaw-fabric-run; do
  if [[ ! -x "${venv_dir}/bin/${installed_command}" ]]; then
    echo "Installed runner wheel is missing executable ${installed_command}." >&2
    exit 1
  fi
done
"${venv_dir}/bin/nemoclaw-fabric-run" --help >/dev/null

cd "${repository_root}"
env -u PYTHONHOME -u PYTHONPATH \
  PYTHONDONTWRITEBYTECODE=1 VIRTUAL_ENV="${venv_dir}" PATH="${venv_dir}/bin:${PATH}" \
  "${venv_python}" -m unittest discover \
  -s packages/nemoclaw-fabric/tests/unit -p 'test_*.py' -v
env -u PYTHONHOME -u PYTHONPATH \
  PYTHONDONTWRITEBYTECODE=1 VIRTUAL_ENV="${venv_dir}" PATH="${venv_dir}/bin:${PATH}" \
  "${venv_python}" -m unittest \
  packages/nemoclaw-fabric/tests/integration/test_fabric.py -v
env -u PYTHONHOME -u PYTHONPATH \
  PYTHONDONTWRITEBYTECODE=1 VIRTUAL_ENV="${venv_dir}" PATH="${venv_dir}/bin:${PATH}" \
  "${venv_python}" -m unittest discover \
  -s packages/nemoclaw-langchain-deepagents-code/tests/fabric -p 'test_*.py' -v
env -u PYTHONHOME -u PYTHONPATH \
  PYTHONDONTWRITEBYTECODE=1 VIRTUAL_ENV="${venv_dir}" PATH="${venv_dir}/bin:${PATH}" \
  "${venv_python}" -m unittest discover \
  -s packages/nemoclaw-pi/tests/fabric -p 'test_*.py' -v
env -u PYTHONHOME -u PYTHONPATH \
  PYTHONDONTWRITEBYTECODE=1 VIRTUAL_ENV="${venv_dir}" PATH="${venv_dir}/bin:${PATH}" \
  "${venv_python}" -m unittest discover \
  -s packages/nemoclaw-openclaw/tests/fabric -p 'test_*.py' -v
env -u PYTHONHOME -u PYTHONPATH \
  PYTHONDONTWRITEBYTECODE=1 VIRTUAL_ENV="${venv_dir}" PATH="${venv_dir}/bin:${PATH}" \
  "${venv_python}" -m unittest discover \
  -s packages/nemoclaw-hermes/tests/fabric -p 'test_*.py' -v
"${venv_python}" -m pip check
