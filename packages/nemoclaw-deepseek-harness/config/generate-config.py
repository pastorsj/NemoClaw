# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Generate the credential-free Fabric configuration for DeepSeek Harness."""

from __future__ import annotations

import json
import os
from pathlib import Path
from urllib.parse import urlsplit


ADAPTER_ID = "nvidia.nemoclaw.deepseek-harness"
ADAPTER_PATH = "/usr/local/share/nemoclaw/deepseek.fabric-adapter.json"
API_KEY_ENV = "DEEPSEEK_FABRIC_API_KEY"
ARTIFACTS_PATH = "/sandbox/.deepseek-harness/fabric-artifacts"
BASE_URL = "https://inference.local/v1"
INFERENCE_API = "openai-completions"


def _normalized_text(value: str | None, name: str) -> str:
    """Return one non-empty metadata value without invisible controls."""

    if value is None:
        raise ValueError(f"{name} is required")
    text = value.strip()
    if not text or any(
        ord(character) < 32 or ord(character) == 127 for character in text
    ):
        raise ValueError(f"{name} must be non-empty text without control characters")
    return text


def _managed_base_url(value: str | None) -> str:
    """Accept only the OpenShell-managed inference route used by the adapter."""

    text = _normalized_text(value or BASE_URL, "NEMOCLAW_INFERENCE_BASE_URL")
    parsed = urlsplit(text)
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError(
            "NEMOCLAW_INFERENCE_BASE_URL must not contain credentials or URL metadata"
        )
    if text != BASE_URL:
        raise ValueError(f"NEMOCLAW_INFERENCE_BASE_URL must be {BASE_URL}")
    return text


def build_fabric_config(environment: dict[str, str]) -> dict[str, object]:
    """Project NemoClaw build settings onto the released Fabric schema."""

    model = _normalized_text(environment.get("NEMOCLAW_MODEL"), "NEMOCLAW_MODEL")
    inference_api = _normalized_text(
        environment.get("NEMOCLAW_INFERENCE_API", INFERENCE_API),
        "NEMOCLAW_INFERENCE_API",
    )
    if inference_api != INFERENCE_API:
        raise ValueError(f"NEMOCLAW_INFERENCE_API must be {INFERENCE_API}")
    base_url = _managed_base_url(environment.get("NEMOCLAW_INFERENCE_BASE_URL"))
    return {
        "schema_version": "fabric.agent/v1alpha1",
        "metadata": {
            "name": "nemoclaw-deepseek-harness",
            "description": "NemoClaw-managed DeepSeek Harness headless runtime",
        },
        "harness": {"adapter_id": ADAPTER_ID, "resolution": "preinstalled"},
        "discovery": {"local_paths": [ADAPTER_PATH]},
        "runtime": {
            "input_schema": "text",
            "output_schema": "message",
            "artifacts": ARTIFACTS_PATH,
            "timeout_seconds": 90,
        },
        "environment": {
            "provider": "local",
            "workspace": "/sandbox",
            "artifacts": ARTIFACTS_PATH,
            "ownership": "caller_owned",
            "control_location": "in_env_control",
        },
        "models": {
            "default": {
                "provider": "openshell",
                "model": model,
                "api_key_env": API_KEY_ENV,
                "base_url": base_url,
            }
        },
    }


def write_fabric_config(environment: dict[str, str]) -> Path:
    """Write private configuration and state directories beneath explicit DSH_HOME."""

    home = Path(environment.get("HOME", "/sandbox"))
    state_root = home / ".deepseek-harness"
    state_root.mkdir(parents=True, exist_ok=True, mode=0o700)
    state_root.chmod(0o700)
    for directory in ("sessions", "logs", "cache", "fabric-artifacts"):
        child = state_root / directory
        child.mkdir(exist_ok=True, mode=0o700)
        child.chmod(0o700)
    config_path = state_root / "fabric.json"
    config_path.write_text(
        json.dumps(build_fabric_config(environment), indent=2) + "\n",
        encoding="utf-8",
    )
    config_path.chmod(0o600)
    return config_path


def main() -> None:
    """Generate the package configuration used by the terminal command."""

    path = write_fabric_config(dict(os.environ))
    print(f"[config] Wrote {path}")


if __name__ == "__main__":
    main()
