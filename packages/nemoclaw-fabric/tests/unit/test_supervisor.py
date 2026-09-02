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
from collections.abc import Iterator
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

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

    def test_non_linux_hosts_do_not_require_the_subreaper_api(self) -> None:
        with (
            patch.object(supervisor.sys, "platform", "darwin"),
            patch.object(supervisor.ctypes, "CDLL") as load_libc,
        ):
            supervisor._enable_linux_child_subreaper()

        load_libc.assert_not_called()

    def test_non_linux_child_discovery_does_not_read_proc(self) -> None:
        with (
            patch.object(supervisor.sys, "platform", "darwin"),
            patch.object(supervisor.os, "scandir") as scandir,
        ):
            process_ids, discovery_complete = supervisor._direct_linux_children(
                worker_process_id=41
            )

        self.assertEqual(process_ids, set())
        self.assertTrue(discovery_complete)
        scandir.assert_not_called()

    def test_linux_subreaper_failure_prevents_an_unowned_worker(self) -> None:
        with (
            patch.object(
                supervisor,
                "_enable_linux_child_subreaper",
                side_effect=OSError("subreaper unavailable"),
            ),
            patch.object(supervisor.subprocess, "Popen") as popen,
        ):
            exit_code = supervisor.run_supervised(self.supervisor_arguments())

        self.assertEqual(exit_code, supervisor.EXIT_UNAVAILABLE)
        popen.assert_not_called()

    def test_linux_proc_scan_failure_is_not_treated_as_no_children(self) -> None:
        with (
            patch.object(supervisor.sys, "platform", "linux"),
            patch.object(
                supervisor.os,
                "scandir",
                side_effect=PermissionError("proc unavailable"),
            ),
        ):
            process_ids, discovery_complete = supervisor._direct_linux_children(
                worker_process_id=41
            )

        self.assertEqual(process_ids, set())
        self.assertFalse(discovery_complete)

    def test_unreadable_linux_proc_stat_is_not_treated_as_no_children(self) -> None:
        class ProcessEntries:
            def __enter__(self) -> ProcessEntries:
                return self

            def __exit__(self, *_args: object) -> None:
                return None

            def __iter__(self) -> Iterator[SimpleNamespace]:
                return iter([SimpleNamespace(name="42")])

        with (
            patch.object(supervisor.sys, "platform", "linux"),
            patch.object(supervisor.os, "scandir", return_value=ProcessEntries()),
            patch.object(
                supervisor.Path,
                "read_text",
                side_effect=PermissionError("stat unavailable"),
            ),
        ):
            process_ids, discovery_complete = supervisor._direct_linux_children(
                worker_process_id=41
            )

        self.assertEqual(process_ids, set())
        self.assertFalse(discovery_complete)

    def test_incomplete_linux_child_discovery_cannot_report_a_stopped_tree(self) -> None:
        process = Mock(pid=41)
        process.poll.return_value = 0
        with (
            patch.object(supervisor, "_process_group_exists", return_value=False),
            patch.object(
                supervisor,
                "_direct_linux_children",
                return_value=(set(), False),
            ),
        ):
            stopped = supervisor._wait_for_process_tree(
                process,
                deadline=time.monotonic(),
                adopted_signal=signal.SIGKILL,
            )

        self.assertFalse(stopped)

    def test_help_succeeds_without_starting_a_worker(self) -> None:
        for argument in ("-h", "--help"):
            with self.subTest(argument=argument):
                stdout = io.StringIO()
                with (
                    patch.object(supervisor.subprocess, "Popen") as popen,
                    patch.object(sys, "stdout", stdout),
                ):
                    exit_code = supervisor.run_supervised([argument])

                self.assertEqual(exit_code, supervisor.EXIT_SUCCESS)
                self.assertIn("usage: nemoclaw-fabric-run", stdout.getvalue())
                popen.assert_not_called()

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

    @unittest.skipUnless(sys.platform == "linux", "child subreapers require Linux")
    def test_forced_stop_reaps_a_frozen_nested_session_and_detached_child(self) -> None:
        process_marker = self.base_dir / "nested-processes.json"
        nested_source = "\n".join(
            [
                "import json, os, signal, subprocess, sys, time",
                "from pathlib import Path",
                "signal.signal(signal.SIGTERM, signal.SIG_IGN)",
                "child = subprocess.Popen(",
                "    [sys.executable, '-c', "
                "'import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(60)'],",
                "    start_new_session=True,",
                ")",
                f"Path({str(process_marker)!r}).write_text(",
                "    json.dumps({'owner': os.getpid(), 'child': child.pid}),",
                "    encoding='utf-8',",
                ")",
                "while True: time.sleep(1)",
            ]
        )
        worker_source = "\n".join(
            [
                "import signal, subprocess, sys, time",
                "signal.signal(signal.SIGTERM, signal.SIG_IGN)",
                "subprocess.Popen(",
                f"    [sys.executable, '-c', {nested_source!r}],",
                "    start_new_session=True,",
                ")",
                "while True: time.sleep(1)",
            ]
        )
        supervisor._enable_linux_child_subreaper()
        process = subprocess.Popen(
            [sys.executable, "-c", worker_source],
            start_new_session=True,
        )
        nested_owner: int | None = None
        detached_child: int | None = None
        try:
            deadline = time.monotonic() + 3
            while not process_marker.exists() and time.monotonic() < deadline:
                time.sleep(0.025)
            self.assertTrue(process_marker.exists())
            payload = json.loads(process_marker.read_text(encoding="utf-8"))
            nested_owner = int(payload["owner"])
            detached_child = int(payload["child"])
            os.killpg(nested_owner, signal.SIGSTOP)

            started_at = time.monotonic()
            supervisor._stop_process(process, 0.2)
            elapsed = time.monotonic() - started_at
        finally:
            for process_group in (process.pid, nested_owner, detached_child):
                if process_group is None:
                    continue
                try:
                    os.killpg(process_group, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            if process.poll() is None:
                process.kill()
                process.wait(timeout=2)

        self.assertLess(elapsed, 1.0)
        self.assert_process_stopped(process.pid)
        assert nested_owner is not None and detached_child is not None
        self.assert_process_stopped(nested_owner)
        self.assert_process_stopped(detached_child)

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
