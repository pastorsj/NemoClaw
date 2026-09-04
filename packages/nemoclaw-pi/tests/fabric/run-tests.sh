#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

package_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
work_dir="$(mktemp -d "${TMPDIR:-/tmp}/nemoclaw-pi-fabric-tests.XXXXXX")"
test_mode="${1:-adapter}"

case "${test_mode}" in
  adapter | composed) ;;
  *)
    printf 'usage: %s [adapter|composed]\n' "$0" >&2
    exit 64
    ;;
esac

cleanup() {
  rm -rf -- "${work_dir}"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Build the adapter from a disposable copy. Setuptools may create build and
# egg-info directories beside its input; package tests must not dirty the source
# checkout or make generated metadata eligible for npm pack.
cp -R "${package_root}/fabric" "${work_dir}/nemoclaw-pi-fabric"
find "${work_dir}/nemoclaw-pi-fabric" \
  -type d \( -name build -o -name '*.egg-info' -o -name __pycache__ \) \
  -prune -exec rm -rf -- {} +

cd "${package_root}"
uv_args=(
  --isolated
  --python 3.13
  --with-requirements fabric/requirements.lock
  --with "${work_dir}/nemoclaw-pi-fabric"
)
test_args=(python tests/fabric/test_adapter.py PiRuntimeTests)

if [ "${test_mode}" = composed ]; then
  repository_root="$(cd "${package_root}/../.." && pwd)"
  runner_source="${NEMOCLAW_FABRIC_RUNNER_PATH:-${repository_root}/packages/nemoclaw-fabric}"
  [ -f "${runner_source}/pyproject.toml" ] || {
    printf 'composed Fabric tests require packages/nemoclaw-fabric in the NemoClaw checkout\n' >&2
    exit 66
  }
  cp -R "${runner_source}" "${work_dir}/nemoclaw-fabric"
  find "${work_dir}/nemoclaw-fabric" \
    -type d \( -name build -o -name '*.egg-info' -o -name __pycache__ \) \
    -prune -exec rm -rf -- {} +
  uv_args+=(--with "${work_dir}/nemoclaw-fabric")
  test_args=(python -m unittest discover -s tests/fabric -p 'test_*.py')
fi

PYTHONDONTWRITEBYTECODE=1 uv run "${uv_args[@]}" "${test_args[@]}"
