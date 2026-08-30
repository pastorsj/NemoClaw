# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Deterministic, network-free adapter used to verify the released Fabric SDK."""

from __future__ import annotations

import asyncio
import os
import time
from pathlib import Path
from typing import Any

from nemo_fabric_adapter_contract.models import AgentConfig
from nemo_fabric_adapter_contract.models import AgentRunError
from nemo_fabric_adapter_contract.models import AgentRunRequest
from nemo_fabric_adapter_contract.models import AgentRunResult
from nemo_fabric_adapter_contract.models import AgentRunStatus
from nemo_fabric_adapter_contract.models import AgentUsage
from nemo_fabric_adapter_contract.models import RuntimeContext
from nemo_fabric_adapters.common import lifecycle


class EchoRuntime:
    """Retain adapter settings and echo ordered invocations."""

    def __init__(self) -> None:
        self._settings: dict[str, Any] = {}
        self._turn = 0

    async def start(self, payload: dict[str, Any]) -> None:
        config = payload["config"]
        harness = config.harness
        self._settings = dict(harness.settings if harness is not None else {})
        self._record_event("start")
        self._write_pid_marker()
        if self._mode == "start_error":
            raise lifecycle.LifecycleError(
                "echo_start_failed",
                f"requested start failure {self._secret_text}",
            )

    async def invoke(
        self,
        request: AgentRunRequest,
        context: RuntimeContext,
    ) -> AgentRunResult:
        self._turn += 1
        self._record_event(f"invoke:{self._turn}")
        if self._mode == "block":
            while True:
                time.sleep(60)
        if self._mode == "delay":
            await asyncio.sleep(float(self._settings.get("delay_seconds", 0.25)))
        if self._mode == "crash":
            os._exit(71)
        if self._mode == "malformed":
            return {"not": "an AgentRunResult"}  # type: ignore[return-value]
        if self._mode == "fail":
            return AgentRunResult(
                status=AgentRunStatus.FAILED,
                output={"received": request.input},
                error=AgentRunError(
                    code="echo_requested_failure",
                    message=f"requested failure {self._secret_text}",
                ),
            )
        return AgentRunResult(
            status=AgentRunStatus.SUCCEEDED,
            output={
                "response": f"echo:{request.input}",
                "runtime_id": context.runtime_id,
                "turn": self._turn,
            },
            usage=AgentUsage(
                input_tokens=1,
                output_tokens=1,
                total_tokens=2,
            ),
        )

    async def stop(self) -> None:
        self._record_event("stop")
        if self._mode == "stop_error":
            raise lifecycle.LifecycleError(
                "echo_stop_failed",
                f"requested stop failure {self._secret_text}",
            )

    @property
    def _mode(self) -> str:
        return str(self._settings.get("mode", "success"))

    @property
    def _secret_text(self) -> str:
        environment_name = self._settings.get("secret_env")
        return os.environ.get(str(environment_name), "") if environment_name else ""

    def _record_event(self, event: str) -> None:
        marker = self._settings.get("event_marker")
        if not marker:
            return
        with Path(str(marker)).open("a", encoding="utf-8") as stream:
            stream.write(f"{event}\n")

    def _write_pid_marker(self) -> None:
        marker = self._settings.get("pid_marker")
        if marker:
            Path(str(marker)).write_text(str(os.getpid()), encoding="utf-8")


def main() -> None:
    """Serve the released persistent adapter lifecycle protocol."""

    lifecycle.serve(EchoRuntime, config_loader=AgentConfig.from_mapping)


if __name__ == "__main__":
    main()
