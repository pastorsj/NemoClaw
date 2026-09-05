# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Translate the typed Fabric lifecycle into one direct Haystack Agent."""

from __future__ import annotations

import asyncio
import os
from collections.abc import Mapping
from pathlib import Path
from typing import Any

# Haystack telemetry is not part of this local package's request contract. Set
# these before importing Haystack so a caller cannot enable an undeclared edge.
os.environ["HAYSTACK_TELEMETRY_ENABLED"] = "false"
os.environ["HAYSTACK_AUTO_TRACE_ENABLED"] = "false"
os.environ["HAYSTACK_CONTENT_TRACING_ENABLED"] = "false"

from haystack.components.agents import Agent
from haystack.components.generators.chat import OpenAIChatGenerator
from haystack.dataclasses import ChatMessage
from haystack.utils import Secret
from nemo_fabric_adapter_contract.models import (
    AgentConfig,
    AgentModelConfig,
    AgentRunError,
    AgentRunRequest,
    AgentRunResult,
    AgentRunStatus,
    AgentUsage,
    RuntimeContext,
)
from nemo_fabric_adapters.common import lifecycle

ADAPTER_ID = "nvidia.nemoclaw.haystack-agent"
MANAGED_PROVIDER = "openshell"
MANAGED_BASE_URL = "https://inference.local/v1"
MANAGED_CREDENTIAL_ENV = "HAYSTACK_FABRIC_API_KEY"
DEFAULT_MAX_AGENT_STEPS = 8
MAX_AGENT_STEPS = 32
INFERENCE_TIMEOUT_SECONDS = 60.0
INFERENCE_MAX_RETRIES = 1


def _failed(code: str, message: str) -> AgentRunResult:
    """Return a normalized failure without forwarding framework diagnostics."""

    return AgentRunResult(
        status=AgentRunStatus.FAILED,
        output=None,
        error=AgentRunError(code=code, message=message, retryable=False),
    )


def _selected_model(config: AgentConfig) -> AgentModelConfig:
    """Select the only model accepted by this intentionally narrow POC."""

    if len(config.models) != 1:
        raise lifecycle.LifecycleError(
            "haystack_model_required",
            "Haystack Agent requires exactly one configured model",
        )
    return config.models.get("default") or next(iter(config.models.values()))


def _validate_model(model: AgentModelConfig) -> None:
    """Reject model settings that bypass NemoClaw's managed inference route."""

    if model.provider != MANAGED_PROVIDER:
        raise lifecycle.LifecycleError(
            "haystack_provider_unsupported",
            f"Haystack Agent requires the managed {MANAGED_PROVIDER} provider",
        )
    if model.base_url != MANAGED_BASE_URL:
        raise lifecycle.LifecycleError(
            "haystack_base_url_unsupported",
            f"Haystack Agent requires the managed {MANAGED_BASE_URL} inference route",
        )
    if model.api_key_env != MANAGED_CREDENTIAL_ENV:
        raise lifecycle.LifecycleError(
            "haystack_credential_unsupported",
            "Haystack Agent requires its package-owned credential environment name",
        )
    if not os.environ.get(MANAGED_CREDENTIAL_ENV):
        raise lifecycle.LifecycleError(
            "haystack_credential_unavailable",
            "Haystack Agent's managed inference credential is unavailable",
        )
    if model.temperature is None or not 0 <= model.temperature <= 2:
        raise lifecycle.LifecycleError(
            "haystack_temperature_unsupported",
            "Haystack Agent requires a temperature between 0 and 2",
        )
    if model.settings:
        raise lifecycle.LifecycleError(
            "haystack_model_settings_unsupported",
            "Haystack Agent does not accept additional model settings",
        )


def _validate_supported_config(config: AgentConfig) -> int:
    """Return the step limit after rejecting undeclared Fabric features."""

    if config.harness is not None and config.harness.settings:
        raise lifecycle.LifecycleError(
            "haystack_harness_settings_unsupported",
            "Haystack Agent does not accept harness settings",
        )
    if config.tools is not None:
        raise lifecycle.LifecycleError(
            "haystack_tools_unsupported",
            "Haystack Agent tools are not enabled in this package",
        )
    if config.skills is not None:
        raise lifecycle.LifecycleError(
            "haystack_skills_unsupported",
            "Haystack Agent skills are not enabled in this package",
        )
    if config.mcp is not None:
        raise lifecycle.LifecycleError(
            "haystack_mcp_unsupported",
            "Haystack Agent MCP is not enabled in this package",
        )
    if config.workflow is not None:
        raise lifecycle.LifecycleError(
            "haystack_workflow_unsupported",
            "Haystack Agent workflow selection is not enabled in this package",
        )
    max_steps = (
        config.runtime.max_turns
        if config.runtime is not None and config.runtime.max_turns is not None
        else DEFAULT_MAX_AGENT_STEPS
    )
    if max_steps > MAX_AGENT_STEPS:
        raise lifecycle.LifecycleError(
            "haystack_step_limit_unsupported",
            f"Haystack Agent accepts at most {MAX_AGENT_STEPS} steps",
        )
    return max_steps


def build_chat_generator(model: AgentModelConfig) -> OpenAIChatGenerator:
    """Build Haystack's OpenAI-compatible generator from the typed model."""

    return OpenAIChatGenerator(
        api_key=Secret.from_env_var(MANAGED_CREDENTIAL_ENV),
        model=model.model,
        api_base_url=model.base_url,
        generation_kwargs={"temperature": model.temperature},
        timeout=INFERENCE_TIMEOUT_SECONDS,
        max_retries=INFERENCE_MAX_RETRIES,
    )


def build_haystack_agent(
    config: AgentConfig, model: AgentModelConfig, max_steps: int
) -> Agent:
    """Construct the package's concrete, tool-free Haystack Agent."""

    system_prompt = (
        config.instructions.system.content
        if config.instructions and config.instructions.system
        else None
    )
    return Agent(
        chat_generator=build_chat_generator(model),
        tools=None,
        system_prompt=system_prompt,
        max_agent_steps=max_steps,
    )


def _nonnegative_int(value: Any) -> int | None:
    """Accept token counters without coercing booleans, floats, or strings."""

    return (
        value
        if isinstance(value, int) and not isinstance(value, bool) and value >= 0
        else None
    )


def _normalized_usage(value: Any) -> AgentUsage | None:
    """Map Haystack's OpenAI-style counters into Fabric usage fields."""

    if not isinstance(value, Mapping):
        return None
    input_tokens = _nonnegative_int(value.get("prompt_tokens"))
    if input_tokens is None:
        input_tokens = _nonnegative_int(value.get("input_tokens"))
    output_tokens = _nonnegative_int(value.get("completion_tokens"))
    if output_tokens is None:
        output_tokens = _nonnegative_int(value.get("output_tokens"))
    total_tokens = _nonnegative_int(value.get("total_tokens"))
    if total_tokens is None and input_tokens is not None and output_tokens is not None:
        total_tokens = input_tokens + output_tokens
    if input_tokens is None and output_tokens is None and total_tokens is None:
        return None
    return AgentUsage(
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        total_tokens=total_tokens,
    )


class HaystackAgentRuntime:
    """Own one direct Haystack Agent for a Fabric lifecycle."""

    def __init__(self) -> None:
        self._agent: Agent | None = None
        self._active_invocation: asyncio.Task[Any] | None = None

    async def start(self, payload: dict[str, Any]) -> None:
        """Validate typed configuration and construct the direct Agent."""

        if self._agent is not None:
            raise lifecycle.LifecycleError(
                "haystack_already_started",
                "Haystack Agent's Fabric runtime is already started",
            )
        config = payload.get("config")
        base_dir = payload.get("base_dir")
        if not isinstance(config, AgentConfig) or not isinstance(base_dir, str):
            raise lifecycle.LifecycleError(
                "haystack_invalid_start",
                "Haystack Agent received an invalid Fabric start payload",
            )
        if not Path(base_dir).is_dir():
            raise lifecycle.LifecycleError(
                "haystack_workspace_unavailable",
                "Haystack Agent's Fabric base directory is unavailable",
            )
        model = _selected_model(config)
        _validate_model(model)
        max_steps = _validate_supported_config(config)
        try:
            self._agent = build_haystack_agent(config, model, max_steps)
        except lifecycle.LifecycleError:
            raise
        except Exception as error:
            raise lifecycle.LifecycleError(
                "haystack_runtime_unavailable",
                "Haystack Agent could not initialize its runtime",
            ) from error

    async def invoke(
        self, request: AgentRunRequest, _context: RuntimeContext
    ) -> AgentRunResult:
        """Run one text request and return only the bounded terminal result."""

        agent = self._agent
        if agent is None:
            raise lifecycle.LifecycleError(
                "haystack_not_started",
                "Haystack Agent's Fabric runtime is not started",
            )
        if self._active_invocation is not None:
            raise lifecycle.LifecycleError(
                "haystack_invocation_active",
                "Haystack Agent already has an active invocation",
            )
        if not isinstance(request.input, str) or not request.input.strip():
            return _failed(
                "haystack_unsupported_input",
                "Haystack Agent accepts one non-empty plain-text input",
            )

        active_task = asyncio.current_task()
        if active_task is None:
            raise RuntimeError("Haystack Agent invocation requires an asyncio task")
        self._active_invocation = active_task
        try:
            result = await agent.run_async(
                messages=[ChatMessage.from_user(request.input)]
            )
        except asyncio.CancelledError:
            raise
        # Haystack components can raise provider- and plugin-specific exception
        # classes. This is the package's trust boundary, so normalize every one
        # without exposing provider diagnostics or credential-bearing details.
        except Exception:  # noqa: BLE001
            return _failed(
                "haystack_inference_failed",
                "Haystack Agent could not complete the inference request",
            )
        finally:
            if self._active_invocation is active_task:
                self._active_invocation = None

        if result.get("exit_reason") == "max_agent_steps":
            return _failed(
                "haystack_step_limit_reached",
                "Haystack Agent reached its configured step limit",
            )
        last_message = result.get("last_message")
        response = (
            last_message.text.strip()
            if isinstance(last_message, ChatMessage) and last_message.text
            else ""
        )
        if not response:
            return _failed(
                "haystack_no_assistant_response",
                "Haystack Agent completed without a final text response",
            )
        step_count = _nonnegative_int(result.get("step_count"))
        tool_call_counts = result.get("tool_call_counts")
        metadata: dict[str, Any] = {
            "exit_reason": result.get("exit_reason"),
            "step_count": step_count,
            "tool_call_counts": tool_call_counts
            if isinstance(tool_call_counts, dict)
            else {},
        }
        return AgentRunResult(
            status=AgentRunStatus.SUCCEEDED,
            output={"response": response, "metadata": metadata},
            usage=_normalized_usage(result.get("token_usage")),
        )

    async def stop(self) -> None:
        """Cancel an active call, close Haystack clients, and clear state."""

        active_invocation = self._active_invocation
        if (
            active_invocation is not None
            and active_invocation is not asyncio.current_task()
        ):
            active_invocation.cancel()
            await asyncio.gather(active_invocation, return_exceptions=True)
        agent = self._agent
        self._active_invocation = None
        self._agent = None
        if agent is not None:
            await agent.close_async()


def main() -> None:
    """Serve Fabric's persistent local-host lifecycle protocol."""

    lifecycle.serve(HaystackAgentRuntime, config_loader=AgentConfig.from_mapping)


if __name__ == "__main__":
    main()
