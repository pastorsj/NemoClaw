# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Render Fabric results without exposing credential diagnostics."""

from __future__ import annotations

import json
import re
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlsplit


REDACTED = "<redacted>"
_SENSITIVE_NAME = re.compile(
    r"(?:^|_)(?:API_?KEY|KEY|TOKEN|SECRET|CREDENTIAL|PASSWORD|PASSWD|PASS)(?:$|_)",
    re.IGNORECASE,
)
_CREDENTIAL_FIELD_NAMES = frozenset(
    {
        "apikey",
        "api_key",
        "auth",
        "credential",
        "credentials",
        "key",
        "keys",
        "pass",
        "passwd",
        "passwds",
        "passphrase",
        "passphrases",
        "password",
        "passwords",
        "resolved_key",
        "resolvedkey",
        "secret",
        "secrets",
        "token",
        "tokens",
    }
)
_CREDENTIAL_FIELD_NAME = re.compile(
    r"^(?:(?:personal_?)?access|refresh|client|bearer|oauth|auth|api|private|public|"
    r"signing|session|bot|app|resolved)_?"
    r"(?:tokens?|keys?|secrets?|passwords?|passphrases?|credentials?)$",
    re.IGNORECASE,
)
_ENVIRONMENT_CREDENTIAL_FIELD_NAME = re.compile(
    r"^(?:[A-Z0-9]+_)*(?:TOKEN|KEY|SECRET|PASSWORD|PASSWD|PASS|PASSPHRASE|CREDENTIAL)S?$"
)
_HEADER_CREDENTIAL_FIELD_NAME = re.compile(
    r"-(?:key|token|secret|password|passphrase|credential|auth)s?$",
    re.IGNORECASE,
)
_CREDENTIAL_HEADER_NAMES = frozenset(
    {"authorization", "cookie", "proxy-authorization", "set-cookie"}
)
_PUBLIC_KEY_FIELD_NAME = re.compile(r"(?:^|_)public_keys?$")
_URI_AUTHORITY_CANDIDATE = re.compile(
    r"(?<![A-Za-z0-9+.-])(?:(?:[A-Za-z][A-Za-z0-9+.-]*):)?//[^\s/?#]+"
)
_URI_USERINFO_SEPARATOR = re.compile(r"@|%40", re.IGNORECASE)
_CREDENTIAL_PATTERNS = (
    re.compile(r"\b(?:Bearer|Basic)\s+\S+", re.IGNORECASE),
    re.compile(
        r"\b(?:nvapi-|nvcf-|gh[pousr]_|sk-proj-|sk-ant-|hf_|glpat-|gsk_|"
        r"pypi-|tvly-)[A-Za-z0-9_-]{8,}"
    ),
    re.compile(r"\bsk-[A-Za-z0-9_-]{20,}"),
    re.compile(r"\bgithub_pat_[A-Za-z0-9_]{20,}"),
    re.compile(r"\b(?:xox[bpas]|xapp)-[A-Za-z0-9-]{8,}"),
    re.compile(r"\bA(?:K|S)IA[A-Z0-9]{16}\b"),
    re.compile(r"\b(?:bot)?\d{8,10}:[A-Za-z0-9_-]{35}\b"),
    re.compile(
        r"\b[A-Za-z0-9]{24}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}\b"
    ),
    re.compile(r"\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]{10,}\b"),
    re.compile(r"\blsv2_(?:pt|sk)_[A-Za-z0-9]{10,}(?:_[A-Za-z0-9]+)*\b"),
    re.compile(
        r"-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----[\s\S]*?"
        r"-----END (?:[A-Z0-9]+ )?PRIVATE KEY-----"
    ),
    re.compile(
        r"(?<![A-Za-z0-9])(?:[A-Za-z0-9]{1,128}_"
        r"(?:KEY|TOKEN|SECRET|CREDENTIAL|PASSWORD|PASSWD|PASS)|"
        r"(?:X[-_])?API[-_]?KEY|KEY|TOKEN|SECRET|CREDENTIAL|PASSWORD|PASSWD|PASS)"
        r"[\"']?(?:[ \t]{0,32}[=:][ \t]{0,32}|[ \t]{1,32})"
        r"[\"']?[^\s'\"]{10,}",
        re.IGNORECASE,
    ),
    re.compile(
        r"(?<![A-Za-z0-9])(?:[A-Za-z0-9]{1,128}(?:Token|Secret|Credential)|"
        r"[A-Za-z0-9]{0,128}(?:Access|Refresh|Client|Bearer|Auth|API|Api|Private|"
        r"Signing|Session|Bot|App|Resolved)Key|"
        r"[A-Za-z0-9]{1,128}(?:Password|Passwd|Pass|Passphrase))"
        r"[\"']?(?:[ \t]{0,32}[=:][ \t]{0,32}|[ \t]{1,32})"
        r"[\"']?[^\s'\"]{10,}"
    ),
)


def normalize_field_name(field_name: str) -> str:
    """Normalize snake, kebab, dotted, and camel-case field names."""

    normalized = re.sub(r"([A-Z]+)([A-Z][a-z])", r"\1_\2", field_name)
    normalized = re.sub(r"([a-z0-9])([A-Z])", r"\1_\2", normalized)
    return re.sub(r"[^A-Za-z0-9]+", "_", normalized).strip("_").lower()


def field_name_looks_like_credential(field_name: str) -> bool:
    """Recognize credential-bearing fields without adapter knowledge."""

    normalized = normalize_field_name(field_name)
    if _PUBLIC_KEY_FIELD_NAME.search(normalized):
        return False
    return bool(
        normalized in _CREDENTIAL_FIELD_NAMES
        or _CREDENTIAL_FIELD_NAME.fullmatch(normalized)
        or normalized in {"authorization", "cookie", "proxy_authorization", "set_cookie"}
        or normalized.endswith(("_pass", "_passwd"))
        or _ENVIRONMENT_CREDENTIAL_FIELD_NAME.fullmatch(field_name)
        or _HEADER_CREDENTIAL_FIELD_NAME.search(field_name)
        or field_name.lower() in _CREDENTIAL_HEADER_NAMES
    )


def _raw_authority_has_userinfo(value: str) -> bool:
    """Inspect authority text when URI parsing rejects malformed structure."""

    authority_start = value.find("//") + 2
    return authority_start > 1 and "@" in value[authority_start:]


def _uri_candidate_has_userinfo(value: str) -> bool:
    decoded = unquote(value)
    candidates = (value,) if decoded == value else (value, decoded)
    for candidate in candidates:
        try:
            parsed = urlsplit(candidate)
            if parsed.netloc and (
                parsed.username is not None or parsed.password is not None
            ):
                return True
        except ValueError:
            if _raw_authority_has_userinfo(candidate):
                return True
    return False


def uri_authority_has_userinfo(value: str) -> bool:
    """Detect literal or once-decoded userinfo in each URI authority."""

    return any(
        _uri_candidate_has_userinfo(match.group(0))
        for match in _URI_AUTHORITY_CANDIDATE.finditer(value)
    )


def _redact_uri_authority_userinfo(text: str) -> str:
    """Replace URI userinfo without changing credential-free URLs."""

    def redact_candidate(match: re.Match[str]) -> str:
        candidate = match.group(0)
        if not _uri_candidate_has_userinfo(candidate):
            return candidate
        authority_start = candidate.find("//") + 2
        authority = candidate[authority_start:]
        separators = tuple(_URI_USERINFO_SEPARATOR.finditer(authority))
        if not separators:
            return REDACTED
        return (
            f"{candidate[:authority_start]}{REDACTED}@"
            f"{authority[separators[-1].end():]}"
        )

    return _URI_AUTHORITY_CANDIDATE.sub(redact_candidate, text)


def value_looks_like_secret(value: str) -> bool:
    """Return whether text contains a supported credential shape."""

    return uri_authority_has_userinfo(value) or any(
        pattern.search(value) for pattern in _CREDENTIAL_PATTERNS
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

    redacted = _redact_uri_authority_userinfo(text)
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
        redacted_mapping: dict[str, Any] = {}
        for key, item in value.items():
            key_text = str(key)
            redacted_key = redact_diagnostic_text(key_text, secret_values)
            redacted_mapping[redacted_key] = (
                REDACTED
                if field_name_looks_like_credential(key_text)
                else redact_output_value(item, secret_values)
            )
        return redacted_mapping
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
