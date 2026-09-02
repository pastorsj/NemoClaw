# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Tests for the stable headless command contract."""

from __future__ import annotations

import io
import json
import tempfile
import unittest
from dataclasses import dataclass
from pathlib import Path
from types import SimpleNamespace
from typing import Any

from nemo_fabric import FabricError

from nemoclaw_fabric.command import EXIT_FAILURE
from nemoclaw_fabric.command import EXIT_SUCCESS
from nemoclaw_fabric.command import EXIT_USAGE
from nemoclaw_fabric.command import run_cli
from nemoclaw_fabric.command import version_text


@dataclass
class StubCheck:
    """One deterministic doctor check."""

    name: str
    status: str
    message: str

    def to_mapping(self) -> dict[str, str]:
        return {
            "name": self.name,
            "status": self.status,
            "message": self.message,
        }


class StubReport:
    """Small DoctorReport-shaped test value."""

    def __init__(self, status: str, checks: list[StubCheck] | None = None) -> None:
        self.status = status
        self.checks = checks or []

    def to_mapping(self) -> dict[str, Any]:
        return {
            "status": self.status,
            "checks": [check.to_mapping() for check in self.checks],
        }


class StubResult:
    """Small RunResult-shaped test value."""

    def __init__(
        self,
        status: str,
        *,
        output: Any = None,
        error: Any = None,
    ) -> None:
        self.status = status
        self.output = output
        self.error = error

    def to_mapping(self) -> dict[str, Any]:
        payload: dict[str, Any] = {"status": self.status, "output": self.output}
        if self.error is not None:
            payload["error"] = {
                "stage": self.error.stage,
                "code": self.error.code,
                "message": self.error.message,
            }
        return payload


class StubFabricClient:
    """Capture generic SDK calls without resolving a real adapter."""

    def __init__(
        self,
        *,
        report: StubReport | None = None,
        result: StubResult | None = None,
        doctor_error: Exception | None = None,
    ) -> None:
        self.report = report or StubReport("pass")
        self.result = result or StubResult("succeeded", output={"response": "ok"})
        self.doctor_error = doctor_error
        self.doctor_calls: list[tuple[Any, Path]] = []
        self.run_calls: list[tuple[Any, Path, Any]] = []

    async def doctor(self, config: Any, *, base_dir: Path) -> StubReport:
        self.doctor_calls.append((config, base_dir))
        if self.doctor_error is not None:
            raise self.doctor_error
        return self.report

    async def run(self, config: Any, *, base_dir: Path, request: Any) -> StubResult:
        self.run_calls.append((config, base_dir, request))
        return self.result


class FabricCommandTests(unittest.TestCase):
    """Verify commands, prompt sources, outputs, exits, and redaction."""

    def setUp(self) -> None:
        self._temporary_directory = tempfile.TemporaryDirectory()
        self.addCleanup(self._temporary_directory.cleanup)
        self.base_dir = Path(self._temporary_directory.name)
        self.config_path = self.base_dir / "fabric.json"
        self.config_path.write_text(
            json.dumps(
                {
                    "metadata": {"name": "command-test"},
                    "harness": {"adapter_id": "test.command.adapter"},
                    "runtime": {"timeout_seconds": 30},
                }
            ),
            encoding="utf-8",
        )

    def invoke(
        self,
        arguments: list[str],
        *,
        client: StubFabricClient | None = None,
        stdin_text: str = "",
        environment: dict[str, str] | None = None,
    ) -> tuple[int, str, str, StubFabricClient]:
        selected_client = client or StubFabricClient()
        stdout = io.StringIO()
        stderr = io.StringIO()
        exit_code = run_cli(
            arguments,
            stdin=io.StringIO(stdin_text),
            stdout=stdout,
            stderr=stderr,
            environment=environment or {},
            client_factory=lambda: selected_client,
        )
        return exit_code, stdout.getvalue(), stderr.getvalue(), selected_client

    def run_arguments(self, *arguments: str) -> list[str]:
        return ["run", "--config", str(self.config_path), *arguments]

    def doctor_arguments(self, *arguments: str) -> list[str]:
        return ["doctor", "--config", str(self.config_path), *arguments]

    def test_version_reports_runner_and_pinned_sdk(self) -> None:
        exit_code, stdout, stderr, _client = self.invoke(["--version"])

        self.assertEqual(exit_code, EXIT_SUCCESS)
        self.assertEqual(stderr, "")
        self.assertIn("nemoclaw-fabric 0.1.2", stdout)
        self.assertIn("nemo-fabric 0.2.0", stdout)
        self.assertEqual(stdout.strip(), version_text())

    def test_each_prompt_source_runs_one_request(self) -> None:
        cases = (
            (self.run_arguments("positional", "text"), "", "positional text"),
            (self.run_arguments("-m", "message text"), "", "message text"),
            (self.run_arguments("--stdin"), "standard input\n", "standard input"),
        )
        for arguments, stdin_text, expected in cases:
            with self.subTest(arguments=arguments):
                exit_code, stdout, stderr, client = self.invoke(
                    arguments,
                    stdin_text=stdin_text,
                )

                self.assertEqual(exit_code, EXIT_SUCCESS)
                self.assertEqual(stdout, "ok\n")
                self.assertEqual(stderr, "")
                self.assertEqual(len(client.run_calls), 1)
                self.assertEqual(client.run_calls[0][2].input, expected)

    def test_duplicate_config_cannot_replace_the_package_pinned_path(self) -> None:
        replacement = self.base_dir / "caller-selected.json"
        replacement.write_text(self.config_path.read_text(encoding="utf-8"), encoding="utf-8")
        cases = (
            self.run_arguments("--config", str(replacement), "prompt"),
            self.doctor_arguments("--config", str(replacement)),
        )
        for arguments in cases:
            with self.subTest(arguments=arguments):
                exit_code, stdout, stderr, client = self.invoke(arguments)

                self.assertEqual(exit_code, EXIT_USAGE)
                self.assertEqual(stdout, "")
                self.assertIn("--config may be specified only once", stderr)
                self.assertEqual(client.doctor_calls, [])
                self.assertEqual(client.run_calls, [])

    def test_zero_multiple_and_empty_prompt_sources_are_usage_errors(self) -> None:
        cases = (
            (self.run_arguments(), ""),
            (self.run_arguments("-m", "message", "positional"), ""),
            (self.run_arguments("--stdin", "-m", "message"), "input"),
            (self.run_arguments("--stdin"), "  \n"),
        )
        for arguments, stdin_text in cases:
            with self.subTest(arguments=arguments):
                exit_code, stdout, stderr, client = self.invoke(
                    arguments,
                    stdin_text=stdin_text,
                )

                self.assertEqual(exit_code, EXIT_USAGE)
                self.assertEqual(stdout, "")
                self.assertIn("input failed [invalid_prompt]", stderr)
                self.assertEqual(client.run_calls, [])

    def test_json_prompt_errors_are_reported_before_client_creation(self) -> None:
        cases = (
            (self.run_arguments("--json"), ""),
            (self.run_arguments("-m", "message", "positional", "--json"), ""),
            (self.run_arguments("--stdin", "-m", "message", "--json"), "input"),
            (self.run_arguments("--stdin", "--json"), "  \n"),
        )
        for arguments, stdin_text in cases:
            with self.subTest(arguments=arguments):
                stdout = io.StringIO()
                stderr = io.StringIO()
                factory_calls: list[None] = []

                def create_client() -> StubFabricClient:
                    factory_calls.append(None)
                    return StubFabricClient()

                exit_code = run_cli(
                    arguments,
                    stdin=io.StringIO(stdin_text),
                    stdout=stdout,
                    stderr=stderr,
                    environment={},
                    client_factory=create_client,
                )

                self.assertEqual(exit_code, EXIT_USAGE)
                self.assertEqual(stderr.getvalue(), "")
                self.assertEqual(factory_calls, [])
                payload = json.loads(stdout.getvalue())
                self.assertEqual(payload["status"], "failed")
                self.assertEqual(payload["error"]["stage"], "input")
                self.assertEqual(payload["error"]["code"], "invalid_prompt")

    def test_argparse_syntax_errors_use_redacted_usage_diagnostics(self) -> None:
        credential_arguments = (
            "--unknown-option=sk-1234567890abcdefghij",
            "--clientSecret=ordinary-secret-value",
        )
        for credential_argument in credential_arguments:
            with self.subTest(credential_argument=credential_argument.split("=", 1)[0]):
                stdout = io.StringIO()
                stderr = io.StringIO()
                factory_calls: list[None] = []

                def create_client() -> StubFabricClient:
                    factory_calls.append(None)
                    return StubFabricClient()

                exit_code = run_cli(
                    self.run_arguments("-m", "prompt", "--json", credential_argument),
                    stdin=io.StringIO(),
                    stdout=stdout,
                    stderr=stderr,
                    environment={},
                    client_factory=create_client,
                )

                self.assertEqual(exit_code, EXIT_USAGE)
                self.assertEqual(stdout.getvalue(), "")
                self.assertNotIn(credential_argument.split("=", 1)[1], stderr.getvalue())
                self.assertIn("input failed [invalid_arguments]", stderr.getvalue())
                self.assertIn("<redacted>", stderr.getvalue())
                self.assertEqual(factory_calls, [])

    def test_doctor_pass_and_warn_are_successful(self) -> None:
        for status in ("pass", "warn"):
            with self.subTest(status=status):
                check = StubCheck("adapter.requirement", status, f"{status} message")
                client = StubFabricClient(report=StubReport(status, [check]))
                exit_code, stdout, stderr, selected = self.invoke(
                    self.doctor_arguments(),
                    client=client,
                )

                self.assertEqual(exit_code, EXIT_SUCCESS)
                self.assertIn(f"Fabric doctor: {status}", stdout)
                self.assertEqual(stderr, "")
                self.assertEqual(len(selected.doctor_calls), 1)

    def test_doctor_failure_uses_failure_exit_and_json_lane(self) -> None:
        secret = "secret-doctor-value"
        check = StubCheck("adapter.requirement", "fail", f"failed with {secret}")
        client = StubFabricClient(report=StubReport("fail", [check]))

        exit_code, stdout, stderr, _selected = self.invoke(
            self.doctor_arguments("--json"),
            client=client,
            environment={"EXAMPLE_API_KEY": secret},
        )

        self.assertEqual(exit_code, EXIT_FAILURE)
        self.assertEqual(stderr, "")
        payload = json.loads(stdout)
        self.assertEqual(payload["status"], "fail")
        self.assertEqual(payload["checks"][0]["message"], "failed with <redacted>")

    def test_package_unavailability_stops_doctor_and_run_before_client_creation(self) -> None:
        credential_name = "MODEL_CRED"
        credential = "ordinary-package-reason-secret"
        self.config_path.write_text(
            json.dumps(
                {
                    "metadata": {"name": "package-unavailable"},
                    "harness": {"adapter_id": "test.command.adapter"},
                    "runtime": {"timeout_seconds": 30},
                    "environment": {
                        "metadata": {
                            "nemoclaw": {
                                "invocation_unavailable_reason": (
                                    f"adapter cannot apply option {credential}"
                                )
                            }
                        }
                    },
                    "models": {
                        "default": {
                            "provider": "example",
                            "model": "example-model",
                            "api_key_env": credential_name,
                        }
                    },
                }
            ),
            encoding="utf-8",
        )

        for arguments in (
            self.doctor_arguments("--json"),
            self.run_arguments("-m", "safe prompt", "--json"),
        ):
            with self.subTest(arguments=arguments):
                stdout = io.StringIO()
                stderr = io.StringIO()
                factory_calls: list[None] = []

                def create_client() -> StubFabricClient:
                    factory_calls.append(None)
                    return StubFabricClient()

                exit_code = run_cli(
                    arguments,
                    stdin=io.StringIO(),
                    stdout=stdout,
                    stderr=stderr,
                    environment={credential_name: credential},
                    client_factory=create_client,
                )

                self.assertEqual(exit_code, EXIT_USAGE)
                self.assertEqual(stderr.getvalue(), "")
                self.assertEqual(factory_calls, [])
                self.assertNotIn(credential, stdout.getvalue())
                payload = json.loads(stdout.getvalue())
                self.assertEqual(payload["status"], "failed")
                self.assertEqual(payload["error"]["stage"], "config")
                self.assertEqual(
                    payload["error"]["code"],
                    "unsupported_configuration",
                )
                self.assertIn("<redacted>", payload["error"]["message"])

    def test_declared_service_account_credential_is_redacted_from_doctor_names(self) -> None:
        credential_name = "MY_CRED"
        credential = "ordinary-service-account-value"
        self.config_path.write_text(
            json.dumps(
                {
                    "metadata": {"name": "service-account-redaction"},
                    "harness": {"adapter_id": "test.command.adapter"},
                    "runtime": {"timeout_seconds": 30},
                    "mcp": {
                        "servers": {
                            "service": {
                                "transport": "streamable-http",
                                "url": "https://mcp.example",
                                "authentication": {
                                    "type": "service_account",
                                    "client_id": "example-client",
                                    "client_secret_env": credential_name,
                                    "token_url": "https://auth.example/token",
                                    "token_endpoint_auth_method": "client_secret_post",
                                },
                            }
                        }
                    },
                }
            ),
            encoding="utf-8",
        )
        report = StubReport(
            "warn",
            [StubCheck(f"adapter.{credential}.requirement", "warn", "safe message")],
        )

        for output_arguments in ((), ("--json",)):
            with self.subTest(arguments=output_arguments):
                exit_code, stdout, stderr, _selected = self.invoke(
                    self.doctor_arguments(*output_arguments),
                    client=StubFabricClient(report=report),
                    environment={credential_name: credential},
                )
                combined_output = f"{stdout}\n{stderr}"

                self.assertEqual(exit_code, EXIT_SUCCESS)
                self.assertNotIn(credential, combined_output)
                self.assertIn("<redacted>", combined_output)

    def test_run_failure_and_cancellation_use_failure_exit(self) -> None:
        for status in ("failed", "cancelled"):
            with self.subTest(status=status):
                error = SimpleNamespace(
                    stage="invoke",
                    code=f"agent_{status}",
                    message=f"agent {status}",
                )
                client = StubFabricClient(
                    result=StubResult(status, output={}, error=error),
                )
                exit_code, stdout, stderr, _selected = self.invoke(
                    self.run_arguments("-m", "prompt"),
                    client=client,
                )

                self.assertEqual(exit_code, EXIT_FAILURE)
                self.assertEqual(stdout, "")
                self.assertIn(f"invoke failed [agent_{status}]", stderr)

    def test_failed_results_redact_declared_credential_from_stage_and_code(self) -> None:
        credential_name = "MY_CRED"
        credential = "ordinary-stage-code-value"
        self.config_path.write_text(
            json.dumps(
                {
                    "metadata": {"name": "result-error-redaction"},
                    "harness": {"adapter_id": "test.command.adapter"},
                    "runtime": {"timeout_seconds": 30},
                    "models": {
                        "default": {
                            "provider": "example",
                            "model": "example-model",
                            "api_key_env": credential_name,
                        }
                    },
                }
            ),
            encoding="utf-8",
        )
        error = SimpleNamespace(
            stage=f"invoke-{credential}",
            code=f"failure-{credential}",
            message="safe message",
        )

        for output_arguments in ((), ("--json",)):
            with self.subTest(arguments=output_arguments):
                client = StubFabricClient(
                    result=StubResult("failed", output={}, error=error),
                )
                exit_code, stdout, stderr, _selected = self.invoke(
                    self.run_arguments("-m", "safe prompt", *output_arguments),
                    client=client,
                    environment={credential_name: credential},
                )
                combined_output = f"{stdout}\n{stderr}"

                self.assertEqual(exit_code, EXIT_FAILURE)
                self.assertNotIn(credential, combined_output)
                self.assertIn("<redacted>", combined_output)

    def test_raised_fabric_errors_redact_declared_credential_from_stage_and_code(
        self,
    ) -> None:
        credential_name = "MY_CRED"
        credential = "ordinary-raised-error-value"
        self.config_path.write_text(
            json.dumps(
                {
                    "metadata": {"name": "raised-error-redaction"},
                    "harness": {"adapter_id": "test.command.adapter"},
                    "runtime": {"timeout_seconds": 30},
                    "models": {
                        "default": {
                            "provider": "example",
                            "model": "example-model",
                            "api_key_env": credential_name,
                        }
                    },
                }
            ),
            encoding="utf-8",
        )
        error = FabricError(
            "safe message",
            stage=f"doctor-{credential}",
            code=f"failure-{credential}",
        )

        for output_arguments in ((), ("--json",)):
            with self.subTest(arguments=output_arguments):
                exit_code, stdout, stderr, _selected = self.invoke(
                    self.doctor_arguments(*output_arguments),
                    client=StubFabricClient(doctor_error=error),
                    environment={credential_name: credential},
                )
                combined_output = f"{stdout}\n{stderr}"

                self.assertEqual(exit_code, EXIT_FAILURE)
                self.assertNotIn(credential, combined_output)
                self.assertIn("<redacted>", combined_output)

    def test_failed_json_results_redact_prompt_from_output_and_error(self) -> None:
        prompt = "private prompt text"
        for status in ("failed", "cancelled"):
            with self.subTest(status=status):
                error = SimpleNamespace(
                    stage="invoke",
                    code=f"agent_{status}",
                    message=f"could not process {prompt}",
                )
                client = StubFabricClient(
                    result=StubResult(
                        status,
                        output={"received": prompt},
                        error=error,
                    ),
                )
                exit_code, stdout, stderr, _selected = self.invoke(
                    self.run_arguments("-m", prompt, "--json"),
                    client=client,
                )

                self.assertEqual(exit_code, EXIT_FAILURE)
                self.assertEqual(stderr, "")
                self.assertNotIn(prompt, stdout)
                payload = json.loads(stdout)
                self.assertEqual(payload["output"]["received"], "<redacted>")
                self.assertIn("<redacted>", payload["error"]["message"])

    def test_failed_doctor_blocks_adapter_start(self) -> None:
        report = StubReport(
            "fail",
            [StubCheck("adapter.requirement", "fail", "missing requirement")],
        )
        client = StubFabricClient(report=report)

        exit_code, stdout, stderr, selected = self.invoke(
            self.run_arguments("-m", "prompt", "--json"),
            client=client,
        )

        self.assertEqual(exit_code, EXIT_FAILURE)
        self.assertEqual(stderr, "")
        self.assertEqual(selected.run_calls, [])
        payload = json.loads(stdout)
        self.assertEqual(payload["status"], "failed")
        self.assertEqual(payload["error"]["stage"], "doctor")
        self.assertEqual(payload["error"]["code"], "doctor_failed")

    def test_invalid_config_is_a_usage_error_without_traceback(self) -> None:
        self.config_path.write_text("{}", encoding="utf-8")

        exit_code, stdout, stderr, _client = self.invoke(
            self.run_arguments("-m", "prompt"),
        )

        self.assertEqual(exit_code, EXIT_USAGE)
        self.assertEqual(stdout, "")
        self.assertIn("config failed [invalid_config]", stderr)
        self.assertNotIn("Traceback", stderr)

    def test_unexpected_failures_redact_environment_secret_and_prompt(self) -> None:
        secret = "environment-secret-value"
        prompt = "private prompt text"
        client = StubFabricClient(
            doctor_error=RuntimeError(f"failure {secret} while handling {prompt}"),
        )

        exit_code, stdout, stderr, _selected = self.invoke(
            self.run_arguments("-m", prompt, "--json"),
            client=client,
            environment={"NVIDIA_API_KEY": secret},
        )

        self.assertEqual(exit_code, EXIT_FAILURE)
        self.assertEqual(stderr, "")
        self.assertNotIn(secret, stdout)
        self.assertNotIn(prompt, stdout)
        payload = json.loads(stdout)
        self.assertEqual(payload["error"]["stage"], "runner")
        self.assertEqual(payload["error"]["code"], "unexpected_error")
        self.assertIn("<redacted>", payload["error"]["message"])

    def test_success_output_is_redacted_in_plain_and_json_modes(self) -> None:
        secret = "result-secret-value"
        for output_arguments in ((), ("--json",)):
            with self.subTest(arguments=output_arguments):
                client = StubFabricClient(
                    result=StubResult(
                        "succeeded",
                        output={"response": f"answer {secret}"},
                    )
                )
                exit_code, stdout, stderr, _selected = self.invoke(
                    self.run_arguments("-m", "prompt", *output_arguments),
                    client=client,
                    environment={"SERVICE_TOKEN": secret},
                )

                self.assertEqual(exit_code, EXIT_SUCCESS)
                self.assertEqual(stderr, "")
                self.assertNotIn(secret, stdout)
                self.assertIn("<redacted>", stdout)

    def test_success_output_redacts_values_under_nested_credential_keys(self) -> None:
        response = {
            "summary": "visible answer",
            "publicKey": "visible public material",
            "api_key_env": "SERVICE_API_KEY",
            "nested": {
                "clientSecret": {"unstructured": "ordinary object value"},
                "accessToken": 42,
                "auth": "ordinary auth value",
                "credentials": "ordinary credentials value",
                "keys": "ordinary keys value",
                "passphrases": "ordinary passphrases value",
                "passwords": "ordinary passwords value",
                "secrets": "ordinary secrets value",
                "tokens": "ordinary tokens value",
                "password": False,
                "authorization": ["ordinary list value"],
                "api_key": None,
                "count": 3,
            },
        }
        for output_arguments in ((), ("--json",)):
            with self.subTest(arguments=output_arguments):
                exit_code, stdout, stderr, _selected = self.invoke(
                    self.run_arguments("-m", "prompt", *output_arguments),
                    client=StubFabricClient(
                        result=StubResult(
                            "succeeded",
                            output={"response": response},
                        )
                    ),
                )

                self.assertEqual(exit_code, EXIT_SUCCESS)
                self.assertEqual(stderr, "")
                rendered = json.loads(stdout)
                selected = (
                    rendered["output"]["response"]
                    if output_arguments
                    else rendered
                )
                self.assertEqual(selected["summary"], "visible answer")
                self.assertEqual(selected["publicKey"], "visible public material")
                self.assertEqual(selected["api_key_env"], "SERVICE_API_KEY")
                self.assertEqual(selected["nested"]["count"], 3)
                for credential_field in (
                    "clientSecret",
                    "accessToken",
                    "auth",
                    "credentials",
                    "keys",
                    "passphrases",
                    "passwords",
                    "secrets",
                    "tokens",
                    "password",
                    "authorization",
                    "api_key",
                ):
                    self.assertEqual(
                        selected["nested"][credential_field],
                        "<redacted>",
                    )
                self.assertNotIn("ordinary object value", stdout)
                self.assertNotIn("ordinary list value", stdout)

    def test_free_text_redacts_uri_userinfo_and_preserves_credential_free_urls(
        self,
    ) -> None:
        credential_uris = (
            "https://alice@example.invalid/v1",
            "https://:ordinary-password@example.invalid/v1",
            "https://alice:%70assword@example.invalid/v1",
            "https://alice%40corp:pass@example.invalid/v1",
            "HTTPS://alice:pass@example.invalid/v1",
            "postgresql://alice:pass@example.invalid/database",
            "//alice:pass@example.invalid/v1",
            "https://alice:pass@example.invalid:notaport/v1",
        )
        for credential_uri in credential_uris:
            for output_arguments in ((), ("--json",)):
                with self.subTest(
                    credential_uri=credential_uri,
                    arguments=output_arguments,
                ):
                    error = SimpleNamespace(
                        stage="invoke",
                        code="adapter_failed",
                        message=f"request to {credential_uri} failed",
                    )
                    exit_code, stdout, stderr, _selected = self.invoke(
                        self.run_arguments("-m", "safe prompt", *output_arguments),
                        client=StubFabricClient(
                            result=StubResult(
                                "failed",
                                output={"diagnostic": credential_uri},
                                error=error,
                            )
                        ),
                    )
                    combined_output = f"{stdout}\n{stderr}"

                    self.assertEqual(exit_code, EXIT_FAILURE)
                    self.assertNotIn(credential_uri, combined_output)
                    self.assertNotIn("alice", combined_output)
                    self.assertNotIn("ordinary-password", combined_output)
                    self.assertIn("<redacted>@example.invalid", combined_output)

        credential_free_url = "https://example.invalid/v1?contact=alice@example.com"
        for output_arguments in ((), ("--json",)):
            with self.subTest(credential_free_arguments=output_arguments):
                exit_code, stdout, stderr, _selected = self.invoke(
                    self.run_arguments("-m", "safe prompt", *output_arguments),
                    client=StubFabricClient(
                        result=StubResult(
                            "succeeded",
                            output={"response": f"reachable {credential_free_url}"},
                        )
                    ),
                )

                self.assertEqual(exit_code, EXIT_SUCCESS)
                self.assertEqual(stderr, "")
                self.assertIn(credential_free_url, stdout)
                self.assertNotIn("<redacted>", stdout)

    def test_plain_output_handles_each_adapter_result_shape(self) -> None:
        secret = "result-fallback-secret"
        cases = (
            ("string output", f"answer {secret}", "answer <redacted>\n"),
            (
                "non-string response",
                {"response": {"answer": secret}, "ignored": "metadata"},
                '{"answer":"<redacted>"}\n',
            ),
            (
                "missing response",
                {"answer": secret, "count": 1},
                '{"answer":"<redacted>","count":1}\n',
            ),
            ("no output", None, "null\n"),
        )
        for case_name, output, expected in cases:
            with self.subTest(case_name=case_name):
                exit_code, stdout, stderr, _selected = self.invoke(
                    self.run_arguments("-m", "prompt"),
                    client=StubFabricClient(
                        result=StubResult("succeeded", output=output),
                    ),
                    environment={"SERVICE_TOKEN": secret},
                )

                self.assertEqual(exit_code, EXIT_SUCCESS)
                self.assertEqual(stderr, "")
                self.assertEqual(stdout, expected)
                self.assertNotIn(secret, stdout)

    def test_config_declared_credential_is_redacted_without_name_heuristics(self) -> None:
        credential_name = "MY_CRED"
        credential = "ordinary-looking-credential-value"
        self.config_path.write_text(
            json.dumps(
                {
                    "metadata": {"name": "declared-credential-test"},
                    "harness": {"adapter_id": "test.command.adapter"},
                    "runtime": {"timeout_seconds": 30},
                    "models": {
                        "default": {
                            "provider": "example",
                            "model": "example-model",
                            "api_key_env": credential_name,
                        }
                    },
                }
            ),
            encoding="utf-8",
        )
        error = SimpleNamespace(
            stage="invoke",
            code="credential_failure",
            message=f"adapter failed with {credential}",
        )
        client = StubFabricClient(
            result=StubResult(
                "failed",
                output={"diagnostic": credential},
                error=error,
            ),
        )

        exit_code, stdout, stderr, _selected = self.invoke(
            self.run_arguments("-m", "safe prompt", "--json"),
            client=client,
            environment={credential_name: credential},
        )

        self.assertEqual(exit_code, EXIT_FAILURE)
        self.assertEqual(stderr, "")
        self.assertNotIn(credential, stdout)
        self.assertIn("<redacted>", stdout)

    def test_config_declared_short_credential_is_still_redacted(self) -> None:
        credential_name = "MY_CRED"
        credential = "abc"
        self.config_path.write_text(
            json.dumps(
                {
                    "metadata": {"name": "declared-short-credential-test"},
                    "harness": {"adapter_id": "test.command.adapter"},
                    "runtime": {"timeout_seconds": 30},
                    "models": {
                        "default": {
                            "provider": "example",
                            "model": "example-model",
                            "api_key_env": credential_name,
                        }
                    },
                }
            ),
            encoding="utf-8",
        )
        error = SimpleNamespace(
            stage="invoke",
            code="credential_failure",
            message=f"adapter failed with {credential}",
        )
        client = StubFabricClient(
            result=StubResult(
                "failed",
                output={"diagnostic": credential},
                error=error,
            ),
        )

        exit_code, stdout, stderr, _selected = self.invoke(
            self.run_arguments("-m", "safe prompt", "--json"),
            client=client,
            environment={credential_name: credential},
        )

        self.assertEqual(exit_code, EXIT_FAILURE)
        self.assertEqual(stderr, "")
        self.assertNotIn(credential, stdout)
        self.assertIn("<redacted>", stdout)

    def test_adapter_extension_credential_reference_redacts_failed_result(self) -> None:
        credential_name = "INNOCUOUS_ENV_NAME"
        credential = "ordinary-looking-secret"
        self.config_path.write_text(
            json.dumps(
                {
                    "metadata": {"name": "extension-credential-redaction"},
                    "harness": {
                        "adapter_id": "test.command.adapter",
                        "settings": {"token_env": credential_name},
                    },
                    "runtime": {"timeout_seconds": 30},
                }
            ),
            encoding="utf-8",
        )
        error = SimpleNamespace(
            stage="invoke",
            code="adapter_failed",
            message=f"adapter returned {credential}",
        )
        client = StubFabricClient(
            result=StubResult(
                "failed",
                output={"diagnostic": credential},
                error=error,
            )
        )

        exit_code, stdout, stderr, _selected = self.invoke(
            self.run_arguments("-m", "safe prompt", "--json"),
            client=client,
            environment={credential_name: credential},
        )

        self.assertEqual(exit_code, EXIT_FAILURE)
        self.assertEqual(stderr, "")
        self.assertNotIn(credential, stdout)
        self.assertGreaterEqual(stdout.count("<redacted>"), 2)

    def test_literal_environment_credential_fails_before_client_creation(self) -> None:
        credential = "literal-secret-value"
        self.config_path.write_text(
            json.dumps(
                {
                    "metadata": {"name": "literal-environment-credential"},
                    "harness": {"adapter_id": "test.command.adapter"},
                    "runtime": {"timeout_seconds": 30},
                    "environment": {"env": {"PRIVATE_TOKEN": credential}},
                }
            ),
            encoding="utf-8",
        )
        factory_calls: list[None] = []

        def create_client() -> StubFabricClient:
            factory_calls.append(None)
            return StubFabricClient()

        stdout = io.StringIO()
        stderr = io.StringIO()
        exit_code = run_cli(
            self.doctor_arguments("--json"),
            stdin=io.StringIO(),
            stdout=stdout,
            stderr=stderr,
            environment={},
            client_factory=create_client,
        )

        self.assertEqual(exit_code, EXIT_USAGE)
        self.assertEqual(stderr.getvalue(), "")
        self.assertEqual(factory_calls, [])
        self.assertNotIn(credential, stdout.getvalue())
        payload = json.loads(stdout.getvalue())
        self.assertEqual(payload["error"]["stage"], "config")
        self.assertEqual(payload["error"]["code"], "invalid_config")

    def test_uri_userinfo_fails_before_client_creation_without_diagnostic_leak(self) -> None:
        credential = "ordinary-url-password"
        self.config_path.write_text(
            json.dumps(
                {
                    "metadata": {"name": "uri-userinfo-credential"},
                    "harness": {
                        "adapter_id": "test.command.adapter",
                        "settings": {
                            "endpoint": f"https://alice:{credential}@example.invalid/v1"
                        },
                    },
                    "runtime": {"timeout_seconds": 30},
                }
            ),
            encoding="utf-8",
        )
        factory_calls: list[None] = []

        def create_client() -> StubFabricClient:
            factory_calls.append(None)
            return StubFabricClient()

        stdout = io.StringIO()
        stderr = io.StringIO()
        exit_code = run_cli(
            self.doctor_arguments("--json"),
            stdin=io.StringIO(),
            stdout=stdout,
            stderr=stderr,
            environment={},
            client_factory=create_client,
        )

        self.assertEqual(exit_code, EXIT_USAGE)
        self.assertEqual(stderr.getvalue(), "")
        self.assertEqual(factory_calls, [])
        self.assertNotIn(credential, stdout.getvalue())
        payload = json.loads(stdout.getvalue())
        self.assertEqual(payload["error"]["stage"], "config")
        self.assertEqual(payload["error"]["code"], "invalid_config")
        self.assertIn("URI authority userinfo", payload["error"]["message"])

    def test_sensitive_adapter_value_shapes_fail_before_client_creation(self) -> None:
        credential_values = (
            ["Bearer sk-proj-list-secret"],
            {"value": "Bearer sk-proj-object-secret"},
            123456789,
            True,
            None,
        )
        for credential_value in credential_values:
            with self.subTest(credential_value=credential_value):
                self.config_path.write_text(
                    json.dumps(
                        {
                            "metadata": {"name": "literal-adapter-credential-shape"},
                            "harness": {
                                "adapter_id": "test.command.adapter",
                                "settings": {"authorization": credential_value},
                            },
                            "runtime": {"timeout_seconds": 30},
                        }
                    ),
                    encoding="utf-8",
                )
                factory_calls: list[None] = []

                def create_client() -> StubFabricClient:
                    factory_calls.append(None)
                    return StubFabricClient()

                stdout = io.StringIO()
                stderr = io.StringIO()
                exit_code = run_cli(
                    self.doctor_arguments("--json"),
                    stdin=io.StringIO(),
                    stdout=stdout,
                    stderr=stderr,
                    environment={},
                    client_factory=create_client,
                )

                self.assertEqual(exit_code, EXIT_USAGE)
                self.assertEqual(stderr.getvalue(), "")
                self.assertEqual(factory_calls, [])
                payload = json.loads(stdout.getvalue())
                self.assertEqual(payload["error"]["stage"], "config")
                self.assertEqual(payload["error"]["code"], "invalid_config")
                self.assertIn(
                    "harness.settings.authorization",
                    payload["error"]["message"],
                )

    def test_common_credential_forms_are_redacted_in_plain_and_json_diagnostics(
        self,
    ) -> None:
        credential_forms = (
            "Bearer bearer-secret-value",
            "Basic dXNlcjpwYXNzd29yZA==",
            "nvapi-1234567890abcdef",
            "nvcf-1234567890abcdef",
            "ghp_1234567890abcdef",
            "github_pat_12345678901234567890",
            "sk-proj-1234567890abcdef",
            "sk-ant-1234567890abcdef",
            "sk-1234567890abcdefghij",
            "hf_1234567890abcdef",
            "glpat-1234567890abcdef",
            "gsk_1234567890abcdef",
            "pypi-1234567890abcdef",
            "tvly-1234567890abcdef",
            "xoxb-12345678-abcdef",
            "xapp-12345678-abcdef",
            "AKIA1234567890ABCDEF",
            "ASIA1234567890ABCDEF",
            "bot12345678:" + "a" * 35,
            "12345678:" + "a" * 35,
            "A" * 24 + "." + "B" * 6 + "." + "C" * 27,
            "eyJabcde.ab.abcdefghij",
            "lsv2_sk_1234567890",
            "KEY=ordinary-secret-value",
            "-----BEGIN "
            "PRIVATE KEY-----\nprivate-material\n-----END "
            "PRIVATE KEY-----",
            "MODEL_API_KEY=ordinary-secret-value",
            "clientSecret=ordinary-secret-value",
        )
        for credential in credential_forms:
            for output_arguments in ((), ("--json",)):
                with self.subTest(
                    credential=credential.split("-", maxsplit=1)[0],
                    arguments=output_arguments,
                ):
                    error = SimpleNamespace(
                        stage="invoke",
                        code="credential_failure",
                        message=f"diagnostic contained {credential}",
                    )
                    client = StubFabricClient(
                        result=StubResult(
                            "failed",
                            output={credential: credential},
                            error=error,
                        ),
                    )
                    exit_code, stdout, stderr, _selected = self.invoke(
                        self.run_arguments("-m", "safe prompt", *output_arguments),
                        client=client,
                    )
                    combined_output = f"{stdout}\n{stderr}"

                    self.assertEqual(exit_code, EXIT_FAILURE)
                    self.assertNotIn(credential, combined_output)
                    self.assertIn("<redacted>", combined_output)


if __name__ == "__main__":
    unittest.main()
