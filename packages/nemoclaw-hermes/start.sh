#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# NemoClaw sandbox entrypoint for Hermes Agent.
#
# Mirrors packages/nemoclaw-openclaw/start.sh (OpenClaw) but launches `hermes gateway
# start` instead of `openclaw gateway run`. Key differences:
#   - No device-pairing auto-pair watcher (Hermes has no browser pairing)
#   - Config is YAML (config.yaml + .env) not JSON (openclaw.json)
#   - Gateway listens on internal port 18642, socat forwards the API to 8642
#   - Dashboard listens on a private loopback port, socat forwards it to 18789
#
# SECURITY: The gateway runs as a separate user so the sandboxed agent cannot
# kill it or restart it with a tampered config. Config hash is verified at
# startup to detect tampering.

# shellcheck disable=SC2034 # Sourced Hermes runtime modules consume these globals.

set -euo pipefail

# SECURITY: Lock down PATH before resolving or sourcing root startup helpers.
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
NEMOCLAW_RUNTIME_STATE_MUTATION_RETRY_ARGV=("$@")

# Runtime modules hold the package-owned implementation. This file keeps their
# execution order visible and owns every startup effect below the definitions.
_HERMES_START_SOURCE="${BASH_SOURCE[0]}"
_HERMES_START_DIR="${_HERMES_START_SOURCE%/*}"
if [ "$_HERMES_START_DIR" = "$_HERMES_START_SOURCE" ]; then
  _HERMES_START_DIR="."
fi
_HERMES_STARTUP_MODULE_DIR="/usr/local/lib/nemoclaw/hermes-startup"
if [ ! -d "$_HERMES_STARTUP_MODULE_DIR" ]; then
  _HERMES_STARTUP_MODULE_DIR="$(cd "$_HERMES_START_DIR" && pwd)/runtime"
fi
if [ ! -d "$_HERMES_STARTUP_MODULE_DIR" ] || [ -L "$_HERMES_STARTUP_MODULE_DIR" ]; then
  printf '%s\n' '[SECURITY] Required Hermes startup module directory is missing or unsafe.' >&2
  exit 1
fi
readonly _HERMES_STARTUP_MODULE_DIR
unset _HERMES_START_SOURCE _HERMES_START_DIR

# 1. Authenticate startup against any active runtime-state mutation.
# hermes-startup-module state-gate begin
_HERMES_STATE_GATE_MODULE="${_HERMES_STARTUP_MODULE_DIR}/state-gate.sh"
if [ ! -f "$_HERMES_STATE_GATE_MODULE" ] || [ -L "$_HERMES_STATE_GATE_MODULE" ]; then
  printf '%s\n' '[SECURITY] Required Hermes state-gate module is missing or unsafe.' >&2
  exit 1
fi
# shellcheck source=packages/nemoclaw-hermes/runtime/state-gate.sh
source "$_HERMES_STATE_GATE_MODULE"
unset _HERMES_STATE_GATE_MODULE
# hermes-startup-module state-gate end

# Normalize the managed OCI wrapper before any other package startup effect.
# Keep this in the visible entrypoint because its argument rewrite applies to
# every later module and command dispatch.
# managed-entrypoint-env-wrapper begin
_NEMOCLAW_ENTRYPOINT_ENV_WRAPPER="/usr/local/lib/nemoclaw/entrypoint-env-wrapper.sh"
if [ ! -f "$_NEMOCLAW_ENTRYPOINT_ENV_WRAPPER" ]; then
  _HERMES_ENTRYPOINT_SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  _NEMOCLAW_ENTRYPOINT_ENV_WRAPPER="${_HERMES_ENTRYPOINT_SOURCE_DIR}/../../scripts/lib/entrypoint-env-wrapper.sh"
  unset _HERMES_ENTRYPOINT_SOURCE_DIR
fi
if [ ! -f "$_NEMOCLAW_ENTRYPOINT_ENV_WRAPPER" ]; then
  printf '%s\n' '[SECURITY] Required entrypoint env-wrapper normalizer is missing.' >&2
  exit 1
fi
# shellcheck source=scripts/lib/entrypoint-env-wrapper.sh
source "$_NEMOCLAW_ENTRYPOINT_ENV_WRAPPER"
nemoclaw_normalize_entrypoint_env_wrapper "$@"
if [ "$NEMOCLAW_ENTRYPOINT_NORMALIZED_ARGC" -eq 0 ]; then
  set --
else
  set -- "${NEMOCLAW_ENTRYPOINT_NORMALIZED_ARGV[@]}"
fi
unset NEMOCLAW_ENTRYPOINT_NORMALIZED_ARGC NEMOCLAW_ENTRYPOINT_NORMALIZED_ARGV \
  _NEMOCLAW_ENTRYPOINT_ENV_WRAPPER
unset -f nemoclaw_normalize_entrypoint_env_wrapper
# managed-entrypoint-env-wrapper end

# ── Source shared sandbox initialisation library ─────────────────
# Single source of truth for security-sensitive primitives shared with
# packages/nemoclaw-openclaw/start.sh (OpenClaw). Ref: #2277
# Installed location (container): /usr/local/lib/nemoclaw/sandbox-init.sh
# Dev fallback: scripts/lib/sandbox-init.sh relative to this script.
_SANDBOX_INIT="/usr/local/lib/nemoclaw/sandbox-init.sh"
if [ ! -f "$_SANDBOX_INIT" ]; then
  _HERMES_START_SOURCE="${BASH_SOURCE[0]}"
  _HERMES_START_DIR="${_HERMES_START_SOURCE%/*}"
  if [ "$_HERMES_START_DIR" = "$_HERMES_START_SOURCE" ]; then
    _HERMES_START_DIR="."
  fi
  _SANDBOX_INIT="$(cd "$_HERMES_START_DIR" && pwd)/../../scripts/lib/sandbox-init.sh"
  unset _HERMES_START_SOURCE _HERMES_START_DIR
fi
# shellcheck source=scripts/lib/sandbox-init.sh
source "$_SANDBOX_INIT"

_GATEWAY_SUPERVISOR="/usr/local/lib/nemoclaw/gateway-supervisor.sh"
if [ ! -f "$_GATEWAY_SUPERVISOR" ]; then
  _GATEWAY_SUPERVISOR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../../scripts/lib/gateway-supervisor.sh"
fi
# shellcheck source=scripts/lib/gateway-supervisor.sh
source "$_GATEWAY_SUPERVISOR"

# Harden RLIMITs (nproc #809 + nofile #4527) as root PID 1, before any step-down.
harden_resource_limits

if [ -d /opt/hermes/hermes_cli/web_dist ]; then
  export HERMES_WEB_DIST="${HERMES_WEB_DIST:-/opt/hermes/hermes_cli/web_dist}"
fi

# Hermes' browser Chat tab shells out to the React/Ink TUI. Force it to the
# trusted prebuilt bundle baked into the image so `hermes dashboard --tui
# --skip-build` never honors a stale/user-controlled TUI path or tries to run
# npm under root-owned /opt/hermes at runtime. Remove this when upstream Hermes
# reliably discovers the prebaked ui-tui bundle without HERMES_TUI_DIR.
if [ -f /opt/hermes/ui-tui/dist/entry.js ]; then
  export HERMES_TUI_DIR="/opt/hermes/ui-tui"
fi

# ── Early stderr/stdout capture ──────────────────────────────────
# Capture all entrypoint output to /tmp/nemoclaw-start.log so startup
# failures before /tmp/gateway.log exists are still diagnosable.
prepare_restricted_log() {
  local path="$1"
  local owner="${2:-}"
  local mode="${3:-600}"
  local dir base tmp

  dir="$(dirname "$path")"
  base="$(basename "$path")"
  tmp="$(mktemp "${dir}/.${base}.tmp.XXXXXX")" || return 1
  : >"$tmp" || {
    rm -f "$tmp"
    return 1
  }
  if [ "$(id -u)" -eq 0 ] && [ -n "$owner" ] && ! chown "$owner" "$tmp"; then
    rm -f "$tmp"
    return 1
  fi
  if ! chmod "$mode" "$tmp"; then
    rm -f "$tmp"
    return 1
  fi
  if ! mv -f "$tmp" "$path"; then
    rm -f "$tmp"
    return 1
  fi
}

_START_LOG="/tmp/nemoclaw-start.log"
if [ "$(id -u)" -eq 0 ]; then
  prepare_restricted_log "$_START_LOG" root:root 600
else
  prepare_restricted_log "$_START_LOG" "" 600
fi
exec > >(tee -a "$_START_LOG") 2> >(tee -a "$_START_LOG" >&2)

# ── Drop unnecessary Linux capabilities (shared) ────────────────
drop_capabilities /usr/local/bin/nemoclaw-start "$@"

NEMOCLAW_CMD=("$@")
NEMOCLAW_RUNTIME_STATE_MUTATION_RETRY_ARGV=("$@")

_chat_ui_url_dashboard_settings() {
  [ -n "${CHAT_UI_URL:-}" ] || return 2
  python3 - "$CHAT_UI_URL" <<'PYPORT'
import ipaddress
import re
import sys
from urllib.parse import urlparse

raw_url = sys.argv[1]
try:
    parsed = urlparse(raw_url)
    host = parsed.hostname
    port = parsed.port
except ValueError:
    sys.exit(1)

if (
    parsed.scheme.lower() not in {"http", "https"}
    or not re.match(r"^[a-z][a-z0-9+.-]*://", raw_url, re.IGNORECASE)
    or not parsed.netloc
    or not host
    or parsed.username is not None
    or parsed.password is not None
):
    sys.exit(1)

host = host.lower().rstrip(".")
if not host:
    sys.exit(1)

external_host = host
if host == "localhost":
    external_host = ""
else:
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        pass
    else:
        if address.is_loopback:
            external_host = ""
        elif address.is_unspecified:
            sys.exit(1)

if external_host and parsed.scheme.lower() != "https":
    sys.exit(1)

dashboard_port = port if port is not None and 1024 <= port <= 65535 else ""
print(f"{dashboard_port}|{external_host}")
PYPORT
}

HERMES_DASHBOARD_EXTERNAL_HOST=""
_chat_ui_port=""
if [ -n "${CHAT_UI_URL:-}" ]; then
  if _chat_ui_settings="$(_chat_ui_url_dashboard_settings)"; then
    _chat_ui_port="${_chat_ui_settings%%|*}"
    HERMES_DASHBOARD_EXTERNAL_HOST="${_chat_ui_settings#*|}"
  else
    printf '%s\n' \
      '[SECURITY] Invalid CHAT_UI_URL for the Hermes dashboard. Use an HTTPS external URL without credentials or an HTTP(S) loopback URL. Set CHAT_UI_URL and rerun onboarding before starting the sandbox.' >&2
    exit 1
  fi
fi
unset _chat_ui_settings

_dashboard_port_raw="${NEMOCLAW_DASHBOARD_PORT:-}"
if [ -z "$_dashboard_port_raw" ]; then
  if [ -n "$_chat_ui_port" ]; then
    _dashboard_port="$_chat_ui_port"
  else
    _dashboard_port=18789
  fi
else
  _dashboard_port="$(printf '%s' "$_dashboard_port_raw" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
  _dashboard_port_valid=1
  case "$_dashboard_port" in
    *[!0-9]* | '') _dashboard_port_valid=0 ;;
  esac
  if [ "$_dashboard_port_valid" -eq 1 ] && { [ "$_dashboard_port" -lt 1024 ] || [ "$_dashboard_port" -gt 65535 ]; }; then
    _dashboard_port_valid=0
  fi
  if [ "$_dashboard_port_valid" -ne 1 ]; then
    echo "[SECURITY] Invalid NEMOCLAW_DASHBOARD_PORT='${NEMOCLAW_DASHBOARD_PORT}' - must be an integer between 1024 and 65535" >&2
    exit 1
  fi
fi

# The API port is a per-sandbox host resource: the host forwards the same
# number it is exposed on here, so two sandboxes on one host need two values.
# NemoClaw allocates the port and passes it in; the default keeps a sandbox
# whose create environment carries no value on the original port.
HERMES_DEFAULT_API_PORT=8642
HERMES_API_PORT_RANGE_END=8652
HERMES_RUNTIME_DIR=/run/nemoclaw
_api_port_raw="${NEMOCLAW_HERMES_API_PORT:-}"
if [ -z "$_api_port_raw" ]; then
  PUBLIC_PORT="$HERMES_DEFAULT_API_PORT"
else
  PUBLIC_PORT="$(printf '%s' "$_api_port_raw" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
  _api_port_valid=1
  case "$PUBLIC_PORT" in
    *[!0-9]* | '') _api_port_valid=0 ;;
  esac
  if [ "$_api_port_valid" -eq 1 ] && { [ "$PUBLIC_PORT" -lt "$HERMES_DEFAULT_API_PORT" ] || [ "$PUBLIC_PORT" -gt "$HERMES_API_PORT_RANGE_END" ]; }; then
    _api_port_valid=0
  fi
  if [ "$_api_port_valid" -ne 1 ]; then
    echo "[SECURITY] Invalid NEMOCLAW_HERMES_API_PORT='${NEMOCLAW_HERMES_API_PORT}' - must be an integer from ${HERMES_DEFAULT_API_PORT} through ${HERMES_API_PORT_RANGE_END}" >&2
    exit 1
  fi
fi

if [ "$_dashboard_port" -eq "$PUBLIC_PORT" ]; then
  echo "[SECURITY] Invalid Hermes dashboard port ${_dashboard_port} - reserved for the Hermes OpenAI-compatible API" >&2
  exit 1
fi

if [ -n "${NEMOCLAW_DASHBOARD_PORT:-}" ]; then
  CHAT_UI_URL="http://127.0.0.1:${_dashboard_port}"
else
  CHAT_UI_URL="${CHAT_UI_URL:-http://127.0.0.1:${_dashboard_port}}"
fi

# Hermes binds the API server to 127.0.0.1. Run it on an internal port and
# use socat to expose the OpenAI-compatible API on PUBLIC_PORT.
INTERNAL_PORT=18642
DASHBOARD_PUBLIC_PORT="$_dashboard_port"
DASHBOARD_INTERNAL_PORT="${NEMOCLAW_HERMES_DASHBOARD_INTERNAL_PORT:-19119}"
if [ "$DASHBOARD_PUBLIC_PORT" -eq "$DASHBOARD_INTERNAL_PORT" ]; then
  DASHBOARD_INTERNAL_PORT=19120
fi
HERMES_DASHBOARD_TUI="${NEMOCLAW_HERMES_DASHBOARD_TUI:-${HERMES_DASHBOARD_TUI:-0}}"
HERMES_DASHBOARD_HOME="${HERMES_DASHBOARD_HOME:-/sandbox/.hermes/profiles/dashboard-home}"
HERMES="$(command -v hermes)" # Resolve once, use absolute path everywhere

# Hermes resolves config and runtime state relative to HERMES_HOME. The config
# root is mutable by the sandbox owner and readable by the gateway group. The
# root directory is group-writable with sticky-bit protection so Hermes v0.14 can
# create new top-level state while the gateway user cannot remove config files.
# Immutability is opt-in via `shields up`.
HERMES_DIR="/sandbox/.hermes"
if [ -z "${HERMES_LAZY_INSTALL_TARGET+x}" ]; then
  export HERMES_LAZY_INSTALL_TARGET="/sandbox/.hermes/lazy-packages"
fi
HERMES_HASH_FILE="/etc/nemoclaw/hermes.config-hash"

# Resolve the standalone secret-boundary validator. The container ships it at
# the installed path; the dev fallback resolves against the script directory so
# ad-hoc bash invocations from a checkout work without copying the file. The
# path is set unconditionally so a caller-supplied _HERMES_BOUNDARY_VALIDATOR
# carried in via the entrypoint env wrapper cannot redirect this security check
# at an attacker-controlled script.
_HERMES_BOUNDARY_VALIDATOR="/usr/local/lib/nemoclaw/validate-hermes-env-secret-boundary.py"
if [ ! -f "$_HERMES_BOUNDARY_VALIDATOR" ]; then
  _HERMES_BOUNDARY_VALIDATOR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/runtime/env-boundary.py"
fi

# Resolve the dashboard config seeder (same install/dev-fallback pattern as the
# boundary validator above). The Hermes dashboard runs under its own
# HERMES_DASHBOARD_HOME, so it never sees the model/custom_providers block
# NemoClaw writes to the gateway config; this script mirrors those routing keys
# into the dashboard config so the Models page and kanban specifier/dispatcher
# resolve the routed model.
_HERMES_DASHBOARD_CONFIG_SEEDER="/usr/local/lib/nemoclaw/seed-hermes-dashboard-config.py"
if [ ! -f "$_HERMES_DASHBOARD_CONFIG_SEEDER" ]; then
  _HERMES_DASHBOARD_CONFIG_SEEDER="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/runtime/dashboard-config.py"
fi
_HERMES_MANAGED_POLICY="/usr/local/share/nemoclaw/hermes-managed-policy.json"

# Descriptor-safe updater for runtime-mutable Hermes config/env/hash files.
_HERMES_RUNTIME_CONFIG_GUARD="/usr/local/lib/nemoclaw/hermes-runtime-config-guard.py"
if [ ! -f "$_HERMES_RUNTIME_CONFIG_GUARD" ]; then
  _HERMES_RUNTIME_CONFIG_GUARD="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/runtime/config-guard.py"
fi
_HERMES_TIRITH_MARKER_FINALIZER="/usr/local/lib/nemoclaw/finalize-tirith-marker.py"
if [ ! -f "$_HERMES_TIRITH_MARKER_FINALIZER" ]; then
  _HERMES_TIRITH_MARKER_FINALIZER="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/runtime/tirith-marker.py"
fi
_HERMES_GUARD_TIMEOUT=(timeout --signal=TERM --kill-after=5s 12m)
_HERMES_BOUNDARY_TIMEOUT=(timeout --signal=TERM --kill-after=2s 15s)
HERMES_RESTART_SEAL_STATE="/run/nemoclaw/hermes-restart-seal.json"
HERMES_CONFIG_MUTATION_LOCK="/run/nemoclaw/hermes-config-mutation.lock"
HERMES_RESTART_ORPHAN_MARKER="/sandbox/.hermes/.nemoclaw-hermes-restart-seal"
HERMES_STARTUP_READY_FILE="/run/nemoclaw/hermes-startup-ready"
HERMES_RESTART_SEALED=0
HERMES_RESTART_ORIGINAL_LOCKED=0
HERMES_RESTART_UNSEALING=0
HERMES_RESTART_SIGNAL_PENDING=0
HERMES_MCP_RECONCILE_PENDING=0
HERMES_MCP_INTEGRITY_FAILED=0

# A same-container PID 1 restart can retain /run. Revoke the prior readiness
# lease before any startup migration or mutable config read; host mutations are
# admitted again only after the root supervisor is fully initialized.
if [ -e "$HERMES_STARTUP_READY_FILE" ] && ! rm -f "$HERMES_STARTUP_READY_FILE"; then
  echo "[SECURITY] Refusing Hermes startup because the stale readiness marker could not be removed" >&2
  exit 1
fi

# The seeder imports PyYAML, which ships ONLY in the Hermes venv — not in the
# base-image python3 that is first on PATH at container boot. Invoked with
# the base python3, the seeder hits its "PyYAML unavailable; skipping model
# seed" branch and returns 0, so the model routing is silently never mirrored
# into the dashboard home and the Models page shows no models.
#
# Pick the venv interpreter from a fixed trusted absolute-path list so a
# PATH-shadowed python3 (via SSH env, compromised sandbox, or malicious
# entrypoint wrapper) cannot bypass the runtime-config-guard security checks.
# The list scans first-wins ordered most-preferred first (venv > local >
# system) so the venv python3 is selected when present and falls back to
# system python3 when the sandbox image has no venv yet. The same priority
# is mirrored in `packages/nemoclaw-hermes/runtime/cli-wrapper.py:_TRUSTED_PYTHON3` and
# `src/lib/agent/hermes-recovery-boundary.ts:buildTrustedPython3Picker` so
# all three entry points pick the same interpreter when several are present.
# The deprecated `/opt/hermes/.venv/bin/python` symlink path is intentionally
# not consulted: it is a symlink an attacker with write access to
# /opt/hermes/.venv could repoint, while the regular files in the trusted
# list cannot be substituted without breaking the image.
_HERMES_PYTHON=""
for _candidate in /opt/hermes/.venv/bin/python3 /usr/local/bin/python3 /usr/bin/python3; do
  if [ -x "$_candidate" ]; then
    _HERMES_PYTHON="$_candidate"
    break
  fi
done
unset _candidate

# 2. Define configuration, log, and durable-state preparation.
# hermes-startup-module config-setup begin
_HERMES_CONFIG_SETUP_MODULE="${_HERMES_STARTUP_MODULE_DIR}/config-setup.sh"
if [ ! -f "$_HERMES_CONFIG_SETUP_MODULE" ] || [ -L "$_HERMES_CONFIG_SETUP_MODULE" ]; then
  printf '%s\n' '[SECURITY] Required Hermes config-setup module is missing or unsafe.' >&2
  exit 1
fi
# shellcheck source=packages/nemoclaw-hermes/runtime/config-setup.sh
source "$_HERMES_CONFIG_SETUP_MODULE"
unset _HERMES_CONFIG_SETUP_MODULE
# hermes-startup-module config-setup end

# 3. Define process identity, dashboard, and loopback-relay control.
# hermes-startup-module service-control begin
_HERMES_SERVICE_CONTROL_MODULE="${_HERMES_STARTUP_MODULE_DIR}/service-control.sh"
if [ ! -f "$_HERMES_SERVICE_CONTROL_MODULE" ] || [ -L "$_HERMES_SERVICE_CONTROL_MODULE" ]; then
  printf '%s\n' '[SECURITY] Required Hermes service-control module is missing or unsafe.' >&2
  exit 1
fi
# shellcheck source=packages/nemoclaw-hermes/runtime/service-control.sh
source "$_HERMES_SERVICE_CONTROL_MODULE"
unset _HERMES_SERVICE_CONTROL_MODULE
# hermes-startup-module service-control end

# ── Messaging egress ─────────────────────────────────────────────
# Hermes sends messaging traffic directly through the OpenShell L7 proxy.
# OpenShell owns credential alias/body/WebSocket rewrite at the egress
# boundary; NemoClaw must not start a local decode proxy, facade, or
# placeholder-normalizing preload.

# cleanup_on_signal is provided by sandbox-init.sh. It reads
# SANDBOX_CHILD_PIDS (array of all PIDs) and SANDBOX_WAIT_PID (the
# primary process whose exit status is returned).
# Each code path below sets these before registering the trap.

# ── Proxy environment ────────────────────────────────────────────
PROXY_HOST="${NEMOCLAW_PROXY_HOST:-10.200.0.1}"
PROXY_PORT="${NEMOCLAW_PROXY_PORT:-3128}"
_PROXY_URL="http://${PROXY_HOST}:${PROXY_PORT}"
_NO_PROXY_VAL="localhost,127.0.0.1,::1,${PROXY_HOST}"
export HTTP_PROXY="$_PROXY_URL"
export HTTPS_PROXY="$_PROXY_URL"
export NO_PROXY="$_NO_PROXY_VAL"
export http_proxy="$_PROXY_URL"
export https_proxy="$_PROXY_URL"
export no_proxy="$_NO_PROXY_VAL"

# Corporate proxy CA merge (NemoClaw#6210).
# OpenShell injects SSL_CERT_FILE for its own L7 proxy CA at runtime. When a
# separate corporate MITM proxy sits in front of the host and re-signs external
# TLS with a different root, that root is absent from the OpenShell bundle, so
# external endpoints (e.g. api.telegram.org) fail verification even when policy
# allows the connection. If onboard baked an operator-supplied corporate CA
# into the image, append it to the OpenShell bundle — never replace it (the
# #1828 OpenShell CA behavior stays intact) — and repoint SSL_CERT_FILE at the
# merged bundle before the CURL/REQUESTS/GIT derivation below picks it up.
_NEMOCLAW_CORPORATE_CA_FILE="/usr/local/share/nemoclaw/corporate-ca.pem"
_NEMOCLAW_CORPORATE_CA_HELPER="/usr/local/lib/nemoclaw/corporate-ca-runtime.sh"
if [ ! -f "$_NEMOCLAW_CORPORATE_CA_HELPER" ]; then
  _HERMES_START_SOURCE="${BASH_SOURCE[0]}"
  _HERMES_START_DIR="${_HERMES_START_SOURCE%/*}"
  if [ "$_HERMES_START_DIR" = "$_HERMES_START_SOURCE" ]; then
    _HERMES_START_DIR="."
  fi
  _NEMOCLAW_CORPORATE_CA_HELPER="$(cd "$_HERMES_START_DIR" && pwd)/../../scripts/lib/corporate-ca-runtime.sh"
  unset _HERMES_START_SOURCE _HERMES_START_DIR
fi
if [ ! -f "$_NEMOCLAW_CORPORATE_CA_HELPER" ] || [ -L "$_NEMOCLAW_CORPORATE_CA_HELPER" ]; then
  echo "[nemoclaw] required corporate CA runtime helper is missing or unsafe" >&2
  exit 1
fi
# shellcheck source=scripts/lib/corporate-ca-runtime.sh
source "$_NEMOCLAW_CORPORATE_CA_HELPER"
if [ "${NEMOCLAW_MANAGED_STARTUP_APPLIED:-0}" != "1" ]; then
  merge_corporate_proxy_ca
fi
unset _NEMOCLAW_CORPORATE_CA_HELPER
# OpenShell injects SSL_CERT_FILE/CURL_CA_BUNDLE for its L7 proxy CA. Persist
# them into connect-session shells so Python Slack probes and Hermes tools trust
# the same proxy CA that the entrypoint received at startup.
if [ -n "${SSL_CERT_FILE:-}" ] && [ -f "${SSL_CERT_FILE}" ]; then
  export CURL_CA_BUNDLE="${CURL_CA_BUNDLE:-$SSL_CERT_FILE}"
  export REQUESTS_CA_BUNDLE="${REQUESTS_CA_BUNDLE:-$SSL_CERT_FILE}"
  export GIT_SSL_CAINFO="${GIT_SSL_CAINFO:-$SSL_CERT_FILE}"
fi

# Resolve sandbox home dir early — used by proxy-env writing before the
# non-root/root branch below.
if [ "$(id -u)" -eq 0 ]; then
  _SANDBOX_HOME=$(getent passwd sandbox 2>/dev/null | cut -d: -f6)
  _SANDBOX_HOME="${_SANDBOX_HOME:-/sandbox}"
else
  _SANDBOX_HOME="${HOME:-/sandbox}"
fi

# SECURITY FIX: Write proxy config to a standalone file via
# emit_sandbox_sourced_file() (444, root-owned when running as root) instead of
# appending inline to .bashrc/.profile. The old approach rewrote files under
# /sandbox during startup, which fails in non-root entrypoint postures.
# Ref: https://github.com/NVIDIA/NemoClaw/issues/2277
_PROXY_ENV_FILE="/tmp/nemoclaw-proxy-env.sh"
write_runtime_shell_env() {
  {
    cat <<PROXYEOF
# Proxy configuration (overrides narrow OpenShell defaults on connect)
export HTTP_PROXY="$_PROXY_URL"
export HTTPS_PROXY="$_PROXY_URL"
export NO_PROXY="$_NO_PROXY_VAL"
export http_proxy="$_PROXY_URL"
export https_proxy="$_PROXY_URL"
export no_proxy="$_NO_PROXY_VAL"
export HERMES_HOME="${HERMES_DIR}"
export HERMES_LAZY_INSTALL_TARGET="/sandbox/.hermes/lazy-packages"
PROXYEOF
    cat <<'TUIENVEOF'
if [ -f /opt/hermes/ui-tui/dist/entry.js ]; then
  export HERMES_TUI_DIR="/opt/hermes/ui-tui"
fi
TUIENVEOF
    for _ca_env_name in SSL_CERT_FILE CURL_CA_BUNDLE REQUESTS_CA_BUNDLE GIT_SSL_CAINFO NODE_EXTRA_CA_CERTS; do
      _ca_env_value="${!_ca_env_name:-}"
      if [ -n "$_ca_env_value" ]; then
        printf 'export %s=%q\n' "$_ca_env_name" "$_ca_env_value"
      fi
    done
    cat <<'GUARDENVEOF'
# nemoclaw-configure-guard begin
hermes() {
  case "$1" in
    setup|doctor)
      echo "Error: 'hermes $1' cannot modify config inside the sandbox." >&2
      echo "NemoClaw manages sandbox config from the host for integrity checks." >&2
      echo "" >&2
      echo "To change your configuration, exit the sandbox and run:" >&2
      echo "  nemoclaw onboard --resume" >&2
      return 1
      ;;
  esac
  command hermes "$@"
}
# nemoclaw-configure-guard end
GUARDENVEOF
  } | emit_sandbox_sourced_file "$_PROXY_ENV_FILE"
}

write_runtime_shell_env
# SECURITY FIX: Lock .bashrc/.profile after all static shims are in place.
# Hermes connect sessions source the dynamic guard from /tmp/nemoclaw-proxy-env.sh
# so startup never needs to rewrite files directly under /sandbox after caps drop.
lock_rc_files "$_SANDBOX_HOME"

# 4. Define migration, integrity, and restart-sealing behavior.
# hermes-startup-module runtime-integrity begin
_HERMES_RUNTIME_INTEGRITY_MODULE="${_HERMES_STARTUP_MODULE_DIR}/runtime-integrity.sh"
if [ ! -f "$_HERMES_RUNTIME_INTEGRITY_MODULE" ] || [ -L "$_HERMES_RUNTIME_INTEGRITY_MODULE" ]; then
  printf '%s\n' '[SECURITY] Required Hermes runtime-integrity module is missing or unsafe.' >&2
  exit 1
fi
# shellcheck source=packages/nemoclaw-hermes/runtime/runtime-integrity.sh
source "$_HERMES_RUNTIME_INTEGRITY_MODULE"
unset _HERMES_RUNTIME_INTEGRITY_MODULE
# hermes-startup-module runtime-integrity end

# 5. Define gateway launch, recovery, and supervision behavior.
# hermes-startup-module gateway-control begin
_HERMES_GATEWAY_CONTROL_MODULE="${_HERMES_STARTUP_MODULE_DIR}/gateway-control.sh"
if [ ! -f "$_HERMES_GATEWAY_CONTROL_MODULE" ] || [ -L "$_HERMES_GATEWAY_CONTROL_MODULE" ]; then
  printf '%s\n' '[SECURITY] Required Hermes gateway-control module is missing or unsafe.' >&2
  exit 1
fi
# shellcheck source=packages/nemoclaw-hermes/runtime/gateway-control.sh
source "$_HERMES_GATEWAY_CONTROL_MODULE"
unset _HERMES_GATEWAY_CONTROL_MODULE
# hermes-startup-module gateway-control end

# ── Main ─────────────────────────────────────────────────────────

# A PID 1 interruption within the same container writable layer can leave the
# root-only seal token behind. Restore it before any startup migration or config
# read. `/run` is not persistent across container recreation, so recognize the
# distinctive frozen parent + sealed-file posture when the token is gone and
# require a rebuild instead of guessing the original ownership/mode/flags.
if [ "$(id -u)" -eq 0 ]; then
  recover_startup_hermes_mutation || exit 1
  if hermes_restart_seal_orphaned; then
    echo "[SECURITY] HERMES_RESTART_SEAL_ORPHANED: restart recovery metadata was lost; restore from a trusted backup and recreate the sandbox" >&2
    exit 1
  fi
  if hermes_config_root_is_locked && ! hermes_locked_parent_is_protected; then
    echo "[SECURITY] HERMES_LOCKED_PARENT_UNPROTECTED: /sandbox must be root:sandbox 1775 while Hermes shields are up; restore from a trusted backup and recreate the sandbox (shields up cannot run while PID 1 refuses startup)" >&2
    exit 1
  fi
elif [ -e "$HERMES_CONFIG_MUTATION_LOCK" ] \
  || [ -e "$HERMES_RESTART_SEAL_STATE" ] \
  || [ -e "$HERMES_RESTART_ORPHAN_MARKER" ] \
  || hermes_restart_seal_orphaned; then
  echo "[SECURITY] HERMES_RESTART_SEAL_ORPHANED: non-root startup cannot safely recover an interrupted root config transaction; restore from a trusted backup and recreate the sandbox" >&2
  exit 1
fi

# Migrate legacy symlink layout before anything else reads .hermes
migrate_legacy_layout "/sandbox/.hermes" "/sandbox/.hermes-data" "hermes" || exit 1

echo 'Setting up NemoClaw (Hermes)...' >&2

# ── Non-root fallback ──────────────────────────────────────────
if [ "$(id -u)" -ne 0 ]; then
  echo "[gateway] Running as non-root (uid=$(id -u)) — privilege separation disabled" >&2
  export HOME=/sandbox
  export HERMES_HOME="${HERMES_DIR}"

  # macOS VM and OpenShell-managed startup run this entrypoint as the sandbox
  # user. In that mode the strict /etc hash cannot remain a root-owned trust
  # anchor, so use the same locked-aware mutable verifier as OpenClaw. Repeat
  # this preparation before every automatic respawn so a stopped gateway never
  # relaunches with stale or boundary-unsafe runtime inputs.
  prepare_hermes_nonroot_runtime || exit 1

  if [ ${#NEMOCLAW_CMD[@]} -gt 0 ]; then
    exec "${NEMOCLAW_CMD[@]}"
  fi

  cleanup_stale_hermes_gateway_runtime

  prepare_restricted_log /tmp/gateway.log "" 600

  # Defence-in-depth: verify /tmp file permissions before launching services.
  # shellcheck disable=SC2119
  validate_tmp_permissions

  # Start Hermes gateway. Messaging egress goes directly through OpenShell.
  umask 0007
  bootstrap_hermes_gateway_current_user || exit 1
  print_dashboard_urls

  supervise_hermes_gateway_current_user
  exit $?
fi

# ── Root path (full privilege separation via setpriv) ──────────

export HERMES_HOME="${HERMES_DIR}"
prepare_hermes_root_runtime

if [ ${#NEMOCLAW_CMD[@]} -gt 0 ]; then
  exec "${STEP_DOWN_PREFIX_SANDBOX[@]}" "${NEMOCLAW_CMD[@]}"
fi

# Same-uid MCP transaction commands are valid only in OpenShell's non-root
# workload topology. Stamp the legacy root-separated path before its gateway
# can start so ordinary sandbox exec fails closed there.
# invalidState: an ordinary sandbox process claims same-UID mutation authority
# while Hermes actually runs in the legacy root-separated topology.
# sourceBoundary: OpenShell owns workload topology; NemoClaw owns the immutable
# root-lifecycle marker and stamps it before starting the root-separated gateway.
# whyNotSourceFix: OpenShell 0.0.106 supports both topologies but exposes no
# attested same-UID capability that this packaged entrypoint can query.
# regressionTest: hermes-mcp-config-transaction.test.ts rejects both probe and
# add when the root-lifecycle marker identifies the legacy topology.
# removalCondition: remove this marker stamp when OpenShell unifies the topology
# or exposes an attested execution-identity capability.
publish_hermes_root_runtime_marker hermes-root-lifecycle root-separated || exit 1

# SECURITY: publish the resolved API port as a root-owned read-only marker.
# Root-separated helpers read this marker. The temporary file receives its
# final ownership and mode before one atomic rename replaces any stale entry.
publish_hermes_root_runtime_marker hermes-api-port "$PUBLIC_PORT" || exit 1

# SECURITY: Protect gateway log from sandbox user tampering
prepare_restricted_log /tmp/gateway.log gateway:gateway 600

# Defence-in-depth: verify /tmp file permissions before launching services.
# shellcheck disable=SC2119
validate_tmp_permissions

# Migrate and seed the dashboard profile before Hermes reads the shared home.
# Waiting until dashboard launch leaves restored legacy state in the gateway's
# HERMES_HOME during its readiness check.
prepare_hermes_dashboard_home sandbox:sandbox || exit 1

# Start Hermes gateway. Messaging egress goes directly through OpenShell.
launch_hermes_gateway
start_gateway_log_stream
wait_for_hermes_gateway_internal "$GATEWAY_PID"
ensure_hermes_supervised_auxiliaries
finalize_tirith_marker_retry
if ! commit_hermes_mcp_applied_if_pending; then
  echo "[SECURITY] HERMES_MCP_APPLIED_COMMIT_FAILED: stopping the uncommitted Hermes gateway" >&2
  stop_hermes_gateway_fail_closed
  exit 1
fi
restore_hermes_config_permissions_after_dashboard_start
# NOTE: PIDs are collected after launch; a signal arriving between trap
# registration and the final append is a small race window (same as before
# the shared-library refactor). Acceptable for entrypoint-level cleanup.
refresh_hermes_supervised_child_pids
# shellcheck disable=SC2034  # read by cleanup_on_signal from sandbox-init.sh
SANDBOX_WAIT_PID="$GATEWAY_PID"
trap hermes_cleanup_on_signal SIGTERM SIGINT
if ! gateway_control_init; then
  echo "[gateway-control] privileged gateway control unavailable" >&2
fi
if ! "$_HERMES_PYTHON" -I "$_HERMES_RUNTIME_CONFIG_GUARD" publish-startup-ready \
  --hermes-dir "$HERMES_DIR" \
  --startup-owner >/dev/null; then
  echo "[gateway-control] failed to publish Hermes startup readiness" >&2
  exit 1
fi
nemoclaw_runtime_state_mutation_checkpoint || exit 1
print_dashboard_urls

# PID 1 remains alive even when Hermes stops its gateway. Host recovery uses
# the authenticated control helper to validate and launch a replacement; no
# unrelated exec process owns or races the child lifecycle.
while :; do
  while [ -n "${GATEWAY_PID:-}" ] \
    && [ "$GATEWAY_PID" -gt 1 ] \
    && hermes_tracked_role_is_current gateway "$GATEWAY_PID" gateway "$INTERNAL_PORT" \
    && [ "$GATEWAY_CONTROL_SIGNAL_PENDING" -eq 0 ]; do
    sleep 1 || true
  done

  if [ "$GATEWAY_CONTROL_SIGNAL_PENDING" -eq 1 ]; then
    handle_hermes_gateway_control_request || true
    continue
  fi

  if [ -n "${GATEWAY_PID:-}" ] \
    && [ "$GATEWAY_PID" -gt 0 ] \
    && ! hermes_tracked_role_is_current gateway "$GATEWAY_PID" gateway "$INTERNAL_PORT"; then
    reap_status=0
    hermes_reap_exited_gateway || reap_status=$?
    case "$reap_status" in
      0) ;;
      3)
        handle_hermes_gateway_control_request || true
        continue
        ;;
      *) exit 1 ;;
    esac
  else
    sleep 1 || true
  fi
done
