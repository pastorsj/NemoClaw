# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Exercise the OpenClaw adapter through direct and generic Fabric boundaries."""

from __future__ import annotations

import asyncio
import io
import json
import os
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch


OPENCLAW_ROOT = Path(__file__).resolve().parents[2]
FABRIC_SOURCE = OPENCLAW_ROOT / "fabric" / "src"
FABRIC_RUN_SUPERVISOR = shutil.which("nemoclaw-fabric-run")
sys.path.insert(0, str(FABRIC_SOURCE))

from nemo_fabric_adapter_contract.models import AgentConfig  # noqa: E402
from nemo_fabric_adapter_contract.models import AgentRunRequest  # noqa: E402
from nemo_fabric_adapter_contract.models import AgentRunStatus  # noqa: E402
from nemo_fabric_adapter_contract.models import RuntimeContext  # noqa: E402
from nemoclaw_openclaw_fabric import adapter as openclaw_adapter  # noqa: E402
from nemoclaw_openclaw_fabric.adapter import ADAPTER_ID  # noqa: E402
from nemoclaw_openclaw_fabric.adapter import OpenClawRuntime  # noqa: E402
from nemoclaw_openclaw_fabric.adapter import (  # noqa: E402
    PROCESS_STREAM_CAPTURE_LIMIT_BYTES,
)
from nemoclaw_openclaw_fabric.adapter import SESSION_PREFIX  # noqa: E402
from nemoclaw_openclaw_fabric.process import INVALID_USAGE_EXIT  # noqa: E402
from nemoclaw_openclaw_fabric.process import run as run_process_wrapper  # noqa: E402


DEFAULT_RESPONSE = {
    "runId": "fixture-openclaw-run",
    "status": "ok",
    "summary": "completed",
    "result": {
        "payloads": [{"text": "deterministic OpenClaw response"}],
        "meta": {"livenessState": "working"},
    },
}


def _generic_runner() -> tuple[int, int, object]:
    """Load the NemoClaw-owned runner only in the composed test lane."""

    from nemoclaw_fabric.command import EXIT_FAILURE
    from nemoclaw_fabric.command import EXIT_SUCCESS
    from nemoclaw_fabric.command import run_cli

    return EXIT_FAILURE, EXIT_SUCCESS, run_cli
FAKE_OPENCLAW_SOURCE = r'''#!/usr/bin/env python3
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import time

args = sys.argv[1:]
mode = os.environ.get("NEMOCLAW_FAKE_OPENCLAW_MODE", "success")
args_marker = os.environ.get("NEMOCLAW_FAKE_OPENCLAW_ARGS")
if args_marker:
    Path(args_marker).write_text(json.dumps(args), encoding="utf-8")
environment_marker = os.environ.get("NEMOCLAW_FAKE_OPENCLAW_ENV")
if environment_marker:
    names = [
        "OPENCLAW_GATEWAY_URL",
        "OPENCLAW_GATEWAY_TOKEN",
        "OPENCLAW_GATEWAY_PASSWORD",
        "OPENCLAW_ALLOW_INSECURE_PRIVATE_WS",
        "OPENCLAW_GATEWAY_PORT",
        "NEMOCLAW_OPENCLAW_GATEWAY_URL",
    ]
    Path(environment_marker).write_text(
        json.dumps({name: name in os.environ for name in names}),
        encoding="utf-8",
    )

try:
    prompt_path = Path(args[args.index("--message-file") + 1])
except (ValueError, IndexError):
    raise SystemExit(65)
prompt = prompt_path.read_text(encoding="utf-8")
prompt_marker = os.environ.get("NEMOCLAW_FAKE_OPENCLAW_PROMPT")
if prompt_marker:
    Path(prompt_marker).write_text(
        json.dumps({
            "mode": stat.S_IMODE(prompt_path.stat().st_mode),
            "path": str(prompt_path),
            "text": prompt,
        }),
        encoding="utf-8",
    )

default_response = {
    "runId": "fixture-openclaw-run",
    "status": "ok",
    "summary": "completed",
    "result": {
        "payloads": [{"text": "deterministic OpenClaw response"}],
        "meta": {"livenessState": "working"},
    },
}

if mode == "success":
    print(os.environ.get("NEMOCLAW_FAKE_OPENCLAW_RESPONSE", json.dumps(default_response)))
    raise SystemExit(0)
if mode == "failure":
    secret = os.environ.get("NEMOCLAW_FAKE_OPENCLAW_SECRET", "missing-secret")
    print(f"fake OpenClaw stdout failed with {secret}")
    print(f"fake OpenClaw stderr failed with {secret}", file=sys.stderr)
    raise SystemExit(23)
if mode == "gateway_auth_failure":
    secret = os.environ.get("NEMOCLAW_FAKE_OPENCLAW_SECRET", "missing-secret")
    print(
        f"GatewayCredentialsRequiredError: gateway agent requires credentials {secret}",
        file=sys.stderr,
    )
    raise SystemExit(1)
if mode == "embedded_fallback":
    secret = os.environ.get("NEMOCLAW_FAKE_OPENCLAW_SECRET", "missing-secret")
    marker = os.environ.get("NEMOCLAW_FAKE_OPENCLAW_FALLBACK_MARKER", "EMBEDDED FALLBACK:")
    print(f"{marker} gateway failed with {secret}", file=sys.stderr)
    print(json.dumps(default_response))
    raise SystemExit(0)
if mode == "hang":
    child = subprocess.Popen(
        [sys.executable, "-c", "import time; time.sleep(300)"],
        start_new_session=sys.platform.startswith("linux"),
    )
    marker = os.environ.get("NEMOCLAW_FAKE_OPENCLAW_PIDS")
    if marker:
        Path(marker).write_text(
            json.dumps({
                "parent": os.getpid(),
                "parent_group": os.getpgrp(),
                "child": child.pid,
                "child_group": os.getpgid(child.pid),
            }),
            encoding="utf-8",
        )
    while True:
        time.sleep(60)
if mode == "hang_without_child":
    marker = os.environ.get("NEMOCLAW_FAKE_OPENCLAW_PIDS")
    if marker:
        Path(marker).write_text(
            json.dumps({
                "parent": os.getpid(),
                "parent_group": os.getpgrp(),
            }),
            encoding="utf-8",
        )
    while True:
        time.sleep(60)
if mode == "background":
    child = subprocess.Popen(
        [sys.executable, "-c", "import time; time.sleep(300)"],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=sys.platform.startswith("linux"),
    )
    marker = os.environ.get("NEMOCLAW_FAKE_OPENCLAW_PIDS")
    if marker:
        Path(marker).write_text(
            json.dumps({
                "parent": os.getpid(),
                "parent_group": os.getpgrp(),
                "child": child.pid,
                "child_group": os.getpgid(child.pid),
            }),
            encoding="utf-8",
        )
    print(json.dumps(default_response))
    raise SystemExit(0)
if mode in {"oversized_stdout", "oversized_stderr"}:
    child = subprocess.Popen(
        [sys.executable, "-c", "import time; time.sleep(300)"],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=sys.platform.startswith("linux"),
    )
    marker = os.environ.get("NEMOCLAW_FAKE_OPENCLAW_PIDS")
    if marker:
        Path(marker).write_text(
            json.dumps({
                "parent": os.getpid(),
                "parent_group": os.getpgrp(),
                "child": child.pid,
                "child_group": os.getpgid(child.pid),
            }),
            encoding="utf-8",
        )
    secret = os.environ.get("NEMOCLAW_FAKE_OPENCLAW_SECRET", "missing-secret")
    output_bytes = int(os.environ["NEMOCLAW_FAKE_OPENCLAW_OUTPUT_BYTES"])
    encoded_secret = secret.encode("utf-8")
    payload = encoded_secret + (b"x" * (output_bytes - len(encoded_secret)))
    stream = sys.stdout.buffer if mode == "oversized_stdout" else sys.stderr.buffer
    stream.write(payload)
    stream.flush()
    while True:
        time.sleep(60)
raise SystemExit(64)
'''


def _agent_config() -> AgentConfig:
    return AgentConfig.from_mapping({"models": {}})


def _runtime_context(workspace: Path, artifacts: Path) -> RuntimeContext:
    return RuntimeContext.from_mapping(
        {
            "runtime_id": "openclaw-runtime",
            "invocation_id": "openclaw-invocation",
            "request_id": "openclaw-request",
            "environment": {
                "environment_id": "openclaw-local",
                "provider": "local",
                "control_location": "in_env_control",
                "workspace": str(workspace),
                "artifacts": str(artifacts),
                "ownership": "caller_owned",
            },
            "artifacts": {"root": str(artifacts), "artifacts": []},
        }
    )


def _request(value: object = "Review the workspace") -> AgentRunRequest:
    return AgentRunRequest.from_mapping({"input": value, "context": {}})


def _process_is_active(process_id: int) -> bool:
    if sys.platform.startswith("linux"):
        try:
            suffix = Path(f"/proc/{process_id}/stat").read_text(
                encoding="ascii"
            ).rsplit(")", 1)[1].strip()
        except (IndexError, OSError):
            return False
        return bool(suffix) and suffix.split(maxsplit=1)[0] != "Z"
    result = subprocess.run(
        ["ps", "-o", "stat=", "-p", str(process_id)],
        check=False,
        capture_output=True,
        text=True,
    )
    state = result.stdout.strip()
    return result.returncode == 0 and bool(state) and not state.startswith("Z")


def _wait_for_stopped(process_ids: list[int]) -> None:
    for _attempt in range(200):
        if all(not _process_is_active(process_id) for process_id in process_ids):
            return
        time.sleep(0.025)
    active = [process_id for process_id in process_ids if _process_is_active(process_id)]
    raise AssertionError(f"OpenClaw fixture processes remain active: {active}")


def _wait_for_removed(path: Path) -> None:
    for _attempt in range(200):
        if not path.exists():
            return
        time.sleep(0.025)
    raise AssertionError(f"OpenClaw private prompt remains: {path}")


class OpenClawFixtureMixin:
    """Create one fake OpenClaw executable and normalized Fabric inputs."""

    def setUp(self) -> None:
        super().setUp()  # type: ignore[misc]
        self._temporary_directory = tempfile.TemporaryDirectory()
        self.addCleanup(self._temporary_directory.cleanup)
        self.base_dir = Path(self._temporary_directory.name)
        self.workspace = self.base_dir / "workspace"
        self.artifacts = self.base_dir / "artifacts"
        self.fake_bin = self.base_dir / "bin"
        self.workspace.mkdir()
        self.artifacts.mkdir()
        self.fake_bin.mkdir()
        self.fake_openclaw = self.fake_bin / "openclaw"
        self.fake_openclaw.write_text(FAKE_OPENCLAW_SOURCE, encoding="utf-8")
        self.fake_openclaw.chmod(
            self.fake_openclaw.stat().st_mode
            | stat.S_IXUSR
            | stat.S_IXGRP
            | stat.S_IXOTH
        )
        self.args_marker = self.base_dir / "openclaw-args.json"
        self.prompt_marker = self.base_dir / "openclaw-prompt.json"
        self.pid_marker = self.base_dir / "openclaw-pids.json"
        self.environment_marker = self.base_dir / "openclaw-environment.json"
        self.environment = {
            "PATH": f"{self.fake_bin}{os.pathsep}{os.environ.get('PATH', '')}",
            "NEMOCLAW_FAKE_OPENCLAW_ARGS": str(self.args_marker),
            "NEMOCLAW_FAKE_OPENCLAW_PROMPT": str(self.prompt_marker),
            "NEMOCLAW_FAKE_OPENCLAW_PIDS": str(self.pid_marker),
            "NEMOCLAW_FAKE_OPENCLAW_ENV": str(self.environment_marker),
        }

    async def start_runtime(self) -> OpenClawRuntime:
        runtime = OpenClawRuntime()
        await runtime.start(
            {
                "agent_name": "openclaw-test",
                "base_dir": str(self.base_dir),
                "config": _agent_config(),
                "runtime_context": _runtime_context(self.workspace, self.artifacts),
            }
        )
        return runtime

    async def wait_for_pid_marker(self) -> list[int]:
        for _attempt in range(200):
            if self.pid_marker.exists():
                payload = json.loads(self.pid_marker.read_text(encoding="utf-8"))
                if sys.platform.startswith("linux"):
                    self.assertEqual(payload["child_group"], payload["child"])
                    self.assertNotEqual(
                        payload["child_group"], payload["parent_group"]
                    )
                return [payload["parent"], payload["child"]]
            await asyncio.sleep(0.025)
        self.fail("fake OpenClaw did not record its process group")  # type: ignore[attr-defined]

    def recorded_prompt(self) -> dict[str, object]:
        return json.loads(self.prompt_marker.read_text(encoding="utf-8"))


class OpenClawRuntimeTests(OpenClawFixtureMixin, unittest.IsolatedAsyncioTestCase):
    """Verify gateway translation, response validation, and process ownership."""

    async def test_success_waits_for_exit_status_after_pipe_eof(self) -> None:
        class CompletedProcess:
            pid = 12345
            returncode: int | None = None
            wait_calls = 0

            async def wait(self) -> int:
                self.wait_calls += 1
                self.returncode = 0
                return self.returncode

        process = CompletedProcess()

        async def spawn_process(*_args: object, **_kwargs: object) -> CompletedProcess:
            return process

        async def capture_output(_process: object) -> tuple[bytes, bytes]:
            return json.dumps(DEFAULT_RESPONSE).encode("utf-8"), b""

        runtime = await self.start_runtime()
        with (
            patch.object(asyncio, "create_subprocess_exec", spawn_process),
            patch.object(openclaw_adapter, "_capture_bounded_output", capture_output),
            patch.object(os, "killpg", side_effect=ProcessLookupError),
        ):
            result = await runtime.invoke(
                _request(), _runtime_context(self.workspace, self.artifacts)
            )

        self.assertIs(result.status, AgentRunStatus.SUCCEEDED)
        self.assertEqual(result.output, {"response": "deterministic OpenClaw response"})
        self.assertEqual(process.wait_calls, 1)
        self.assertEqual(process.returncode, 0)
        self.assertIsNone(runtime._process)
        self.assertEqual(list(self.artifacts.iterdir()), [])

    async def test_cleanup_permission_error_retains_process_ownership(self) -> None:
        class ActiveProcess:
            pid = 12345
            returncode: int | None = None

        process = ActiveProcess()

        async def spawn_process(*_args: object, **_kwargs: object) -> ActiveProcess:
            return process

        async def capture_output(_process: object) -> tuple[bytes, bytes]:
            return json.dumps(DEFAULT_RESPONSE).encode("utf-8"), b""

        runtime = await self.start_runtime()
        with (
            patch.object(asyncio, "create_subprocess_exec", spawn_process),
            patch.object(openclaw_adapter, "_capture_bounded_output", capture_output),
            patch.object(os, "killpg", side_effect=PermissionError),
        ):
            with self.assertRaises(PermissionError):
                await runtime.invoke(
                    _request(), _runtime_context(self.workspace, self.artifacts)
                )

        self.assertIs(runtime._process, process)
        self.assertEqual(list(self.artifacts.iterdir()), [])

    async def test_probe_permission_error_is_only_accepted_on_macos(self) -> None:
        class ExitedProcess:
            pid = 12345
            returncode = 0

        with (
            patch.object(openclaw_adapter.sys, "platform", "darwin"),
            patch.object(
                openclaw_adapter.os,
                "killpg",
                side_effect=[None, PermissionError],
            ) as signal_group,
        ):
            await openclaw_adapter._stop_process_group(ExitedProcess())

        self.assertEqual(
            [invocation.args for invocation in signal_group.call_args_list],
            [(12345, signal.SIGTERM), (12345, 0)],
        )
        with (
            patch.object(openclaw_adapter.sys, "platform", "linux"),
            patch.object(
                openclaw_adapter.os,
                "killpg",
                side_effect=[None, PermissionError],
            ),
        ):
            with self.assertRaises(PermissionError):
                await openclaw_adapter._stop_process_group(ExitedProcess())

    async def test_success_uses_private_prompt_file_and_gateway_options(self) -> None:
        with patch.dict(os.environ, self.environment):
            runtime = await self.start_runtime()
            result = await runtime.invoke(
                _request(), _runtime_context(self.workspace, self.artifacts)
            )
            await runtime.stop()

        self.assertIs(result.status, AgentRunStatus.SUCCEEDED)
        self.assertEqual(result.output, {"response": "deterministic OpenClaw response"})
        arguments = json.loads(self.args_marker.read_text(encoding="utf-8"))
        prompt = self.recorded_prompt()
        self.assertEqual(
            arguments[:7],
            ["agent", "--agent", "main", "--json", "--thinking", "off", "--session-id"],
        )
        self.assertTrue(arguments[7].startswith(SESSION_PREFIX))
        self.assertEqual(arguments[8:10], ["--timeout", "80"])
        self.assertEqual(arguments[10], "--message-file")
        self.assertEqual(arguments[11], prompt["path"])
        self.assertEqual(prompt["text"], "Review the workspace")
        self.assertEqual(prompt["mode"], 0o600)
        self.assertEqual(Path(str(prompt["path"])).parent, self.artifacts.resolve())
        self.assertNotIn("Review the workspace", arguments)
        self.assertFalse(Path(str(prompt["path"])).exists())

    async def test_each_request_uses_a_new_session(self) -> None:
        session_ids: list[str] = []
        with patch.dict(os.environ, self.environment):
            runtime = await self.start_runtime()
            for prompt in ("first", "second"):
                result = await runtime.invoke(
                    _request(prompt), _runtime_context(self.workspace, self.artifacts)
                )
                self.assertIs(result.status, AgentRunStatus.SUCCEEDED)
                arguments = json.loads(self.args_marker.read_text(encoding="utf-8"))
                session_ids.append(arguments[arguments.index("--session-id") + 1])
            await runtime.stop()

        self.assertEqual(len(set(session_ids)), 2)

    async def test_managed_gateway_config_ignores_caller_auth_overrides(self) -> None:
        environment = {
            **self.environment,
            "OPENCLAW_GATEWAY_URL": "ws://untrusted.example.test:18789",
            "OPENCLAW_GATEWAY_TOKEN": "untrusted-token",
            "OPENCLAW_GATEWAY_PASSWORD": "untrusted-password",
            "OPENCLAW_ALLOW_INSECURE_PRIVATE_WS": "1",
            "OPENCLAW_GATEWAY_PORT": "18791",
            "NEMOCLAW_OPENCLAW_GATEWAY_URL": "ws://172.20.0.2:18791",
        }
        with patch.dict(os.environ, environment):
            runtime = await self.start_runtime()
            result = await runtime.invoke(
                _request(), _runtime_context(self.workspace, self.artifacts)
            )
            await runtime.stop()

        self.assertIs(result.status, AgentRunStatus.SUCCEEDED)
        recorded = json.loads(self.environment_marker.read_text(encoding="utf-8"))
        self.assertEqual(
            recorded,
            {
                "OPENCLAW_GATEWAY_URL": False,
                "OPENCLAW_GATEWAY_TOKEN": False,
                "OPENCLAW_GATEWAY_PASSWORD": False,
                "OPENCLAW_ALLOW_INSECURE_PRIVATE_WS": False,
                "OPENCLAW_GATEWAY_PORT": True,
                "NEMOCLAW_OPENCLAW_GATEWAY_URL": True,
            },
        )

    async def test_option_and_file_shaped_requests_remain_literal_text(self) -> None:
        secret_file = self.workspace / "secret"
        secret_file.write_text("must-not-be-expanded", encoding="utf-8")
        for request_text in ("--version", "@workspace/secret"):
            with self.subTest(request_text=request_text):
                with patch.dict(os.environ, self.environment):
                    runtime = await self.start_runtime()
                    result = await runtime.invoke(
                        _request(request_text),
                        _runtime_context(self.workspace, self.artifacts),
                    )
                    await runtime.stop()

                self.assertIs(result.status, AgentRunStatus.SUCCEEDED)
                self.assertEqual(self.recorded_prompt()["text"], request_text)
                arguments = json.loads(self.args_marker.read_text(encoding="utf-8"))
                self.assertNotIn(request_text, arguments)
                self.assertNotIn("must-not-be-expanded", json.dumps(result.to_mapping()))

    async def test_response_joins_direct_text_payloads(self) -> None:
        response = {
            **DEFAULT_RESPONSE,
            "result": {
                "payloads": [
                    {"text": " first response "},
                    {"mediaUrl": "file:///ignored"},
                    {"text": "second response"},
                ],
                "meta": {},
            },
        }
        environment = {
            **self.environment,
            "NEMOCLAW_FAKE_OPENCLAW_RESPONSE": json.dumps(response),
        }
        with patch.dict(os.environ, environment):
            runtime = await self.start_runtime()
            result = await runtime.invoke(
                _request(), _runtime_context(self.workspace, self.artifacts)
            )
            await runtime.stop()

        self.assertIs(result.status, AgentRunStatus.SUCCEEDED)
        self.assertEqual(result.output, {"response": "first response\nsecond response"})

    async def test_non_text_and_empty_inputs_do_not_start_openclaw(self) -> None:
        with patch.dict(os.environ, self.environment):
            runtime = await self.start_runtime()
            non_text = await runtime.invoke(
                _request({"messages": []}),
                _runtime_context(self.workspace, self.artifacts),
            )
            empty = await runtime.invoke(
                _request("   "), _runtime_context(self.workspace, self.artifacts)
            )
            await runtime.stop()

        self.assertEqual(non_text.error.code, "openclaw_unsupported_input")
        self.assertEqual(empty.error.code, "openclaw_empty_input")
        self.assertFalse(self.args_marker.exists())

    async def test_unfinished_or_malformed_envelopes_fail_closed(self) -> None:
        cases = {
            "local response": {
                "payloads": [{"text": "unbound"}],
                "meta": {},
            },
            "in flight": {
                **DEFAULT_RESPONSE,
                "status": "in_flight",
            },
            "aborted summary": {
                **DEFAULT_RESPONSE,
                "summary": "aborted",
            },
            "missing metadata": {
                **DEFAULT_RESPONSE,
                "result": {"payloads": [{"text": "unbound"}]},
            },
            "replay invalid": {
                **DEFAULT_RESPONSE,
                "result": {
                    "payloads": [{"text": "unbound"}],
                    "meta": {"replayInvalid": True},
                },
            },
            "embedded transport": {
                **DEFAULT_RESPONSE,
                "result": {
                    "payloads": [{"text": "unbound"}],
                    "meta": {"fallbackFrom": "gateway", "transport": "embedded"},
                },
            },
            "abandoned": {
                **DEFAULT_RESPONSE,
                "result": {
                    "payloads": [{"text": "unbound"}],
                    "meta": {"livenessState": "abandoned"},
                },
            },
            "timeout": {
                **DEFAULT_RESPONSE,
                "result": {
                    "payloads": [{"text": "unbound"}],
                    "meta": {"timeoutPhase": "provider"},
                },
            },
            "incomplete turn": {
                **DEFAULT_RESPONSE,
                "result": {
                    "payloads": [{"text": "unbound"}],
                    "meta": {"error": {"kind": "incomplete_turn"}},
                },
            },
            "error payload": {
                **DEFAULT_RESPONSE,
                "result": {
                    "payloads": [{"text": "unbound", "isError": True}],
                    "meta": {},
                },
            },
        }
        for label, response in cases.items():
            with self.subTest(label=label):
                environment = {
                    **self.environment,
                    "NEMOCLAW_FAKE_OPENCLAW_RESPONSE": json.dumps(response),
                }
                with patch.dict(os.environ, environment):
                    runtime = await self.start_runtime()
                    result = await runtime.invoke(
                        _request(), _runtime_context(self.workspace, self.artifacts)
                    )
                    await runtime.stop()

                self.assertIs(result.status, AgentRunStatus.FAILED)
                self.assertEqual(result.error.code, "openclaw_response_invalid")
                self.assertNotIn("unbound", json.dumps(result.to_mapping()))

    async def test_failure_discards_stdout_stderr_and_removes_prompt(self) -> None:
        secret = "nvapi-openclaw-adapter-redaction-sentinel"
        environment = {
            **self.environment,
            "NEMOCLAW_FAKE_OPENCLAW_MODE": "failure",
            "NEMOCLAW_FAKE_OPENCLAW_SECRET": secret,
        }
        with patch.dict(os.environ, environment):
            runtime = await self.start_runtime()
            result = await runtime.invoke(
                _request(), _runtime_context(self.workspace, self.artifacts)
            )
            await runtime.stop()

        self.assertIs(result.status, AgentRunStatus.FAILED)
        self.assertEqual(result.error.code, "openclaw_process_failed")
        self.assertEqual(
            result.error.message,
            "OpenClaw could not complete the request (exit 23)",
        )
        self.assertNotIn(secret, json.dumps(result.to_mapping()))
        self.assertFalse(Path(str(self.recorded_prompt()["path"])).exists())

    async def test_each_embedded_fallback_marker_is_rejected_without_forwarding_stderr(
        self,
    ) -> None:
        secret = "nvapi-openclaw-fallback-sentinel"
        for marker in (
            "EMBEDDED FALLBACK:",
            "[agent/embedded]",
            '"fallbackFrom": "gateway"',
            '"transport": "embedded"',
        ):
            with self.subTest(marker=marker):
                environment = {
                    **self.environment,
                    "NEMOCLAW_FAKE_OPENCLAW_MODE": "embedded_fallback",
                    "NEMOCLAW_FAKE_OPENCLAW_FALLBACK_MARKER": marker,
                    "NEMOCLAW_FAKE_OPENCLAW_SECRET": secret,
                }
                with patch.dict(os.environ, environment):
                    runtime = await self.start_runtime()
                    result = await runtime.invoke(
                        _request(), _runtime_context(self.workspace, self.artifacts)
                    )
                    await runtime.stop()

                self.assertIs(result.status, AgentRunStatus.FAILED)
                self.assertEqual(result.error.code, "openclaw_gateway_fallback_rejected")
                self.assertEqual(
                    result.error.message,
                    "OpenClaw did not remain on its managed gateway",
                )
                self.assertNotIn(secret, json.dumps(result.to_mapping()))
                self.assertFalse(Path(str(self.recorded_prompt()["path"])).exists())

    async def test_gateway_auth_failure_is_classified_without_forwarding_stderr(self) -> None:
        secret = "nvapi-openclaw-gateway-auth-sentinel"
        environment = {
            **self.environment,
            "NEMOCLAW_FAKE_OPENCLAW_MODE": "gateway_auth_failure",
            "NEMOCLAW_FAKE_OPENCLAW_SECRET": secret,
        }
        with patch.dict(os.environ, environment):
            runtime = await self.start_runtime()
            result = await runtime.invoke(
                _request(), _runtime_context(self.workspace, self.artifacts)
            )
            await runtime.stop()

        self.assertIs(result.status, AgentRunStatus.FAILED)
        self.assertEqual(result.error.code, "openclaw_gateway_auth_unavailable")
        self.assertEqual(
            result.error.message,
            "OpenClaw could not authenticate to its managed gateway",
        )
        self.assertNotIn(secret, json.dumps(result.to_mapping()))
        self.assertFalse(Path(str(self.recorded_prompt()["path"])).exists())

    async def test_invalid_stdout_never_becomes_a_fabric_diagnostic(self) -> None:
        secret = "invalid-openclaw-stdout-secret"
        environment = {
            **self.environment,
            "NEMOCLAW_FAKE_OPENCLAW_RESPONSE": secret,
        }
        with patch.dict(os.environ, environment):
            runtime = await self.start_runtime()
            result = await runtime.invoke(
                _request(), _runtime_context(self.workspace, self.artifacts)
            )
            await runtime.stop()

        self.assertEqual(result.error.code, "openclaw_response_invalid")
        self.assertNotIn(secret, json.dumps(result.to_mapping()))

    async def test_stdout_limit_stops_openclaw_and_its_detached_child(self) -> None:
        secret = "oversized-openclaw-stdout-secret"
        environment = {
            **self.environment,
            "NEMOCLAW_FAKE_OPENCLAW_MODE": "oversized_stdout",
            "NEMOCLAW_FAKE_OPENCLAW_OUTPUT_BYTES": str(
                PROCESS_STREAM_CAPTURE_LIMIT_BYTES + 1
            ),
            "NEMOCLAW_FAKE_OPENCLAW_SECRET": secret,
        }
        with patch.dict(os.environ, environment):
            runtime = await self.start_runtime()
            result = await asyncio.wait_for(
                runtime.invoke(
                    _request(), _runtime_context(self.workspace, self.artifacts)
                ),
                timeout=5,
            )
            await runtime.stop()

        payload = json.loads(self.pid_marker.read_text(encoding="utf-8"))
        _wait_for_stopped([payload["parent"], payload["child"]])
        self.assertIs(result.status, AgentRunStatus.FAILED)
        self.assertEqual(result.error.code, "openclaw_output_limit_exceeded")
        self.assertEqual(
            result.error.message,
            "OpenClaw output exceeded the 1048576-byte stream capture limit",
        )
        self.assertNotIn(secret, json.dumps(result.to_mapping()))
        self.assertFalse(Path(str(self.recorded_prompt()["path"])).exists())

    async def test_stderr_limit_stops_openclaw_and_its_detached_child(self) -> None:
        secret = "oversized-openclaw-stderr-secret"
        environment = {
            **self.environment,
            "NEMOCLAW_FAKE_OPENCLAW_MODE": "oversized_stderr",
            "NEMOCLAW_FAKE_OPENCLAW_OUTPUT_BYTES": str(
                PROCESS_STREAM_CAPTURE_LIMIT_BYTES + 1
            ),
            "NEMOCLAW_FAKE_OPENCLAW_SECRET": secret,
        }
        with patch.dict(os.environ, environment):
            runtime = await self.start_runtime()
            result = await asyncio.wait_for(
                runtime.invoke(
                    _request(), _runtime_context(self.workspace, self.artifacts)
                ),
                timeout=5,
            )
            await runtime.stop()

        payload = json.loads(self.pid_marker.read_text(encoding="utf-8"))
        _wait_for_stopped([payload["parent"], payload["child"]])
        self.assertIs(result.status, AgentRunStatus.FAILED)
        self.assertEqual(result.error.code, "openclaw_output_limit_exceeded")
        self.assertEqual(
            result.error.message,
            "OpenClaw output exceeded the 1048576-byte stream capture limit",
        )
        self.assertNotIn(secret, json.dumps(result.to_mapping()))
        self.assertFalse(Path(str(self.recorded_prompt()["path"])).exists())

    async def test_stream_read_failure_stops_process_tree_and_removes_prompt(self) -> None:
        injected_error = "injected OpenClaw stream read failure"
        read_stream = openclaw_adapter._read_bounded_stream
        failure_assigned = False

        async def fail_after_process_tree_started(
            stream: asyncio.StreamReader,
        ) -> bytes:
            nonlocal failure_assigned
            if failure_assigned:
                return await read_stream(stream)
            failure_assigned = True
            await self.wait_for_pid_marker()
            raise OSError(injected_error)

        environment = {**self.environment, "NEMOCLAW_FAKE_OPENCLAW_MODE": "hang"}
        with patch.dict(os.environ, environment):
            runtime = await self.start_runtime()
            with patch.object(
                openclaw_adapter,
                "_read_bounded_stream",
                fail_after_process_tree_started,
            ):
                with self.assertRaisesRegex(OSError, injected_error):
                    await asyncio.wait_for(
                        runtime.invoke(
                            _request(),
                            _runtime_context(self.workspace, self.artifacts),
                        ),
                        timeout=5,
                    )
            await runtime.stop()

        payload = json.loads(self.pid_marker.read_text(encoding="utf-8"))
        prompt_path = Path(str(self.recorded_prompt()["path"]))
        _wait_for_stopped([payload["parent"], payload["child"]])
        _wait_for_removed(prompt_path)

    async def test_spawn_cancellation_removes_the_private_prompt(self) -> None:
        spawn_started = asyncio.Event()

        async def wait_until_cancelled(*_args: object, **_kwargs: object) -> object:
            spawn_started.set()
            await asyncio.Future()
            raise AssertionError("unreachable")

        with patch.object(
            asyncio,
            "create_subprocess_exec",
            wait_until_cancelled,
        ):
            runtime = await self.start_runtime()
            task = asyncio.create_task(
                runtime.invoke(
                    _request(), _runtime_context(self.workspace, self.artifacts)
                )
            )
            await asyncio.wait_for(spawn_started.wait(), timeout=5)
            prompt_paths = list(
                self.artifacts.glob(".nemoclaw-openclaw-prompt-*.txt")
            )
            self.assertEqual(len(prompt_paths), 1)
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task
            await runtime.stop()

        self.assertFalse(prompt_paths[0].exists())

    async def test_timeout_cancels_openclaw_and_its_detached_child(self) -> None:
        environment = {**self.environment, "NEMOCLAW_FAKE_OPENCLAW_MODE": "hang"}
        with patch.dict(os.environ, environment):
            runtime = await self.start_runtime()
            task = asyncio.create_task(
                runtime.invoke(
                    _request(), _runtime_context(self.workspace, self.artifacts)
                )
            )
            process_ids = await self.wait_for_pid_marker()
            with self.assertRaises(TimeoutError):
                await asyncio.wait_for(task, timeout=0.05)
            await runtime.stop()

        _wait_for_stopped(process_ids)
        self.assertFalse(Path(str(self.recorded_prompt()["path"])).exists())

    async def test_success_reaps_a_detached_child(self) -> None:
        environment = {
            **self.environment,
            "NEMOCLAW_FAKE_OPENCLAW_MODE": "background",
        }
        with patch.dict(os.environ, environment):
            runtime = await self.start_runtime()
            result = await runtime.invoke(
                _request(), _runtime_context(self.workspace, self.artifacts)
            )
            process_ids = await self.wait_for_pid_marker()
            await runtime.stop()

        self.assertIs(result.status, AgentRunStatus.SUCCEEDED)
        _wait_for_stopped(process_ids)

    @unittest.skipUnless(sys.platform.startswith("linux"), "OpenClaw sandboxes run on Linux")
    async def test_adapter_host_loss_reaps_openclaw_and_its_detached_child(self) -> None:
        wrapper_marker = self.base_dir / "wrapper-pid"
        host_source = "\n".join(
            [
                "import os, subprocess, sys, time",
                "from pathlib import Path",
                f"prompt = Path({str(self.workspace / 'host-prompt.txt')!r})",
                "prompt.write_text('host loss', encoding='utf-8')",
                "wrapper = subprocess.Popen([",
                "    sys.executable, '-m', 'nemoclaw_openclaw_fabric.process',",
                "    '--parent-pid', str(os.getpid()), '--cleanup-path', str(prompt),",
                "    '--', 'openclaw', 'agent',",
                "    '--message-file', str(prompt),",
                "], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)",
                f"Path({str(wrapper_marker)!r}).write_text(str(wrapper.pid), encoding='ascii')",
                f"marker = Path({str(self.pid_marker)!r})",
                "deadline = time.monotonic() + 5",
                "while not marker.exists() and time.monotonic() < deadline:",
                "    time.sleep(0.025)",
                "os._exit(0)",
            ]
        )
        environment = {
            **os.environ,
            **self.environment,
            "NEMOCLAW_FAKE_OPENCLAW_MODE": "hang",
            "PYTHONPATH": f"{FABRIC_SOURCE}{os.pathsep}{os.environ.get('PYTHONPATH', '')}",
        }
        host = subprocess.Popen([sys.executable, "-c", host_source], env=environment)
        self.assertEqual(host.wait(timeout=10), 0)
        self.assertTrue(wrapper_marker.exists())
        process_ids = await self.wait_for_pid_marker()
        process_ids.append(int(wrapper_marker.read_text(encoding="ascii")))

        _wait_for_stopped(process_ids)
        _wait_for_removed(self.workspace / "host-prompt.txt")


class ProcessWrapperTests(unittest.TestCase):
    """Reject malformed private wrapper calls without masking the exit status."""

    def test_invalid_arguments_return_the_private_usage_status(self) -> None:
        self.assertEqual(run_process_wrapper([]), INVALID_USAGE_EXIT)

    def test_private_wrapper_failures_have_distinct_safe_errors(self) -> None:
        cases = {
            125: (
                "openclaw_adapter_host_lost",
                "OpenClaw's process owner lost its Fabric adapter host",
            ),
            127: (
                "openclaw_process_unavailable",
                "OpenClaw's process owner could not start the command",
            ),
            -15: (
                "openclaw_process_signaled",
                "OpenClaw was terminated by signal 15",
            ),
        }
        for return_code, expected in cases.items():
            with self.subTest(return_code=return_code):
                result = openclaw_adapter._process_failure(
                    return_code,
                    b"untrusted diagnostic with nvapi-private-sentinel",
                )
                self.assertEqual((result.error.code, result.error.message), expected)
                self.assertNotIn("nvapi-private-sentinel", json.dumps(result.to_mapping()))


class GenericRunnerTests(OpenClawFixtureMixin, unittest.TestCase):
    """Run doctor and invoke through the real generic NemoClaw Fabric runner."""

    def setUp(self) -> None:
        super().setUp()
        self.descriptor = self.base_dir / "openclaw.fabric-adapter.json"
        shutil.copyfile(OPENCLAW_ROOT / "fabric" / self.descriptor.name, self.descriptor)
        self.config_path = self.base_dir / "fabric.json"

    def write_config(self, *, timeout_seconds: float = 5) -> Path:
        payload = {
            "schema_version": "fabric.agent/v1alpha1",
            "metadata": {"name": "nemoclaw-openclaw-fixture"},
            "harness": {"adapter_id": ADAPTER_ID, "resolution": "preinstalled"},
            "discovery": {"local_paths": [self.descriptor.name]},
            "runtime": {
                "input_schema": "text",
                "output_schema": "message",
                "artifacts": "./artifacts",
                "timeout_seconds": timeout_seconds,
            },
            "environment": {
                "provider": "local",
                "workspace": "./workspace",
                "artifacts": "./artifacts",
            },
            "models": {},
        }
        self.config_path.write_text(json.dumps(payload), encoding="utf-8")
        return self.config_path

    def invoke_cli(self, arguments: list[str]) -> tuple[int, str, str]:
        _exit_failure, _exit_success, run_cli = _generic_runner()
        stdout = io.StringIO()
        stderr = io.StringIO()
        virtual_env = str(Path(sys.executable).parent.parent)
        with patch.dict(
            os.environ,
            {**self.environment, "VIRTUAL_ENV": virtual_env},
        ):
            exit_code = run_cli(
                arguments,
                stdin=io.StringIO(),
                stdout=stdout,
                stderr=stderr,
            )
        return exit_code, stdout.getvalue(), stderr.getvalue()

    def invoke_doctor_process(self, config: Path) -> subprocess.CompletedProcess[str]:
        command = shutil.which("nemoclaw-fabric")
        self.assertIsNotNone(command)
        virtual_env = str(Path(sys.executable).parent.parent)
        return subprocess.run(
            [str(command), "doctor", "--config", str(config), "--json"],
            check=False,
            capture_output=True,
            text=True,
            env={
                **os.environ,
                **self.environment,
                "VIRTUAL_ENV": virtual_env,
            },
            timeout=10,
        )

    def assert_fabric_artifacts_removed(self) -> None:
        self.assertEqual(list(self.artifacts.iterdir()), [])

    def test_doctor_accepts_openclaws_empty_model_catalogue_before_run(self) -> None:
        _exit_failure, exit_success, _run_cli = _generic_runner()
        config = self.write_config()
        doctor = self.invoke_doctor_process(config)
        run_exit, run_stdout, run_stderr = self.invoke_cli(
            ["run", "--config", str(config), "-m", "hello from Fabric", "--json"]
        )

        self.assertEqual(doctor.returncode, exit_success, doctor.stdout + doctor.stderr)
        self.assertEqual(doctor.stderr, "")
        self.assertIn(json.loads(doctor.stdout)["status"], {"pass", "warn"})
        self.assertEqual(run_exit, exit_success, run_stdout + run_stderr)
        self.assertEqual(run_stderr, "")
        result = json.loads(run_stdout)
        self.assertEqual(result["status"], "succeeded")
        self.assertEqual(result["harness"], ADAPTER_ID)
        self.assertEqual(result["adapter_kind"], "python")
        self.assertEqual(
            result["output"], {"response": "deterministic OpenClaw response"}
        )
        self.assertEqual(self.recorded_prompt()["text"], "hello from Fabric")
        self.assert_fabric_artifacts_removed()

    def test_runner_failure_never_returns_openclaw_output_or_prompt(self) -> None:
        exit_failure, _exit_success, _run_cli = _generic_runner()
        secret = "nvapi-openclaw-runner-redaction-sentinel"
        config = self.write_config()
        self.environment.update(
            {
                "NEMOCLAW_FAKE_OPENCLAW_MODE": "failure",
                "NEMOCLAW_FAKE_OPENCLAW_SECRET": secret,
            }
        )
        exit_code, stdout, stderr = self.invoke_cli(
            ["run", "--config", str(config), "-m", secret, "--json"]
        )

        self.assertEqual(exit_code, exit_failure, stdout + stderr)
        self.assertEqual(stderr, "")
        self.assertNotIn(secret, stdout)
        result = json.loads(stdout)
        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["error"]["code"], "openclaw_process_failed")
        _wait_for_removed(Path(str(self.recorded_prompt()["path"])))
        self.assert_fabric_artifacts_removed()

    def test_runner_timeout_stops_openclaw_and_removes_prompt(self) -> None:
        exit_failure, _exit_success, _run_cli = _generic_runner()
        config = self.write_config(timeout_seconds=0.1)
        self.environment["NEMOCLAW_FAKE_OPENCLAW_MODE"] = "hang"
        exit_code, stdout, stderr = self.invoke_cli(
            ["run", "--config", str(config), "-m", "bounded request", "--json"]
        )

        self.assertEqual(exit_code, exit_failure, stdout + stderr)
        self.assertEqual(stderr, "")
        self.assertEqual(json.loads(stdout)["status"], "failed")
        payload = json.loads(self.pid_marker.read_text(encoding="utf-8"))
        _wait_for_stopped([payload["parent"], payload["child"]])
        _wait_for_removed(Path(str(self.recorded_prompt()["path"])))
        self.assert_fabric_artifacts_removed()

    @unittest.skipUnless(
        sys.platform.startswith("linux") and FABRIC_RUN_SUPERVISOR is not None,
        "the installed Linux Fabric supervisor is required",
    )
    def test_supervisor_deadline_reaps_nested_openclaw_session(self) -> None:
        config = self.write_config(timeout_seconds=30)
        secret_prompt = "forced-kill-private-openclaw-prompt"
        environment = {
            **os.environ,
            **self.environment,
            "NEMOCLAW_FAKE_OPENCLAW_MODE": "hang",
            "VIRTUAL_ENV": str(Path(sys.executable).parent.parent),
        }
        assert FABRIC_RUN_SUPERVISOR is not None
        process = subprocess.Popen(
            [
                FABRIC_RUN_SUPERVISOR,
                "--deadline-seconds",
                "2",
                "--kill-grace-seconds",
                "0.1",
                "--config",
                str(config),
                "--stdin",
                "--json",
            ],
            env=environment,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        worker_group: int | None = None
        wrapper_group: int | None = None
        fake_process: int | None = None
        detached_process: int | None = None
        try:
            assert process.stdin is not None
            process.stdin.write(secret_prompt)
            process.stdin.close()
            process.stdin = None

            deadline = time.monotonic() + 10
            while (
                not self.prompt_marker.exists() or not self.pid_marker.exists()
            ) and time.monotonic() < deadline:
                time.sleep(0.025)
            self.assertTrue(self.prompt_marker.exists())
            self.assertTrue(self.pid_marker.exists())

            prompt_path = Path(str(self.recorded_prompt()["path"]))
            invocation_directory = prompt_path.parent
            self.assertEqual(invocation_directory.parent, self.artifacts.resolve())
            self.assertTrue(invocation_directory.name.startswith(".nemoclaw-run-"))
            worker_group = int(
                invocation_directory.name.removeprefix(".nemoclaw-run-").split(
                    "-", 1
                )[0]
            )
            process_payload = json.loads(self.pid_marker.read_text(encoding="utf-8"))
            fake_process = int(process_payload["parent"])
            detached_process = int(process_payload["child"])
            wrapper_group = int(process_payload["parent_group"])
            self.assertEqual(int(process_payload["child_group"]), detached_process)
            self.assertNotEqual(detached_process, wrapper_group)

            # Freeze both cleanup-capable process groups. The supervisor must
            # reach its hard deadline, adopt the nested wrapper, then reap both
            # the stopped OpenClaw session and its separately detached child.
            os.killpg(wrapper_group, signal.SIGSTOP)
            os.killpg(worker_group, signal.SIGSTOP)
            return_code = process.wait(timeout=10)
            stdout = process.stdout.read() if process.stdout is not None else ""
            stderr = process.stderr.read() if process.stderr is not None else ""

            self.assertEqual(return_code, 124, stdout + stderr)
            self.assertNotIn(secret_prompt, stdout + stderr)
            for process_id in (wrapper_group, fake_process, detached_process):
                with self.assertRaises(ProcessLookupError):
                    os.kill(process_id, 0)
            self.assertFalse(prompt_path.exists())
            self.assert_fabric_artifacts_removed()
        finally:
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)
            for process_group in (worker_group, wrapper_group, detached_process):
                if process_group is None:
                    continue
                try:
                    os.killpg(process_group, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            remaining = [
                process_id
                for process_id in (wrapper_group, fake_process, detached_process)
                if process_id is not None
            ]
            if remaining:
                _wait_for_stopped(remaining)
            for stream in (process.stdout, process.stderr):
                if stream is not None:
                    stream.close()


if __name__ == "__main__":
    unittest.main()
