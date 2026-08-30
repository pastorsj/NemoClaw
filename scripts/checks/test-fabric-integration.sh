#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
python_command="${PYTHON_313:-python3.13}"
fabric_lock="${repository_root}/agents/langchain-deepagents-code/fabric-requirements.lock"
runner_source="${repository_root}/packages/nemoclaw-fabric"
runner_build_lock="${runner_source}/build-requirements.lock"

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
wheel_dir="${work_dir}/wheels"
runner_build_source="${work_dir}/runner-source"
"${python_command}" -m venv "${venv_dir}"
mkdir -p "${wheel_dir}"
mkdir -p "${runner_build_source}"
cp "${runner_source}/README.md" "${runner_source}/pyproject.toml" "${runner_build_source}/"
cp -R "${runner_source}/src" "${runner_build_source}/src"
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
  "${runner_build_source}"
"${venv_python}" -m pip install \
  --disable-pip-version-check \
  --quiet \
  --require-hashes \
  --requirement "${fabric_lock}"

runner_wheel="$(find "${wheel_dir}" -maxdepth 1 -type f -name 'nemoclaw_fabric-*.whl' -print)"
if [[ -z "${runner_wheel}" || "${runner_wheel}" == *$'\n'* ]]; then
  echo "Expected one nemoclaw-fabric wheel in ${wheel_dir}." >&2
  exit 1
fi
"${venv_python}" -m pip install \
  --disable-pip-version-check \
  --quiet \
  --no-index \
  --no-deps \
  "${runner_wheel}"
"${venv_python}" -I - <<'PY'
from importlib.metadata import requires, version

assert version("nemoclaw-fabric") == "0.1.1"
declared = [item.replace(" ", "") for item in (requires("nemoclaw-fabric") or [])]
runtime = [item for item in declared if ";extra==" not in item]
optional = sorted(item for item in declared if ";extra==" in item)
assert runtime == ["nemo-fabric==0.2.0"], declared
assert optional == [
    'nemo-fabric-adapter-contract==0.2.0;extra=="test"',
    'nemo-fabric-adapters-common==0.2.0;extra=="test"',
], declared
PY

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
  -s agents/langchain-deepagents-code/tests/fabric -p 'test_*.py' -v
"${venv_python}" -m pip check
