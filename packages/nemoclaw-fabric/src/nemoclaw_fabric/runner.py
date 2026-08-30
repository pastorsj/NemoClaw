# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Drive the released NeMo Fabric lifecycle without adapter-specific branches."""

from __future__ import annotations

import os
import sys
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Protocol

from nemo_fabric import Fabric, FabricConfig, RunRequest


class FabricClient(Protocol):
    """The released Fabric methods used by the headless runner."""

    async def doctor(self, config: FabricConfig, *, base_dir: Path) -> Any: ...

    async def run(
        self,
        config: FabricConfig,
        *,
        base_dir: Path,
        request: RunRequest,
    ) -> Any: ...


class FabricDoctorFailure(RuntimeError):
    """Fabric preflight reported a failed requirement."""

    def __init__(self, report: Any) -> None:
        super().__init__("Fabric doctor reported a failed requirement")
        self.report = report


@contextmanager
def use_runner_python_environment() -> Iterator[None]:
    """Keep Fabric discovery and child adapters on the runner's Python graph."""

    previous = {name: os.environ.get(name) for name in ("VIRTUAL_ENV", "PATH", "PYTHONHOME")}
    runner_prefix = str(Path(sys.prefix).resolve())
    runner_bin = str(Path(sys.executable).parent)
    path_parts = [part for part in (previous["PATH"] or "").split(os.pathsep) if part]
    os.environ["VIRTUAL_ENV"] = runner_prefix
    os.environ["PATH"] = os.pathsep.join(
        [runner_bin, *(part for part in path_parts if part != runner_bin)]
    )
    os.environ.pop("PYTHONHOME", None)
    try:
        yield
    finally:
        for name, value in previous.items():
            if value is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = value


def create_fabric_client() -> Fabric:
    """Create the released Fabric SDK client."""

    return Fabric()


async def check_fabric_requirements(
    client: FabricClient,
    config: FabricConfig,
    *,
    base_dir: Path,
) -> Any:
    """Run Fabric preflight and retain its complete report."""

    with use_runner_python_environment():
        return await client.doctor(config, base_dir=base_dir)


async def run_fabric_request(
    client: FabricClient,
    config: FabricConfig,
    *,
    base_dir: Path,
    prompt: str,
) -> Any:
    """Reject a failed preflight, then run one complete Fabric lifecycle."""

    with use_runner_python_environment():
        report = await check_fabric_requirements(client, config, base_dir=base_dir)
        if report.status == "fail":
            raise FabricDoctorFailure(report)
        return await client.run(
            config,
            base_dir=base_dir,
            request=RunRequest(input=prompt),
        )
