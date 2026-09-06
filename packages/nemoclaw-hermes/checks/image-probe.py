#!/opt/hermes/.venv/bin/python -I
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Validate the package-owned requirements of a Hermes base image."""

from __future__ import annotations

import hashlib
from importlib import metadata
from pathlib import Path

PROBE_OK = "nemoclaw-image-probe-ok"


def managed_runtime_is_usable() -> bool:
    """Require the ACP adapter and lazy MCP Streamable HTTP client surfaces."""

    try:
        import acp  # noqa: F401
        import mcp  # noqa: F401
        from acp_adapter.server import HermesACPAgent  # noqa: F401
        from tools import mcp_tool
    except (ImportError, ModuleNotFoundError):
        return False
    return (
        metadata.version("agent-client-protocol") == "0.9.0"
        and mcp_tool._ensure_mcp_sdk()
        and bool(getattr(mcp_tool, "_MCP_AVAILABLE", False))
        and bool(getattr(mcp_tool, "_MCP_HTTP_AVAILABLE", False))
    )


def main() -> int:
    """Emit a source-bound marker only when every package requirement passes."""

    if not managed_runtime_is_usable():
        return 1
    source_digest = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    print(f"{PROBE_OK} {source_digest}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
