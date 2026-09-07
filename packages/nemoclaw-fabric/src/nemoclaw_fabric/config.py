# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Load the package-owned NeMo Fabric configuration."""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import stat
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from nemo_fabric import FabricConfig

from nemoclaw_fabric.output import field_name_looks_like_credential
from nemoclaw_fabric.output import normalize_field_name
from nemoclaw_fabric.output import uri_authority_has_userinfo
from nemoclaw_fabric.output import value_looks_like_secret


DEFAULT_CONFIG_PATH = Path("/etc/nemoclaw/fabric.json")
FABRIC_CONFIG_MAX_BYTES = 1024 * 1024
SUPERVISOR_CONFIG_SHA256_ENV = "NEMOCLAW_FABRIC_SUPERVISOR_CONFIG_SHA256"

# Fabric 0.2 credential fields contain environment-variable names, never the
# credential values themselves. Keep this list aligned with the pinned SDK
# models so every declared credential can be removed from diagnostics.
_CREDENTIAL_ENVIRONMENT_FIELDS = frozenset(
    {
        "api_key_env",
        "client_secret_env",
        "secret_access_key_var",
        "session_token_var",
    }
)
_CREDENTIAL_ENVIRONMENT_MAPPING_FIELDS = frozenset({"header_env"})
_ENVIRONMENT_VARIABLE_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
_GENERIC_ENVIRONMENT_REFERENCE_FIELD = re.compile(
    r"(?:_env|_env_var|_(?:access_?key|api_?key|credential|pass(?:word|wd)?|secret|token)_var)$",
    re.IGNORECASE,
)


class FabricConfigLoadError(ValueError):
    """A Fabric configuration file could not be read or validated."""


@dataclass(frozen=True, slots=True)
class LoadedFabricConfig:
    """A validated Fabric configuration and its relative-path boundary."""

    config: FabricConfig
    base_dir: Path
    path: Path
    content_sha256: str
    credential_environment_names: tuple[str, ...]
    invocation_unavailable_reason: str | None


def _is_credential_reference_field(field_name: str) -> bool:
    normalized = normalize_field_name(field_name)
    return bool(
        normalized in _CREDENTIAL_ENVIRONMENT_FIELDS
        or normalized in _CREDENTIAL_ENVIRONMENT_MAPPING_FIELDS
        or _GENERIC_ENVIRONMENT_REFERENCE_FIELD.search(normalized)
    )


def _credential_environment_names(value: Any) -> tuple[str, ...]:
    """Find reviewed and conventional credential indirection in a Fabric mapping."""

    names: set[str] = set()

    def add_environment_name(environment_name: Any, field: str) -> None:
        if not isinstance(environment_name, str) or not _ENVIRONMENT_VARIABLE_NAME.fullmatch(
            environment_name
        ):
            raise FabricConfigLoadError(
                f"{field} must name an environment variable using letters, digits, and underscores"
            )
        names.add(environment_name)

    def visit(candidate: Any, path: tuple[str, ...] = ()) -> None:
        if isinstance(candidate, Mapping):
            for key, item in candidate.items():
                key_text = str(key)
                normalized_key = normalize_field_name(key_text)
                field_path = ".".join((*path, key_text))
                if normalized_key in _CREDENTIAL_ENVIRONMENT_MAPPING_FIELDS:
                    if not isinstance(item, Mapping):
                        raise FabricConfigLoadError(
                            f"{field_path} must map header names to environment variable names"
                        )
                    for environment_name in item.values():
                        add_environment_name(environment_name, field_path)
                elif _is_credential_reference_field(key_text):
                    add_environment_name(item, field_path)
                visit(item, (*path, key_text))
        elif isinstance(candidate, Sequence) and not isinstance(
            candidate, (str, bytes, bytearray)
        ):
            for item in candidate:
                visit(item, path)

    visit(value)
    return tuple(sorted(names))


def _nemoclaw_metadata(payload: Mapping[str, Any]) -> Mapping[str, Any]:
    environment = payload.get("environment")
    if not isinstance(environment, Mapping):
        return {}
    metadata = environment.get("metadata")
    if not isinstance(metadata, Mapping):
        return {}
    nemoclaw = metadata.get("nemoclaw")
    return nemoclaw if isinstance(nemoclaw, Mapping) else {}


def _declared_credential_environment_names(payload: Mapping[str, Any]) -> tuple[str, ...]:
    """Validate the runner-owned extension list for adapter-specific credentials."""

    declared = _nemoclaw_metadata(payload).get("credential_environment_names")
    if declared is None:
        return ()
    if isinstance(declared, (str, bytes, bytearray)) or not isinstance(declared, Sequence):
        raise FabricConfigLoadError(
            "environment.metadata.nemoclaw.credential_environment_names must be an array"
        )
    names: list[str] = []
    for environment_name in declared:
        if not isinstance(environment_name, str) or not _ENVIRONMENT_VARIABLE_NAME.fullmatch(
            environment_name
        ):
            raise FabricConfigLoadError(
                "environment.metadata.nemoclaw.credential_environment_names entries must use "
                "letters, digits, and underscores"
            )
        names.append(environment_name)
    if len(names) != len(set(names)):
        raise FabricConfigLoadError(
            "environment.metadata.nemoclaw.credential_environment_names must not contain duplicates"
        )
    return tuple(names)


def _reject_literal_credentials(
    value: Any,
    credential_environment_names: frozenset[str],
    path: tuple[str, ...] = (),
) -> None:
    """Reject credential values that bypass environment-name indirection."""

    if isinstance(value, Mapping):
        for key, item in value.items():
            key_text = str(key)
            normalized_key = normalize_field_name(key_text)
            field_path = ".".join((*path, key_text))
            is_reference = _is_credential_reference_field(key_text)
            if field_name_looks_like_credential(key_text) and not is_reference:
                raise FabricConfigLoadError(
                    f"{field_path} must use environment-variable-name indirection for credentials"
                )
            if key_text == "env" and isinstance(item, Mapping):
                for environment_name in item:
                    environment_name_text = str(environment_name)
                    if (
                        environment_name_text in credential_environment_names
                        or field_name_looks_like_credential(environment_name_text)
                    ):
                        raise FabricConfigLoadError(
                            f"{field_path}.{environment_name} must not contain a literal credential"
                        )
            if normalized_key in _CREDENTIAL_ENVIRONMENT_MAPPING_FIELDS:
                continue
            _reject_literal_credentials(
                item,
                credential_environment_names,
                (*path, key_text),
            )
    elif isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        for item in value:
            _reject_literal_credentials(item, credential_environment_names, path)
    elif isinstance(value, str):
        field_path = ".".join(path) or "config"
        if uri_authority_has_userinfo(value):
            raise FabricConfigLoadError(
                f"{field_path} must not contain URI authority userinfo"
            )
        if value_looks_like_secret(value):
            raise FabricConfigLoadError(f"{field_path} must not contain a literal credential")


def _validation_summary(error: Exception) -> str:
    """Describe validation locations without echoing rejected config values."""

    errors_method = getattr(error, "errors", None)
    if not callable(errors_method):
        return error.__class__.__name__
    try:
        issues = errors_method(
            include_url=False,
            include_context=False,
            include_input=False,
        )
    except (TypeError, ValueError):
        return error.__class__.__name__
    summaries: list[str] = []
    for issue in issues:
        location = ".".join(str(part) for part in issue.get("loc", ())) or "config"
        message = str(issue.get("msg", "is invalid"))
        summaries.append(f"{location}: {message}")
    return "; ".join(summaries) if summaries else error.__class__.__name__


def _invocation_unavailable_reason(payload: Mapping[str, Any]) -> str | None:
    """Read the package-owned NemoClaw invocation availability decision."""

    reason = _nemoclaw_metadata(payload).get("invocation_unavailable_reason")
    if reason is None:
        return None
    if not isinstance(reason, str) or not reason.strip():
        raise FabricConfigLoadError(
            "environment.metadata.nemoclaw.invocation_unavailable_reason "
            "must be a non-empty string"
        )
    return reason.strip()


def _read_bounded_config(config_path: Path) -> tuple[Path, bytes]:
    """Read one stable regular file without following its final path component."""

    no_follow = getattr(os, "O_NOFOLLOW", None)
    if no_follow is None:
        raise FabricConfigLoadError("this platform cannot safely open a Fabric config")
    candidate = Path(os.path.abspath(config_path))
    flags = os.O_RDONLY | os.O_NONBLOCK | no_follow | getattr(os, "O_CLOEXEC", 0)
    try:
        descriptor = os.open(candidate, flags)
    except OSError as error:
        raise FabricConfigLoadError(
            f"could not open Fabric config {config_path} as a regular file"
        ) from error

    try:
        before = os.fstat(descriptor)
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1:
            raise FabricConfigLoadError(
                f"Fabric config {config_path} must be one regular file"
            )
        if before.st_size > FABRIC_CONFIG_MAX_BYTES:
            raise FabricConfigLoadError(
                f"Fabric config {config_path} exceeds the {FABRIC_CONFIG_MAX_BYTES}-byte limit"
            )

        chunks: list[bytes] = []
        remaining = FABRIC_CONFIG_MAX_BYTES + 1
        while remaining > 0:
            chunk = os.read(descriptor, min(64 * 1024, remaining))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        raw_bytes = b"".join(chunks)
        if len(raw_bytes) > FABRIC_CONFIG_MAX_BYTES:
            raise FabricConfigLoadError(
                f"Fabric config {config_path} exceeds the {FABRIC_CONFIG_MAX_BYTES}-byte limit"
            )

        after = os.fstat(descriptor)
        stable_fields = ("st_dev", "st_ino", "st_mode", "st_nlink", "st_size", "st_mtime_ns")
        if any(getattr(before, field) != getattr(after, field) for field in stable_fields):
            raise FabricConfigLoadError(f"Fabric config {config_path} changed while it was read")
        path_metadata = os.lstat(candidate)
        if (
            not stat.S_ISREG(path_metadata.st_mode)
            or path_metadata.st_nlink != 1
            or path_metadata.st_dev != after.st_dev
            or path_metadata.st_ino != after.st_ino
        ):
            raise FabricConfigLoadError(
                f"Fabric config {config_path} changed while it was read"
            )
        resolved_path = candidate.resolve(strict=True)
        resolved_metadata = os.stat(resolved_path, follow_symlinks=False)
        if (
            not stat.S_ISREG(resolved_metadata.st_mode)
            or resolved_metadata.st_dev != after.st_dev
            or resolved_metadata.st_ino != after.st_ino
        ):
            raise FabricConfigLoadError(
                f"Fabric config {config_path} changed while it was resolved"
            )
        return resolved_path, raw_bytes
    except OSError as error:
        raise FabricConfigLoadError(
            f"could not read Fabric config {config_path} safely"
        ) from error
    finally:
        os.close(descriptor)


def load_fabric_config(path: str | Path) -> LoadedFabricConfig:
    """Read one JSON file and validate it with Fabric's native config model."""

    config_path = Path(path).expanduser()
    try:
        resolved_path, raw_bytes = _read_bounded_config(config_path)
        raw = raw_bytes.decode("utf-8")
    except FabricConfigLoadError:
        raise
    except UnicodeError as error:
        raise FabricConfigLoadError(
            f"could not read Fabric config {config_path}: {error}"
        ) from error

    try:
        payload: Any = json.loads(raw)
    except json.JSONDecodeError as error:
        raise FabricConfigLoadError(
            f"Fabric config {resolved_path} is not valid JSON: "
            f"line {error.lineno}, column {error.colno}"
        ) from error
    if not isinstance(payload, dict):
        raise FabricConfigLoadError(f"Fabric config {resolved_path} must contain a JSON object")

    names = set(_credential_environment_names(payload))
    names.update(_declared_credential_environment_names(payload))
    _reject_literal_credentials(payload, frozenset(names))

    try:
        config = FabricConfig.from_mapping(payload)
    except Exception as error:
        raise FabricConfigLoadError(
            f"Fabric config {resolved_path} is invalid: {_validation_summary(error)}"
        ) from error
    if config.runtime.timeout_seconds is None:
        raise FabricConfigLoadError(
            f"Fabric config {resolved_path} must set runtime.timeout_seconds"
        )
    return LoadedFabricConfig(
        config=config,
        base_dir=resolved_path.parent,
        path=resolved_path,
        content_sha256=hashlib.sha256(raw_bytes).hexdigest(),
        credential_environment_names=tuple(sorted(names)),
        invocation_unavailable_reason=_invocation_unavailable_reason(payload),
    )


def require_supervisor_config_identity(
    loaded: LoadedFabricConfig,
    environment: Mapping[str, str],
) -> None:
    """Reject a config changed after the cleanup supervisor selected its root."""

    expected = environment.get(SUPERVISOR_CONFIG_SHA256_ENV)
    if expected is None:
        return
    if not re.fullmatch(r"[0-9a-f]{64}", expected) or not hmac.compare_digest(
        loaded.content_sha256,
        expected,
    ):
        raise FabricConfigLoadError(
            "Fabric config changed after the request supervisor validated it"
        )
