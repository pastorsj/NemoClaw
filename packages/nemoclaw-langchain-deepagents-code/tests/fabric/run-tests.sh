#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

package_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
work_dir="$(mktemp -d "${TMPDIR:-/tmp}/nemoclaw-dcode-fabric-tests.XXXXXX")"
test_mode="${1:-adapter}"

case "${test_mode}" in
  adapter | composed) ;;
  *)
    printf 'usage: %s [adapter|composed] [nemoclaw-fabric-package]\n' "$0" >&2
    exit 64
    ;;
esac

cleanup() {
  rm -rf -- "${work_dir}"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

cd "${package_root}"
uv_args=(
  --isolated
  --python 3.13
  --with-requirements fabric/requirements.lock
)
test_args=(
  python3 -m unittest
  tests.fabric.test_turn.ReleasedDeepAgentsAdapterTests
  tests.fabric.test_image_order.FabricImageOrderTests
  tests.fabric.test_runtime_probe.FabricRuntimeProbeTests
)

if [ "${test_mode}" = "composed" ]; then
  runner_source="${NEMOCLAW_FABRIC_RUNNER_PATH:-${2:-}}"
  [ -n "${runner_source}" ] || {
    printf 'composed Fabric tests require an explicit nemoclaw-fabric package path\n' >&2
    exit 64
  }
  [ -f "${runner_source}/pyproject.toml" ] || {
    printf 'composed Fabric runner package is unavailable: %s\n' "${runner_source}" >&2
    exit 66
  }
  cp -R "${runner_source}" "${work_dir}/nemoclaw-fabric"
  find "${work_dir}/nemoclaw-fabric" \
    -type d \( -name build -o -name '*.egg-info' -o -name __pycache__ \) \
    -prune -exec rm -rf -- {} +
  uv_args+=(--with "${work_dir}/nemoclaw-fabric")
  test_args=(python3 -m unittest discover -s tests/fabric -p 'test_*.py')
fi

PYTHONDONTWRITEBYTECODE=1 uv run "${uv_args[@]}" "${test_args[@]}"
