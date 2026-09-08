# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Validate OpenClaw's intentional no-device-auth runtime state."""

import json
import os
import stat
import sys

ALLOWED_OPT_OUT_SOURCES = {"managed-onboard", "operator"}


def read_disabled_device_auth_projection(environment=None):
    current_environment = os.environ if environment is None else environment
    if current_environment.get("NEMOCLAW_DISABLE_DEVICE_AUTH") != "1":
        raise ValueError("device authentication is not intentionally disabled")
    opt_out_source = current_environment.get("NEMOCLAW_DEVICE_AUTH_OPT_OUT_SOURCE", "")
    if opt_out_source not in ALLOWED_OPT_OUT_SOURCES:
        raise ValueError("device authentication opt-out source is invalid")

    state_directory = current_environment.get("OPENCLAW_STATE_DIR") or "/sandbox/.openclaw"
    config_path = os.path.join(state_directory, "openclaw.json")
    metadata = os.lstat(config_path)
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1:
        raise ValueError("OpenClaw config is not a regular single-link file")
    with open(config_path, "r", encoding="utf-8") as handle:
        document = json.load(handle)
    try:
        disabled = document["gateway"]["controlUi"]["dangerouslyDisableDeviceAuth"]
    except (KeyError, TypeError) as error:
        raise ValueError("OpenClaw device-auth config is incomplete") from error
    if disabled is not True:
        raise ValueError("OpenClaw device authentication remains enabled")
    return {"deviceAuth": "disabled", "optOutSource": opt_out_source}


def main():
    if len(sys.argv) != 1:
        raise SystemExit(2)
    projection = read_disabled_device_auth_projection()
    print(json.dumps(projection, separators=(",", ":"), sort_keys=True))


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, json.JSONDecodeError):
        raise SystemExit(1) from None
