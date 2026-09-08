# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Return a stable, credential-free digest for OpenClaw's canonical CLI session."""

import base64
import hashlib
import importlib.util
import json
import os
import subprocess
import sys

MAX_NATIVE_OUTPUT_BYTES = 1024 * 1024
REQUIRED_PAIRED_SCOPES = {"operator.pairing", "operator.write"}
REQUIRED_TOKEN_SCOPES = {"operator.pairing", "operator.read", "operator.write"}


def load_auth_state_helper():
    installed_path = "/usr/local/lib/nemoclaw/openclaw-auth-state.py"
    source_path = os.path.join(os.path.dirname(__file__), "auth-state.py")
    helper_path = source_path if os.path.isfile(source_path) else installed_path
    spec = importlib.util.spec_from_file_location("nemoclaw_openclaw_auth_state", helper_path)
    if spec is None or spec.loader is None:
        raise ValueError("device-auth state helper is unavailable")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.read_disabled_device_auth_projection


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
    ):
        child_environment.pop(name, None)
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
        and exact_string_set(device.get("approvedScopes"), REQUIRED_PAIRED_SCOPES)
    ]
    if len(candidates) != 1:
        raise ValueError("canonical CLI device is not uniquely paired")
    candidate = candidates[0]
    tokens = candidate.get("tokens")
    operator = tokens.get("operator") if isinstance(tokens, dict) and set(tokens) == {"operator"} else None
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
    # Managed onboarding intentionally disables device authentication. In that
    # mode there is no credential state to inspect, but launch readiness still
    # needs a stable package-owned observation. Keeping the distinction here
    # lets NemoClaw core remain unaware of OpenClaw configuration details.
    if os.environ.get("NEMOCLAW_DISABLE_DEVICE_AUTH") == "1":
        return load_auth_state_helper()()
    if os.environ.get("NEMOCLAW_DISABLE_DEVICE_AUTH", "0") != "0":
        raise ValueError("device authentication mode is invalid")
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
