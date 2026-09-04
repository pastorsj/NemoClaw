# shellcheck shell=bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
# Track process identity and operate the dashboard and loopback relays.

hermes_role_identity_value() {
  case "$1" in
    gateway) printf '%s' "${GATEWAY_PID_START_IDENTITY:-}" ;;
    dashboard) printf '%s' "${DASHBOARD_PID_START_IDENTITY:-}" ;;
    api-socat) printf '%s' "${SOCAT_PID_START_IDENTITY:-}" ;;
    dashboard-socat) printf '%s' "${DASHBOARD_SOCAT_PID_START_IDENTITY:-}" ;;
    gateway-log) printf '%s' "${GATEWAY_LOG_TAIL_PID_START_IDENTITY:-}" ;;
    dashboard-log) printf '%s' "${DASHBOARD_LOG_TAIL_PID_START_IDENTITY:-}" ;;
    *) return 1 ;;
  esac
}

hermes_set_role_identity() {
  local role="$1"
  local value="$2"
  case "$role" in
    gateway) GATEWAY_PID_START_IDENTITY="$value" ;;
    dashboard) DASHBOARD_PID_START_IDENTITY="$value" ;;
    api-socat) SOCAT_PID_START_IDENTITY="$value" ;;
    dashboard-socat) DASHBOARD_SOCAT_PID_START_IDENTITY="$value" ;;
    gateway-log) GATEWAY_LOG_TAIL_PID_START_IDENTITY="$value" ;;
    dashboard-log) DASHBOARD_LOG_TAIL_PID_START_IDENTITY="$value" ;;
    *) return 1 ;;
  esac
}

hermes_expected_service_uid() {
  case "$1" in
    current) id -u ;;
    gateway) id -u gateway ;;
    sandbox) id -u sandbox ;;
    *) return 1 ;;
  esac
}

hermes_process_start_identity() {
  local pid="$1"
  local proc_stat
  local stat_suffix
  local expected_parent_pid="${HERMES_STARTUP_SUPERVISOR_PID:-$$}"
  local process_ppid
  local process_start

  case "$pid" in
    '' | 0 | 1 | *[!0-9]*) return 1 ;;
  esac
  [ -r "${_HERMES_PROC_ROOT}/${pid}/stat" ] || return 1
  IFS= read -r proc_stat <"${_HERMES_PROC_ROOT}/${pid}/stat" || return 1
  stat_suffix="${proc_stat##*) }"
  process_ppid="$(awk '{print $2}' <<<"$stat_suffix")"
  process_start="$(awk '{print $20}' <<<"$stat_suffix")"
  [ "$process_ppid" = "$expected_parent_pid" ] || return 1
  case "$process_start" in
    '' | *[!0-9]*) return 1 ;;
  esac
  printf '%s' "$process_start"
}

hermes_process_role_identity() {
  local role="$1"
  local pid="$2"
  local service_user="$3"
  local port="${4:-}"
  local process_start
  local expected_uid
  local effective_uid
  local cmdline

  gateway_control_pid_is_live "$pid" || return 1
  [ -r "${_HERMES_PROC_ROOT}/${pid}/status" ] \
    && [ -r "${_HERMES_PROC_ROOT}/${pid}/cmdline" ] || return 1
  process_start="$(hermes_process_start_identity "$pid")" || return 1
  expected_uid="$(hermes_expected_service_uid "$service_user")" || return 1
  effective_uid="$(awk '/^Uid:/ { print $3; exit }' "${_HERMES_PROC_ROOT}/${pid}/status")"
  [ "$effective_uid" = "$expected_uid" ] || return 1
  cmdline="$(tr '\0' ' ' <"${_HERMES_PROC_ROOT}/${pid}/cmdline")" || return 1
  case "$role" in
    gateway)
      case "$cmdline" in
        *hermes*gateway*run*) ;;
        *) return 1 ;;
      esac
      ;;
    dashboard)
      case "$cmdline" in
        *hermes*dashboard*) ;;
        *) return 1 ;;
      esac
      ;;
    api-socat | dashboard-socat)
      case "$port" in
        '' | *[!0-9]*) return 1 ;;
      esac
      case "$cmdline" in
        *socat*"TCP-LISTEN:${port},"*) ;;
        *) return 1 ;;
      esac
      ;;
    gateway-log)
      case "$cmdline" in
        *sed*gateway-log*) ;;
        *) return 1 ;;
      esac
      ;;
    dashboard-log)
      case "$cmdline" in
        *sed*dashboard-log*) ;;
        *) return 1 ;;
      esac
      ;;
    *) return 1 ;;
  esac
  printf '%s' "$process_start"
}

hermes_capture_tracked_role() {
  local role="$1"
  local pid="$2"
  local service_user="$3"
  local port="${4:-}"
  local identity
  local attempts=0
  while [ "$attempts" -lt 50 ]; do
    if identity="$(hermes_process_role_identity "$role" "$pid" "$service_user" "$port")"; then
      hermes_set_role_identity "$role" "$identity"
      return 0
    fi
    gateway_control_pid_is_live "$pid" || return 1
    sleep 0.1
    attempts=$((attempts + 1))
  done
  return 1
}

hermes_tracked_role_is_current() {
  local role="$1"
  local pid="$2"
  local service_user="$3"
  local port="${4:-}"
  local expected
  local current
  expected="$(hermes_role_identity_value "$role")" || return 1
  [ -n "$expected" ] || return 1
  current="$(hermes_process_role_identity "$role" "$pid" "$service_user" "$port")" || return 1
  [ "$current" = "$expected" ]
}

hermes_stop_tracked_role() {
  local role="$1"
  local pid="$2"
  local service_user="$3"
  local port="${4:-}"
  local expected_start_identity
  local current_start_identity
  local state
  expected_start_identity="$(hermes_role_identity_value "$role")" || return 1

  case "$pid" in
    '' | 0 | 1 | *[!0-9]*)
      # An empty role has never owned a process and is a safe no-op. A stored
      # identity paired with an invalid PID is inconsistent and must not be
      # reported as a successful stop.
      [ -z "$expected_start_identity" ] && return 0
      return 1
      ;;
  esac
  [ -n "$expected_start_identity" ] || return 1

  if ! hermes_tracked_role_is_current "$role" "$pid" "$service_user" "$port"; then
    # Distinguish a child that is definitely gone from a live/reused/unreadable
    # numeric PID. Only the former is a successful no-op. A matching zombie is
    # still the exact tracked child and the shared helper can reap it safely.
    current_start_identity="$(hermes_process_start_identity "$pid" 2>/dev/null || true)"
    if [ -n "$current_start_identity" ]; then
      if [ "$current_start_identity" != "$expected_start_identity" ]; then
        echo "[SECURITY] Hermes ${role} pid ${pid} was reused; refusing to signal or treat it as stopped" >&2
        return 1
      fi
      state="$(gateway_control_pid_state "$pid" 2>/dev/null || true)"
      case "$state" in
        Z*) ;;
        *)
          echo "[SECURITY] Hermes ${role} pid ${pid} still has its captured start identity but its role cannot be proven; refusing to signal or treat it as stopped" >&2
          return 1
          ;;
      esac
    elif kill -0 "$pid" 2>/dev/null; then
      echo "[SECURITY] Hermes ${role} pid ${pid} is live but its start identity cannot be proven; refusing to signal or treat it as stopped" >&2
      return 1
    else
      hermes_set_role_identity "$role" ""
      return 0
    fi
  fi

  gateway_control_stop_tracked_pid "$pid" "$expected_start_identity" || return 1
  if kill -0 "$pid" 2>/dev/null; then
    # The shared helper may return success when its final identity read says
    # the numeric PID was replaced. That is sufficient for ordinary cleanup,
    # but not for a gateway revocation that is about to mark the role stopped
    # and relaunch. Require the numeric PID to be absent as a postcondition.
    echo "[SECURITY] Hermes ${role} pid ${pid} remains live after tracked stop; refusing to treat it as stopped" >&2
    return 1
  fi
  hermes_set_role_identity "$role" ""
}

hermes_tracked_service_owns_listener() {
  local pid="$1"
  local port="$2"
  local service_user="$3"

  if [ "$(id -u)" -ne 0 ] || [ "$service_user" = "current" ]; then
    gateway_control_pid_owns_tcp_listener "$pid" "$port"
    return $?
  fi
  case "$service_user" in
    gateway)
      # shellcheck disable=SC2016  # positional args expand in the stepped-down shell
      "${STEP_DOWN_PREFIX_GATEWAY[@]}" env -u BASH_ENV \
        bash --noprofile --norc -c \
        'source "$1"; gateway_control_pid_owns_tcp_listener "$2" "$3"' \
        bash "$_GATEWAY_SUPERVISOR" "$pid" "$port"
      ;;
    sandbox)
      # shellcheck disable=SC2016  # positional args expand in the stepped-down shell
      "${STEP_DOWN_PREFIX_SANDBOX[@]}" env -u BASH_ENV \
        bash --noprofile --norc -c \
        'source "$1"; gateway_control_pid_owns_tcp_listener "$2" "$3"' \
        bash "$_GATEWAY_SUPERVISOR" "$pid" "$port"
      ;;
    *) return 1 ;;
  esac
}

start_socat_forwarder() {
  local public_port="$1"
  local internal_port="$2"
  local label="$3"
  local pid_var="${4:-SOCAT_PID}"
  local owner_pid="${5:-}"
  local owner_user="${6:-current}"
  local _socat_pid
  local _socat_role=""
  local owner_role=""

  case "$owner_user" in
    gateway) owner_role=gateway ;;
    sandbox) owner_role=dashboard ;;
    current)
      # INTERNAL_PORT is defined by start.sh before this sourced module runs.
      # shellcheck disable=SC2153
      if [ "$internal_port" = "$INTERNAL_PORT" ]; then
        owner_role=gateway
      elif [ "$internal_port" = "$DASHBOARD_INTERNAL_PORT" ]; then
        owner_role=dashboard
      fi
      ;;
  esac

  if ! command -v socat >/dev/null 2>&1; then
    echo "[gateway] socat not available - ${label} port forwarding from host may not work" >&2
    return
  fi
  local attempts=0
  local internal_ready=0
  while [ "$attempts" -lt 30 ]; do
    if [ -n "$owner_pid" ]; then
      if [ -z "$owner_role" ] \
        || ! hermes_tracked_role_is_current \
          "$owner_role" "$owner_pid" "$owner_user" "$internal_port"; then
        echo "[gateway] ${label} service owner pid ${owner_pid} exited before binding 127.0.0.1:${internal_port}" >&2
        return 1
      fi
      if hermes_tracked_service_owns_listener "$owner_pid" "$internal_port" "$owner_user"; then
        internal_ready=1
        break
      fi
    elif ss -tln 2>/dev/null | grep -q "127.0.0.1:${internal_port}"; then
      # Compatibility for non-supervised callers; PID 1 production paths pass
      # an exact owner PID and never rely on this transport-only fallback.
      internal_ready=1
      break
    fi
    sleep 1
    attempts=$((attempts + 1))
  done
  if [ "$internal_ready" -ne 1 ]; then
    echo "[gateway] ${label} service did not bind 127.0.0.1:${internal_port}; refusing to publish an empty forward" >&2
    return 1
  fi
  nohup socat TCP-LISTEN:"${public_port}",bind=0.0.0.0,fork,reuseaddr \
    TCP:127.0.0.1:"${internal_port}" >/dev/null 2>&1 &
  _socat_pid=$!
  sleep 0.1
  if ! gateway_control_pid_is_live "$_socat_pid"; then
    wait "$_socat_pid" 2>/dev/null || true
    echo "[gateway] ${label} socat forwarder failed to stay running on 0.0.0.0:${public_port}" >&2
    return 1
  fi
  case "$pid_var" in
    SOCAT_PID)
      _socat_role=api-socat
      if ! hermes_capture_tracked_role api-socat "$_socat_pid" current "$public_port"; then
        hermes_set_role_identity api-socat ""
        hermes_fatal_unproven_child api-socat "$_socat_pid"
      fi
      ;;
    DASHBOARD_SOCAT_PID)
      _socat_role=dashboard-socat
      if ! hermes_capture_tracked_role dashboard-socat "$_socat_pid" current "$public_port"; then
        hermes_set_role_identity dashboard-socat ""
        hermes_fatal_unproven_child dashboard-socat "$_socat_pid"
      fi
      ;;
  esac
  attempts=0
  while [ "$attempts" -lt 30 ]; do
    gateway_control_pid_owns_tcp_listener "$_socat_pid" "$public_port" && break
    gateway_control_pid_is_live "$_socat_pid" || break
    sleep 0.1
    attempts=$((attempts + 1))
  done
  if ! gateway_control_pid_owns_tcp_listener "$_socat_pid" "$public_port"; then
    if [ -n "$_socat_role" ]; then
      hermes_stop_tracked_role "$_socat_role" "$_socat_pid" current "$public_port" || true
    fi
    echo "[gateway] ${label} socat process did not own 0.0.0.0:${public_port}" >&2
    return 1
  fi
  printf -v "$pid_var" '%s' "$_socat_pid"
  echo "[gateway] ${label} socat forwarder 0.0.0.0:${public_port} -> 127.0.0.1:${internal_port} (pid ${_socat_pid})" >&2
}

build_hermes_dashboard_args() {
  # HERMES_DASHBOARD_HOME is a dedicated profile for privilege separation.
  # Hermes otherwise treats a profiles/<name> launch as a request for its
  # unified machine dashboard and re-execs outside this prepared profile.
  HERMES_DASHBOARD_ARGS=(
    dashboard
    --host
    127.0.0.1
    --port
    "$DASHBOARD_INTERNAL_PORT"
    --skip-build
    --no-open
    --isolated
  )
  if hermes_dashboard_tui_enabled; then
    HERMES_DASHBOARD_ARGS+=(--tui)
  fi
}

prepare_hermes_dashboard_home() {
  local owner="${1:-}"
  local rc=0
  if [ "$(id -u)" -eq 0 ] && [ -n "$owner" ]; then
    # Root starts the dashboard service, but the dashboard home is sandbox-owned
    # mutable state. Do every path-touching operation after step-down so root
    # never follows, creates, chowns, chmods, or deletes through a
    # sandbox-controlled dashboard-home path. Remove this branch only if
    # dashboard home creation moves into a trusted image-build step.
    # shellcheck disable=SC2016  # inner shell expands after sandbox step-down
    env HERMES_DIR="$HERMES_DIR" \
      HERMES_DASHBOARD_HOME="$HERMES_DASHBOARD_HOME" \
      _HERMES_PYTHON="$_HERMES_PYTHON" \
      _HERMES_DASHBOARD_CONFIG_SEEDER="$_HERMES_DASHBOARD_CONFIG_SEEDER" \
      _HERMES_MANAGED_POLICY="$_HERMES_MANAGED_POLICY" \
      "${STEP_DOWN_PREFIX_SANDBOX[@]}" sh -c '
        if [ -L "$HERMES_DASHBOARD_HOME" ]; then
          echo "[SECURITY] Refusing Hermes dashboard startup because ${HERMES_DASHBOARD_HOME} is a symlink" >&2
          exit 1
        fi
        mkdir -p "$HERMES_DASHBOARD_HOME" || exit 1
        if [ -L "$HERMES_DASHBOARD_HOME" ] || [ ! -d "$HERMES_DASHBOARD_HOME" ]; then
          echo "[SECURITY] Refusing Hermes dashboard startup because ${HERMES_DASHBOARD_HOME} is not a safe directory" >&2
          exit 1
        fi
        chmod 700 "$HERMES_DASHBOARD_HOME" || exit 1
        # The dashboard can attempt a gateway restart from its isolated
        # HERMES_HOME. In NemoClaw the real gateway lives under /sandbox/.hermes,
        # so a failed dashboard-scoped restart can leave stale startup_failed
        # state that poisons /api/status even while the real gateway is healthy.
        rm -f "${HERMES_DASHBOARD_HOME}/gateway_state.json" 2>/dev/null || true
        exec "$_HERMES_PYTHON" "$_HERMES_DASHBOARD_CONFIG_SEEDER" \
          "$_HERMES_MANAGED_POLICY" \
          "${HERMES_DIR}/config.yaml" "${HERMES_DASHBOARD_HOME}/config.yaml" \
          "${HERMES_DIR}/.env" "${HERMES_DASHBOARD_HOME}/.env"
      ' || rc=$?
    if [ "$rc" -ne 0 ]; then
      echo "[dashboard] ERROR: config seed exited ${rc}; refusing dashboard startup" >&2
      return "$rc"
    fi
    return 0
  fi

  if [ -L "$HERMES_DASHBOARD_HOME" ]; then
    echo "[SECURITY] Refusing Hermes dashboard startup because ${HERMES_DASHBOARD_HOME} is a symlink" >&2
    return 1
  fi
  mkdir -p "$HERMES_DASHBOARD_HOME" || return 1
  if [ -L "$HERMES_DASHBOARD_HOME" ] || [ ! -d "$HERMES_DASHBOARD_HOME" ]; then
    echo "[SECURITY] Refusing Hermes dashboard startup because ${HERMES_DASHBOARD_HOME} is not a safe directory" >&2
    return 1
  fi
  chmod 700 "$HERMES_DASHBOARD_HOME" || return 1
  seed_hermes_dashboard_config
}

# Mirror the gateway's model routing and non-secret dotenv context into the
# dashboard's isolated HERMES_HOME so its Models page (/api/model/options),
# Chat/TUI setup checks, and kanban specifier/dispatcher resolve the routed
# model. The dashboard runs under HERMES_DASHBOARD_HOME for privilege separation and
# otherwise only sees a Hermes-default config with an empty model. Idempotent:
# refreshes the keys on every launch. Missing gateway config is a benign no-op
# in the seeder; security refusals and write failures abort startup.
seed_hermes_dashboard_config() {
  local dst="${HERMES_DASHBOARD_HOME}/config.yaml"
  local env_dst="${HERMES_DASHBOARD_HOME}/.env"
  local rc=0

  # Non-root and explicit same-user launches perform cleanup and seeding under
  # the current service user; root launches run the equivalent block inside
  # prepare_hermes_dashboard_home after stepping down to the sandbox identity.
  rm -f "${HERMES_DASHBOARD_HOME}/gateway_state.json" 2>/dev/null || true
  env "$_HERMES_PYTHON" "$_HERMES_DASHBOARD_CONFIG_SEEDER" \
    "$_HERMES_MANAGED_POLICY" \
    "${HERMES_DIR}/config.yaml" "$dst" \
    "${HERMES_DIR}/.env" "$env_dst" || rc=$?

  if [ "$rc" -ne 0 ]; then
    echo "[dashboard] ERROR: config seed exited ${rc}; refusing dashboard startup" >&2
    return "$rc"
  fi
}

launch_hermes_dashboard_process() {
  local service_user="${1:-current}"
  local HERMES_HOME="${HERMES_DASHBOARD_HOME}"
  local GATEWAY_HEALTH_URL="http://127.0.0.1:${INTERNAL_PORT}"
  local NEMOCLAW_HERMES_DASHBOARD_API_SERVER_ENV="${HERMES_DIR}/.env"
  local _NEMOCLAW_HERMES_DASHBOARD_EXTERNAL_HOST="${HERMES_DASHBOARD_EXTERNAL_HOST}"
  export HERMES_HOME GATEWAY_HEALTH_URL NEMOCLAW_HERMES_DASHBOARD_API_SERVER_ENV \
    _NEMOCLAW_HERMES_DASHBOARD_EXTERNAL_HOST

  case "$service_user" in
    current)
      nohup "$HERMES" "${HERMES_DASHBOARD_ARGS[@]}" >/tmp/dashboard.log 2>&1 &
      ;;
    sandbox)
      nohup "${STEP_DOWN_PREFIX_SANDBOX[@]}" sh -c \
        'umask 0077; exec "$@" >/tmp/dashboard.log 2>&1' \
        sh "$HERMES" "${HERMES_DASHBOARD_ARGS[@]}" &
      ;;
    *)
      echo "[dashboard] ERROR: invalid dashboard service user" >&2
      return 1
      ;;
  esac
  DASHBOARD_PID=$!
}

start_hermes_dashboard_current_user() {
  build_hermes_dashboard_args || return 1
  prepare_hermes_dashboard_home "" || return 1
  prepare_restricted_log /tmp/dashboard.log "" 600 || return 1
  launch_hermes_dashboard_process current || return 1
  echo "[gateway] hermes dashboard launched (pid $DASHBOARD_PID)" >&2
  if ! hermes_capture_tracked_role dashboard "$DASHBOARD_PID" current "$DASHBOARD_INTERNAL_PORT"; then
    hermes_fatal_unproven_child dashboard "$DASHBOARD_PID"
  fi
  ensure_dashboard_log_stream || return 1
  start_socat_forwarder \
    "$DASHBOARD_PUBLIC_PORT" "$DASHBOARD_INTERNAL_PORT" "dashboard" DASHBOARD_SOCAT_PID \
    "$DASHBOARD_PID" current
}

start_hermes_dashboard_sandbox_user() {
  build_hermes_dashboard_args || return 1
  prepare_hermes_dashboard_home sandbox:sandbox || return 1
  prepare_restricted_log /tmp/dashboard.log sandbox:sandbox 600 || return 1
  launch_hermes_dashboard_process sandbox || return 1
  echo "[gateway] hermes dashboard launched as 'sandbox' user (pid $DASHBOARD_PID)" >&2
  if ! hermes_capture_tracked_role dashboard "$DASHBOARD_PID" sandbox "$DASHBOARD_INTERNAL_PORT"; then
    hermes_fatal_unproven_child dashboard "$DASHBOARD_PID"
  fi
  ensure_dashboard_log_stream || return 1
  start_socat_forwarder \
    "$DASHBOARD_PUBLIC_PORT" "$DASHBOARD_INTERNAL_PORT" "dashboard" DASHBOARD_SOCAT_PID \
    "$DASHBOARD_PID" sandbox
}

wait_for_hermes_gateway_internal() {
  local gateway_pid="$1"
  local deadline=$((SECONDS + 90))
  local code
  local service_user=current
  [ "$(id -u)" -eq 0 ] && service_user=gateway
  while [ "$SECONDS" -lt "$deadline" ]; do
    # Status-code extraction (not curl -sf) so a 401 counts as alive: Hermes
    # v0.16.0+ may guard the api_server with API_SERVER_KEY, and the probe is
    # unauthenticated. A 401 still proves the gateway is bound and serving.
    # Mirrors GATEWAY_ALIVE_CODES in src/lib/verify-deployment.ts.
    if hermes_tracked_role_is_current gateway "$gateway_pid" "$service_user" "$INTERNAL_PORT" \
      && hermes_tracked_service_owns_listener "$gateway_pid" "$INTERNAL_PORT" "$service_user"; then
      code=$(curl -so /dev/null -w '%{http_code}' --max-time 2 \
        "http://127.0.0.1:${INTERNAL_PORT}/health" 2>/dev/null || echo 000)
      case "$code" in
        200 | 401) return 0 ;;
      esac
    fi
    if ! hermes_tracked_role_is_current gateway "$gateway_pid" "$service_user" "$INTERNAL_PORT"; then
      wait "$gateway_pid"
      return $?
    fi
    sleep 1
  done
  echo "[gateway] Hermes gateway did not become healthy on internal port ${INTERNAL_PORT}" >&2
  return 1
}

restore_hermes_config_permissions_after_dashboard_start() {
  [ "$(id -u)" -eq 0 ] || return 0
  # Hermes dashboard startup may tighten HERMES_HOME to 0700 because it runs as
  # the sandbox owner. The gateway process runs as the separate gateway user and
  # reads config via sandbox-group membership, so restore NemoClaw's shared
  # mutable-root mode after the dashboard has performed its startup checks.
  local attempts=0
  while [ "$attempts" -lt 5 ]; do
    ensure_hermes_config_root_mode || return 1
    attempts=$((attempts + 1))
    sleep 1
  done
}

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
