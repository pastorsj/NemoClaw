# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Installed-package boundary tests for the generic Fabric runner."""

from __future__ import annotations

import unittest
from importlib.metadata import entry_points
from importlib.metadata import metadata
from importlib.metadata import requires
from importlib.metadata import version


class InstalledRunnerPackageTests(unittest.TestCase):
    """Verify the independently installable runner artifact."""

    def test_metadata_pins_the_released_fabric_contract(self) -> None:
        self.assertEqual(version("nemoclaw-fabric"), "0.1.2")
        self.assertEqual(metadata("nemoclaw-fabric")["Requires-Python"], "<3.14,>=3.13")

        declared = [item.replace(" ", "") for item in (requires("nemoclaw-fabric") or [])]
        runtime = [item for item in declared if ";extra==" not in item]
        optional = sorted(item for item in declared if ";extra==" in item)
        self.assertEqual(runtime, ["nemo-fabric==0.2.0"])
        self.assertEqual(
            optional,
            [
                'nemo-fabric-adapter-contract==0.2.0;extra=="test"',
                'nemo-fabric-adapters-common==0.2.0;extra=="test"',
            ],
        )

    def test_console_commands_are_installed(self) -> None:
        commands = {
            point.name: point.value
            for point in entry_points(group="console_scripts")
            if point.dist and point.dist.name == "nemoclaw-fabric"
        }
        self.assertEqual(
            commands,
            {
                "nemoclaw-fabric": "nemoclaw_fabric.command:main",
                "nemoclaw-fabric-run": "nemoclaw_fabric.supervisor:main",
            },
        )


if __name__ == "__main__":
    unittest.main()
