#!/opt/nemoclaw-fabric-venv/bin/python3 -I
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Validate the package-owned requirements of a DCode base image."""

from __future__ import annotations

import hashlib
import subprocess
from importlib import metadata
from pathlib import Path

EXPECTED_FABRIC_DISTRIBUTIONS = {
    "deepagents": "0.6.12",
    "langchain-mcp-adapters": "0.2.2",
    "nemo-fabric": "0.2.0",
    "nemo-fabric-adapter-contract": "0.2.0",
    "nemo-fabric-adapters-common": "0.2.0",
    "nemo-fabric-adapters-deepagents": "0.2.0",
    "nemo-fabric-runtime": "0.2.0",
}
EXPECTED_DCODE_VERSION = "0.1.55"
PROBE_OK = "nemoclaw-image-probe-ok"


def fabric_versions_match() -> bool:
    """Return true when the isolated Fabric environment matches its lock."""

    try:
        installed = {
            name: metadata.version(name) for name in EXPECTED_FABRIC_DISTRIBUTIONS
        }
    except metadata.PackageNotFoundError:
        return False
    return installed == EXPECTED_FABRIC_DISTRIBUTIONS


def dcode_version_matches() -> bool:
    """Check the separately isolated native DCode environment."""

    result = subprocess.run(
        [
            "/opt/venv/bin/python3",
            "-I",
            "-c",
            "import importlib.metadata as m; print(m.version('deepagents-code'))",
        ],
        capture_output=True,
        check=False,
        text=True,
    )
    return result.returncode == 0 and result.stdout.strip() == EXPECTED_DCODE_VERSION


def dos2unix_is_usable() -> bool:
    """Require the workspace conversion tool used by DCode workflows."""

    executable = Path("/usr/bin/dos2unix")
    if not executable.is_file():
        return False
    result = subprocess.run(
        [str(executable), "--version"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=False,
    )
    return result.returncode == 0


def main() -> int:
    """Emit a source-bound marker only when every package requirement passes."""

    if not fabric_versions_match() or not dcode_version_matches() or not dos2unix_is_usable():
        return 1
    source_digest = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    print(f"{PROBE_OK} {source_digest}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
