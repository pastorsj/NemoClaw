#!/usr/bin/python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Return a stable, credential-free digest for OpenClaw's canonical CLI session."""

import base64
import hashlib
import json
import os
import subprocess
import sys

MAX_NATIVE_OUTPUT_BYTES = 1024 * 1024
REQUIRED_PAIRED_SCOPES = {"operator.pairing", "operator.write"}
REQUIRED_TOKEN_SCOPES = {"operator.pairing", "operator.read", "operator.write"}


def exact_string_set(value, expected):
    return (
        isinstance(value, list)
        and len(value) == len(expected)
        and all(isinstance(item, str) for item in value)
        and set(value) == expected
    )


def identity_public_key(identity):
    public_key = str(identity.get("publicKey", "") or "").strip()
    if public_key:
        return public_key
    pem = str(identity.get("publicKeyPem", "") or "")
    body = "".join(line.strip() for line in pem.splitlines() if "---" not in line)
    if not body:
        return ""
    decoded = base64.b64decode(body, validate=True)
    if len(decoded) < 32:
        return ""
    return base64.urlsafe_b64encode(decoded[-32:]).decode("ascii").rstrip("=")


def local_identity(state_directory):
    identity_path = os.path.join(state_directory, "identity", "device.json")
    with open(identity_path, "r", encoding="utf-8") as handle:
        identity = json.load(handle)
    if not isinstance(identity, dict):
        raise ValueError("device identity is malformed")
    device_id = str(identity.get("deviceId", "") or "").strip()
    public_key = identity_public_key(identity)
    decoded_key = base64.urlsafe_b64decode(public_key + "=" * (-len(public_key) % 4))
    if len(decoded_key) != 32 or hashlib.sha256(decoded_key).hexdigest() != device_id:
        raise ValueError("device identity is invalid")
    return device_id, public_key


def devices_list(openclaw_binary):
    child_environment = dict(os.environ)
    for name in (
        "OPENCLAW_GATEWAY_URL",
        "OPENCLAW_GATEWAY_PORT",
        "OPENCLAW_GATEWAY_TOKEN",
        "OPENCLAW_GATEWAY_PASSWORD",
        "NEMOCLAW_OPENCLAW_FORCE_DEVICE_PAIRING",
        "NEMOCLAW_OPENCLAW_RESTORED_CLONE_PAIRING",
        "NEMOCLAW_OPENCLAW_PAIRING_SETTLEMENT",
        "NEMOCLAW_OPENCLAW_BOUNDED_DEVICE_APPROVAL",
    ):
        child_environment.pop(name, None)
    # The compatibility wrapper uses this marker to require the canonical
    # CLI's stored device credential. Without it, OpenClaw may satisfy the
    # observation with shared gateway auth or a local pending-list fallback.
    child_environment["NEMOCLAW_OPENCLAW_PAIRING_SETTLEMENT"] = "1"
    result = subprocess.run(
        [openclaw_binary, "devices", "list", "--json"],
        capture_output=True,
        check=False,
        env=child_environment,
        timeout=15,
    )
    if result.returncode != 0 or len(result.stdout) > MAX_NATIVE_OUTPUT_BYTES:
        raise ValueError("device observation failed")
    document = json.loads(result.stdout.decode("utf-8"))
    if not isinstance(document, dict):
        raise ValueError("device observation is malformed")
    return document


def qualified_projection(document, device_id, public_key):
    paired = document.get("paired")
    pending = document.get("pending")
    if not isinstance(paired, list) or not isinstance(pending, list):
        raise ValueError("device observation is incomplete")
    if any(not isinstance(request, dict) for request in pending):
        raise ValueError("pending device observation is malformed")
    candidates = [
        device
        for device in paired
        if isinstance(device, dict)
        and device.get("deviceId") == device_id
        and device.get("publicKey") == public_key
        and device.get("clientId") == "cli"
        and device.get("clientMode") == "cli"
        and device.get("role") == "operator"
        and exact_string_set(device.get("roles"), {"operator"})
        and exact_string_set(device.get("scopes"), REQUIRED_PAIRED_SCOPES)
    ]
    if len(candidates) != 1:
        raise ValueError("canonical CLI device is not uniquely paired")
    candidate = candidates[0]
    tokens = candidate.get("tokens")
    if isinstance(tokens, list):
        operator = tokens[0] if len(tokens) == 1 else None
        # OpenClaw's current public devices-list envelope omits approvedScopes
        # and redacts token values. If it supplies approvedScopes, still require
        # the exact baseline rather than accepting a contradictory projection.
        if "approvedScopes" in candidate and not exact_string_set(
            candidate.get("approvedScopes"), REQUIRED_PAIRED_SCOPES
        ):
            raise ValueError("canonical CLI approved scopes are invalid")
    else:
        operator = (
            tokens.get("operator")
            if isinstance(tokens, dict) and set(tokens) == {"operator"}
            else None
        )
        if not exact_string_set(candidate.get("approvedScopes"), REQUIRED_PAIRED_SCOPES):
            raise ValueError("canonical CLI approved scopes are invalid")
    if (
        not isinstance(operator, dict)
        or operator.get("role") != "operator"
        or operator.get("revokedAtMs") is not None
        or not exact_string_set(operator.get("scopes"), REQUIRED_TOKEN_SCOPES)
    ):
        raise ValueError("canonical CLI credential is not qualified")
    if any(
        isinstance(request, dict) and request.get("deviceId") == device_id
        for request in pending
    ):
        raise ValueError("canonical CLI device still has a pending request")
    identity_digest = hashlib.sha256(f"{device_id}\0{public_key}".encode("utf-8")).hexdigest()
    return {
        "deviceIdentitySha256": identity_digest,
        "pairedScopes": sorted(REQUIRED_PAIRED_SCOPES),
        "tokenScopes": sorted(REQUIRED_TOKEN_SCOPES),
    }


def current_session_projection():
    # dangerouslyDisableDeviceAuth applies to OpenClaw's Control UI. The
    # canonical CLI still authenticates to the gateway with a paired device,
    # so launch readiness must always prove that credential rather than infer
    # session authority from the browser setting.
    state_directory = os.environ.get("OPENCLAW_STATE_DIR") or "/sandbox/.openclaw"
    device_id, public_key = local_identity(state_directory)
    openclaw_binary = os.environ.get("OPENCLAW_BIN") or "openclaw"
    return qualified_projection(devices_list(openclaw_binary), device_id, public_key)


def main():
    if len(sys.argv) != 2 or len(sys.argv[1]) != 64:
        raise SystemExit(2)
    nonce = sys.argv[1]
    if any(character not in "0123456789abcdef" for character in nonce):
        raise SystemExit(2)
    projection = current_session_projection()
    canonical = json.dumps(projection, separators=(",", ":"), sort_keys=True).encode("utf-8")
    state_digest = hashlib.sha256(canonical).hexdigest()
    print(f"__NEMOCLAW_SESSION_QUALIFIED__={nonce}:{state_digest}")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, json.JSONDecodeError, subprocess.TimeoutExpired):
        raise SystemExit(1) from None
