#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

PACKAGE_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/nemoclaw-hermes-fabric-tests.XXXXXX")"
TEST_MODE="${1:-adapter}"

case "${TEST_MODE}" in
  adapter | composed) ;;
  *)
    printf 'usage: %s [adapter|composed]\n' "$0" >&2
    exit 64
    ;;
esac

cleanup() {
  rm -rf -- "${WORK_DIR}"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

cd "$PACKAGE_ROOT"

# Build the package-owned proxy from a disposable copy so setuptools does not
# leave metadata in the source checkout.
cp -R "${PACKAGE_ROOT}/fabric" "${WORK_DIR}/nemoclaw-hermes-fabric"
find "${WORK_DIR}/nemoclaw-hermes-fabric" \
  -type d \( -name build -o -name '*.egg-info' -o -name __pycache__ \) \
  -prune -exec rm -rf -- {} +

UV_ARGS=(
  --isolated
  --no-project
  --python 3.13
  --with-requirements fabric/runtime-requirements.lock
  --with-requirements fabric/adapter-requirements.lock
  --with "${WORK_DIR}/nemoclaw-hermes-fabric"
)
TEST_ARGS=(
  python3
  tests/fabric/test_adapter.py
  ReleasedHermesAdapterTests
  HermesProxyTests
)

if [ "${TEST_MODE}" = "composed" ]; then
  REPOSITORY_ROOT="$(cd "${PACKAGE_ROOT}/../.." && pwd)"
  RUNNER_SOURCE="${NEMOCLAW_FABRIC_RUNNER_PATH:-${REPOSITORY_ROOT}/packages/nemoclaw-fabric}"
  [ -f "${RUNNER_SOURCE}/pyproject.toml" ] || {
    printf 'composed Fabric tests require packages/nemoclaw-fabric in the NemoClaw checkout\n' >&2
    exit 66
  }
  cp -R "${RUNNER_SOURCE}" "${WORK_DIR}/nemoclaw-fabric"
  find "${WORK_DIR}/nemoclaw-fabric" \
    -type d \( -name build -o -name '*.egg-info' -o -name __pycache__ \) \
    -prune -exec rm -rf -- {} +
  UV_ARGS+=(--with "${WORK_DIR}/nemoclaw-fabric")
  TEST_ARGS=(python3 -m unittest discover -s tests/fabric -p 'test_*.py')
fi

PYTHONDONTWRITEBYTECODE=1 uv run "${UV_ARGS[@]}" "${TEST_ARGS[@]}"

if [ "${TEST_MODE}" = "composed" ]; then
  PYTHONDONTWRITEBYTECODE=1 uv run \
    --isolated \
    --no-project \
    --python 3.13 \
    python3 tests/fabric/split_venv.py --runner-source "${RUNNER_SOURCE}"
fi
