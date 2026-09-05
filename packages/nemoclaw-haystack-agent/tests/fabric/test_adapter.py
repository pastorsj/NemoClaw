# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Exercise the direct Haystack Agent and generic Fabric boundaries."""

from __future__ import annotations

import asyncio
import io
import json
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

PACKAGE_ROOT = Path(__file__).resolve().parents[2]
FABRIC_SOURCE = PACKAGE_ROOT / "fabric" / "src"
sys.path.insert(0, str(FABRIC_SOURCE))

from haystack.components.generators.chat import MockChatGenerator
from haystack.dataclasses import ChatMessage
from nemo_fabric_adapter_contract.models import (
    AgentConfig,
    AgentRunRequest,
    AgentRunStatus,
    RuntimeContext,
)
from nemo_fabric_adapters.common.lifecycle import LifecycleError
from nemoclaw_haystack_fabric import adapter as haystack_adapter
from nemoclaw_haystack_fabric.adapter import (
    ADAPTER_ID,
    HaystackAgentRuntime,
)

CREDENTIAL_NAME = "HAYSTACK_MANAGED_INFERENCE_ROUTE"
CREDENTIAL_VALUE = "nvapi-haystack-fixture-secret"


def _agent_config(**overrides: object) -> AgentConfig:
    payload: dict[str, object] = {
        "models": {
            "default": {
                "provider": "openshell",
                "model": "nvidia/nemotron-3-super-120b-a12b",
                "api_key_env": CREDENTIAL_NAME,
                "temperature": 0.0,
                "base_url": "https://inference.local/v1",
            }
        },
        "instructions": {"system": {"content": "Answer briefly.", "mode": "replace"}},
        "runtime": {"max_turns": 8},
    }
    payload.update(overrides)
    return AgentConfig.from_mapping(payload)


def _runtime_context(base_dir: Path) -> RuntimeContext:
    return RuntimeContext.from_mapping(
        {
            "runtime_id": "haystack-runtime",
            "invocation_id": "haystack-invocation",
            "request_id": "haystack-request",
            "environment": {
                "environment_id": "haystack-local",
                "provider": "local",
                "control_location": "in_env_control",
                "workspace": str(base_dir),
                "artifacts": str(base_dir / "artifacts"),
                "ownership": "caller_owned",
            },
            "artifacts": {"root": str(base_dir / "artifacts"), "artifacts": []},
        }
    )


def _request(value: object = "Reply with PONG") -> AgentRunRequest:
    return AgentRunRequest.from_mapping({"input": value, "context": {}})


class _ResultAgent:
    def __init__(self, result: dict[str, object]) -> None:
        self.result = result
        self.closed = False

    async def run_async(self, **_kwargs: object) -> dict[str, object]:
        return self.result

    async def close_async(self) -> None:
        self.closed = True


class _FailingAgent:
    async def run_async(self, **_kwargs: object) -> dict[str, object]:
        raise RuntimeError(CREDENTIAL_VALUE)

    async def close_async(self) -> None:
        return None


class _BlockingAgent:
    def __init__(self) -> None:
        self.started = asyncio.Event()
        self.release = asyncio.Event()
        self.closed = False

    async def run_async(self, **_kwargs: object) -> dict[str, object]:
        self.started.set()
        await self.release.wait()
        return {
            "last_message": ChatMessage.from_assistant("PONG"),
            "step_count": 1,
            "tool_call_counts": {},
            "token_usage": {},
            "exit_reason": "text",
        }

    async def close_async(self) -> None:
        self.closed = True


class HaystackAgentRuntimeTests(unittest.IsolatedAsyncioTestCase):
    """Prove the package translation without an external model service."""

    def setUp(self) -> None:
        self._temporary_directory = tempfile.TemporaryDirectory()
        self.addCleanup(self._temporary_directory.cleanup)
        self.base_dir = Path(self._temporary_directory.name)
        (self.base_dir / "artifacts").mkdir()
        self.environment = {CREDENTIAL_NAME: CREDENTIAL_VALUE}

    async def start_runtime(
        self,
        *,
        config: AgentConfig | None = None,
        generator: MockChatGenerator | None = None,
    ) -> HaystackAgentRuntime:
        runtime = HaystackAgentRuntime()
        response_generator = generator or MockChatGenerator(responses="PONG")
        with (
            patch.dict(os.environ, self.environment),
            patch.object(
                haystack_adapter,
                "build_chat_generator",
                return_value=response_generator,
            ),
        ):
            await runtime.start(
                {
                    "agent_name": "haystack-agent-test",
                    "base_dir": str(self.base_dir),
                    "config": config or _agent_config(),
                }
            )
        self.addAsyncCleanup(runtime.stop)
        return runtime

    async def test_direct_agent_returns_text_metadata_and_usage(self) -> None:
        response = ChatMessage.from_assistant(
            "PONG",
            meta={
                "usage": {
                    "prompt_tokens": 7,
                    "completion_tokens": 2,
                    "total_tokens": 9,
                }
            },
        )
        runtime = await self.start_runtime(
            generator=MockChatGenerator(responses=response)
        )

        first = await runtime.invoke(_request(), _runtime_context(self.base_dir))
        second = await runtime.invoke(
            _request("Second turn"), _runtime_context(self.base_dir)
        )

        self.assertIs(first.status, AgentRunStatus.SUCCEEDED)
        self.assertEqual(first.output["response"], "PONG")
        self.assertEqual(first.output["metadata"]["exit_reason"], "text")
        self.assertEqual(first.output["metadata"]["step_count"], 1)
        self.assertEqual(first.usage.input_tokens, 7)
        self.assertEqual(first.usage.output_tokens, 2)
        self.assertEqual(first.usage.total_tokens, 9)
        self.assertIs(second.status, AgentRunStatus.SUCCEEDED)
        self.assertNotIn(CREDENTIAL_VALUE, json.dumps(first.to_mapping()))

    async def test_direct_agent_rejects_empty_and_structured_input(self) -> None:
        runtime = await self.start_runtime()
        for value in ("  ", {"prompt": "hello"}):
            with self.subTest(value=value):
                result = await runtime.invoke(
                    _request(value), _runtime_context(self.base_dir)
                )
                self.assertIs(result.status, AgentRunStatus.FAILED)
                self.assertEqual(result.error.code, "haystack_unsupported_input")

    async def test_framework_exception_returns_a_secret_free_failure(self) -> None:
        runtime = await self.start_runtime()
        runtime._agent = _FailingAgent()  # type: ignore[assignment]

        result = await runtime.invoke(_request(), _runtime_context(self.base_dir))

        self.assertIs(result.status, AgentRunStatus.FAILED)
        self.assertEqual(result.error.code, "haystack_inference_failed")
        self.assertNotIn(CREDENTIAL_VALUE, json.dumps(result.to_mapping()))

    async def test_malformed_and_step_limit_outputs_fail_closed(self) -> None:
        runtime = await self.start_runtime()
        for result, code in (
            (
                {
                    "last_message": ChatMessage.from_assistant(None),
                    "exit_reason": "text",
                },
                "haystack_no_assistant_response",
            ),
            (
                {
                    "last_message": ChatMessage.from_assistant("unfinished"),
                    "exit_reason": "max_agent_steps",
                },
                "haystack_step_limit_reached",
            ),
        ):
            with self.subTest(code=code):
                runtime._agent = _ResultAgent(result)  # type: ignore[assignment]
                response = await runtime.invoke(
                    _request(), _runtime_context(self.base_dir)
                )
                self.assertIs(response.status, AgentRunStatus.FAILED)
                self.assertEqual(response.error.code, code)

    async def test_concurrent_invoke_is_rejected_and_stop_cancels_the_owner(
        self,
    ) -> None:
        runtime = await self.start_runtime()
        blocking_agent = _BlockingAgent()
        runtime._agent = blocking_agent  # type: ignore[assignment]
        active = asyncio.create_task(
            runtime.invoke(_request(), _runtime_context(self.base_dir))
        )
        await blocking_agent.started.wait()

        with self.assertRaisesRegex(LifecycleError, "active invocation"):
            await runtime.invoke(_request("second"), _runtime_context(self.base_dir))
        await runtime.stop()

        with self.assertRaises(asyncio.CancelledError):
            await active
        self.assertTrue(blocking_agent.closed)
        await runtime.stop()

    async def test_start_requires_the_managed_boundary_and_supported_features(
        self,
    ) -> None:
        invalid_payloads = [
            {"models": {}},
            {
                "models": {
                    "default": {
                        "provider": "openai",
                        "model": "test",
                        "api_key_env": CREDENTIAL_NAME,
                        "temperature": 0,
                        "base_url": "https://inference.local/v1",
                    }
                }
            },
            {
                "models": {
                    "default": {
                        "provider": "openshell",
                        "model": "test",
                        "api_key_env": "OTHER_API_KEY",
                        "temperature": 0,
                        "base_url": "https://inference.local/v1",
                    }
                }
            },
            {
                "models": {
                    "default": {
                        "provider": "openshell",
                        "model": "test",
                        "api_key_env": CREDENTIAL_NAME,
                        "temperature": 0,
                        "base_url": "https://example.com/v1",
                    }
                }
            },
            {**_agent_config().to_mapping(), "runtime": {"max_turns": 33}},
            {**_agent_config().to_mapping(), "tools": {}},
            {**_agent_config().to_mapping(), "skills": {"paths": []}},
            {**_agent_config().to_mapping(), "mcp": {"servers": {}}},
            {
                **_agent_config().to_mapping(),
                "workflow": {"entrypoint": {"kind": "python", "ref": "unsafe"}},
            },
        ]
        for payload in invalid_payloads:
            with self.subTest(payload=payload):
                runtime = HaystackAgentRuntime()
                with (
                    patch.dict(os.environ, self.environment),
                    self.assertRaises(LifecycleError),
                ):
                    await runtime.start(
                        {
                            "base_dir": str(self.base_dir),
                            "config": AgentConfig.from_mapping(payload),
                        }
                    )

    async def test_start_rejects_a_missing_route_marker_or_base_directory(self) -> None:
        runtime = HaystackAgentRuntime()
        with (
            patch.dict(os.environ, {}, clear=True),
            self.assertRaisesRegex(LifecycleError, "route marker is unavailable"),
        ):
            await runtime.start(
                {"base_dir": str(self.base_dir), "config": _agent_config()}
            )
        with (
            patch.dict(os.environ, self.environment),
            self.assertRaisesRegex(LifecycleError, "base directory is unavailable"),
        ):
            await runtime.start(
                {
                    "base_dir": str(self.base_dir / "missing"),
                    "config": _agent_config(),
                }
            )

    async def test_generator_uses_the_typed_model_without_resolving_its_secret(
        self,
    ) -> None:
        model = _agent_config().models["default"]
        generator = haystack_adapter.build_chat_generator(model)
        self.assertEqual(generator.model, "nvidia/nemotron-3-super-120b-a12b")
        self.assertEqual(generator.api_base_url, "https://inference.local/v1")
        self.assertEqual(generator.generation_kwargs, {"temperature": 0.0})
        self.assertEqual(generator.timeout, 60.0)
        self.assertEqual(generator.max_retries, 1)
        self.assertNotIn(CREDENTIAL_VALUE, repr(generator.api_key))
        await generator.close_async()


class GenericRunnerTests(unittest.TestCase):
    """Compose the package descriptor with the real generic NemoClaw runner."""

    def setUp(self) -> None:
        self._temporary_directory = tempfile.TemporaryDirectory()
        self.addCleanup(self._temporary_directory.cleanup)
        self.base_dir = Path(self._temporary_directory.name)
        (self.base_dir / "workspace").mkdir()
        (self.base_dir / "artifacts").mkdir()
        self.descriptor = self.base_dir / "haystack-agent.fabric-adapter.json"
        shutil.copyfile(PACKAGE_ROOT / "fabric" / self.descriptor.name, self.descriptor)
        self.config_path = self.base_dir / "fabric.json"

    def write_config(self) -> Path:
        payload = {
            "schema_version": "fabric.agent/v1alpha1",
            "metadata": {"name": "nemoclaw-haystack-fixture"},
            "harness": {"adapter_id": ADAPTER_ID, "resolution": "preinstalled"},
            "discovery": {"local_paths": [self.descriptor.name]},
            "instructions": {
                "system": {"content": "Answer briefly.", "mode": "replace"}
            },
            "runtime": {
                "input_schema": "text",
                "output_schema": "message",
                "artifacts": "./artifacts",
                "timeout_seconds": 5,
                "max_turns": 8,
            },
            "environment": {
                "provider": "local",
                "workspace": "./workspace",
                "artifacts": "./artifacts",
            },
            "models": {
                "default": {
                    "provider": "openshell",
                    "model": "test-model",
                    "api_key_env": CREDENTIAL_NAME,
                    "temperature": 0,
                    "base_url": "https://inference.local/v1",
                }
            },
        }
        self.config_path.write_text(json.dumps(payload), encoding="utf-8")
        return self.config_path

    def invoke_cli(self, arguments: list[str]) -> tuple[int, str, str]:
        from nemoclaw_fabric.command import run_cli

        stdout = io.StringIO()
        stderr = io.StringIO()
        environment = {
            "PATH": f"{Path(sys.executable).parent}{os.pathsep}{os.environ.get('PATH', '')}",
            "VIRTUAL_ENV": str(Path(sys.executable).parent.parent),
        }
        with patch.dict(os.environ, environment, clear=True):
            exit_code = run_cli(
                arguments,
                stdin=io.StringIO(),
                stdout=stdout,
                stderr=stderr,
            )
        return exit_code, stdout.getvalue(), stderr.getvalue()

    def test_real_runner_validates_descriptor_and_stops_without_a_route_marker(
        self,
    ) -> None:
        config = self.write_config()
        doctor_exit, doctor_stdout, doctor_stderr = self.invoke_cli(
            ["doctor", "--config", str(config), "--json"]
        )
        run_exit, run_stdout, run_stderr = self.invoke_cli(
            ["run", "--config", str(config), "-m", CREDENTIAL_VALUE, "--json"]
        )

        self.assertEqual(doctor_stderr, "")
        self.assertIn(doctor_exit, {0, 1}, doctor_stdout)
        self.assertIn(json.loads(doctor_stdout)["status"], {"pass", "warn", "fail"})
        self.assertEqual(run_exit, 1, run_stdout + run_stderr)
        self.assertEqual(run_stderr, "")
        self.assertNotIn(CREDENTIAL_VALUE, run_stdout)
        result = json.loads(run_stdout)
        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["error"]["stage"], "run")
        self.assertEqual(result["error"]["code"], "fabric_error")
        self.assertIn("route marker is unavailable", result["error"]["message"])
        self.assertEqual(list((self.base_dir / "artifacts").rglob("*")), [])


if __name__ == "__main__":
    unittest.main()
