# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Render Fabric results without exposing credential diagnostics."""

from __future__ import annotations

import json
import re
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any


REDACTED = "<redacted>"
_SENSITIVE_NAME = re.compile(
    r"(?:^|_)(?:API_?KEY|KEY|TOKEN|SECRET|CREDENTIAL|PASSWORD|PASSWD|PASS)(?:$|_)",
    re.IGNORECASE,
)
_CREDENTIAL_PATTERNS = (
    re.compile(r"\b(?:Bearer|Basic)\s+\S+", re.IGNORECASE),
    re.compile(
        r"\b(?:nvapi-|nvcf-|gh[pousr]_|sk-proj-|sk-ant-|hf_|glpat-|gsk_|"
        r"pypi-|tvly-)[A-Za-z0-9_-]{8,}"
    ),
    re.compile(r"\bgithub_pat_[A-Za-z0-9_]{20,}"),
    re.compile(r"\bxox(?:b|p|a|s|r)-[A-Za-z0-9-]{8,}"),
)


def collect_secret_values(
    environment: Mapping[str, str],
    credential_environment_names: Sequence[str] = (),
) -> tuple[str, ...]:
    """Return declared and name-shaped secrets in longest-first replacement order."""

    declared_names = set(credential_environment_names)
    values = {
        value
        for name, value in environment.items()
        if value
        and (
            name in declared_names
            or (len(value) >= 4 and _SENSITIVE_NAME.search(name))
        )
    }
    return tuple(sorted(values, key=len, reverse=True))


def redact_diagnostic_text(text: str, secret_values: Sequence[str] = ()) -> str:
    """Remove known secret values and common credential forms from text."""

    redacted = text
    for secret in sorted({value for value in secret_values if value}, key=len, reverse=True):
        redacted = redacted.replace(secret, REDACTED)
    for pattern in _CREDENTIAL_PATTERNS:
        redacted = pattern.sub(REDACTED, redacted)
    return redacted


def redact_output_value(value: Any, secret_values: Sequence[str] = ()) -> Any:
    """Convert a Fabric mapping to JSON values while redacting every string."""

    if value is None or isinstance(value, (bool, int, float)):
        return value
    if isinstance(value, str):
        return redact_diagnostic_text(value, secret_values)
    if isinstance(value, Path):
        return redact_diagnostic_text(str(value), secret_values)
    if isinstance(value, Mapping):
        return {
            redact_diagnostic_text(str(key), secret_values): redact_output_value(
                item, secret_values
            )
            for key, item in value.items()
        }
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        return [redact_output_value(item, secret_values) for item in value]
    if hasattr(value, "to_mapping"):
        return redact_output_value(value.to_mapping(), secret_values)
    return redact_diagnostic_text(str(value), secret_values)


def serialize_json_output(value: Any, secret_values: Sequence[str] = ()) -> str:
    """Return one stable compact JSON record."""

    return json.dumps(
        redact_output_value(value, secret_values),
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    )


def render_plain_result(result: Any, secret_values: Sequence[str] = ()) -> str:
    """Return the response text, or the complete adapter output when absent."""

    output = result.output
    response = output.get("response") if isinstance(output, Mapping) else None
    selected = response if response is not None else output
    if isinstance(selected, str):
        return redact_diagnostic_text(selected, secret_values)
    return serialize_json_output(selected, secret_values)


def error_payload(
    *,
    stage: str,
    code: str,
    message: str,
    secret_values: Sequence[str] = (),
    details: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """Build one runner-owned structured error for failures without a RunResult."""

    error: dict[str, Any] = {
        "stage": redact_diagnostic_text(stage, secret_values),
        "code": redact_diagnostic_text(code, secret_values),
        "message": redact_diagnostic_text(message, secret_values),
        "retryable": False,
    }
    if details:
        error["details"] = redact_output_value(details, secret_values)
    return {"status": "failed", "error": error}
