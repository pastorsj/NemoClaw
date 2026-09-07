# shellcheck shell=bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
# Launch, validate, recover, and supervise the Hermes gateway topology.

hermes_socat_bridge_healthy() {
  local role="$1"
  local pid="$2"
  local port="$3"
  hermes_tracked_role_is_current "$role" "$pid" current "$port" || return 1
  gateway_control_pid_owns_tcp_listener "$pid" "$port"
}

hermes_api_socat_bridge_healthy() {
  local pid="$1"
  local port="$2"
  local code
  hermes_socat_bridge_healthy api-socat "$pid" "$port" || return 1
  # A listener-owning socat parent can survive a gateway SIGUSR1 replacement
  # while its relay path no longer reaches the replacement. Validate the same
  # public HTTP path clients use so the managed supervisor repairs that stale
  # bridge instead of treating its listener as sufficient proof of health.
  code="$(curl -so /dev/null -w '%{http_code}' --max-time 2 \
    "http://127.0.0.1:${port}/health" 2>/dev/null || echo 000)"
  case "$code" in
    200 | 401) hermes_socat_bridge_healthy api-socat "$pid" "$port" ;;
    *) return 1 ;;
  esac
}

hermes_dashboard_healthy() {
  local pid="$1"
  local code
  local service_user=current
  [ "$(id -u)" -eq 0 ] && service_user=sandbox
  hermes_tracked_role_is_current dashboard "$pid" "$service_user" "$DASHBOARD_INTERNAL_PORT" || return 1
  hermes_tracked_service_owns_listener "$pid" "$DASHBOARD_INTERNAL_PORT" sandbox || return 1
  code="$(curl -so /dev/null -w '%{http_code}' --max-time 3 \
    "http://127.0.0.1:${DASHBOARD_INTERNAL_PORT}/" 2>/dev/null || true)"
  case "$code" in
    200 | 301 | 302 | 307 | 308) return 0 ;;
    *) return 1 ;;
  esac
}

hermes_auxiliaries_need_recovery() {
  hermes_api_socat_bridge_healthy "${SOCAT_PID:-}" "$PUBLIC_PORT" || return 0
  hermes_dashboard_healthy "${DASHBOARD_PID:-}" || return 0
  hermes_socat_bridge_healthy dashboard-socat "${DASHBOARD_SOCAT_PID:-}" "$DASHBOARD_PUBLIC_PORT" || return 0
  return 1
}

cleanup_sealed_hermes_gateway_runtime() {
  # shellcheck disable=SC2016  # positional args expand in the stepped-down shell
  "${STEP_DOWN_PREFIX_GATEWAY[@]}" sh -c '
    rm -f "$1/runtime/gateway.pid" "$1/runtime/gateway.lock"
  ' sh "$HERMES_DIR"
}

launch_hermes_gateway() {
  # This function is called from an `if ! ...` recovery branch, where Bash
  # disables errexit throughout the function call. Propagate every security-
  # sensitive preparation failure explicitly before creating a child.
  if [ "$HERMES_RESTART_SEALED" -ne 1 ]; then
    cleanup_stale_hermes_gateway_runtime || return 1
  fi
  HERMES_HOME="${HERMES_DIR}" \
    HOME=/sandbox \
    HERMES_LAZY_INSTALL_TARGET="${HERMES_GATEWAY_LAZY_INSTALL_TARGET}" \
    HERMES_BUNDLED_PLUGINS="${HERMES_MANAGED_BUNDLED_PLUGINS}" \
    nohup "${STEP_DOWN_PREFIX_GATEWAY[@]}" sh -c \
    'umask 0007; exec "$@" >>/tmp/gateway.log 2>&1' sh "$HERMES" gateway run &
  GATEWAY_PID=$!
  if ! hermes_capture_tracked_role gateway "$GATEWAY_PID" gateway "$INTERNAL_PORT"; then
    hermes_fatal_unproven_child gateway "$GATEWAY_PID"
  fi
  # shellcheck disable=SC2034  # read by cleanup_on_signal from sandbox-init.sh
  SANDBOX_WAIT_PID="$GATEWAY_PID"
  echo "[gateway] hermes gateway launched as 'gateway' user (pid $GATEWAY_PID)" >&2
}

ensure_hermes_supervised_auxiliaries() {
  local gateway_user=current
  local dashboard_user=current
  if [ "$(id -u)" -eq 0 ]; then
    gateway_user=gateway
    dashboard_user=sandbox
  fi

  # Structural identity/listener loss requires exact relay replacement. A
  # transient public HTTP miss does not: forked socat accepts each request on
  # a fresh backend connection, so churning its proven listener can prolong
  # the outage while the replacement gateway is still settling. Preserve the
  # exact parent and let the supervised recovery loop retry readiness instead.
  if ! hermes_socat_bridge_healthy api-socat "${SOCAT_PID:-}" "$PUBLIC_PORT"; then
    hermes_stop_tracked_role api-socat "${SOCAT_PID:-0}" current "$PUBLIC_PORT" || return 1
    SOCAT_PID=""
    start_socat_forwarder \
      "$PUBLIC_PORT" "$INTERNAL_PORT" "API" SOCAT_PID "$GATEWAY_PID" "$gateway_user" || return 1
  fi
  hermes_api_socat_bridge_healthy "$SOCAT_PID" "$PUBLIC_PORT" || return 1
  if ! hermes_dashboard_healthy "${DASHBOARD_PID:-}"; then
    # A live PID is not sufficient: it may be reused, alive without the exact
    # dashboard listener, or serving a wedged HTTP process. Stop both tracked
    # children before relaunch so the replacement cannot lose either bind race.
    hermes_stop_tracked_role dashboard-socat "${DASHBOARD_SOCAT_PID:-0}" current "$DASHBOARD_PUBLIC_PORT" || return 1
    DASHBOARD_SOCAT_PID=""
    hermes_stop_tracked_role dashboard "${DASHBOARD_PID:-0}" "$dashboard_user" "$DASHBOARD_INTERNAL_PORT" || return 1
    DASHBOARD_PID=""
    if [ "$(id -u)" -eq 0 ]; then
      start_hermes_dashboard_sandbox_user || return 1
    else
      start_hermes_dashboard_current_user || return 1
    fi
  elif ! hermes_socat_bridge_healthy dashboard-socat "${DASHBOARD_SOCAT_PID:-}" "$DASHBOARD_PUBLIC_PORT"; then
    hermes_stop_tracked_role dashboard-socat "${DASHBOARD_SOCAT_PID:-0}" current "$DASHBOARD_PUBLIC_PORT" || return 1
    DASHBOARD_SOCAT_PID=""
    start_socat_forwarder \
      "$DASHBOARD_PUBLIC_PORT" "$DASHBOARD_INTERNAL_PORT" "dashboard" DASHBOARD_SOCAT_PID \
      "$DASHBOARD_PID" "$dashboard_user" || return 1
  fi
  ensure_dashboard_log_stream || return 1
  ensure_gateway_log_stream || return 1
}

refresh_hermes_supervised_child_pids() {
  local gateway_user=current
  local dashboard_user=current
  SANDBOX_CHILD_PIDS=()
  if [ "$(id -u)" -eq 0 ]; then
    gateway_user=gateway
    dashboard_user=sandbox
  fi
  hermes_tracked_role_is_current gateway "${GATEWAY_PID:-}" "$gateway_user" "$INTERNAL_PORT" \
    && SANDBOX_CHILD_PIDS+=("$GATEWAY_PID")
  hermes_tracked_role_is_current dashboard "${DASHBOARD_PID:-}" "$dashboard_user" "$DASHBOARD_INTERNAL_PORT" \
    && SANDBOX_CHILD_PIDS+=("$DASHBOARD_PID")
  hermes_tracked_role_is_current api-socat "${SOCAT_PID:-}" current "$PUBLIC_PORT" \
    && SANDBOX_CHILD_PIDS+=("$SOCAT_PID")
  hermes_tracked_role_is_current dashboard-socat "${DASHBOARD_SOCAT_PID:-}" current "$DASHBOARD_PUBLIC_PORT" \
    && SANDBOX_CHILD_PIDS+=("$DASHBOARD_SOCAT_PID")
  hermes_tracked_role_is_current gateway-log "${GATEWAY_LOG_TAIL_PID:-}" current \
    && SANDBOX_CHILD_PIDS+=("$GATEWAY_LOG_TAIL_PID")
  hermes_tracked_role_is_current dashboard-log "${DASHBOARD_LOG_TAIL_PID:-}" current \
    && SANDBOX_CHILD_PIDS+=("$DASHBOARD_LOG_TAIL_PID")
  # Each tracked child can be absent while a service is replaced. Return success
  # so `set -e` callers can launch the replacement gateway.
  return 0
}

hermes_cleanup_on_signal() {
  local gateway_user=current
  [ "$(id -u)" -eq 0 ] && gateway_user=gateway
  refresh_hermes_supervised_child_pids
  if ! hermes_tracked_role_is_current gateway "${GATEWAY_PID:-}" "$gateway_user" "$INTERNAL_PORT"; then
    # The shared cleanup helper must never wait on or signal a PID that has
    # been reused/adopted since NemoClaw captured the gateway start identity.
    SANDBOX_WAIT_PID=""
  fi
  cleanup_on_signal
}

mark_hermes_gateway_stopped() {
  GATEWAY_PID=0
  GATEWAY_PID_START_IDENTITY=""
  # shellcheck disable=SC2034  # read by cleanup_on_signal from sandbox-init.sh
  SANDBOX_WAIT_PID=""
  refresh_hermes_supervised_child_pids
}

hermes_reap_exited_gateway() {
  local pid="${GATEWAY_PID:-0}"
  local expected_start_identity="${GATEWAY_PID_START_IDENTITY:-}"
  local current_start_identity state
  local rc=0
  case "$pid" in
    '' | 0 | 1 | *[!0-9]*) return 1 ;;
  esac
  [ -n "$expected_start_identity" ] || return 1

  current_start_identity="$(hermes_process_start_identity "$pid" 2>/dev/null || true)"
  if [ -n "$current_start_identity" ] \
    && [ "$current_start_identity" != "$expected_start_identity" ]; then
    echo "[SECURITY] Hermes gateway pid $pid no longer matches its captured start identity; refusing to poll or reap it" >&2
    return 2
  fi

  # kill -0 also succeeds for zombies. Only the exact matching zombie is safe
  # to reap. A live process, or one whose state/identity cannot be proven, must
  # not send PID 1 into an unbounded wait or let an interrupted wait forget a
  # still-running gateway.
  if kill -0 "$pid" 2>/dev/null; then
    state="$(gateway_control_pid_state "$pid" 2>/dev/null || true)"
    case "$state" in
      Z*) [ "$current_start_identity" = "$expected_start_identity" ] || return 2 ;;
      *)
        if [ "${GATEWAY_CONTROL_SIGNAL_PENDING:-0}" -eq 1 ] \
          && hermes_tracked_role_is_current gateway "$pid" gateway "$INTERNAL_PORT"; then
          return 3
        fi
        echo "[SECURITY] Hermes gateway pid $pid cannot be proven exited with its captured role identity; refusing to reap it" >&2
        return 2
        ;;
    esac
  fi

  # If the proc entry is already gone, Bash's child-status table keeps this
  # wait scoped to the original direct child rather than an unrelated PID.
  wait "$pid" 2>/dev/null || rc=$?
  # USR1 may interrupt wait before it reaps the exact child. Preserve the
  # tracked identity and let the authenticated request handler own the child.
  if [ "${GATEWAY_CONTROL_SIGNAL_PENDING:-0}" -eq 1 ] \
    && hermes_tracked_role_is_current gateway "$pid" gateway "$INTERNAL_PORT"; then
    return 3
  fi
  echo "[gateway] Hermes gateway pid $pid exited (rc=$rc); awaiting host recovery" >&2
  mark_hermes_gateway_stopped
}

handle_hermes_gateway_control_request() {
  gateway_control_take_request || return 1
  local old_pid="${GATEWAY_PID:-0}"
  local failure_code

  if [ "$GATEWAY_CONTROL_ACTION" = "probe" ]; then
    # Probe verifies the running process and credential boundary. It does not
    # adopt mutable config or change MCP transaction state.
    if ! validate_running_hermes_boundary; then
      gateway_control_fail "$HERMES_RESTART_FAILURE_CODE" "$old_pid"
      return 1
    fi
    if ! gateway_control_pid_is_live "$old_pid" \
      || ! hermes_gateway_healthy "$old_pid" \
      || hermes_auxiliaries_need_recovery; then
      gateway_control_fail health-timeout "$old_pid"
      return 1
    fi
    gateway_control_complete already-running "$old_pid" "$old_pid"
    return 0
  fi

  if [ "$GATEWAY_CONTROL_ACTION" = "recover" ] \
    && gateway_control_pid_is_live "$old_pid" \
    && hermes_gateway_healthy "$old_pid"; then
    # Recovery may also recreate the dashboard from the shared Hermes config.
    # Adopt one stable snapshot before any auxiliary consumes current config;
    # the old gateway's health does not prove that snapshot stayed unchanged.
    if ! prepare_hermes_gateway_restart; then
      if hermes_restart_failure_revokes_gateway "$HERMES_RESTART_FAILURE_CODE"; then
        stop_hermes_gateway_fail_closed
      fi
      gateway_control_fail "$HERMES_RESTART_FAILURE_CODE" "$old_pid"
      return 1
    fi
    if [ "$HERMES_MCP_RECONCILE_PENDING" -eq 0 ]; then
      if hermes_auxiliaries_need_recovery; then
        if ! seal_hermes_restart_inputs; then
          if [ "$HERMES_RESTART_SEALED" -eq 1 ]; then
            stop_hermes_gateway_fail_closed
          fi
          gateway_control_fail "$HERMES_RESTART_FAILURE_CODE" "$old_pid"
          return 1
        fi
        # Re-run boundary + hash validation against the fresh sealed inodes. A
        # pre-open attacker fd cannot change these pathnames after this point.
        if ! prepare_hermes_gateway_restart; then
          failure_code="$HERMES_RESTART_FAILURE_CODE"
          if hermes_restart_failure_revokes_gateway "$failure_code"; then
            # A post-seal boundary refusal means the currently running service no
            # longer has a boundary we can prove safe. Stop it even if metadata
            # restoration subsequently fails.
            stop_hermes_gateway_fail_closed
          fi
          if ! unseal_hermes_restart_inputs; then
            gateway_control_fail "$HERMES_RESTART_FAILURE_CODE" "$old_pid"
            return 1
          fi
          gateway_control_fail "$failure_code" "$old_pid"
          return 1
        fi
        if ! ensure_hermes_supervised_auxiliaries; then
          if ! unseal_hermes_restart_inputs; then
            stop_hermes_gateway_fail_closed
            gateway_control_fail "$HERMES_RESTART_FAILURE_CODE" "$old_pid"
          else
            gateway_control_fail launch-failed "$old_pid"
          fi
          refresh_hermes_supervised_child_pids
          return 1
        fi
        if ! unseal_hermes_restart_inputs; then
          stop_hermes_gateway_fail_closed
          gateway_control_fail "$HERMES_RESTART_FAILURE_CODE" "$old_pid"
          return 1
        fi
      fi
      refresh_hermes_supervised_child_pids
      gateway_control_complete already-running "$old_pid" "$old_pid"
      return 0
    fi
  fi

  if ! prepare_hermes_gateway_restart; then
    if hermes_restart_failure_revokes_gateway "$HERMES_RESTART_FAILURE_CODE"; then
      stop_hermes_gateway_fail_closed
    fi
    gateway_control_fail "$HERMES_RESTART_FAILURE_CODE" "$old_pid"
    return 1
  fi

  # Seal and revalidate while the old gateway is still healthy. A seal failure
  # must not turn a rejected config into an avoidable outage.
  if ! seal_hermes_restart_inputs; then
    if [ "$HERMES_RESTART_SEALED" -eq 1 ]; then
      stop_hermes_gateway_fail_closed
    fi
    gateway_control_fail "$HERMES_RESTART_FAILURE_CODE" "$old_pid"
    return 1
  fi
  if ! prepare_hermes_gateway_restart; then
    failure_code="$HERMES_RESTART_FAILURE_CODE"
    if hermes_restart_failure_revokes_gateway "$failure_code"; then
      # Do not leave the old gateway alive after a boundary refusal merely
      # because restoring the restart seal also fails.
      stop_hermes_gateway_fail_closed
    fi
    if ! unseal_hermes_restart_inputs; then
      gateway_control_fail "$HERMES_RESTART_FAILURE_CODE" "$old_pid"
      return 1
    fi
    gateway_control_fail "$failure_code" "$old_pid"
    return 1
  fi

  if ! hermes_stop_tracked_role gateway "$old_pid" gateway "$INTERNAL_PORT"; then
    if ! unseal_hermes_restart_inputs; then
      gateway_control_fail "$HERMES_RESTART_FAILURE_CODE" "$old_pid"
    else
      gateway_control_fail internal "$old_pid"
    fi
    return 1
  fi
  mark_hermes_gateway_stopped

  if ! cleanup_sealed_hermes_gateway_runtime; then
    if ! unseal_hermes_restart_inputs; then
      gateway_control_fail "$HERMES_RESTART_FAILURE_CODE" "$old_pid"
    else
      gateway_control_fail unsafe-config "$old_pid"
    fi
    return 1
  fi

  if ! launch_hermes_gateway || ! wait_for_hermes_gateway_internal "$GATEWAY_PID"; then
    stop_hermes_gateway_fail_closed
    if ! unseal_hermes_restart_inputs; then
      gateway_control_fail "$HERMES_RESTART_FAILURE_CODE" "$old_pid"
    else
      gateway_control_fail health-timeout "$old_pid"
    fi
    return 1
  fi
  if ! ensure_hermes_supervised_auxiliaries; then
    refresh_hermes_supervised_child_pids
    if ! unseal_hermes_restart_inputs; then
      stop_hermes_gateway_fail_closed
      gateway_control_fail "$HERMES_RESTART_FAILURE_CODE" "$old_pid"
    else
      gateway_control_fail launch-failed "$old_pid"
    fi
    return 1
  fi
  if ! unseal_hermes_restart_inputs; then
    stop_hermes_gateway_fail_closed
    gateway_control_fail "$HERMES_RESTART_FAILURE_CODE" "$old_pid"
    return 1
  fi
  if ! commit_hermes_mcp_applied_if_pending; then
    stop_hermes_gateway_fail_closed
    gateway_control_fail mcp-integrity "$old_pid"
    return 1
  fi
  refresh_hermes_supervised_child_pids
  gateway_control_complete ok "$old_pid" "$GATEWAY_PID"
}

prepare_hermes_nonroot_runtime() {
  # Classify raw .env material at its dedicated boundary before the MCP
  # integrity guard authenticates the full config/env snapshot. Otherwise a
  # mutable default with a raw secret fails as generic MCP drift and bypasses
  # the actionable, redacted secret-boundary refusal. Repeat after the trusted
  # startup mutations below so their outputs remain covered as well.
  validate_hermes_env_secret_boundary || return 1
  # The non-root Hermes runtime can persist safe config/env changes while it is
  # running. Adopt one stable snapshot only after the secret boundary is valid.
  # Direct MCP drift becomes pending until the replacement gateway is healthy.
  refresh_hermes_runtime_config_hashes compat adopt || return 1
  inspect_hermes_mcp_integrity "${HERMES_DIR}/.config-hash" || return 1
  prepare_hermes_lazy_dependencies || return 1
  ensure_hermes_runtime_api_server_key compat || return 1
  validate_hermes_env_secret_boundary || return 1
  validate_hermes_runtime_env_secret_boundary || return 1
  refresh_hermes_provider_placeholders compat || return 1
  refresh_hermes_runtime_config_hashes compat || return 1
  inspect_hermes_mcp_integrity "${HERMES_DIR}/.config-hash" || return 1
  configure_messaging_channels || return 1
  prepare_tirith_marker_retry || return 1
}

prepare_hermes_root_runtime_dir() {
  local runtime_metadata
  if [ -L "$HERMES_RUNTIME_DIR" ]; then
    echo "[SECURITY] Refusing Hermes startup because $HERMES_RUNTIME_DIR is a symbolic link" >&2
    return 1
  fi
  if [ ! -e "$HERMES_RUNTIME_DIR" ]; then
    install -d -m 0755 -o root -g root -- "$HERMES_RUNTIME_DIR" || {
      echo "[SECURITY] Refusing Hermes startup because $HERMES_RUNTIME_DIR could not be created safely" >&2
      return 1
    }
  fi
  if [ ! -d "$HERMES_RUNTIME_DIR" ] || [ -L "$HERMES_RUNTIME_DIR" ]; then
    echo "[SECURITY] Refusing Hermes startup because $HERMES_RUNTIME_DIR is not a real directory" >&2
    return 1
  fi
  runtime_metadata="$(stat -c '%u:%g:%a' -- "$HERMES_RUNTIME_DIR" 2>/dev/null)" || {
    echo "[SECURITY] Refusing Hermes startup because $HERMES_RUNTIME_DIR metadata is unavailable" >&2
    return 1
  }
  if [ "$runtime_metadata" != "0:0:755" ]; then
    # The managed runtime can present this directory before the root-separated
    # gateway starts. Restore the trust boundary from root, and refuse when the
    # restore is not permitted.
    chown root:root -- "$HERMES_RUNTIME_DIR" 2>/dev/null
    chmod 0755 -- "$HERMES_RUNTIME_DIR" 2>/dev/null
    runtime_metadata="$(stat -c '%u:%g:%a' -- "$HERMES_RUNTIME_DIR" 2>/dev/null)" || runtime_metadata=""
  fi
  if [ "$runtime_metadata" != "0:0:755" ]; then
    echo "[SECURITY] Refusing Hermes startup because $HERMES_RUNTIME_DIR must be root-owned with mode 0755" >&2
    return 1
  fi
  return 0
}

prepare_hermes_gateway_lazy_install_target() {
  local target_metadata runtime_device target_device
  prepare_hermes_root_runtime_dir || return 1
  if [ -L "$HERMES_GATEWAY_LAZY_INSTALL_TARGET" ]; then
    echo "[SECURITY] Refusing Hermes startup because the gateway lazy-install target is a symbolic link" >&2
    return 1
  fi
  if [ ! -e "$HERMES_GATEWAY_LAZY_INSTALL_TARGET" ]; then
    install -d -o gateway -g gateway -m 0700 -- "$HERMES_GATEWAY_LAZY_INSTALL_TARGET" || {
      echo "[SECURITY] Refusing Hermes startup because the gateway lazy-install target could not be created safely" >&2
      return 1
    }
  fi
  if [ ! -d "$HERMES_GATEWAY_LAZY_INSTALL_TARGET" ] || [ -L "$HERMES_GATEWAY_LAZY_INSTALL_TARGET" ]; then
    echo "[SECURITY] Refusing Hermes startup because the gateway lazy-install target is not a real directory" >&2
    return 1
  fi
  runtime_device="$(stat -c '%d' -- "$HERMES_RUNTIME_DIR" 2>/dev/null)" || runtime_device=""
  target_device="$(stat -c '%d' -- "$HERMES_GATEWAY_LAZY_INSTALL_TARGET" 2>/dev/null)" || target_device=""
  if [ -z "$runtime_device" ] || [ "$target_device" != "$runtime_device" ]; then
    echo "[SECURITY] Refusing Hermes startup because the gateway lazy-install target is outside the managed runtime filesystem" >&2
    return 1
  fi
  chown gateway:gateway -- "$HERMES_GATEWAY_LAZY_INSTALL_TARGET" 2>/dev/null || true
  chmod 0700 -- "$HERMES_GATEWAY_LAZY_INSTALL_TARGET" 2>/dev/null || true
  target_metadata="$(stat -c '%U:%G:%a' -- "$HERMES_GATEWAY_LAZY_INSTALL_TARGET" 2>/dev/null)" || target_metadata=""
  if [ "$target_metadata" != "gateway:gateway:700" ]; then
    echo "[SECURITY] Refusing Hermes startup because the gateway lazy-install target must be gateway-owned with mode 0700" >&2
    return 1
  fi
  return 0
}

publish_hermes_root_runtime_marker() {
  local marker_name="$1"
  local marker_value="$2"
  local marker_path temporary_marker
  case "$marker_name" in
    '' | *[!A-Za-z0-9_-]*)
      echo "[SECURITY] Refusing Hermes startup because the runtime marker name is invalid" >&2
      return 1
      ;;
  esac
  prepare_hermes_root_runtime_dir || return 1
  marker_path="${HERMES_RUNTIME_DIR}/${marker_name}"
  temporary_marker="$(mktemp "${HERMES_RUNTIME_DIR}/.${marker_name}.XXXXXX")" || {
    echo "[SECURITY] Refusing Hermes startup because ${marker_path} could not be prepared" >&2
    return 1
  }
  if ! printf '%s\n' "$marker_value" >"$temporary_marker" \
    || ! chown root:root "$temporary_marker" \
    || ! chmod 0444 "$temporary_marker" \
    || ! mv -f -- "$temporary_marker" "$marker_path"; then
    rm -f -- "$temporary_marker"
    echo "[SECURITY] Refusing Hermes startup because ${marker_path} could not be published atomically" >&2
    return 1
  fi
}

prepare_hermes_root_runtime() {
  validate_hermes_env_secret_boundary || return 1
  validate_hermes_runtime_env_secret_boundary || return 1
  refresh_hermes_runtime_config_hashes both adopt || return 1
  inspect_hermes_mcp_integrity "$HERMES_HASH_FILE" || return 1
  prepare_hermes_lazy_dependencies || return 1
  ensure_hermes_config_root_mode || return 1
  ensure_hermes_runtime_api_server_key both || return 1
  validate_hermes_env_secret_boundary || return 1
  validate_hermes_runtime_env_secret_boundary || return 1
  refresh_hermes_provider_placeholders both || return 1
  configure_messaging_channels || return 1
  prepare_tirith_marker_retry || return 1
}

launch_hermes_gateway_current_user() {
  cleanup_stale_hermes_gateway_runtime || return 1
  HERMES_HOME="${HERMES_DIR}" \
    HOME=/sandbox \
    HERMES_LAZY_INSTALL_TARGET="${HERMES_SANDBOX_LAZY_INSTALL_TARGET}" \
    HERMES_BUNDLED_PLUGINS="${HERMES_MANAGED_BUNDLED_PLUGINS}" \
    nohup "$HERMES" gateway run >>/tmp/gateway.log 2>&1 &
  GATEWAY_PID=$!
  if ! hermes_capture_tracked_role gateway "$GATEWAY_PID" current "$INTERNAL_PORT"; then
    hermes_fatal_unproven_child gateway "$GATEWAY_PID"
  fi
  # shellcheck disable=SC2034  # read by cleanup_on_signal from sandbox-init.sh
  SANDBOX_WAIT_PID="$GATEWAY_PID"
  echo "[gateway] hermes gateway launched (pid $GATEWAY_PID)" >&2
}

HERMES_MANAGED_GATEWAY_EXIT_TIMES=()
HERMES_MANAGED_GATEWAY_EXIT_COUNT=0
readonly HERMES_MANAGED_EXPECTED_EXIT_DIR="/run/nemoclaw"
readonly HERMES_MANAGED_EXPECTED_EXIT_MARKER="managed-gateway-expected-exit"
readonly HERMES_MANAGED_CONTROLLER_PATH="/usr/local/lib/nemoclaw/managed-gateway-control.py"

quarantine_hermes_managed_gateway_relaunch() {
  while :; do
    sleep 60 || true
  done
}

hermes_managed_controller_argv_is_expected() {
  [ "$#" -eq 5 ] || return 1
  case "${1##*/}" in
    python3) ;;
    *) return 1 ;;
  esac
  [ "$2" = "-I" ] && [ "$3" = "$HERMES_MANAGED_CONTROLLER_PATH" ] || return 1
  case "$4" in
    restart | recover) ;;
    *) return 1 ;;
  esac
  case "$5" in
    '' | *[!0-9a-f]*) return 1 ;;
  esac
  [ "${#5}" -eq 64 ]
}

hermes_managed_controller_is_live() {
  local pid="$1"
  local expected_start_identity="$2"
  local proc_root="${_HERMES_PROC_ROOT:-/proc}"
  local first_start second_start first_state second_state first_uids second_uids
  local -a first_argv=()
  local -a second_argv=()

  case "$pid" in
    '' | 0 | 1 | *[!0-9]*) return 1 ;;
  esac
  case "$expected_start_identity" in
    '' | *[!0-9]*) return 1 ;;
  esac
  [ -r "${proc_root}/${pid}/status" ] \
    && [ -r "${proc_root}/${pid}/cmdline" ] || return 1

  first_start="$(gateway_control_pid_start_identity "$pid")" || return 1
  first_state="$(gateway_control_pid_state "$pid")" || return 1
  first_uids="$(awk '/^Uid:/ { print $2 ":" $3 ":" $4 ":" $5; exit }' "${proc_root}/${pid}/status")" || return 1
  while IFS= read -r -d "" elem; do first_argv+=("$elem"); done <"${proc_root}/${pid}/cmdline" || return 1
  hermes_managed_controller_argv_is_expected "${first_argv[@]}" || return 1

  second_start="$(gateway_control_pid_start_identity "$pid")" || return 1
  second_state="$(gateway_control_pid_state "$pid")" || return 1
  second_uids="$(awk '/^Uid:/ { print $2 ":" $3 ":" $4 ":" $5; exit }' "${proc_root}/${pid}/status")" || return 1
  while IFS= read -r -d "" elem; do second_argv+=("$elem"); done <"${proc_root}/${pid}/cmdline" || return 1
  hermes_managed_controller_argv_is_expected "${second_argv[@]}" || return 1

  [ "$first_start" = "$expected_start_identity" ] \
    && [ "$second_start" = "$expected_start_identity" ] \
    && [ "$first_uids" = "0:0:0:0" ] \
    && [ "$second_uids" = "0:0:0:0" ] \
    && [ "$first_state" != "Z" ] \
    && [ "$second_state" != "Z" ] \
    && [ "${first_argv[*]}" = "${second_argv[*]}" ]
}

hermes_managed_gateway_exit_was_host_authorized() {
  local pid="$1"
  local start_identity="$2"
  local marker dir_metadata marker_metadata
  local version marker_pid marker_start_identity controller_pid controller_start_identity extra
  local trailing=""

  case "$pid" in
    '' | 0 | 1 | *[!0-9]*) return 1 ;;
  esac
  case "$start_identity" in
    '' | *[!0-9]*) return 1 ;;
  esac

  [ -d "$HERMES_MANAGED_EXPECTED_EXIT_DIR" ] \
    && [ ! -L "$HERMES_MANAGED_EXPECTED_EXIT_DIR" ] || return 1
  dir_metadata="$(stat -c '%u:%g %a' "$HERMES_MANAGED_EXPECTED_EXIT_DIR" 2>/dev/null || true)"
  [ "$dir_metadata" = "0:0 711" ] || return 1

  marker="${HERMES_MANAGED_EXPECTED_EXIT_DIR}/${HERMES_MANAGED_EXPECTED_EXIT_MARKER}"
  [ -f "$marker" ] && [ ! -L "$marker" ] || return 1
  marker_metadata="$(stat -c '%u:%g %a %h' "$marker" 2>/dev/null || true)"
  [ "$marker_metadata" = "0:0 444 1" ] || return 1

  # bash 4.1+ named FDs ({var}<file) are not available on bash 3.2 (macOS).
  # Use a grouped redirect instead — variables assigned inside {} remain in scope.
  {
    if ! IFS=' ' read -r \
      version marker_pid marker_start_identity controller_pid controller_start_identity extra; then
      return 1
    fi
    if IFS= read -r trailing || [ -n "$trailing" ]; then
      return 1
    fi
  } <"$marker" || return 1

  [ "$version" = "v1" ] \
    && [ "$marker_pid" = "$pid" ] \
    && [ "$marker_start_identity" = "$start_identity" ] \
    && [ -z "${extra:-}" ] || return 1
  case "$controller_pid" in
    '' | 0 | 1 | *[!0-9]*) return 1 ;;
  esac
  case "$controller_start_identity" in
    '' | *[!0-9]*) return 1 ;;
  esac
  hermes_managed_controller_is_live "$controller_pid" "$controller_start_identity"
}

record_hermes_managed_gateway_exit() {
  local now timestamp
  local -a retained=()

  now="$(date +%s)"
  HERMES_MANAGED_GATEWAY_EXIT_TIMES+=("$now")
  for timestamp in "${HERMES_MANAGED_GATEWAY_EXIT_TIMES[@]+"${HERMES_MANAGED_GATEWAY_EXIT_TIMES[@]}"}"; do
    [ $((now - timestamp)) -le 60 ] && retained+=("$timestamp")
  done
  HERMES_MANAGED_GATEWAY_EXIT_TIMES=("${retained[@]+"${retained[@]}"}")
  HERMES_MANAGED_GATEWAY_EXIT_COUNT=${#HERMES_MANAGED_GATEWAY_EXIT_TIMES[@]}
  if [ "$HERMES_MANAGED_GATEWAY_EXIT_COUNT" -ge 5 ]; then
    echo "[gateway] CRITICAL: $HERMES_MANAGED_GATEWAY_EXIT_COUNT exits in 60s window — Hermes relaunch is stopped for this supervisor instance; correct the reported failure, then stop and start the sandbox; check /tmp/gateway.log" >&2
    quarantine_hermes_managed_gateway_relaunch
    return 1
  fi
}

recover_hermes_gateway_current_user() {
  local replacement_reached_internal_health preparation_failures=0 preparation_failure_limit=5

  while :; do
    replacement_reached_internal_health=0
    until prepare_hermes_nonroot_runtime; do
      preparation_failures=$((preparation_failures + 1))
      if [ "$preparation_failures" -ge "$preparation_failure_limit" ]; then
        echo "[gateway] Hermes runtime preparation failed after ${preparation_failures} consecutive attempts; supervisor exiting without launching a gateway; correct the reported failure, then stop and start the sandbox" >&2
        return 1
      fi
      echo "[gateway] Hermes runtime preparation refused automatic respawn; retrying in 5s" >&2
      sleep 5 || true
    done
    preparation_failures=0
    if ! launch_hermes_gateway_current_user; then
      echo "[gateway] Hermes gateway launch failed; retrying under the same supervisor" >&2
      sleep 5 || true
      continue
    fi
    if wait_for_hermes_gateway_internal "$GATEWAY_PID"; then
      replacement_reached_internal_health=1
      # The gateway and its socat relay are separate supervised children. A
      # transient relay repair failure must not churn an internally healthy,
      # identity-pinned replacement or charge that churn against the gateway
      # crash budget. Retry only while the exact gateway remains healthy, and
      # re-prove it after auxiliary repair before committing applied MCP state.
      while hermes_tracked_role_is_current \
        gateway "$GATEWAY_PID" current "$INTERNAL_PORT" \
        && hermes_gateway_healthy "$GATEWAY_PID"; do
        if ensure_hermes_supervised_auxiliaries; then
          if ! hermes_tracked_role_is_current \
            gateway "$GATEWAY_PID" current "$INTERNAL_PORT" \
            || ! hermes_gateway_healthy "$GATEWAY_PID"; then
            break
          fi
          finalize_tirith_marker_retry
          if ! commit_hermes_mcp_applied_if_pending; then
            echo "[SECURITY] HERMES_MCP_APPLIED_COMMIT_FAILED: stopping the uncommitted Hermes gateway" >&2
            hermes_stop_tracked_role gateway "$GATEWAY_PID" current "$INTERNAL_PORT" || return 1
            mark_hermes_gateway_stopped
            return 1
          fi
          refresh_hermes_supervised_child_pids
          return 0
        fi
        echo "[gateway] Hermes auxiliary repair failed; retrying while the exact gateway remains healthy" >&2
        sleep 1 || true
      done
    fi

    if [ "$replacement_reached_internal_health" -eq 1 ]; then
      echo "[gateway] Hermes replacement gateway lost its listener or health endpoint during auxiliary validation; stopping the exact child" >&2
    else
      echo "[gateway] Hermes replacement gateway failed listener or health validation; stopping the exact child" >&2
    fi
    if ! hermes_stop_tracked_role \
      gateway "$GATEWAY_PID" current "$INTERNAL_PORT"; then
      echo "[gateway] CRITICAL: exact Hermes replacement could not be stopped; managed supervisor is quarantined without another launch" >&2
      quarantine_hermes_managed_gateway_relaunch
      return 1
    fi
    mark_hermes_gateway_stopped
    record_hermes_managed_gateway_exit || return 1
    sleep 2 || true
  done
}

supervise_hermes_gateway_current_user() {
  local exited_gateway_pid exited_gateway_start_identity rc respawn_count unhealthy_streak=0

  while :; do
    # Keep one exact supervisor alive for the full managed OpenShell process
    # tree and continuously repair its dashboard and internal relays.
    while hermes_tracked_role_is_current gateway "$GATEWAY_PID" current "$INTERNAL_PORT"; do
      if hermes_gateway_healthy "$GATEWAY_PID"; then
        unhealthy_streak=0
        if ! ensure_hermes_supervised_auxiliaries; then
          echo "[gateway] Hermes auxiliary repair failed; retrying while the exact gateway remains supervised" >&2
        fi
      else
        unhealthy_streak=$((unhealthy_streak + 1))
        echo "[gateway] Hermes gateway failed health validation ($unhealthy_streak/4)" >&2
        if [ "$unhealthy_streak" -ge 4 ]; then
          echo "[gateway] CRITICAL: Hermes gateway lost its listener or health endpoint; stopping the exact child for recovery" >&2
          if ! hermes_stop_tracked_role \
            gateway "$GATEWAY_PID" current "$INTERNAL_PORT"; then
            echo "[gateway] CRITICAL: unhealthy Hermes gateway could not be stopped; managed supervisor is quarantined without another launch" >&2
            quarantine_hermes_managed_gateway_relaunch
            return 1
          fi
          break
        fi
      fi
      refresh_hermes_supervised_child_pids
      sleep 1 || true
    done

    exited_gateway_pid="$GATEWAY_PID"
    exited_gateway_start_identity="${GATEWAY_PID_START_IDENTITY:-}"
    rc=0
    wait "$GATEWAY_PID" 2>/dev/null || rc=$?
    mark_hermes_gateway_stopped

    if hermes_managed_gateway_exit_was_host_authorized \
      "$exited_gateway_pid" "$exited_gateway_start_identity"; then
      echo "[gateway] Hermes gateway pid $exited_gateway_pid exited (rc=$rc; authenticated host authorization); respawning without charging crash quarantine in 2s" >&2
    else
      record_hermes_managed_gateway_exit || return 1
      respawn_count="$HERMES_MANAGED_GATEWAY_EXIT_COUNT"
      echo "[gateway] Hermes gateway pid $exited_gateway_pid exited (rc=$rc); respawning (#$respawn_count in 60s window) in 2s" >&2
    fi
    sleep 2 || true

    recover_hermes_gateway_current_user || return 1
    unhealthy_streak=0
    echo "[gateway] Hermes gateway respawned (pid $GATEWAY_PID)" >&2
  done
}

bootstrap_hermes_gateway_current_user() {
  launch_hermes_gateway_current_user || return 1
  start_gateway_log_stream
  refresh_hermes_supervised_child_pids
  trap hermes_cleanup_on_signal SIGTERM SIGINT

  if wait_for_hermes_gateway_internal "$GATEWAY_PID" \
    && ensure_hermes_supervised_auxiliaries; then
    finalize_tirith_marker_retry
    if ! commit_hermes_mcp_applied_if_pending; then
      echo "[SECURITY] HERMES_MCP_APPLIED_COMMIT_FAILED: stopping the uncommitted Hermes gateway" >&2
      hermes_stop_tracked_role gateway "$GATEWAY_PID" current "$INTERNAL_PORT" || return 1
      mark_hermes_gateway_stopped
      return 1
    fi
    refresh_hermes_supervised_child_pids
    return 0
  fi

  echo "[gateway] Initial Hermes gateway failed health or auxiliary validation; stopping the exact child for supervised recovery" >&2
  if ! hermes_stop_tracked_role \
    gateway "$GATEWAY_PID" current "$INTERNAL_PORT"; then
    echo "[gateway] CRITICAL: initial Hermes gateway could not be stopped; managed supervisor is quarantined without another launch" >&2
    quarantine_hermes_managed_gateway_relaunch
    return 1
  fi
  mark_hermes_gateway_stopped
  record_hermes_managed_gateway_exit || return 1
  sleep 2 || true
  recover_hermes_gateway_current_user || return 1
  refresh_hermes_supervised_child_pids
}
