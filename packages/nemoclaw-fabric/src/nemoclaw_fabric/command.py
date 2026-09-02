# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Command-line interface for one package-selected Fabric adapter."""

from __future__ import annotations

import argparse
import asyncio
import importlib.metadata
import os
import signal
import sys
from collections.abc import Awaitable, Callable, Mapping, Sequence
from pathlib import Path
from typing import Any, TextIO

from nemo_fabric import FabricConfigError, FabricError

from nemoclaw_fabric import PACKAGE_VERSION
from nemoclaw_fabric.config import (
    DEFAULT_CONFIG_PATH,
    FabricConfigLoadError,
    LoadedFabricConfig,
    require_supervisor_config_identity,
    load_fabric_config,
)
from nemoclaw_fabric.output import (
    collect_secret_values,
    error_payload,
    redact_diagnostic_text,
    render_plain_result,
    serialize_json_output,
)
from nemoclaw_fabric.runner import (
    FabricClient,
    FabricDoctorFailure,
    check_fabric_requirements,
    create_fabric_client,
    run_fabric_request,
)


EXIT_SUCCESS = 0
EXIT_FAILURE = 1
EXIT_USAGE = 2
MAX_PROMPT_BYTES = 1024 * 1024
MAX_OUTPUT_BYTES = 1024 * 1024


class PromptSourceError(ValueError):
    """The run command did not receive one non-empty prompt source."""


class CommandArgumentError(ValueError):
    """The command line did not match the public command grammar."""


class FabricInvocationUnavailableError(RuntimeError):
    """Package data marks this Fabric invocation configuration unavailable."""


class FabricOutputLimitError(RuntimeError):
    """A rendered Fabric result exceeds the public command output limit."""


class CommandInterrupted(RuntimeError):
    """A process signal interrupted the active Fabric command."""

    def __init__(self, signal_number: int) -> None:
        super().__init__(f"interrupted by signal {signal_number}")
        self.signal_number = signal_number


class RedactingArgumentParser(argparse.ArgumentParser):
    """Raise parser errors so the command can redact their argument values."""

    def error(self, message: str) -> None:
        raise CommandArgumentError(message)


class SingleConfigPathAction(argparse.Action):
    """Reject a caller attempt to replace a package-pinned Fabric config."""

    def __call__(
        self,
        parser: argparse.ArgumentParser,
        namespace: argparse.Namespace,
        values: Any,
        option_string: str | None = None,
    ) -> None:
        if getattr(namespace, "_nemoclaw_config_seen", False):
            parser.error(f"{option_string or '--config'} may be specified only once")
        setattr(namespace, "_nemoclaw_config_seen", True)
        setattr(namespace, self.dest, values)


def build_parser() -> argparse.ArgumentParser:
    """Build the complete public command grammar."""

    parser = RedactingArgumentParser(
        prog="nemoclaw-fabric",
        description="Run a package-selected NeMo Fabric adapter.",
    )
    parser.add_argument("--version", action="store_true", help="print version information")
    subcommands = parser.add_subparsers(dest="command")

    doctor = subcommands.add_parser("doctor", help="check the configured adapter requirements")
    _add_common_options(doctor)

    run = subcommands.add_parser("run", help="run one headless agent request")
    _add_common_options(run)
    run.add_argument("prompt", nargs="*", help="prompt text")
    run.add_argument("-m", "--message", help="prompt text")
    run.add_argument("--stdin", action="store_true", help="read the prompt from standard input")
    return parser


def _add_common_options(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--config",
        type=Path,
        default=DEFAULT_CONFIG_PATH,
        action=SingleConfigPathAction,
        help=f"Fabric configuration file (default: {DEFAULT_CONFIG_PATH})",
    )
    parser.add_argument("--json", action="store_true", help="print one JSON object")


def _package_version(distribution: str, fallback: str) -> str:
    try:
        return importlib.metadata.version(distribution)
    except importlib.metadata.PackageNotFoundError:
        return fallback


def version_text() -> str:
    """Return runner and pinned Fabric versions."""

    runner_version = _package_version("nemoclaw-fabric", PACKAGE_VERSION)
    fabric_version = _package_version("nemo-fabric", "unavailable")
    return f"nemoclaw-fabric {runner_version} (nemo-fabric {fabric_version})"


def select_prompt(args: argparse.Namespace, stdin: TextIO) -> str:
    """Require one non-empty positional, message, or standard-input prompt."""

    positional = " ".join(args.prompt) if args.prompt else None
    message = args.message if args.message is not None else None
    selected_sources = sum(
        value is not None for value in (positional, message, True if args.stdin else None)
    )
    if selected_sources != 1:
        raise PromptSourceError(
            "run requires exactly one prompt source: positional text, -m/--message, or --stdin"
        )
    prompt = stdin.read(MAX_PROMPT_BYTES + 1) if args.stdin else positional or message
    if prompt is not None and len(prompt.encode("utf-8")) > MAX_PROMPT_BYTES:
        raise PromptSourceError(
            f"the selected prompt exceeds the {MAX_PROMPT_BYTES}-byte input limit"
        )
    prompt = prompt.strip() if prompt is not None else None
    if prompt is None or not prompt:
        raise PromptSourceError("the selected prompt source is empty")
    return prompt


def _report_mapping(report: Any) -> Any:
    return report.to_mapping() if hasattr(report, "to_mapping") else report


def _write_line(stream: TextIO, text: str) -> None:
    stream.write(text)
    stream.write("\n")
    stream.flush()


def _require_bounded_output(text: str) -> str:
    if len(text.encode("utf-8")) + 1 > MAX_OUTPUT_BYTES:
        raise FabricOutputLimitError(
            f"the Fabric result exceeds the {MAX_OUTPUT_BYTES}-byte output limit"
        )
    return text


def _doctor_plain_text(report: Any, secret_values: Sequence[str]) -> str:
    lines = [f"Fabric doctor: {report.status}"]
    for check in report.checks:
        if check.status not in {"warn", "fail"}:
            continue
        name = redact_diagnostic_text(check.name, secret_values)
        message = redact_diagnostic_text(check.message, secret_values)
        lines.append(f"{check.status}: {name}: {message}")
    return "\n".join(lines)


async def _run_doctor(
    loaded: LoadedFabricConfig,
    *,
    client: FabricClient,
) -> Any:
    return await check_fabric_requirements(
        client,
        loaded.config,
        base_dir=loaded.base_dir,
    )


async def _run_request(
    loaded: LoadedFabricConfig,
    prompt: str,
    *,
    client: FabricClient,
) -> Any:
    return await run_fabric_request(
        client,
        loaded.config,
        base_dir=loaded.base_dir,
        prompt=prompt,
    )


async def _await_with_signal_cleanup(operation: Awaitable[Any]) -> Any:
    """Cancel on SIGINT or SIGTERM and wait for Fabric's cleanup path."""

    loop = asyncio.get_running_loop()
    task = asyncio.create_task(operation)
    received_signal: int | None = None
    registered: list[signal.Signals] = []
    previous_handlers: dict[signal.Signals, Any] = {}

    def cancel_for_signal(selected_signal: signal.Signals) -> None:
        nonlocal received_signal
        if received_signal is not None:
            return
        received_signal = int(selected_signal)
        signal.signal(selected_signal, signal.SIG_DFL)
        task.cancel()

    for selected_signal in (signal.SIGINT, signal.SIGTERM):
        try:
            previous_handlers[selected_signal] = signal.getsignal(selected_signal)
            loop.add_signal_handler(selected_signal, cancel_for_signal, selected_signal)
            registered.append(selected_signal)
        except (NotImplementedError, RuntimeError, ValueError):
            continue
    try:
        return await task
    except asyncio.CancelledError:
        if received_signal is not None:
            raise CommandInterrupted(received_signal) from None
        raise
    finally:
        for selected_signal in registered:
            loop.remove_signal_handler(selected_signal)
            signal.signal(selected_signal, previous_handlers[selected_signal])


def _fabric_error_fields(error: FabricError) -> tuple[str, str]:
    stage = error.stage or "fabric"
    code = error.code or (
        "invalid_config" if isinstance(error, FabricConfigError) else "fabric_error"
    )
    return stage, code


def _write_command_error(
    *,
    error: BaseException,
    json_output: bool,
    stdout: TextIO,
    stderr: TextIO,
    secret_values: Sequence[str],
    prompt: str | None = None,
) -> int:
    hidden_values = (*secret_values, *((prompt,) if prompt else ()))
    if isinstance(error, PromptSourceError):
        stage, code, exit_code = "input", "invalid_prompt", EXIT_USAGE
    elif isinstance(error, CommandArgumentError):
        stage, code, exit_code = "input", "invalid_arguments", EXIT_USAGE
    elif isinstance(error, FabricInvocationUnavailableError):
        stage, code, exit_code = "config", "unsupported_configuration", EXIT_USAGE
    elif isinstance(error, FabricOutputLimitError):
        stage, code, exit_code = "output", "output_limit_exceeded", EXIT_FAILURE
    elif isinstance(error, FabricConfigLoadError):
        stage, code, exit_code = "config", "invalid_config", EXIT_USAGE
    elif isinstance(error, FabricError):
        stage, code = _fabric_error_fields(error)
        exit_code = EXIT_USAGE if isinstance(error, FabricConfigError) else EXIT_FAILURE
    else:
        stage, code, exit_code = "runner", "unexpected_error", EXIT_FAILURE
    stage = redact_diagnostic_text(stage, hidden_values)
    code = redact_diagnostic_text(code, hidden_values)
    message = redact_diagnostic_text(str(error) or error.__class__.__name__, hidden_values)
    if json_output:
        rendered = serialize_json_output(
            error_payload(
                stage=stage,
                code=code,
                message=message,
                secret_values=hidden_values,
            ),
            hidden_values,
        )
        if len(rendered.encode("utf-8")) + 1 > MAX_OUTPUT_BYTES:
            rendered = serialize_json_output(
                error_payload(
                    stage="output",
                    code="output_limit_exceeded",
                    message=(
                        f"the Fabric result exceeds the {MAX_OUTPUT_BYTES}-byte output limit"
                    ),
                ),
                hidden_values,
            )
        _write_line(stdout, rendered)
    else:
        rendered = f"nemoclaw-fabric: {stage} failed [{code}]: {message}"
        if len(rendered.encode("utf-8")) + 1 > MAX_OUTPUT_BYTES:
            rendered = (
                "nemoclaw-fabric: output failed [output_limit_exceeded]: "
                f"the Fabric result exceeds the {MAX_OUTPUT_BYTES}-byte output limit"
            )
        _write_line(stderr, rendered)
    return exit_code


def run_cli(
    argv: Sequence[str] | None = None,
    *,
    stdin: TextIO | None = None,
    stdout: TextIO | None = None,
    stderr: TextIO | None = None,
    environment: Mapping[str, str] | None = None,
    client_factory: Callable[[], FabricClient] = create_fabric_client,
) -> int:
    """Parse and run one command. Return a stable process exit code."""

    input_stream = stdin or sys.stdin
    output_stream = stdout or sys.stdout
    error_stream = stderr or sys.stderr
    process_environment = environment if environment is not None else os.environ
    secret_values = collect_secret_values(process_environment)
    parser = build_parser()
    try:
        args = parser.parse_args(list(argv) if argv is not None else None)
        if args.command is None and not args.version:
            parser.error("a command is required")
    except CommandArgumentError as error:
        return _write_command_error(
            error=error,
            json_output=False,
            stdout=output_stream,
            stderr=error_stream,
            secret_values=secret_values,
        )

    if args.version:
        _write_line(output_stream, version_text())
        return EXIT_SUCCESS

    prompt: str | None = None
    try:
        loaded = load_fabric_config(args.config)
        require_supervisor_config_identity(loaded, process_environment)
        secret_values = collect_secret_values(
            process_environment,
            loaded.credential_environment_names,
        )
        if loaded.invocation_unavailable_reason is not None:
            raise FabricInvocationUnavailableError(loaded.invocation_unavailable_reason)
        if args.command == "doctor":
            client = client_factory()
            report = asyncio.run(_await_with_signal_cleanup(_run_doctor(loaded, client=client)))
            rendered = (
                serialize_json_output(_report_mapping(report), secret_values)
                if args.json
                else _doctor_plain_text(report, secret_values)
            )
            target = error_stream if report.status == "fail" and not args.json else output_stream
            _write_line(target, _require_bounded_output(rendered))
            return EXIT_FAILURE if report.status == "fail" else EXIT_SUCCESS

        prompt = select_prompt(args, input_stream)
        client = client_factory()
        result = asyncio.run(
            _await_with_signal_cleanup(_run_request(loaded, prompt, client=client))
        )
        if args.json:
            result_secrets = (
                secret_values
                if result.status == "succeeded"
                else (*secret_values, prompt)
            )
            rendered = serialize_json_output(_report_mapping(result), result_secrets)
            _write_line(output_stream, _require_bounded_output(rendered))
        elif result.status == "succeeded":
            rendered = render_plain_result(result, secret_values)
            _write_line(output_stream, _require_bounded_output(rendered))
        else:
            error = result.error
            stage = error.stage if error is not None else "invoke"
            code = error.code if error is not None else "agent_failed"
            message = (
                error.message
                if error is not None
                else f"Fabric returned status {result.status}"
            )
            stage = redact_diagnostic_text(stage, (*secret_values, prompt))
            code = redact_diagnostic_text(code, (*secret_values, prompt))
            rendered = (
                f"nemoclaw-fabric: {stage} failed [{code}]: "
                f"{redact_diagnostic_text(message, (*secret_values, prompt))}"
            )
            _write_line(error_stream, _require_bounded_output(rendered))
        return EXIT_SUCCESS if result.status == "succeeded" else EXIT_FAILURE
    except PromptSourceError as error:
        return _write_command_error(
            error=error,
            json_output=bool(getattr(args, "json", False)),
            stdout=output_stream,
            stderr=error_stream,
            secret_values=secret_values,
            prompt=prompt,
        )
    except FabricDoctorFailure as error:
        report = _report_mapping(error.report)
        try:
            if args.json:
                payload = error_payload(
                    stage="doctor",
                    code="doctor_failed",
                    message=str(error),
                    details={"report": report},
                )
                rendered = serialize_json_output(payload, secret_values)
                _write_line(output_stream, _require_bounded_output(rendered))
            else:
                rendered = _doctor_plain_text(error.report, secret_values)
                _write_line(error_stream, _require_bounded_output(rendered))
        except FabricOutputLimitError as output_error:
            return _write_command_error(
                error=output_error,
                json_output=bool(getattr(args, "json", False)),
                stdout=output_stream,
                stderr=error_stream,
                secret_values=secret_values,
                prompt=prompt,
            )
        return EXIT_FAILURE
    except CommandInterrupted as error:
        message = f"interrupted by signal {error.signal_number}"
        if bool(getattr(args, "json", False)):
            _write_line(
                output_stream,
                serialize_json_output(
                    error_payload(
                        stage="signal",
                        code="interrupted",
                        message=message,
                    ),
                    (*secret_values, *((prompt,) if prompt else ())),
                ),
            )
        else:
            _write_line(error_stream, f"nemoclaw-fabric: {message}")
        return 128 + error.signal_number
    except (
        FabricConfigLoadError,
        FabricInvocationUnavailableError,
        FabricOutputLimitError,
        FabricError,
    ) as error:
        return _write_command_error(
            error=error,
            json_output=bool(getattr(args, "json", False)),
            stdout=output_stream,
            stderr=error_stream,
            secret_values=secret_values,
            prompt=prompt,
        )
    except Exception as error:
        return _write_command_error(
            error=error,
            json_output=bool(getattr(args, "json", False)),
            stdout=output_stream,
            stderr=error_stream,
            secret_values=secret_values,
            prompt=prompt,
        )


def main() -> int:
    """Run the process command."""

    return run_cli()
