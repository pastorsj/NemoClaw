# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Exercise the package-owned Fabric config with the released Deep Agents adapter."""

from __future__ import annotations

import io
import importlib.metadata
import json
import os
import stat
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler
from http.server import ThreadingHTTPServer
from pathlib import Path
from typing import Any
from unittest.mock import patch

from nemoclaw_fabric.command import EXIT_FAILURE
from nemoclaw_fabric.command import EXIT_SUCCESS
from nemoclaw_fabric.command import EXIT_USAGE
from nemoclaw_fabric.command import run_cli


AGENT_ROOT = Path(__file__).resolve().parents[2]
REPOSITORY_ROOT = AGENT_ROOT.parents[1]
CONFIG_GENERATOR = AGENT_ROOT / "config" / "generate-config.ts"


def released_deepagents_descriptor() -> Path:
    """Locate the descriptor installed by Fabric's released adapter package."""

    distribution = importlib.metadata.distribution(
        "nemo-fabric-adapters-deepagents"
    )
    descriptors = [
        distribution.locate_file(file)
        for file in distribution.files or ()
        if str(file).endswith("deepagents.fabric-adapter.json")
    ]
    if len(descriptors) != 1:
        raise AssertionError(
            "expected one released Deep Agents adapter descriptor, "
            f"found {len(descriptors)}"
        )
    return descriptors[0]


class FakeOpenAIHandler(BaseHTTPRequestHandler):
    """Return deterministic assistant messages and retain requests in order."""

    protocol_version = "HTTP/1.1"

    def do_POST(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler owns the name.
        content_length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(content_length)
        response_index = self.server.request_count  # type: ignore[attr-defined]
        self.server.request_count += 1  # type: ignore[attr-defined]
        self.server.request_path = self.path  # type: ignore[attr-defined]
        self.server.authorization = self.headers.get("Authorization")  # type: ignore[attr-defined]
        self.server.request_body = json.loads(body)  # type: ignore[attr-defined]
        self.server.request_paths.append(self.path)  # type: ignore[attr-defined]
        self.server.authorizations.append(  # type: ignore[attr-defined]
            self.headers.get("Authorization")
        )
        self.server.request_bodies.append(  # type: ignore[attr-defined]
            self.server.request_body  # type: ignore[attr-defined]
        )
        responses = self.server.responses  # type: ignore[attr-defined]
        if response_index >= len(responses):
            self.send_error(500, "The fixture received an unexpected request")
            return
        response = json.dumps(responses[response_index]).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(response)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(response)

    def log_message(self, _format: str, *_args: Any) -> None:
        """Keep deterministic test output quiet."""


class ReleasedDeepAgentsTurnTests(unittest.TestCase):
    """Verify the package projection drives the real released adapter."""

    def setUp(self) -> None:
        self._temporary_directory = tempfile.TemporaryDirectory()
        self.addCleanup(self._temporary_directory.cleanup)
        self.base_dir = Path(self._temporary_directory.name)
        self.home = self.base_dir / "home"
        self.workspace = self.base_dir / "workspace"
        self.artifacts = self.base_dir / "artifacts"
        self.home.mkdir()
        self.workspace.mkdir()
        self.artifacts.mkdir()
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), FakeOpenAIHandler)
        self.server.request_count = 0  # type: ignore[attr-defined]
        self.server.request_paths = []  # type: ignore[attr-defined]
        self.server.authorizations = []  # type: ignore[attr-defined]
        self.server.request_bodies = []  # type: ignore[attr-defined]
        self.server.responses = [  # type: ignore[attr-defined]
            self._assistant_response("deterministic Deep Agents reply")
        ]
        self.server_thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.server_thread.start()
        self.addCleanup(self._stop_server)

    def _stop_server(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.server_thread.join(timeout=5)
        self.assertFalse(self.server_thread.is_alive())

    @staticmethod
    def _assistant_response(content: str) -> dict[str, Any]:
        return {
            "id": "chatcmpl-nemoclaw-fabric-test",
            "object": "chat.completion",
            "created": 1,
            "model": "fixture-model",
            "choices": [
                {
                    "index": 0,
                    "message": {"role": "assistant", "content": content},
                    "finish_reason": "stop",
                }
            ],
            "usage": {
                "prompt_tokens": 7,
                "completion_tokens": 4,
                "total_tokens": 11,
            },
        }

    @staticmethod
    def _write_file_response(file_path: str, content: str) -> dict[str, Any]:
        return {
            "id": "chatcmpl-nemoclaw-fabric-tool",
            "object": "chat.completion",
            "created": 1,
            "model": "fixture-model",
            "choices": [
                {
                    "index": 0,
                    "message": {
                        "role": "assistant",
                        "content": None,
                        "tool_calls": [
                            {
                                "id": "call-fabric-write-file",
                                "type": "function",
                                "function": {
                                    "name": "write_file",
                                    "arguments": json.dumps(
                                        {"file_path": file_path, "content": content}
                                    ),
                                },
                            }
                        ],
                    },
                    "finish_reason": "tool_calls",
                }
            ],
            "usage": {
                "prompt_tokens": 8,
                "completion_tokens": 5,
                "total_tokens": 13,
            },
        }

    def _generate_test_config(
        self,
        credential_name: str,
        *,
        model: str = "fixture-model",
        reasoning_effort: str | None = None,
    ) -> Path:
        endpoint = f"http://127.0.0.1:{self.server.server_port}/v1"
        generator_environment = {
            "HOME": str(self.home),
            "PATH": os.environ.get("PATH", ""),
            "NEMOCLAW_INFERENCE_BASE_URL": endpoint,
            "NEMOCLAW_INFERENCE_PROVIDER_ID": "fabric-fixture",
            "NEMOCLAW_MODEL": model,
            "NEMOCLAW_UPSTREAM_PROVIDER": "compatible-endpoint",
        }
        if reasoning_effort is not None:
            generator_environment["NEMOCLAW_REASONING_EFFORT"] = reasoning_effort
        subprocess.run(
            [
                "node",
                "--experimental-strip-types",
                "--no-warnings",
                str(CONFIG_GENERATOR),
            ],
            cwd=REPOSITORY_ROOT,
            env=generator_environment,
            check=True,
            capture_output=True,
            text=True,
        )

        config_path = self.home / ".deepagents" / "fabric.json"
        payload = json.loads(config_path.read_text(encoding="utf-8"))
        self.assertEqual(payload["schema_version"], "fabric.agent/v1alpha1")
        self.assertEqual(
            payload["harness"]["adapter_id"],
            "nvidia.fabric.langchain.deepagents",
        )
        self.assertEqual(payload["models"]["default"]["model"], model)
        self.assertEqual(payload["models"]["default"]["base_url"], endpoint)
        self.assertEqual(
            payload["models"]["default"]["api_key_env"],
            "DEEPAGENTS_CODE_OPENAI_API_KEY",
        )
        self.assertEqual(stat.S_IMODE(config_path.stat().st_mode), 0o600)

        payload["runtime"]["artifacts"] = str(self.artifacts)
        payload["environment"]["workspace"] = str(self.workspace)
        payload["environment"]["artifacts"] = str(self.artifacts)
        payload["models"]["default"]["api_key_env"] = credential_name
        # `uv run --isolated --with-requirements` links wheel contents from its
        # cache, so the wheel's data descriptor can sit outside the temporary
        # interpreter prefix searched by automatic installed discovery. Fabric
        # supports explicit descriptor discovery for exactly this boundary.
        payload["discovery"] = {
            "local_paths": [str(released_deepagents_descriptor())]
        }
        config_path.write_text(json.dumps(payload), encoding="utf-8")
        config_path.chmod(0o600)
        return config_path

    def test_generated_unsupported_model_options_stop_before_fabric_client_creation(
        self,
    ) -> None:
        cases = (
            (
                "nemotron-ultra",
                "nvidia/nemotron-3-ultra-550b-a55b",
                None,
                "managed Nemotron Ultra force_nonempty_content option",
            ),
            (
                "reasoning-effort",
                "fixture-model",
                "high",
                "NEMOCLAW_REASONING_EFFORT=high",
            ),
        )
        for case_name, model, reasoning_effort, expected_reason in cases:
            with self.subTest(case=case_name):
                config_path = self._generate_test_config(
                    "FABRIC_UNAVAILABLE_FIXTURE_CRED",
                    model=model,
                    reasoning_effort=reasoning_effort,
                )
                client_factory_calls = 0

                def create_client() -> Any:
                    nonlocal client_factory_calls
                    client_factory_calls += 1
                    raise AssertionError("Fabric client creation must not be reached")

                stdout = io.StringIO()
                stderr = io.StringIO()
                exit_code = run_cli(
                    [
                        "run",
                        "--config",
                        str(config_path),
                        "-m",
                        "This prompt must not reach Fabric.",
                        "--json",
                    ],
                    stdin=io.StringIO(),
                    stdout=stdout,
                    stderr=stderr,
                    client_factory=create_client,
                )

                self.assertEqual(exit_code, EXIT_USAGE, stderr.getvalue())
                self.assertEqual(stderr.getvalue(), "")
                result = json.loads(stdout.getvalue())
                self.assertEqual(result["status"], "failed")
                self.assertEqual(result["error"]["stage"], "config")
                self.assertEqual(
                    result["error"]["code"],
                    "unsupported_configuration",
                )
                self.assertIn(expected_reason, result["error"]["message"])
                self.assertEqual(client_factory_calls, 0)
                self.assertEqual(self.server.request_count, 0)  # type: ignore[attr-defined]

    def test_package_config_completes_one_turn_with_the_released_adapter(self) -> None:
        credential_name = "FABRIC_FIXTURE_CRED"
        credential = "fabric-deepagents-secret-sentinel"
        prompt = "Reply with the deterministic fixture response."
        config_path = self._generate_test_config(credential_name)
        stdout = io.StringIO()
        stderr = io.StringIO()
        ambient_dcode_venv = self.base_dir / "dcode-venv"
        ambient_dcode_venv.mkdir()
        process_path = f"{Path(sys.executable).parent}{os.pathsep}{os.environ.get('PATH', '')}"

        with patch.dict(
            os.environ,
            {
                credential_name: credential,
                "PATH": process_path,
                # The image exports DCode's /opt/venv. Fabric must discover
                # adapters from its isolated Python environment instead.
                "VIRTUAL_ENV": str(ambient_dcode_venv),
            },
        ):
            exit_code = run_cli(
                ["run", "--config", str(config_path), "-m", prompt, "--json"],
                stdin=io.StringIO(),
                stdout=stdout,
                stderr=stderr,
            )

        self.assertEqual(exit_code, EXIT_SUCCESS, stderr.getvalue())
        self.assertEqual(stderr.getvalue(), "")
        result = json.loads(stdout.getvalue())
        self.assertEqual(result["status"], "succeeded")
        self.assertEqual(result["harness"], "nvidia.fabric.langchain.deepagents")
        self.assertEqual(result["output"]["response"], "deterministic Deep Agents reply")
        self.assertEqual(result["usage"]["total_tokens"], 11)
        self.assertEqual(
            self.server.request_path,  # type: ignore[attr-defined]
            "/v1/chat/completions",
        )
        self.assertEqual(
            self.server.authorization,  # type: ignore[attr-defined]
            f"Bearer {credential}",
        )
        self.assertEqual(self.server.request_count, 1)  # type: ignore[attr-defined]
        request_body = self.server.request_body  # type: ignore[attr-defined]
        self.assertEqual(request_body["model"], "fixture-model")
        self.assertEqual(request_body["messages"][-1]["content"], prompt)
        self.assertNotIn(credential, json.dumps(request_body))
        retained_bytes = b"".join(
            path.read_bytes() for path in self.base_dir.rglob("*") if path.is_file()
        )
        self.assertNotIn(credential.encode("utf-8"), retained_bytes)
        self.assertNotIn(credential, stdout.getvalue())

    def test_released_adapter_writes_workspace_file_before_final_response(self) -> None:
        credential_name = "FABRIC_TOOL_FIXTURE_CRED"
        credential = "fabric-tool-secret-sentinel"
        prompt = "Write the fixture file, then report completion."
        virtual_file_path = "/fabric-proof.txt"
        file_content = "Fabric workspace tool completed.\n"
        final_response = "workspace tool completed"
        expected_file = self.workspace / virtual_file_path.removeprefix("/")
        self.server.responses = [  # type: ignore[attr-defined]
            self._write_file_response(virtual_file_path, file_content),
            self._assistant_response(final_response),
        ]
        config_path = self._generate_test_config(credential_name)
        stdout = io.StringIO()
        stderr = io.StringIO()
        process_path = f"{Path(sys.executable).parent}{os.pathsep}{os.environ.get('PATH', '')}"

        with patch.dict(
            os.environ,
            {
                credential_name: credential,
                "PATH": process_path,
                "VIRTUAL_ENV": str(self.base_dir / "unrelated-venv"),
            },
        ):
            exit_code = run_cli(
                ["run", "--config", str(config_path), "-m", prompt, "--json"],
                stdin=io.StringIO(),
                stdout=stdout,
                stderr=stderr,
            )

        self.assertEqual(exit_code, EXIT_SUCCESS, stderr.getvalue())
        self.assertEqual(stderr.getvalue(), "")
        result = json.loads(stdout.getvalue())
        self.assertEqual(result["status"], "succeeded")
        self.assertEqual(result["output"]["response"], final_response)
        messages = result["output"]["messages"]
        tool_calls = [
            call
            for message in messages
            for call in message.get("tool_calls", [])
        ]
        self.assertEqual(
            tool_calls,
            [
                {
                    "args": {
                        "content": file_content,
                        "file_path": virtual_file_path,
                    },
                    "id": "call-fabric-write-file",
                    "name": "write_file",
                    "type": "tool_call",
                }
            ],
        )
        self.assertEqual(expected_file.read_text(encoding="utf-8"), file_content)
        self.assertEqual(
            [path for path in self.base_dir.rglob(expected_file.name)],
            [expected_file],
        )

        self.assertEqual(self.server.request_count, 2)  # type: ignore[attr-defined]
        self.assertEqual(  # type: ignore[attr-defined]
            self.server.request_paths,
            ["/v1/chat/completions", "/v1/chat/completions"],
        )
        self.assertEqual(  # type: ignore[attr-defined]
            self.server.authorizations,
            [f"Bearer {credential}", f"Bearer {credential}"],
        )
        first_request, second_request = self.server.request_bodies  # type: ignore[attr-defined]
        self.assertEqual(first_request["messages"][-1]["content"], prompt)
        self.assertFalse(
            any(message.get("role") == "tool" for message in first_request["messages"])
        )
        second_messages = second_request["messages"]
        tool_call_message_index = next(
            index for index, message in enumerate(second_messages) if message.get("tool_calls")
        )
        tool_result_index = next(
            index for index, message in enumerate(second_messages) if message.get("role") == "tool"
        )
        self.assertLess(tool_call_message_index, tool_result_index)
        self.assertEqual(
            second_messages[tool_call_message_index]["tool_calls"][0]["function"]["name"],
            "write_file",
        )
        self.assertEqual(
            second_messages[tool_result_index]["tool_call_id"],
            "call-fabric-write-file",
        )

        serialized_bodies = json.dumps(self.server.request_bodies)  # type: ignore[attr-defined]
        self.assertNotIn(credential, serialized_bodies)
        self.assertNotIn(credential, stdout.getvalue())
        self.assertNotIn(credential, stderr.getvalue())
        retained_bytes = b"".join(
            path.read_bytes() for path in self.base_dir.rglob("*") if path.is_file()
        )
        self.assertNotIn(credential.encode("utf-8"), retained_bytes)

    def test_missing_credential_fails_before_the_released_adapter_sends_a_request(self) -> None:
        credential_name = "FABRIC_FIXTURE_MISSING_CRED"
        prompt = "This request must not reach the endpoint."
        config_path = self._generate_test_config(credential_name)
        stdout = io.StringIO()
        stderr = io.StringIO()
        process_path = f"{Path(sys.executable).parent}{os.pathsep}{os.environ.get('PATH', '')}"

        with patch.dict(
            os.environ,
            {
                "PATH": process_path,
                "VIRTUAL_ENV": str(self.base_dir / "unrelated-venv"),
            },
        ):
            os.environ.pop(credential_name, None)
            exit_code = run_cli(
                ["run", "--config", str(config_path), "-m", prompt, "--json"],
                stdin=io.StringIO(),
                stdout=stdout,
                stderr=stderr,
            )

        self.assertEqual(exit_code, EXIT_FAILURE, stderr.getvalue())
        self.assertEqual(stderr.getvalue(), "")
        self.assertNotIn(prompt, stdout.getvalue())
        result = json.loads(stdout.getvalue())
        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["error"]["stage"], "run")
        self.assertEqual(result["error"]["code"], "fabric_error")
        self.assertIn(credential_name, result["error"]["message"])
        self.assertIn("is not set in the environment", result["error"]["message"])
        self.assertEqual(self.server.request_count, 0)  # type: ignore[attr-defined]


if __name__ == "__main__":
    unittest.main()
