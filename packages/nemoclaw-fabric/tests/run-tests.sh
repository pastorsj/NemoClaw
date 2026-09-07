#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

package_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
work_dir="$(mktemp -d "${TMPDIR:-/tmp}/nemoclaw-fabric-runner-tests.XXXXXX")"

cleanup() {
  rm -rf -- "${work_dir}"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Install a disposable source copy so tests exercise package metadata and
# console entry points without leaving build metadata in the checkout.
runner_source="${work_dir}/nemoclaw-fabric"
mkdir -p "${runner_source}"
cp "${package_root}/README.md" "${package_root}/pyproject.toml" "${runner_source}/"
cp -R "${package_root}/src" "${runner_source}/src"

uv_args=(
  --isolated
  --no-project
  --python 3.13
  --with-requirements "${package_root}/test-requirements.lock"
  --with "${runner_source}"
)

env -u PYTHONHOME -u PYTHONPATH \
  PYTHONDONTWRITEBYTECODE=1 \
  uv run "${uv_args[@]}" python -m unittest discover \
  -s "${package_root}/tests/unit" -p 'test_*.py' -v
env -u PYTHONHOME -u PYTHONPATH \
  PYTHONDONTWRITEBYTECODE=1 \
  uv run "${uv_args[@]}" python -m unittest \
  "${package_root}/tests/integration/test_fabric.py" -v
