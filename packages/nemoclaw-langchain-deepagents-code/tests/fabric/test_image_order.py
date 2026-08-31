# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Package-owned source-order checks for the Fabric image layer."""

from __future__ import annotations

import unittest
from pathlib import Path


class FabricImageOrderTests(unittest.TestCase):
    """Keep managed wrapper probes behind their trusted route inputs."""

    def test_dcode_wrapper_probe_runs_after_proxy_files_are_installed(self) -> None:
        dockerfile = Path(__file__).resolve().parents[2].joinpath("Dockerfile").read_text(
            encoding="utf-8"
        )
        fabric_layer_start = dockerfile.index("# Build the first-party generic runner")
        fabric_layer_end = dockerfile.index("ARG NEMOCLAW_MODEL", fabric_layer_start)
        proxy_files = dockerfile.index(
            'printf \'%s\\n\' "$NEMOCLAW_PROXY_HOST" > '
            "/usr/local/share/nemoclaw/dcode-proxy-host"
        )
        configured_probe = dockerfile.index(
            "env -i /usr/local/bin/dcode --version",
            proxy_files,
        )

        self.assertNotIn(
            "/usr/local/bin/dcode --version",
            dockerfile[fabric_layer_start:fabric_layer_end],
        )
        self.assertGreater(configured_probe, proxy_files)


if __name__ == "__main__":
    unittest.main()
