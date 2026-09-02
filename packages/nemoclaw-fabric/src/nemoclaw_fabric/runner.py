# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Drive the released NeMo Fabric lifecycle without adapter-specific branches."""

from __future__ import annotations

import os
import shutil
import stat
import sys
import tempfile
import threading
from collections.abc import Iterator, Mapping, Sequence
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Protocol

from nemo_fabric import Fabric, FabricConfig, FabricConfigError, FabricError, RunRequest, RunResult


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


_RUNNER_ENVIRONMENT_LOCK = threading.Lock()


@contextmanager
def use_runner_python_environment() -> Iterator[None]:
    """Keep Fabric discovery and child adapters on the runner's Python graph."""

    if not _RUNNER_ENVIRONMENT_LOCK.acquire(blocking=False):
        raise FabricError(
            "concurrent Fabric SDK calls in one process are unsupported",
            stage="runner",
            code="concurrent_run_unsupported",
        )
    try:
        previous = {
            name: os.environ.get(name)
            for name in ("VIRTUAL_ENV", "PATH", "PYTHONHOME")
        }
        runner_prefix = str(Path(sys.prefix).resolve())
        runner_bin = str(Path(sys.executable).parent)
        path_parts = [
            part for part in (previous["PATH"] or "").split(os.pathsep) if part
        ]
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
    finally:
        _RUNNER_ENVIRONMENT_LOCK.release()


def create_fabric_client() -> Fabric:
    """Create the released Fabric SDK client."""

    return Fabric()


def resolve_fabric_artifact_root(config: FabricConfig, base_dir: Path) -> Path:
    """Resolve one package-owned artifact root beside the config."""

    runtime_value = config.runtime.artifacts
    environment_value = (
        config.environment.artifacts if config.environment is not None else None
    )
    if runtime_value is None or environment_value is None:
        raise FabricConfigError(
            "NemoClaw Fabric runs require one package-owned artifact root",
            stage="config",
            code="missing_artifact_root",
        )

    canonical_base = base_dir.resolve(strict=True)

    def candidate_path(value: str | Path) -> Path:
        candidate = Path(value)
        if not candidate.is_absolute():
            candidate = canonical_base / candidate
        candidate = Path(os.path.abspath(candidate))
        if candidate.parent != canonical_base:
            raise FabricConfigError(
                "NemoClaw Fabric artifact roots must be canonical direct children of the config directory",
                stage="config",
                code="unsafe_artifact_root",
            )
        return candidate

    runtime_root = candidate_path(runtime_value)
    environment_root = candidate_path(environment_value)
    if runtime_root != environment_root:
        raise FabricConfigError(
            "NemoClaw Fabric runtime and environment artifact roots must match",
            stage="config",
            code="mismatched_artifact_root",
        )

    directory_flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    parent_descriptor = -1
    root_descriptor = -1
    try:
        parent_descriptor = os.open(canonical_base, directory_flags)
        try:
            os.mkdir(runtime_root.name, mode=0o700, dir_fd=parent_descriptor)
        except FileExistsError:
            pass
        root_descriptor = os.open(
            runtime_root.name,
            directory_flags,
            dir_fd=parent_descriptor,
        )
        root_stat = os.fstat(root_descriptor)
        named_stat = os.stat(
            runtime_root.name,
            dir_fd=parent_descriptor,
            follow_symlinks=False,
        )
        if (
            not stat.S_ISDIR(root_stat.st_mode)
            or (root_stat.st_dev, root_stat.st_ino)
            != (named_stat.st_dev, named_stat.st_ino)
        ):
            raise FabricConfigError(
                "NemoClaw Fabric artifact root changed during validation",
                stage="config",
                code="unsafe_artifact_root",
            )
    except FabricConfigError:
        raise
    except OSError as error:
        raise FabricConfigError(
            "NemoClaw Fabric artifact root is unavailable",
            stage="config",
            code="unavailable_artifact_root",
        ) from error
    finally:
        if root_descriptor >= 0:
            os.close(root_descriptor)
        if parent_descriptor >= 0:
            os.close(parent_descriptor)

    try:
        resolved = runtime_root.resolve(strict=True)
    except OSError as error:
        raise FabricConfigError(
            "NemoClaw Fabric artifact root is unavailable",
            stage="config",
            code="unavailable_artifact_root",
        ) from error
    if runtime_root != resolved:
        raise FabricConfigError(
            "NemoClaw Fabric artifact roots must be canonical direct children of the config directory",
            stage="config",
            code="unsafe_artifact_root",
        )
    if not os.access(runtime_root, os.R_OK | os.W_OK | os.X_OK):
        raise FabricConfigError(
            "NemoClaw Fabric artifact root is not accessible to the runtime",
            stage="config",
            code="unavailable_artifact_root",
        )
    return runtime_root


def remove_process_artifacts(artifact_root: Path, process_id: int) -> int:
    """Remove only private invocation directories owned by one finished process."""

    if process_id <= 0 or not shutil.rmtree.avoids_symlink_attacks:
        raise RuntimeError("Fabric process artifacts cannot be removed safely")
    prefix = f".nemoclaw-run-{process_id}-"
    directory_flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    root_descriptor = os.open(artifact_root, directory_flags)
    removed = 0
    try:
        with os.scandir(root_descriptor) as entries:
            selected = [entry.name for entry in entries if entry.name.startswith(prefix)]
        for name in selected:
            try:
                entry_stat = os.stat(name, dir_fd=root_descriptor, follow_symlinks=False)
                if stat.S_ISDIR(entry_stat.st_mode):
                    shutil.rmtree(name, dir_fd=root_descriptor)
                else:
                    os.unlink(name, dir_fd=root_descriptor)
            except FileNotFoundError:
                continue
            removed += 1
    finally:
        os.close(root_descriptor)
    return removed


@contextmanager
def use_private_fabric_artifacts(
    config: FabricConfig,
    *,
    base_dir: Path,
) -> Iterator[FabricConfig]:
    """Use one private invocation directory and remove every retained request byte."""

    if not shutil.rmtree.avoids_symlink_attacks:
        raise FabricConfigError(
            "This platform cannot safely remove Fabric invocation artifacts",
            stage="config",
            code="unsafe_artifact_cleanup",
        )
    artifact_root = resolve_fabric_artifact_root(config, base_dir)
    prefix = f".nemoclaw-run-{os.getpid()}-"
    with tempfile.TemporaryDirectory(prefix=prefix, dir=artifact_root) as temporary:
        invocation_root = Path(temporary)
        payload = config.to_mapping()
        payload["runtime"]["artifacts"] = str(invocation_root)
        payload["environment"]["artifacts"] = str(invocation_root)
        yield FabricConfig.from_mapping(payload)


_OMIT_EPHEMERAL_PATH = object()


def _remove_ephemeral_paths(value: Any, invocation_root: Path) -> Any:
    """Remove references to files that disappear when one Fabric run ends."""

    root_text = str(invocation_root)
    if isinstance(value, Path):
        value = str(value)
    if isinstance(value, str):
        if value == root_text or value.startswith(f"{root_text}{os.sep}"):
            return _OMIT_EPHEMERAL_PATH
        return value.replace(root_text, "<ephemeral-artifacts>")
    if isinstance(value, Mapping):
        cleaned: dict[str, Any] = {}
        for key, item in value.items():
            cleaned_key = _remove_ephemeral_paths(str(key), invocation_root)
            selected = _remove_ephemeral_paths(item, invocation_root)
            if (
                cleaned_key is not _OMIT_EPHEMERAL_PATH
                and selected is not _OMIT_EPHEMERAL_PATH
            ):
                cleaned[str(cleaned_key)] = selected
        return cleaned
    if isinstance(value, Sequence) and not isinstance(value, (bytes, bytearray)):
        cleaned_items = []
        for item in value:
            selected = _remove_ephemeral_paths(item, invocation_root)
            if selected is not _OMIT_EPHEMERAL_PATH:
                cleaned_items.append(selected)
        return cleaned_items
    return value


def _without_ephemeral_artifact_references(
    result: Any,
    invocation_root: Path,
) -> Any:
    """Return a Fabric result that never points at deleted request artifacts."""

    if not isinstance(result, RunResult):
        return result
    payload = result.to_mapping()
    payload["artifacts"] = {"root": None, "artifacts": []}
    cleaned = _remove_ephemeral_paths(payload, invocation_root)
    if not isinstance(cleaned, Mapping):
        raise RuntimeError("Fabric returned an invalid result mapping")
    return RunResult.from_mapping(cleaned)


async def check_fabric_requirements(
    client: FabricClient,
    config: FabricConfig,
    *,
    base_dir: Path,
) -> Any:
    """Run Fabric preflight and retain its complete report."""

    resolve_fabric_artifact_root(config, base_dir)
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

    with use_private_fabric_artifacts(config, base_dir=base_dir) as invocation_config:
        with use_runner_python_environment():
            report = await client.doctor(invocation_config, base_dir=base_dir)
            if report.status == "fail":
                raise FabricDoctorFailure(report)
            result = await client.run(
                invocation_config,
                base_dir=base_dir,
                request=RunRequest(input=prompt),
            )
            invocation_root = Path(invocation_config.runtime.artifacts)
            return _without_ephemeral_artifact_references(result, invocation_root)
