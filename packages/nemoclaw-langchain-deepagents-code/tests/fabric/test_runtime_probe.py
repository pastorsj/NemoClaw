# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Exercise the DCode package's base-image Fabric runtime check."""

from __future__ import annotations

import hashlib
import importlib.util
import subprocess
import sys
import unittest
from pathlib import Path
from types import ModuleType
from unittest.mock import patch

PACKAGE_ROOT = Path(__file__).resolve().parents[2]
FABRIC_RUNTIME_CHECK = PACKAGE_ROOT / "checks" / "fabric-runtime.py"
PROBE_OK = "nemoclaw-dcode-fabric-runtime-ok"


def load_runtime_check() -> ModuleType:
    """Load the hyphenated package check without running its command entrypoint."""

    spec = importlib.util.spec_from_file_location(
        "nemoclaw_dcode_fabric_runtime_check", FABRIC_RUNTIME_CHECK
    )
    if spec is None or spec.loader is None:
        raise AssertionError("could not load the Fabric runtime check")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class FabricRuntimeProbeTests(unittest.TestCase):
    """Keep the base-image check aligned with the package's hash-locked graph."""

    def test_accepts_the_locked_fabric_distributions(self) -> None:
        first_line = FABRIC_RUNTIME_CHECK.read_text(encoding="utf-8").splitlines()[0]
        self.assertEqual(first_line, "#!/opt/nemoclaw-fabric-venv/bin/python3 -I")

        completed = subprocess.run(
            [sys.executable, "-I", str(FABRIC_RUNTIME_CHECK)],
            check=False,
            capture_output=True,
            text=True,
        )

        self.assertEqual(completed.returncode, 0, completed.stderr)
        expected_digest = hashlib.sha256(FABRIC_RUNTIME_CHECK.read_bytes()).hexdigest()
        self.assertEqual(completed.stdout, f"{PROBE_OK} {expected_digest}\n")

    def test_rejects_a_distribution_version_mismatch(self) -> None:
        runtime_check = load_runtime_check()

        with patch.object(runtime_check.metadata, "version", return_value="0.0.0"):
            self.assertEqual(runtime_check.main(), 1)

    def test_rejects_a_missing_distribution(self) -> None:
        runtime_check = load_runtime_check()

        with patch.object(
            runtime_check.metadata,
            "version",
            side_effect=runtime_check.metadata.PackageNotFoundError("missing"),
        ):
            self.assertEqual(runtime_check.main(), 1)


if __name__ == "__main__":
    unittest.main()
