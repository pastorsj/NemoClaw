#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

package_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
repository_root="$(cd "${package_root}/../.." && pwd)"
work_dir="$(mktemp -d "${TMPDIR:-/tmp}/nemoclaw-pi-fabric-tests.XXXXXX")"

cleanup() {
  rm -rf -- "${work_dir}"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Build both first-party distributions from disposable copies. Setuptools may
# create build and egg-info directories beside its input; package tests must not
# dirty the source checkout or make generated metadata eligible for npm pack.
cp -R "${repository_root}/packages/nemoclaw-fabric" "${work_dir}/nemoclaw-fabric"
cp -R "${package_root}/fabric" "${work_dir}/nemoclaw-pi-fabric"
find "${work_dir}/nemoclaw-fabric" "${work_dir}/nemoclaw-pi-fabric" \
  -type d \( -name build -o -name '*.egg-info' -o -name __pycache__ \) \
  -prune -exec rm -rf -- {} +

cd "${package_root}"
PYTHONDONTWRITEBYTECODE=1 uv run \
  --isolated \
  --python 3.13 \
  --with-requirements fabric/requirements.lock \
  --with "${work_dir}/nemoclaw-fabric" \
  --with "${work_dir}/nemoclaw-pi-fabric" \
  python -m unittest discover -s tests/fabric -p 'test_*.py'
