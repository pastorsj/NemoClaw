#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# NemoClaw sandbox entrypoint. Runs as root (via ENTRYPOINT) to start the
# gateway as the 'gateway' user, then drops to 'sandbox' for agent commands.
#
# SECURITY: The gateway runs as a separate user so the sandboxed agent cannot
# kill it or restart it with a tampered config (CVE: fake-HOME bypass).
# The config hash is verified at startup to detect tampering.
#
# Optional env:
#   NVIDIA_INFERENCE_API_KEY                API key for NVIDIA-hosted inference
#   CHAT_UI_URL                   Browser origin that will access the forwarded dashboard
#   NEMOCLAW_DISABLE_DEVICE_AUTH  Build-time only. Set to "1" to skip device-pairing auth.
#                                  Also auto-disabled when CHAT_UI_URL is non-loopback.
#                                 (development/headless). Has no runtime effect — openclaw.json
#                                 is baked at image build and verified by hash at startup.
#   NEMOCLAW_MODEL_OVERRIDE       Override the primary model at startup without rebuilding
#                                 the sandbox image. Must match the model configured on
#                                 the gateway via `openshell inference set`.
#   NEMOCLAW_INFERENCE_API_OVERRIDE  Override the inference API type when switching between
#                                 provider families (e.g., "anthropic-messages" or
#                                 "openai-completions"). Only needed for cross-provider switches.
#   NEMOCLAW_CONTEXT_WINDOW        Override the model's context window size (e.g., "32768").
#   NEMOCLAW_MAX_TOKENS            Override the model's max output tokens (e.g., "8192").
#   NEMOCLAW_REASONING             Set to "true" to enable reasoning mode for the model.
#   NEMOCLAW_REASONING_EFFORT     Build-time reasoning effort ("low", "medium", or "high")
#                                 for a compatible OpenAI endpoint. Startup preserves the
#                                 persisted value so `inference set` changes survive restarts.
#   NEMOCLAW_CORS_ORIGIN           Add a browser origin to allowedOrigins at startup without
#                                 rebuilding. Useful for custom domains/ports (e.g.,
#                                 "https://my-server.example.com:8443").

set -euo pipefail

_nemoclaw_capture_epoch_realtime() {
  local destination="$1"
  local LC_NUMERIC=C
  printf -v "$destination" '%s' "${EPOCHREALTIME:-}"
}

_nemoclaw_capture_epoch_realtime _NEMOCLAW_GATEWAY_STARTUP_ENTRY_EPOCH

# SECURITY: Lock down PATH before any commands run so an injected PATH
# cannot resolve id/chown/chmod/tee from an attacker-controlled location.
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

# Keep process-control variables out of the OCI image environment: managed
# bootstrap rejects them before recreating the root supervisor. Establish the
# image-owned DNS policy only after the trusted entrypoint has started, replacing
# any ambient NODE_OPTIONS before this script launches a Node process.
export NODE_OPTIONS="--dns-result-order=ipv4first"

# managed-entrypoint-env-wrapper begin
_NEMOCLAW_ENTRYPOINT_ENV_WRAPPER="/usr/local/lib/nemoclaw/entrypoint-env-wrapper.sh"
if [ ! -f "$_NEMOCLAW_ENTRYPOINT_ENV_WRAPPER" ]; then
  _NEMOCLAW_ENTRYPOINT_SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  _NEMOCLAW_ENTRYPOINT_ENV_WRAPPER="${_NEMOCLAW_ENTRYPOINT_SOURCE_DIR}/../../scripts/lib/entrypoint-env-wrapper.sh"
  unset _NEMOCLAW_ENTRYPOINT_SOURCE_DIR
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

# Reject an invalid explicit dashboard port before installing the tee/fd startup
# capture below. Some CI Docker runners can drop very early fd4 output from
# short-lived containers, and this validation is meant to be fail-fast and
# directly visible to callers.
_EARLY_DASHBOARD_PORT_RAW="${NEMOCLAW_DASHBOARD_PORT:-}"
if [ -n "$_EARLY_DASHBOARD_PORT_RAW" ]; then
  _EARLY_DASHBOARD_PORT="$(printf '%s' "$_EARLY_DASHBOARD_PORT_RAW" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
  _EARLY_DASHBOARD_PORT_VALID=1
  case "$_EARLY_DASHBOARD_PORT" in
    *[!0-9]* | '')
      _EARLY_DASHBOARD_PORT_VALID=0
      ;;
  esac
  if [ "$_EARLY_DASHBOARD_PORT_VALID" -eq 1 ] && { [ "$_EARLY_DASHBOARD_PORT" -lt 1024 ] || [ "$_EARLY_DASHBOARD_PORT" -gt 65535 ]; }; then
    _EARLY_DASHBOARD_PORT_VALID=0
  fi
  if [ "$_EARLY_DASHBOARD_PORT_VALID" -ne 1 ]; then
    printf '%s\n' "[SECURITY] Invalid NEMOCLAW_DASHBOARD_PORT='${NEMOCLAW_DASHBOARD_PORT}' — must be an integer between 1024 and 65535" >&2
    exit 1
  fi
fi
unset _EARLY_DASHBOARD_PORT_RAW _EARLY_DASHBOARD_PORT _EARLY_DASHBOARD_PORT_VALID

# ── Early stderr/stdout capture ──────────────────────────────────
# Capture all entrypoint output to /tmp/nemoclaw-start.log so that if
# the script crashes before gateway log setup (e.g., a Landlock
# read failure), the output is still available for diagnostics.
# The log is written in append mode and also forwarded to the original
# stderr/stdout via tee so openshell sandbox create can still stream it.
# SECURITY: restrict permissions before writing — startup diagnostics may
# include dashboard URLs, but auth tokens must stay redacted in logs.
_nemoclaw_safe_replace_tmp_file() {
  local target="$1"
  local mode="$2"
  local owner="${3:-}"
  local chmod_policy="${4:-required}"
  local dir base tmp
  dir="$(dirname "$target")"
  base="$(basename "$target")"
  tmp="$(mktemp "${dir}/.${base}.tmp.XXXXXX")" || return 1

  if ! cat >"$tmp"; then
    rm -f "$tmp" 2>/dev/null || true
    return 1
  fi
  if [ -n "$owner" ] && ! chown "$owner" "$tmp"; then
    rm -f "$tmp" 2>/dev/null || true
    return 1
  fi
  if [ "$chmod_policy" = "best-effort" ]; then
    chmod "$mode" "$tmp" 2>/dev/null || true
  elif ! chmod "$mode" "$tmp"; then
    rm -f "$tmp" 2>/dev/null || true
    return 1
  fi
  if ! mv -f "$tmp" "$target"; then
    rm -f "$tmp" 2>/dev/null || true
    return 1
  fi
}

_nemoclaw_safe_create_tmp_file() {
  _nemoclaw_safe_replace_tmp_file "$@" </dev/null
}

_START_LOG="/tmp/nemoclaw-start.log"
if [ "$(id -u)" -eq 0 ]; then
  _nemoclaw_safe_create_tmp_file "$_START_LOG" 600 root:root
else
  _nemoclaw_safe_create_tmp_file "$_START_LOG" 600 "" best-effort
fi
exec 3>&1
exec 4>&2
exec > >(tee -a "$_START_LOG" >&3) 2> >(tee -a "$_START_LOG" >&4)

# ── Source shared sandbox initialisation library ─────────────────
# Single source of truth for security-sensitive primitives shared with
# packages/nemoclaw-hermes/start.sh. Ref: https://github.com/NVIDIA/NemoClaw/issues/2277
# Installed location (container): /usr/local/lib/nemoclaw/sandbox-init.sh
# Dev fallback: scripts/lib/sandbox-init.sh relative to this package.
_SANDBOX_INIT="/usr/local/lib/nemoclaw/sandbox-init.sh"
if [ ! -f "$_SANDBOX_INIT" ]; then
  _SANDBOX_INIT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../../scripts/lib/sandbox-init.sh"
fi
# shellcheck source=scripts/lib/sandbox-init.sh
source "$_SANDBOX_INIT"

_GATEWAY_SUPERVISOR="/usr/local/lib/nemoclaw/gateway-supervisor.sh"
if [ ! -f "$_GATEWAY_SUPERVISOR" ]; then
  _GATEWAY_SUPERVISOR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../../scripts/lib/gateway-supervisor.sh"
fi
# shellcheck source=scripts/lib/gateway-supervisor.sh
source "$_GATEWAY_SUPERVISOR"

# Harden RLIMITs (nproc #809 + nofile #4527) as root PID 1, before the capsh
# drop and the setpriv step-down, so the caps are inherited and unraisable.
harden_resource_limits

# PATH was already locked down at the top of this script (before the
# early stderr capture). This comment marks the original location.

# Redirect tool caches and state to /tmp so transient package-manager and
# shell state stays outside the agent's durable workspace. Without these, tools
# would create noisy dotfiles (~/.npm, ~/.cache, ~/.bash_history, ~/.gitconfig,
# ~/.local, ~/.claude) under /sandbox.
#
# IMPORTANT: This array is the single source of truth for tool-cache redirects.
# The same entries are emitted into /tmp/nemoclaw-proxy-env.sh (see below) so
# that `openshell sandbox connect` sessions also pick up the redirects.
_TOOL_REDIRECTS=(
  'npm_config_cache=/tmp/.npm-cache'
  'XDG_CACHE_HOME=/tmp/.cache'
  'XDG_CONFIG_HOME=/tmp/.config'
  'XDG_DATA_HOME=/tmp/.local/share'
  'XDG_STATE_HOME=/tmp/.local/state'
  'XDG_RUNTIME_DIR=/tmp/.runtime'
  'NODE_REPL_HISTORY=/tmp/.node_repl_history'
  'HISTFILE=/tmp/.bash_history'
  'GIT_CONFIG_GLOBAL=/tmp/.gitconfig'
  'GNUPGHOME=/tmp/.gnupg'
  'PYTHONUSERBASE=/tmp/.local'
  'PYTHON_HISTORY=/tmp/.python_history'
  'CLAUDE_CONFIG_DIR=/tmp/.claude'
  'npm_config_prefix=/tmp/npm-global'
  # Pin npm online at runtime so a stale base image or future build-time
  # offline-lock regression cannot force `only-if-cached` mode on PID 1 or
  # `openshell sandbox connect` sessions.
  'npm_config_offline=false'
  'NPM_CONFIG_OFFLINE=false'
)
for _redir in "${_TOOL_REDIRECTS[@]}"; do
  export "${_redir?}"
done

# Pre-create redirected directories to prevent ownership conflicts.
# In root mode: the gateway starts first (as gateway user) and inherits these
# env vars — if it creates a dir first, it would be gateway:gateway 755 and
# the sandbox user couldn't write subdirs later. Creating them as root with
# explicit sandbox ownership ensures the sandbox user always has write access.
# In non-root mode: we're already the sandbox user, so mkdir -p is sufficient —
# directories are owned by us automatically. Using install -o would fail with
# EPERM because only root can chown. Ref: #804
if [ "$(id -u)" -eq 0 ]; then
  install -d -o sandbox -g sandbox -m 755 \
    /tmp/.npm-cache /tmp/.cache /tmp/.config /tmp/.local/share \
    /tmp/.local/state /tmp/.runtime /tmp/.claude \
    /tmp/npm-global
  install -d -o sandbox -g sandbox -m 700 /tmp/.gnupg
else
  mkdir -p /tmp/.npm-cache /tmp/.cache /tmp/.config /tmp/.local/share \
    /tmp/.local/state /tmp/.runtime /tmp/.claude \
    /tmp/npm-global
  install -d -m 700 /tmp/.gnupg
fi

# ── Drop unnecessary Linux capabilities (shared) ────────────────
drop_capabilities /usr/local/bin/nemoclaw-start "$@"

NEMOCLAW_CMD=("$@")

# OpenShell blocks the link-local EC2 Instance Metadata Service. Force this
# after self-wrapper normalization so injected or inherited values cannot make
# OpenClaw processes probe an impossible credential source.
export AWS_EC2_METADATA_DISABLED=true

# Marker file the Docker HEALTHCHECK reads to decide whether an in-container
# gateway liveness check is meaningful. Its presence means this container has
# entered the OpenClaw gateway launch path (standalone deployments and the #3975
# forwarded-port shape); its absence means this entrypoint has not launched a
# gateway in this container, so the HEALTHCHECK short-circuits to healthy and
# defers to the runtime that owns gateway delivery. See the HEALTHCHECK block in
# the Dockerfile.
#
# IMPORTANT (#4710): the marker is dropped immediately before each
# `openclaw gateway run --port ...` invocation later in this script — NOT
# here. An early conditional gated on env hints (NEMOCLAW_CMD empty or
# OPENSHELL_DRIVERS=docker) is unreliable because OpenShell 0.0.44 does not
# export OPENSHELL_DRIVERS into the sandbox container env, so the guard never
# fires for docker-driver sandboxes. Other OpenShell env values are also not a
# trusted gateway-location source: they describe the sandbox container request,
# not whether this process owns the dashboard gateway. Tying the marker to the
# actual gateway-launch code path makes it true-by-construction: the marker
# exists if-and-only-if this container is about to start the gateway. Both the
# root and non-root entrypoint paths call `mark_in_container_gateway` directly
# before their `openclaw gateway run` invocation.
# Internal test seam shared by the PID writer and watchdog. This is deliberately
# not documented as a public env API; production always keeps the default path.
GATEWAY_PID_FILE=/tmp/nemoclaw-gateway.pid
GATEWAY_WATCHDOG_KILL_FILE="${_NEMOCLAW_GATEWAY_WATCHDOG_KILL_FILE:-/tmp/nemoclaw-gateway-watchdog-kill}"

# A numeric PID is not a process identity: Linux may reuse it immediately
# after the child is reaped.  Capture `/proc/<pid>/stat` field 22 (starttime)
# for every supervised process and require the pair to keep matching before
# admitting, probing, or signalling that process.  The `ps` fallback exists
# only so the shell helpers remain testable on non-Linux developer hosts;
# production containers always use the strict `/proc` identity.
GATEWAY_PID_START_IDENTITY=""
# The sourced runtime modules assign and consume these identities. ShellCheck
# analyzes this entrypoint without following those package-owned modules.
# shellcheck disable=SC2034
AUTO_PAIR_PID_START_IDENTITY=""
# shellcheck disable=SC2034
GATEWAY_LOG_TAIL_PID_START_IDENTITY=""
# shellcheck disable=SC2034
GATEWAY_LOG_PERSIST_PID_START_IDENTITY=""
# shellcheck disable=SC2034
PLUGIN_REFRESH_PID_START_IDENTITY=""
# shellcheck disable=SC2034
GATEWAY_WATCHDOG_PID_START_IDENTITY=""

# Best-effort: a marker write failure must never block startup.
mark_in_container_gateway() {
  _nemoclaw_safe_create_tmp_file /tmp/nemoclaw-gateway-local 600 "" best-effort 2>/dev/null || true
}

# Drop the in-container gateway marker (#4952). The HEALTHCHECK's pidfile
# fallback trusts /tmp/nemoclaw-gateway.pid, which is refreshed *only* by
# record_gateway_pid inside this supervisor's launch/respawn paths. On
# OpenShell docker-driver sandboxes this script is NOT PID 1 -- OpenShell's
# `sleep infinity` keeps the container alive as a sibling -- so when the
# supervise loop exits, the container lives on but nothing refreshes the
# pidfile. The marker would otherwise stay in place, leaving the healthcheck
# trusting a stale PID forever (permanent false `unhealthy`). Tying marker
# removal to supervisor exit completes the #4710 marker semantics: the marker
# means "a supervisor is actively managing the gateway and keeping the pidfile
# fresh". Once it is gone the healthcheck takes the marker-absent -> healthy
# branch (#4503) instead. Best-effort: failure must never block teardown.
clear_in_container_gateway_marker() {
  rm -f /tmp/nemoclaw-gateway-local 2>/dev/null || true
}

# Record the PID/starttime identity of the live in-container gateway so the
# Docker HEALTHCHECK
# can confirm the actual gateway process (not merely *some* `openclaw`
# process) is still alive when the in-container curl probe cannot reach the
# dashboard port (#4952). Refreshed on every (re)launch so a respawned gateway
# is tracked and a window where the gateway is down reads as unhealthy.
# Best-effort: a write failure must never block startup.
record_gateway_pid() {
  printf '%s %s\n' "${1:-}" "${2:-}" \
    | _nemoclaw_safe_replace_tmp_file "$GATEWAY_PID_FILE" 600 "" best-effort 2>/dev/null || true
}

clear_gateway_pid_record() {
  printf '' | _nemoclaw_safe_replace_tmp_file "$GATEWAY_PID_FILE" 600 "" best-effort 2>/dev/null || true
}

record_gateway_watchdog_kill() {
  printf '%s\n' "${1:-}" \
    | _nemoclaw_safe_replace_tmp_file "$GATEWAY_WATCHDOG_KILL_FILE" 600 "" best-effort 2>/dev/null || true
}

consume_gateway_watchdog_kill() {
  local expected="$1" marked=""
  [ -f "$GATEWAY_WATCHDOG_KILL_FILE" ] || return 1
  IFS= read -r marked <"$GATEWAY_WATCHDOG_KILL_FILE" 2>/dev/null || true
  rm -f "$GATEWAY_WATCHDOG_KILL_FILE" 2>/dev/null || true
  [ -n "$marked" ] && [ "$marked" = "$expected" ]
}

_chat_ui_url_port() {
  [ -n "${CHAT_UI_URL:-}" ] || return 1
  python3 - "$CHAT_UI_URL" <<'PYPORT'
import re
import sys
from urllib.parse import urlparse

raw_url = sys.argv[1]
if raw_url and not re.match(r"^[a-z][a-z0-9+.-]*://", raw_url, re.IGNORECASE):
    raw_url = f"http://{raw_url}"
try:
    port = urlparse(raw_url).port
except ValueError:
    sys.exit(1)
if port is None or port < 1024 or port > 65535:
    sys.exit(1)
print(port)
PYPORT
}

emit_startup_error() {
  local message="$1"
  if [ -n "${_START_LOG:-}" ]; then
    printf '%s\n' "$message" >>"$_START_LOG" 2>/dev/null || true
  fi
  if { true >&4; } 2>/dev/null; then
    printf '%s\n' "$message" >&4
  else
    printf '%s\n' "$message" >&2
  fi
}

# Validate NEMOCLAW_DASHBOARD_PORT if set (same behavior as ports.js: fail fast).
_DASHBOARD_PORT_RAW="${NEMOCLAW_DASHBOARD_PORT:-}"
if [ -z "$_DASHBOARD_PORT_RAW" ]; then
  if _CHAT_UI_PORT="$(_chat_ui_url_port)"; then
    _DASHBOARD_PORT="$_CHAT_UI_PORT"
  else
    _DASHBOARD_PORT=18789
  fi
else
  _DASHBOARD_PORT="$(printf '%s' "$_DASHBOARD_PORT_RAW" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
  _DASHBOARD_PORT_VALID=1
  case "$_DASHBOARD_PORT" in
    *[!0-9]* | '')
      _DASHBOARD_PORT_VALID=0
      ;;
  esac
  if [ "$_DASHBOARD_PORT_VALID" -eq 1 ] && { [ "$_DASHBOARD_PORT" -lt 1024 ] || [ "$_DASHBOARD_PORT" -gt 65535 ]; }; then
    _DASHBOARD_PORT_VALID=0
  fi
  if [ "$_DASHBOARD_PORT_VALID" -ne 1 ]; then
    emit_startup_error "[SECURITY] Invalid NEMOCLAW_DASHBOARD_PORT='${NEMOCLAW_DASHBOARD_PORT}' — must be an integer between 1024 and 65535"
    exit 1
  fi
fi
# When NEMOCLAW_DASHBOARD_PORT is explicitly set (injected at sandbox create time
# via envArgs in onboard.ts), unconditionally override CHAT_UI_URL so the gateway
# starts on the configured port even if the Docker image has a different value
# baked in. Without this, the Docker ENV takes precedence and the gateway listens
# on the wrong port while the SSH tunnel forwards the custom port. (#1925)
if [ -n "${NEMOCLAW_DASHBOARD_PORT:-}" ]; then
  CHAT_UI_URL="http://127.0.0.1:${_DASHBOARD_PORT}"
else
  CHAT_UI_URL="${CHAT_UI_URL:-http://127.0.0.1:${_DASHBOARD_PORT}}"
fi
# Read by the sourced gateway setup module.
# shellcheck disable=SC2034
PUBLIC_PORT="$_DASHBOARD_PORT"
export OPENCLAW_GATEWAY_PORT="$_DASHBOARD_PORT"
# Gateway WebSocket URL host. Default to the sandbox's own primary interface
# address rather than loopback: spawned sub-agent runtimes (sessions_spawn)
# dial OPENCLAW_GATEWAY_URL from inside the enforced process tree, where the
# OpenShell L7 proxy transparently intercepts connect() and hard-denies
# loopback destinations regardless of policy. With a loopback URL every child
# WebSocket upgrade dies with `1006 abnormal closure (no close frame)` and
# nothing reaches the gateway log. The gateway listens on 0.0.0.0 and the
# eth0 address is allowlisted in the base sandbox policy
# (openclaw_gateway_dialback in policy-additions.yaml), so the same dial
# works from both enforced and unenforced contexts. Falls back to loopback
# when no interface address is detectable (the pre-fix behavior). Override
# with NEMOCLAW_GATEWAY_WS_HOST.
_GATEWAY_WS_HOST="${NEMOCLAW_GATEWAY_WS_HOST:-}"
# Only auto-derive inside a real sandbox (the Dockerfile.base image always
# has /sandbox); on dev machines and CI runners the loopback default is
# kept. NEMOCLAW_SANDBOX_ROOT is overridable for tests. `|| true` keeps
# the assignment safe under `set -o pipefail` when hostname lacks -I.
if [ -z "$_GATEWAY_WS_HOST" ] && [ -d "${NEMOCLAW_SANDBOX_ROOT:-/sandbox}" ]; then
  _GATEWAY_WS_HOST="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
fi
if [ -z "$_GATEWAY_WS_HOST" ]; then
  _GATEWAY_WS_HOST="127.0.0.1"
fi
export OPENCLAW_GATEWAY_URL="ws://${_GATEWAY_WS_HOST}:${_DASHBOARD_PORT}"
if [ "$_GATEWAY_WS_HOST" != "127.0.0.1" ]; then
  # The OpenClaw client refuses plaintext ws:// to non-loopback private
  # addresses unless this break-glass is set. The sandbox bridge is a
  # host-local veth pair — frames never leave the machine — and the
  # alternative (loopback) is unconditionally blocked by the L7 proxy,
  # which breaks sessions_spawn entirely.
  export OPENCLAW_ALLOW_INSECURE_PRIVATE_WS=1
fi
OPENCLAW="$(command -v openclaw)" # Resolve once, use absolute path everywhere
_SANDBOX_HOME="/sandbox"          # Home dir for the sandbox user (useradd -d /sandbox in Dockerfile.base)
_OPENCLAW_STATE_DIR="${_SANDBOX_HOME}/.openclaw"
_OPENCLAW_CREDENTIALS_DIR="${_OPENCLAW_STATE_DIR}/credentials"

# OpenClaw 2026.4.x stores channel pairing requests under
# resolveOAuthDir(resolveStateDir(...))/<channel>-pairing.json. The gateway
# runs as the gateway user while connect-shell commands run as sandbox, so
# relying on HOME/os.homedir() can split pending requests across users. Force
# every OpenClaw process in the sandbox to the persistent shared state root.
export OPENCLAW_HOME="${_SANDBOX_HOME}"
export OPENCLAW_STATE_DIR="${_OPENCLAW_STATE_DIR}"
export OPENCLAW_CONFIG_PATH="${_OPENCLAW_STATE_DIR}/openclaw.json"
export OPENCLAW_OAUTH_DIR="${_OPENCLAW_CREDENTIALS_DIR}"

# startup-modules begin
# Package-owned startup modules keep this entrypoint readable as a workflow.
_OPENCLAW_STARTUP_DIR=/usr/local/lib/nemoclaw/openclaw-startup
if [ ! -d "$_OPENCLAW_STARTUP_DIR" ]; then
  _OPENCLAW_STARTUP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/runtime" && pwd)"
fi
if [ ! -d "$_OPENCLAW_STARTUP_DIR" ] || [ -L "$_OPENCLAW_STARTUP_DIR" ]; then
  printf '%s\n' '[SECURITY] Required OpenClaw startup module directory is missing or unsafe.' >&2
  exit 1
fi
_OPENCLAW_AUTO_PAIR_SCRIPT="$_OPENCLAW_STARTUP_DIR/auto-pair.py"

require_openclaw_startup_file() {
  local startup_path="$_OPENCLAW_STARTUP_DIR/$1"
  if [ ! -f "$startup_path" ] || [ -L "$startup_path" ] || [ ! -r "$startup_path" ]; then
    printf '[SECURITY] Required OpenClaw startup file is missing or unsafe: %s\n' "$1" >&2
    exit 1
  fi
}

require_openclaw_startup_file auto-pair.py
require_openclaw_startup_file runtime-state.sh
# shellcheck source=packages/nemoclaw-openclaw/runtime/runtime-state.sh
source "$_OPENCLAW_STARTUP_DIR/runtime-state.sh"
require_openclaw_startup_file gateway-timing.sh
# shellcheck source=packages/nemoclaw-openclaw/runtime/gateway-timing.sh
source "$_OPENCLAW_STARTUP_DIR/gateway-timing.sh"
require_openclaw_startup_file model-routing.sh
# shellcheck source=packages/nemoclaw-openclaw/runtime/model-routing.sh
source "$_OPENCLAW_STARTUP_DIR/model-routing.sh"
require_openclaw_startup_file gateway-setup.sh
# shellcheck source=packages/nemoclaw-openclaw/runtime/gateway-setup.sh
source "$_OPENCLAW_STARTUP_DIR/gateway-setup.sh"
require_openclaw_startup_file startup-env.sh
# shellcheck source=packages/nemoclaw-openclaw/runtime/startup-env.sh
source "$_OPENCLAW_STARTUP_DIR/startup-env.sh"
require_openclaw_startup_file sandbox-setup.sh
# shellcheck source=packages/nemoclaw-openclaw/runtime/sandbox-setup.sh
source "$_OPENCLAW_STARTUP_DIR/sandbox-setup.sh"
require_openclaw_startup_file process-control.sh
# shellcheck source=packages/nemoclaw-openclaw/runtime/process-control.sh
source "$_OPENCLAW_STARTUP_DIR/process-control.sh"
unset -f require_openclaw_startup_file
# startup-modules end

# ── Main ─────────────────────────────────────────────────────────

# OpenClaw 2026.7.1 enforces owner-only SQLite and models-file modes on every
# open. Only the root entrypoint uses NemoClaw's separate sandbox/gateway UIDs;
# OpenShell starts this entrypoint as the sandbox UID and runs both roles as that
# same user. Derive the compatibility marker from the real topology instead of
# an image-wide or caller-supplied environment marker.
if [ "$(id -u)" -eq 0 ]; then
  export NEMOCLAW_OPENCLAW_SHARED_STATE=1
else
  unset NEMOCLAW_OPENCLAW_SHARED_STATE
fi

# Begin the root PID 1 readiness lease before any startup path reads or mutates
# OpenClaw config. Recovery runs before the locked-parent discriminator so a
# crash in a prior config write/restart/handoff can complete deterministically.
if [ "$(id -u)" -eq 0 ]; then
  prepare_openclaw_config_startup || exit 1
fi

# A root-owned config directory is the shields-up discriminator. Its parent
# must be sticky and root-owned too; otherwise the sandbox identity can rename
# the entire `.openclaw` entry and replace the pathname with mutable content.
# Refuse before migration or any config read. PID 1 cannot repair this posture
# after startup has failed, so recovery requires a trusted snapshot/recreate.
if [ "$(openclaw_config_dir_owner /sandbox/.openclaw)" = "root" ] \
  && ! openclaw_locked_parent_is_protected; then
  echo "[SECURITY] OPENCLAW_LOCKED_PARENT_UNPROTECTED: /sandbox must be root:sandbox 1775 while OpenClaw shields are up; restore from a trusted backup and recreate the sandbox" >&2
  exit 1
fi

# Migrate legacy symlink layout before anything else reads .openclaw
migrate_legacy_layout "/sandbox/.openclaw" "/sandbox/.openclaw-data" "openclaw" || exit 1
remove_openclaw_legacy_update_check_state || exit 1

echo 'Setting up NemoClaw...' >&2
# Best-effort: .env may not exist.
if [ -f .env ]; then
  if ! chmod 600 .env 2>/dev/null; then
    echo "[SECURITY WARNING] Could not restrict .env permissions — file may be world-readable (read-only filesystem)" >&2
  fi
fi

# ── Non-root fallback ──────────────────────────────────────────
# OpenShell runs containers with --security-opt=no-new-privileges, which
# blocks setpriv's setuid syscall. When we're not root, skip privilege
# separation and run everything as the current user (sandbox).
# Gateway process isolation is not available in this mode.
if [ "$(id -u)" -ne 0 ]; then
  echo "[gateway] Running as non-root (uid=$(id -u)) — privilege separation disabled" >&2
  export HOME=/sandbox
  # Empty-config recovery runs before integrity check so a #3118 truncation
  # (openshell inference set inside the sandbox) is restored from baseline
  # rather than failing the integrity hash for the empty file.
  _nemoclaw_capture_epoch_realtime _NEMOCLAW_GATEWAY_CONFIG_STARTED_EPOCH
  recover_openclaw_config_if_empty
  if ! verify_config_integrity_if_locked /sandbox/.openclaw; then
    echo "[SECURITY] Config integrity check failed — refusing to start (non-root mode)" >&2
    exit 1
  fi
  normalize_mutable_config_perms
  _nemoclaw_capture_epoch_realtime _NEMOCLAW_GATEWAY_CONFIG_FINISHED_EPOCH
  apply_model_override
  reconcile_agent_model_with_provider
  apply_cors_override
  _nemoclaw_capture_epoch_realtime _NEMOCLAW_GATEWAY_PROVIDER_FINISHED_EPOCH
  refresh_openclaw_provider_placeholders
  ensure_mutable_openclaw_config_hash
  prepare_gateway_token_for_current_command
  # Capture baseline for next start's recovery — only after overrides and
  # placeholder refresh have produced the post-startup config the user
  # actually runs with.
  write_openclaw_config_baseline
  export_gateway_token
  _nemoclaw_capture_epoch_realtime _NEMOCLAW_GATEWAY_TOKEN_FINISHED_EPOCH
  write_messaging_runtime_setup_plan
  write_runtime_shell_env
  ensure_runtime_shell_env_shim
  lock_rc_files "$_SANDBOX_HOME" || true
  # Apply manifest-declared runtime env aliases before any child inherits the
  # env. This covers both one-shot commands and the gateway launch.
  apply_messaging_runtime_env_aliases

  if [ ${#NEMOCLAW_CMD[@]} -gt 0 ]; then
    install_messaging_runtime_preloads
    verify_messaging_runtime_secret_scans
    _nemoclaw_cmd_rc=0
    run_oneshot_command "${NEMOCLAW_CMD[@]}" || _nemoclaw_cmd_rc=$?
    exit "$_nemoclaw_cmd_rc"
  fi

  configure_messaging_channels
  refresh_openclaw_provider_placeholders
  ensure_mutable_openclaw_config_hash
  write_openclaw_config_baseline
  install_messaging_runtime_preloads
  verify_messaging_runtime_secret_scans
  _nemoclaw_capture_epoch_realtime _NEMOCLAW_GATEWAY_MESSAGING_FINISHED_EPOCH

  # Ensure writable state directories exist and are owned by the current user.
  # The Docker build (Dockerfile) sets this up correctly, but the native curl
  # installer may create these directories as root, causing EACCES when openclaw
  # tries to write device-auth.json or other state files.  Ref: #692
  fix_openclaw_ownership() {
    local openclaw_dir="${HOME}/.openclaw"
    [ -d "$openclaw_dir" ] || return 0
    local subdirs="agents/main/agent extensions workspace skills hooks identity devices canvas cron memory logs credentials flows sandbox telegram media"
    for sub in $subdirs; do
      mkdir -p "${openclaw_dir}/${sub}" 2>/dev/null || true
    done
    if find "$openclaw_dir" ! -uid "$(id -u)" -print -quit 2>/dev/null | grep -q .; then
      chown -R "$(id -u):$(id -g)" "$openclaw_dir" 2>/dev/null \
        && echo "[setup] fixed ownership on ${openclaw_dir}" >&2 \
        || echo "[setup] could not fix ownership on ${openclaw_dir}; writes may fail" >&2
    fi
    chmod 2770 "$openclaw_dir" 2>/dev/null || true
    chmod 660 "$openclaw_dir/openclaw.json" "$openclaw_dir/.config-hash" 2>/dev/null || true
    chmod 600 "$openclaw_dir/fabric.json" 2>/dev/null || true
  }
  fix_openclaw_ownership
  normalize_mutable_config_perms
  seed_default_workspace_templates /sandbox/.openclaw/workspace "" /sandbox/.openclaw/openclaw.json
  write_auth_profile
  harden_auth_profiles

  prepare_auto_pair_log

  prepare_plugin_refresh_log || exit 1

  # Defence-in-depth: verify /tmp file permissions before launching services.
  # Pass the HTTP proxy-fix path so it is validated alongside proxy-env.sh
  # (both are trust-boundary files; tampering would let the sandbox user
  # inject code into any Node process via NODE_OPTIONS).
  validate_nemoclaw_tmp_permissions
  _nemoclaw_capture_epoch_realtime _NEMOCLAW_GATEWAY_WORKSPACE_FINISHED_EPOCH

  # Start gateway in background, auto-pair, then wait. Mark the in-container
  # gateway path so the Docker HEALTHCHECK probes it rather than short-circuiting
  # to healthy — see the mark_in_container_gateway comment near the top of this
  # file for the #4710 rationale (why the marker is tied to the launch site
  # rather than an env-var conditional at startup).
  launch_openclaw_gateway_non_root
  # Diagnostic: mirror gateway log to PID 1's stderr — see root-mode block
  # below for rationale (NVIDIA/NemoClaw#2484).
  { tail -n +1 -F /tmp/gateway.log 2>/dev/null | sed -u 's/^/[gateway-log:] /' >&2; } &
  GATEWAY_LOG_TAIL_PID=$!
  capture_openclaw_pid_start_identity \
    "$GATEWAY_LOG_TAIL_PID" GATEWAY_LOG_TAIL_PID_START_IDENTITY || exit 1
  # Persistent mirror: see root-mode block for rationale.
  start_persistent_gateway_log_mirror || exit 1
  start_auto_pair
  start_plugin_registry_refresh
  start_gateway_serving_watchdog
  # NOTE: PIDs are collected after launch; a signal arriving between trap
  # registration and the final append is a small race window (same as before
  # the shared-library refactor). Acceptable for entrypoint-level cleanup.
  refresh_openclaw_supervised_child_pids
  # shellcheck disable=SC2034  # read by cleanup_on_signal from sandbox-init.sh
  SANDBOX_WAIT_PID="$GATEWAY_PID"
  print_dashboard_urls

  # Auto-respawn gateway on unexpected death (NVIDIA/NemoClaw#2757). Without
  # this loop, gateway death unblocks `wait` → PID 1 exits → Docker reaps the
  # whole sandbox container, forcing users to run `nemoclaw connect` to recover.
  # RESPAWN_TIMES is a true sliding 60s window of crash timestamps; entries
  # older than the cutoff are pruned each iteration so bursts spanning a
  # window boundary still trigger the >=5 alarm.
  RESPAWN_TIMES=()
  while :; do
    # `wait` must be guarded with `|| RC=$?` because errexit (set -e on
    # line 33) would otherwise exit PID 1 the instant the gateway returns
    # non-zero, defeating the respawn loop entirely.
    RC=0
    EXITED_GATEWAY_PID="$GATEWAY_PID"
    EXITED_GATEWAY_START_IDENTITY="$GATEWAY_PID_START_IDENTITY"
    wait "$EXITED_GATEWAY_PID" || RC=$?
    mark_openclaw_gateway_stopped
    if [ "$RC" -eq 0 ] \
      && ! consume_gateway_watchdog_kill "${EXITED_GATEWAY_PID}:${EXITED_GATEWAY_START_IDENTITY}" \
      && ! gateway_control_exit_was_host_authorized \
        "$EXITED_GATEWAY_PID" "$EXITED_GATEWAY_START_IDENTITY"; then
      exit 0
    fi
    NOW=$(date +%s)
    RESPAWN_TIMES+=("$NOW")
    _PRUNED=()
    for _t in "${RESPAWN_TIMES[@]+"${RESPAWN_TIMES[@]}"}"; do
      [ $((NOW - _t)) -le 60 ] && _PRUNED+=("$_t")
    done
    RESPAWN_TIMES=("${_PRUNED[@]+"${_PRUNED[@]}"}")
    RESPAWN_COUNT=${#RESPAWN_TIMES[@]}
    if [ "$RESPAWN_COUNT" -ge 5 ]; then
      echo "[gateway] CRITICAL: $RESPAWN_COUNT respawns in 60s window — gateway likely unstable; check /tmp/gateway.log" >&2
    fi
    echo "[gateway] pid $EXITED_GATEWAY_PID exited (rc=$RC); respawning (#$RESPAWN_COUNT in 60s window) in 2s" >&2
    sleep 2
    prepare_openclaw_automatic_respawn || exit 1
    launch_openclaw_gateway_process append current \
      "$OPENCLAW" gateway run --port "${_DASHBOARD_PORT}"
    capture_openclaw_pid_start_identity "$GATEWAY_PID" GATEWAY_PID_START_IDENTITY || exit 1
    record_gateway_pid "$GATEWAY_PID" "$GATEWAY_PID_START_IDENTITY"
    # shellcheck disable=SC2034  # read by cleanup_on_signal from sandbox-init.sh
    SANDBOX_WAIT_PID="$GATEWAY_PID"
    refresh_openclaw_supervised_child_pids
    echo "[gateway] respawned (pid $GATEWAY_PID)" >&2
  done
fi

# ── Root path (full privilege separation via setpriv) ──────────

echo "[gateway] NEMOCLAW_ENTRYPOINT_MODE=root" >&2

# Empty-config recovery runs before integrity check so a #3118 truncation
# (openshell inference set inside the sandbox) is restored from baseline
# rather than failing the integrity hash for the empty file.
recover_openclaw_config_if_empty
# Verify locked config integrity before starting anything. Mutable-default
# config is intentionally writable and is not a trust anchor until shields-up.
verify_config_integrity_if_locked /sandbox/.openclaw
normalize_mutable_config_perms
apply_model_override
reconcile_agent_model_with_provider
apply_cors_override
configure_messaging_channels
refresh_openclaw_provider_placeholders
ensure_mutable_openclaw_config_hash
prepare_gateway_token_for_current_command
# Capture baseline for next start's recovery — only after overrides and
# placeholder refresh have produced the post-startup config the user
# actually runs with.
write_openclaw_config_baseline
export_gateway_token
write_messaging_runtime_setup_plan
write_runtime_shell_env
ensure_runtime_shell_env_shim
lock_rc_files "$_SANDBOX_HOME"
# Apply manifest-declared runtime env aliases before any child (the one-shot
# "${NEMOCLAW_CMD[@]}" exec or the stepped-down gateway) inherits the env.
# setpriv preserves the environment, so the export reaches the gateway user.
apply_messaging_runtime_env_aliases

# Messaging channel config was announced before placeholder refresh so the
# baseline captures the same provider placeholders the gateway will use.
# Install manifest-declared Node runtime preloads before starting OpenClaw.
install_messaging_runtime_preloads
verify_messaging_runtime_secret_scans

# Write auth profile as sandbox user and recursively re-tighten any
# auth-profiles.json files under ~/.openclaw. See
# setup_auth_profile_as_sandbox for the HOME-handling rationale.
setup_auth_profile_as_sandbox

# If a command was passed (e.g., "openclaw agent ..."), run it as sandbox user
if [ ${#NEMOCLAW_CMD[@]} -gt 0 ]; then
  _nemoclaw_cmd_rc=0
  run_oneshot_command "${STEP_DOWN_PREFIX_SANDBOX[@]}" "${NEMOCLAW_CMD[@]}" || _nemoclaw_cmd_rc=$?
  exit "$_nemoclaw_cmd_rc"
fi

prepare_auto_pair_log

prepare_plugin_refresh_log || exit 1

# Provision per-agent workspaces for multi-agent OpenClaw deployments.
#
# OpenClaw can be configured with multiple named agents (agents.defaults.workspace
# + agents.list[*].workspace in openclaw.json), each producing its own
# `/sandbox/.openclaw/workspace-<name>/` directory. In the mutable-by-default
# layout these live directly under `.openclaw/` (no symlink indirection).
# Ensure they exist and are sandbox-writable.
#
# Ref: https://github.com/NVIDIA/NemoClaw/issues/1260
provision_agent_workspaces() {
  local config_dir="/sandbox/.openclaw"
  local names=""
  local d name config_names

  # Discover existing workspace-* dirs.
  if [ -d "$config_dir" ]; then
    for d in "$config_dir"/workspace-*; do
      [ -e "$d" ] || [ -L "$d" ] || continue
      if [ -L "$d" ]; then
        echo "[SECURITY] refusing symlinked workspace dir: $d" >&2
        continue
      fi
      [ -d "$d" ] || continue
      name="$(basename "$d")"
      names="${names} ${name}"
    done
  fi

  # Also provision workspace directories declared in openclaw.json. On first
  # boot these may not exist yet, so directory discovery alone is insufficient.
  if [ -f "$config_dir/openclaw.json" ] && command -v node >/dev/null 2>&1; then
    config_names="$(
      node - "$config_dir/openclaw.json" <<'NODE' 2>/dev/null || true
  const fs = require("fs");
  const configPath = process.argv[2];
  const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const names = new Set();
  const workspacePattern = /^workspace-[A-Za-z0-9._-]+$/;
  function addWorkspace(value) {
    if (typeof value !== "string") return;
    const trimmed = value.trim();
    if (!trimmed) return;
    if (trimmed.startsWith("/sandbox/.openclaw/")) {
      const relative = trimmed.slice("/sandbox/.openclaw/".length);
      if (workspacePattern.test(relative)) names.add(relative);
      return;
    }
    if (/^[A-Za-z0-9._-]+$/.test(trimmed)) {
      const name = trimmed.startsWith("workspace-") ? trimmed : `workspace-${trimmed}`;
      if (workspacePattern.test(name)) names.add(name);
    }
  }
  addWorkspace(cfg?.agents?.defaults?.workspace);
  for (const agent of cfg?.agents?.list || []) addWorkspace(agent?.workspace);
  for (const name of names) console.log(name);
NODE
    )"
    if [ -n "$config_names" ]; then
      names="$({
        for name in $names; do
          printf '%s\n' "$name"
        done
        printf '%s\n' "$config_names"
      } | awk 'NF && !seen[$0]++' | tr '\n' ' ')"
    fi
  fi

  for name in $names; do
    local ws_path="$config_dir/$name"
    if [ -L "$ws_path" ]; then
      echo "[SECURITY] refusing to provision symlinked workspace path: $ws_path" >&2
      continue
    fi
    mkdir -p "$ws_path"
    chown_tree_no_symlink_follow sandbox:sandbox "$ws_path"
    echo "[setup] provisioned multi-agent workspace: $name" >&2
  done
}
provision_agent_workspaces

# Seed default workspace templates if the default workspace is empty.
# Run as the sandbox user so the seeded files inherit sandbox:sandbox
# ownership (the function's own cp calls would otherwise produce
# root-owned files in this branch). See function comment for context.
seed_default_workspace_templates_as_sandbox

# Defence-in-depth: verify /tmp file permissions before launching services.
# Pass the HTTP proxy-fix path so it is validated alongside proxy-env.sh
# (both are trust-boundary files; tampering would let the sandbox user
# inject code into any Node process via NODE_OPTIONS).
validate_nemoclaw_tmp_permissions

# Start the gateway as the 'gateway' user.
# SECURITY: The sandbox user cannot kill this process because it runs
# under a different UID. The fake-HOME attack no longer works because
# the agent cannot restart the gateway with a tampered config.
# Marking, privilege step-down, log redirection, and PID recording are kept in
# one reusable launch primitive so PID 1 owns initial start, crash respawn, and
# host-requested restart identically.
# The launch primitive arms signal and EXIT cleanup before writing the marker.
launch_openclaw_gateway

# Diagnostic: mirror gateway log to PID 1's stderr so its content surfaces in
# docker logs. /tmp/gateway.log is otherwise only readable from inside the
# sandbox via `nemoclaw <sandbox> logs` and is not captured by the e2e test
# framework on failure. Streaming it to PID 1's stderr lets a workflow-level
# `docker logs` capture pick it up. Each line is prefixed with [gateway-log:]
# so it can be filtered out post-hoc when not investigating.
# Ref: NVIDIA/NemoClaw#2484 (TC-SBX-02 hang investigation)
{ tail -n +1 -F /tmp/gateway.log 2>/dev/null | sed -u 's/^/[gateway-log:] /' >&2; } &
GATEWAY_LOG_TAIL_PID=$!
capture_openclaw_pid_start_identity \
  "$GATEWAY_LOG_TAIL_PID" GATEWAY_LOG_TAIL_PID_START_IDENTITY || exit 1

# Persistent mirror: append /tmp/gateway.log content to a file under
# /sandbox/.openclaw/logs which is volume-mounted by openshell and
# survives pod restarts. /tmp/gateway.log itself is wiped when the pod
# restarts (TC-SBX-06 docker-kills the gateway container), so the
# only durable record of pre-restart events lives here. The diag
# streamer in the e2e workflow snapshots this file post-test.
start_persistent_gateway_log_mirror || exit 1

start_auto_pair

# Re-register non-bundled plugins after the gateway's first policy-changed
# regen. Under GPU sandbox onboard, OpenClaw rebuilds plugins[] from bundled
# extensions only and drops path/npm-origin entries like the NemoClaw plugin
# and the WeChat plugin. Their installRecords survive on disk, but the runtime
# registry forgets them — so `/nemoclaw` is unreachable in the TUI and
# `openclaw plugins inspect nemoclaw` says "Plugin not found" (#2021).
# A `plugins registry --refresh` repopulates plugins[] from installRecords.
# Backgrounded so the gateway-wait loop is unblocked; failure is non-fatal.
# Source boundary: the lossy policy-changed rebuild lives in OpenClaw's registry
# regeneration path, outside NemoClaw. NemoClaw can only heal the initial
# post-start registry from persisted installRecords until upstream preserves
# path/npm-origin plugins itself. Later runtime policy mutations are owned by
# OpenClaw's upstream fix, not by this one-shot startup workaround. Remove this
# workaround after openclaw/openclaw#89606 ships and the full onboard E2E still
# proves /nemoclaw registration without the refresh.
start_plugin_registry_refresh

start_gateway_serving_watchdog

# NOTE: PIDs are collected after launch; a signal arriving between trap
# registration and the final append is a small race window (same as before
# the shared-library refactor). Acceptable for entrypoint-level cleanup.
refresh_openclaw_supervised_child_pids
# shellcheck disable=SC2034  # read by cleanup_on_signal from sandbox-init.sh
SANDBOX_WAIT_PID="$GATEWAY_PID"
if ! gateway_control_init; then
  echo "[gateway-control] privileged gateway control unavailable" >&2
fi
if ! run_openclaw_config_guard publish-startup-ready --startup-owner; then
  echo "[SECURITY] OpenClaw config readiness lease could not be published; refusing to keep the gateway running" >&2
  stop_openclaw_supervised_gateway \
    "${GATEWAY_PID:-0}" "${GATEWAY_PID_START_IDENTITY:-}" || true
  exit 1
fi
print_dashboard_urls

# Keep container running by waiting on the gateway process.
# This script is PID 1 (ENTRYPOINT); if it exits, Docker kills all children.
# Auto-respawn gateway on unexpected death (NVIDIA/NemoClaw#2757). Without
# this loop, gateway death unblocks `wait` → PID 1 exits → Docker reaps the
# whole sandbox container, forcing users to run `nemoclaw connect` to recover.
# RESPAWN_TIMES is a true sliding 60s window of crash timestamps; entries
# older than the cutoff are pruned each iteration so bursts spanning a
# window boundary still trigger the >=5 alarm.
RESPAWN_TIMES=()
while :; do
  # Poll the tracked child instead of entering an unbounded wait immediately.
  # A USR1 that lands just before `wait` would otherwise set the trap flag and
  # then leave PID 1 blocked forever because there is no second signal to
  # interrupt that wait.
  while openclaw_supervised_pid_is_live \
    "$GATEWAY_PID" "$GATEWAY_PID_START_IDENTITY" \
    && [ "$GATEWAY_CONTROL_SIGNAL_PENDING" -eq 0 ]; do
    sleep 1 || true
  done
  if [ "$GATEWAY_CONTROL_SIGNAL_PENDING" -eq 1 ]; then
    handle_openclaw_gateway_control_request || true
    continue
  fi

  EXITED_GATEWAY_PID="$GATEWAY_PID"
  EXITED_GATEWAY_START_IDENTITY="$GATEWAY_PID_START_IDENTITY"
  REAP_STATUS=0
  openclaw_reap_exited_gateway || REAP_STATUS=$?
  if [ "$REAP_STATUS" -eq 3 ]; then
    handle_openclaw_gateway_control_request || true
    continue
  fi
  if [ "$REAP_STATUS" -ne 0 ]; then
    exit 1
  fi
  RC="$OPENCLAW_REAP_EXIT_STATUS"
  if [ "$GATEWAY_CONTROL_SIGNAL_PENDING" -eq 1 ]; then
    handle_openclaw_gateway_control_request || true
    continue
  fi
  if [ "$RC" -eq 0 ] \
    && ! consume_gateway_watchdog_kill "${EXITED_GATEWAY_PID}:${EXITED_GATEWAY_START_IDENTITY}" \
    && ! gateway_control_exit_was_host_authorized \
      "$EXITED_GATEWAY_PID" "$EXITED_GATEWAY_START_IDENTITY"; then
    exit 0
  fi
  NOW=$(date +%s)
  RESPAWN_TIMES+=("$NOW")
  _PRUNED=()
  for _t in "${RESPAWN_TIMES[@]+"${RESPAWN_TIMES[@]}"}"; do
    [ $((NOW - _t)) -le 60 ] && _PRUNED+=("$_t")
  done
  RESPAWN_TIMES=("${_PRUNED[@]+"${_PRUNED[@]}"}")
  RESPAWN_COUNT=${#RESPAWN_TIMES[@]}
  if [ "$RESPAWN_COUNT" -ge 5 ]; then
    echo "[gateway] CRITICAL: $RESPAWN_COUNT respawns in 60s window — gateway likely unstable; check /tmp/gateway.log" >&2
  fi
  echo "[gateway] pid $EXITED_GATEWAY_PID exited (rc=$RC); respawning (#$RESPAWN_COUNT in 60s window) in 2s" >&2
  sleep 2 || true
  # A host request can arrive during the crash backoff. Service it before the
  # automatic relaunch so PID 1 never launches an untracked extra gateway and
  # immediately replaces it again.
  if [ "$GATEWAY_CONTROL_SIGNAL_PENDING" -eq 1 ]; then
    handle_openclaw_gateway_control_request || true
    continue
  fi
  prepare_openclaw_automatic_respawn || exit 1
  launch_openclaw_gateway
  refresh_openclaw_supervised_child_pids
  echo "[gateway] respawned (pid $GATEWAY_PID)" >&2
done
