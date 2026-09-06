# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Clear stale managed-provider session pins after a rebuild state restore."""

import json
import os
import re
import tempfile

CONFIG_PATH = "/sandbox/.openclaw/openclaw.json"
SESSIONS_PATH = "/sandbox/.openclaw/agents/main/sessions/sessions.json"
MANAGED_PROVIDER = "inference"
SAFE_MODEL = re.compile(r"^[A-Za-z0-9._:/-]{1,512}$")


def read_primary_model() -> str | None:
    try:
        with open(CONFIG_PATH, encoding="utf-8") as config_file:
            value = json.load(config_file)["agents"]["defaults"]["model"]["primary"]
    except (KeyError, OSError, TypeError, ValueError):
        return None
    return value if isinstance(value, str) and SAFE_MODEL.fullmatch(value) else None


def reconcile_sessions(primary: str) -> None:
    try:
        source = os.stat(SESSIONS_PATH, follow_symlinks=False)
        if not os.path.isfile(SESSIONS_PATH) or source.st_nlink != 1:
            raise ValueError("session store must be a singly linked regular file")
        with open(SESSIONS_PATH, encoding="utf-8") as sessions_file:
            sessions = json.load(sessions_file)
    except FileNotFoundError:
        return
    if not isinstance(sessions, dict):
        raise ValueError("session store must contain an object")

    changed = False
    for session in sessions.values():
        if not isinstance(session, dict):
            continue
        provider = session.get("modelProvider")
        model = session.get("model")
        if provider != MANAGED_PROVIDER or not isinstance(model, str):
            continue
        if f"{provider}/{model}" == primary:
            continue
        session.pop("model", None)
        session.pop("modelProvider", None)
        changed = True
    if not changed:
        return

    parent = os.path.dirname(SESSIONS_PATH)
    descriptor, staged = tempfile.mkstemp(prefix=".sessions.json.nemoclaw.", dir=parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as staged_file:
            json.dump(sessions, staged_file, indent=2)
            staged_file.write("\n")
            staged_file.flush()
            os.fchmod(staged_file.fileno(), source.st_mode & 0o7777)
            os.fsync(staged_file.fileno())
        current = os.stat(SESSIONS_PATH, follow_symlinks=False)
        if (current.st_dev, current.st_ino, current.st_size, current.st_mtime_ns) != (
            source.st_dev,
            source.st_ino,
            source.st_size,
            source.st_mtime_ns,
        ):
            raise RuntimeError("session store changed during reconciliation")
        os.replace(staged, SESSIONS_PATH)
        staged = ""
    finally:
        if staged:
            os.unlink(staged)


def main() -> None:
    primary = read_primary_model()
    if primary is not None:
        reconcile_sessions(primary)


if __name__ == "__main__":
    main()
