# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Translate OpenClaw's native extension registry into NemoClaw's bounded protocol."""

from __future__ import annotations

import json
import os
import sqlite3
import stat
import sys
import urllib.parse
from pathlib import PurePosixPath
from typing import Any


MAX_FILE_BYTES = 4 * 1024 * 1024
MAX_EXTENSIONS = 128
MAX_LOAD_PATHS = 512
MAX_PATH_BYTES = 4096
VALID_SOURCES = {"archive", "clawhub", "git", "marketplace", "npm", "path"}
FORBIDDEN_IDS = {"__proto__", "constructor", "prototype"}


def _read_regular_file(path: str) -> bytes:
    opened = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    try:
        before = os.fstat(opened)
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1:
            raise ValueError("native state input is not an independent regular file")
        if before.st_size > MAX_FILE_BYTES:
            raise ValueError("native state input exceeds its size limit")
        content = os.read(opened, MAX_FILE_BYTES + 1)
        after = os.fstat(opened)
        if len(content) > MAX_FILE_BYTES:
            raise ValueError("native state input exceeds its size limit")
        if (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns) != (
            after.st_dev,
            after.st_ino,
            after.st_size,
            after.st_mtime_ns,
        ):
            raise ValueError("native state input changed while it was read")
        return content
    finally:
        os.close(opened)


def _read_json(path: str) -> Any:
    return json.loads(_read_regular_file(path).decode("utf-8"))


def _read_sqlite_records(path: str) -> Any:
    metadata = os.lstat(path)
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1:
        raise ValueError("native SQLite registry is not an independent regular file")
    uri = "file:" + urllib.parse.quote(path, safe="/") + "?mode=ro"
    connection = sqlite3.connect(uri, uri=True, timeout=30)
    try:
        connection.execute("PRAGMA query_only=ON")
        connection.execute("PRAGMA busy_timeout=30000")
        row = connection.execute(
            "SELECT install_records_json FROM installed_plugin_index "
            "WHERE index_key = 'installed-plugin-index'"
        ).fetchone()
        if not row or not row[0]:
            raise ValueError("native SQLite registry has no installed-extension index")
        if len(row[0].encode("utf-8")) > MAX_FILE_BYTES:
            raise ValueError("native SQLite registry response exceeds its size limit")
        return json.loads(row[0])
    finally:
        connection.close()


def _canonical_absolute_path(value: Any) -> str:
    if not isinstance(value, str) or not value.startswith("/"):
        raise ValueError("native extension path is not absolute")
    if len(value.encode("utf-8")) > MAX_PATH_BYTES or any(ord(char) < 32 for char in value):
        raise ValueError("native extension path is invalid")
    normalized = str(PurePosixPath(value))
    if normalized != value or ".." in PurePosixPath(value).parts:
        raise ValueError("native extension path is not canonical")
    return value


def _extension_id(value: Any) -> str:
    if (
        not isinstance(value, str)
        or not value
        or len(value) > 256
        or value in FORBIDDEN_IDS
        or any(ord(char) < 32 or ord(char) == 127 for char in value)
    ):
        raise ValueError("native extension identifier is invalid")
    return value


def _load_native_state(root: str) -> tuple[dict[str, Any], list[str]]:
    config = _read_json(os.path.join(root, "openclaw.json"))
    plugins = config.get("plugins") if isinstance(config, dict) else None
    load = plugins.get("load") if isinstance(plugins, dict) else None
    raw_load_paths = load.get("paths", []) if isinstance(load, dict) else []
    if (
        not isinstance(raw_load_paths, list)
        or len(raw_load_paths) > MAX_LOAD_PATHS
        or any(not isinstance(item, str) or len(item) > MAX_PATH_BYTES for item in raw_load_paths)
    ):
        raise ValueError("native configured extension paths are invalid")

    sqlite_path = os.path.join(root, "state", "openclaw.sqlite")
    if os.path.lexists(sqlite_path):
        records = _read_sqlite_records(sqlite_path)
    else:
        legacy = _read_json(os.path.join(root, "plugins", "installs.json"))
        records = legacy.get("installRecords") if isinstance(legacy, dict) else None
    if not isinstance(records, dict) or len(records) > MAX_EXTENSIONS:
        raise ValueError("native extension registry is invalid")
    return records, raw_load_paths


def _project_extensions(root: str) -> list[dict[str, Any]]:
    records, load_paths = _load_native_state(root)
    configured_paths = set(load_paths)
    extension_root = root.rstrip("/") + "/extensions/"
    result: list[dict[str, Any]] = []
    directories: set[str] = set()
    configured_owners: set[str] = set()
    for raw_id in sorted(records):
        extension_id = _extension_id(raw_id)
        metadata = records[raw_id]
        if not isinstance(metadata, dict) or metadata.get("source") not in VALID_SOURCES:
            raise ValueError("native extension metadata is invalid")
        install_path = _canonical_absolute_path(metadata.get("installPath"))
        source_path = metadata.get("sourcePath")
        if source_path is not None:
            source_path = _canonical_absolute_path(source_path)
        if metadata.get("source") == "path" and source_path is None:
            raise ValueError("native path extension is missing its source")

        directory: str | None = None
        if install_path.startswith(extension_root):
            relative = install_path[len(extension_root) :]
            if "/" in relative or not relative or relative in {".", ".."}:
                raise ValueError("native extension directory is invalid")
            directory = relative
            if directory in directories:
                raise ValueError("native extension directory is duplicated")
            directories.add(directory)

        config_paths: list[str] = []
        if metadata.get("source") == "path" and source_path in configured_paths:
            if source_path in configured_owners:
                raise ValueError("native configured extension path has multiple owners")
            configured_owners.add(source_path)
            config_paths.append(source_path)
        result.append(
            {"id": extension_id, "directory": directory, "configPaths": config_paths}
        )
    return result


def main(argv: list[str]) -> int:
    if len(argv) != 3 or argv[2] != "inspect-managed-extensions":
        raise ValueError("unsupported managed-extension controller operation")
    root = _canonical_absolute_path(argv[1])
    print(
        json.dumps(
            {"schemaVersion": 1, "extensions": _project_extensions(root)},
            separators=(",", ":"),
            sort_keys=True,
        )
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main(sys.argv))
    except (OSError, ValueError, json.JSONDecodeError, sqlite3.Error) as error:
        print(f"managed-extension inspection failed: {error}", file=sys.stderr)
        raise SystemExit(1) from None
