# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Tests for the parent-owned Fabric deadline and cleanup boundary."""

from __future__ import annotations

import io
import json
import os
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from nemoclaw_fabric import supervisor


class FabricRunSupervisorTests(unittest.TestCase):
    """Keep the worker identity, process group, and request cleanup bound together."""

    def setUp(self) -> None:
        self._temporary_directory = tempfile.TemporaryDirectory()
        self.addCleanup(self._temporary_directory.cleanup)
        self.base_dir = Path(self._temporary_directory.name)
        self.artifacts = self.base_dir / "artifacts"
        self.workspace = self.base_dir / "workspace"
        self.artifacts.mkdir(mode=0o700)
        self.workspace.mkdir(mode=0o700)
        self.config_path = self.base_dir / "fabric.json"
        self.write_config("test.supervisor.initial")

    def write_config(self, adapter_id: str) -> None:
        self.config_path.write_text(
            json.dumps(
                {
                    "metadata": {"name": "supervisor-test"},
                    "harness": {"adapter_id": adapter_id},
                    "runtime": {
                        "artifacts": "./artifacts",
                        "timeout_seconds": 30,
                    },
                    "environment": {
                        "provider": "local",
                        "workspace": "./workspace",
                        "artifacts": "./artifacts",
                    },
                }
            ),
            encoding="utf-8",
        )

    def supervisor_arguments(self) -> list[str]:
        return [
            "--deadline-seconds",
            "2",
            "--kill-grace-seconds",
            "0.25",
            "--config",
            str(self.config_path),
            "-m",
            "bounded test prompt",
            "--json",
        ]

    def assert_process_stopped(self, process_id: int) -> None:
        with self.assertRaises(ProcessLookupError):
            os.kill(process_id, 0)

    def test_worker_rejects_a_config_changed_after_parent_validation(self) -> None:
        original_popen = subprocess.Popen
        children: list[subprocess.Popen[bytes]] = []

        def mutate_then_spawn(
            command: list[str],
            **options: object,
        ) -> subprocess.Popen[bytes]:
            self.write_config("test.supervisor.changed")
            child = original_popen(
                command,
                **options,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            )
            children.append(child)
            return child

        with patch.object(supervisor.subprocess, "Popen", side_effect=mutate_then_spawn):
            exit_code = supervisor.run_supervised(self.supervisor_arguments())

        self.assertEqual(exit_code, supervisor.EXIT_USAGE)
        self.assertEqual(len(children), 1)
        stdout, stderr = children[0].communicate(timeout=2)
        output = stdout.decode("utf-8") + stderr.decode("utf-8")
        self.assertIn("changed after the request supervisor validated it", output)
        self.assertNotIn("test.supervisor.changed", output)
        self.assertNotIn("bounded test prompt", output)
        self.assertEqual(list(self.artifacts.iterdir()), [])

    @unittest.skipUnless(os.name == "posix", "process-group signals require POSIX")
    def test_signal_received_during_spawn_stops_worker_before_cleanup(self) -> None:
        original_popen = subprocess.Popen
        children: list[subprocess.Popen[bytes]] = []

        def spawn_then_signal(
            _command: list[str],
            **options: object,
        ) -> subprocess.Popen[bytes]:
            child = original_popen(
                [sys.executable, "-c", "import time; time.sleep(60)"],
                env=options.get("env"),
                start_new_session=bool(options.get("start_new_session")),
            )
            children.append(child)
            retained = self.artifacts / f".nemoclaw-run-{child.pid}-signal"
            retained.mkdir(mode=0o700)
            (retained / "request.txt").write_text(
                "signal cleanup sentinel",
                encoding="utf-8",
            )
            os.kill(os.getpid(), signal.SIGTERM)
            return child

        with patch.object(supervisor.subprocess, "Popen", side_effect=spawn_then_signal):
            exit_code = supervisor.run_supervised(self.supervisor_arguments())

        self.assertEqual(exit_code, 128 + signal.SIGTERM)
        self.assertEqual(len(children), 1)
        self.assert_process_stopped(children[0].pid)
        self.assertEqual(list(self.artifacts.iterdir()), [])

    @unittest.skipUnless(os.name == "posix", "process-group signals require POSIX")
    def test_term_ignoring_process_group_is_killed_after_one_grace_period(self) -> None:
        descendant_marker = self.base_dir / "descendant.pid"
        script = "\n".join(
            [
                "import signal, subprocess, sys, time",
                "from pathlib import Path",
                "signal.signal(signal.SIGTERM, signal.SIG_IGN)",
                "child = subprocess.Popen([sys.executable, '-c', "
                "'import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(60)'])",
                f"Path({str(descendant_marker)!r}).write_text(str(child.pid), encoding='ascii')",
                "while True: time.sleep(1)",
            ]
        )
        process = subprocess.Popen(
            [sys.executable, "-c", script],
            start_new_session=True,
        )
        try:
            deadline = time.monotonic() + 3
            while not descendant_marker.exists() and time.monotonic() < deadline:
                time.sleep(0.025)
            self.assertTrue(descendant_marker.exists())
            started_at = time.monotonic()
            supervisor._stop_process(process, 0.2)
            elapsed = time.monotonic() - started_at
        finally:
            if process.poll() is None:
                process.kill()
                process.wait(timeout=2)

        self.assertLess(elapsed, 0.75)
        self.assert_process_stopped(process.pid)
        self.assertFalse(supervisor._process_group_exists(process.pid))

    def test_cleanup_failure_cannot_be_reported_as_success_or_echo_details(self) -> None:
        original_popen = subprocess.Popen
        stderr = io.StringIO()

        def spawn_success(
            _command: list[str],
            **options: object,
        ) -> subprocess.Popen[bytes]:
            return original_popen(
                [sys.executable, "-c", "pass"],
                env=options.get("env"),
                start_new_session=bool(options.get("start_new_session")),
            )

        with (
            patch.object(supervisor.subprocess, "Popen", side_effect=spawn_success),
            patch.object(
                supervisor,
                "remove_process_artifacts",
                side_effect=OSError("cleanup-secret-sentinel"),
            ),
            patch.object(sys, "stderr", stderr),
        ):
            exit_code = supervisor.run_supervised(self.supervisor_arguments())

        self.assertEqual(exit_code, supervisor.EXIT_FAILURE)
        self.assertIn("failed to remove private Fabric request artifacts", stderr.getvalue())
        self.assertNotIn("cleanup-secret-sentinel", stderr.getvalue())
        self.assertNotIn("bounded test prompt", stderr.getvalue())


if __name__ == "__main__":
    unittest.main()
