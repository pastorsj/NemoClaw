#!/opt/nemoclaw-fabric-venv/bin/python3 -I
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Check the Fabric dependency graph installed in the DCode base image."""

from __future__ import annotations

import hashlib
from importlib import metadata
from pathlib import Path

EXPECTED_DISTRIBUTIONS = {
    "deepagents": "0.6.12",
    "langchain-mcp-adapters": "0.2.2",
    "nemo-fabric": "0.2.0",
    "nemo-fabric-adapter-contract": "0.2.0",
    "nemo-fabric-adapters-common": "0.2.0",
    "nemo-fabric-adapters-deepagents": "0.2.0",
    "nemo-fabric-runtime": "0.2.0",
}
PROBE_OK = "nemoclaw-dcode-fabric-runtime-ok"


def installed_versions_match() -> bool:
    """Return true when each installed distribution matches the package lock."""

    try:
        installed = {name: metadata.version(name) for name in EXPECTED_DISTRIBUTIONS}
    except metadata.PackageNotFoundError:
        return False
    return installed == EXPECTED_DISTRIBUTIONS


def main() -> int:
    """Emit the stable base-image marker only for the reviewed dependency graph."""

    if not installed_versions_match():
        return 1
    source_digest = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    print(f"{PROBE_OK} {source_digest}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
