# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
# shellcheck shell=bash

openclaw_load_pid_identity() {
  local pid="$1"
  local proc_root="${_NEMOCLAW_PROC_ROOT:-/proc}"
  local stat_line rest parent_pid start_identity started

  OPENCLAW_OBSERVED_PARENT_PID=""
  OPENCLAW_OBSERVED_START_IDENTITY=""
  case "$pid" in
    '' | 0 | 1 | *[!0-9]*) return 1 ;;
  esac

  if [ -r "${proc_root}/${pid}/stat" ]; then
    IFS= read -r stat_line <"${proc_root}/${pid}/stat" || return 1
    rest="${stat_line##*) }"
    [ "$rest" != "$stat_line" ] || return 1
    # After `pid (comm)` is removed, state is $1, ppid is $2, and Linux
    # starttime (the original field 22) is $20.  `##*) ` deliberately uses
    # the final closing parenthesis because comm itself may contain `)`.
    # shellcheck disable=SC2086  # intentional field split of proc stat suffix
    set -- $rest
    [ "$#" -ge 20 ] || return 1
    parent_pid="$2"
    start_identity="${20}"
    case "$parent_pid" in
      '' | *[!0-9]*) return 1 ;;
    esac
    case "$start_identity" in
      '' | *[!0-9]*) return 1 ;;
    esac
  else
    # An explicitly supplied proc root is a fail-closed test seam: never fall
    # through to host `ps`, which would inspect a different process namespace.
    [ "${_NEMOCLAW_PROC_ROOT+x}" != x ] || return 1
    command -v ps >/dev/null 2>&1 || return 1
    parent_pid="$(ps -o ppid= -p "$pid" 2>/dev/null | awk 'NR == 1 { gsub(/[[:space:]]/, "", $0); print; exit }')"
    started="$(LC_ALL=C ps -o lstart= -p "$pid" 2>/dev/null | awk 'NR == 1 { sub(/^[[:space:]]+/, ""); sub(/[[:space:]]+$/, ""); print; exit }')"
    case "$parent_pid" in
      '' | *[!0-9]*) return 1 ;;
    esac
    [ -n "$started" ] || return 1
    start_identity="ps:${started//[[:space:]]/_}"
  fi

  OPENCLAW_OBSERVED_PARENT_PID="$parent_pid"
  OPENCLAW_OBSERVED_START_IDENTITY="$start_identity"
}

openclaw_pid_start_identity() {
  openclaw_load_pid_identity "$1" || return 1
  printf '%s\n' "$OPENCLAW_OBSERVED_START_IDENTITY"
}

capture_openclaw_pid_start_identity() {
  local pid="$1"
  local output_var="$2"
  local identity
  identity="$(openclaw_pid_start_identity "$pid")" || return 1
  [ -n "$identity" ] || return 1
  printf -v "$output_var" '%s' "$identity"
}

openclaw_supervised_pid_is_live() {
  local pid="$1"
  local expected_identity="$2"
  [ -n "$expected_identity" ] || return 1
  gateway_control_pid_is_live "$pid" || return 1
  openclaw_load_pid_identity "$pid" || return 1
  [ "$OPENCLAW_OBSERVED_PARENT_PID" = "$$" ] \
    && [ "$OPENCLAW_OBSERVED_START_IDENTITY" = "$expected_identity" ]
}

# Watchdog for the in-container gateway HTTP listener (#4710). OpenClaw can
# leave its gateway process alive after the listener stops serving, while the
# respawn loop can observe only process exit. After one serving response, this
# watchdog terminates the tracked gateway after a bounded run of not-serving
# probes so the existing supervisor can relaunch it. Before the first serving
# response, it preserves the process through the longer boot grace window.
#
# A serving probe requires `/health` to return 200 or 401. Refused, timed-out,
# reset, empty, and HTTP-error responses count as not serving. A missing or
# broken probe is inconclusive and can never trigger a kill. PID identity checks
# bind every signal to the gateway process that the supervisor actually started.
#
# Source boundary: OpenClaw owns the in-process reload path that can leave this
# state behind. Remove this watchdog when a gateway that cannot serve exits on
# its own, because the existing respawn loop will then observe the failure.
gateway_watchdog_curl_reason() {
  case "$1" in
    7) printf 'connection refused' ;;
    28) printf 'probe timeout' ;;
    52) printf 'empty reply from gateway' ;;
    55) printf 'send error' ;;
    56) printf 'connection reset' ;;
    *) printf 'curl exit %s' "$1" ;;
  esac
}

# Classify one health probe of the local gateway port.
#   0: serving: /health answered 200 or 401
#   1: not serving: refused, timed out, reset, or answered an HTTP error
#   2: inconclusive: the probe itself could not run; change no watchdog state
# GATEWAY_WATCHDOG_PROBE_REASON carries the cause for the two failure returns.
gateway_watchdog_probe_gateway() {
  local port="$1"
  local rc=0 code
  GATEWAY_WATCHDOG_PROBE_REASON=""
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 \
    "http://127.0.0.1:${port}/health" 2>/dev/null)" || rc=$?
  if [ "$rc" -ne 0 ]; then
    GATEWAY_WATCHDOG_PROBE_REASON="$(gateway_watchdog_curl_reason "$rc")"
    # Only transport outcomes prove the gateway is not serving. Anything else
    # (curl absent, bad invocation, an unexpected local failure) is a broken
    # probe, not a broken gateway, and must never escalate to a kill.
    case "$rc" in
      7 | 28 | 52 | 55 | 56) return 1 ;;
      *) return 2 ;;
    esac
  fi
  case "$code" in
    200 | 401) return 0 ;;
  esac
  GATEWAY_WATCHDOG_PROBE_REASON="HTTP ${code:-000}"
  return 1
}

# PID-reuse / tamper defense: only kill a process whose cmdline still looks
# like the OpenClaw gateway. Match the PID 1 launch argv
# ("... openclaw gateway run --port N") and the rewritten process titles
# ("openclaw-gateway", bare "openclaw").
gateway_pid_is_openclaw_gateway() {
  # _NEMOCLAW_PROC_ROOT is a test seam (unit tests also run on macOS, which
  # has no /proc). Production always uses /proc: the watchdog inherits PID 1's
  # environment, which the sandbox user cannot influence.
  local cmdline
  cmdline="$(tr '\0' ' ' <"${_NEMOCLAW_PROC_ROOT:-/proc}/$1/cmdline" 2>/dev/null)" || return 1
  cmdline="${cmdline%"${cmdline##*[![:space:]]}"}"
  [ -n "$cmdline" ] || return 1
  printf '%s' "$cmdline" | grep -qE 'openclaw([ -]gateway| gateway run|$)'
}

# Positive integer guard used by the gateway watchdog environment variable
# validation. Extracted so a regression test can exercise the regex against
# trailing non-digit and zero or invalid inputs without starting the watcher.
gateway_watchdog_positive_int_ok() {
  # Bound the length as well as the shape. A longer decimal still looks like a
  # positive integer but overflows Bash arithmetic to a negative value, and a
  # negative threshold makes every "count is below the threshold" test false,
  # so the watchdog would kill the gateway on its first not-serving probe.
  # Nine digits is far above any useful interval or probe count.
  [[ "$1" =~ ^[1-9][0-9]{0,8}$ ]]
}

# Validate that this PID is still the tracked gateway process, regardless of
# its current parent. The Docker HEALTHCHECK uses the same evidence.
# The kernel's start time from /proc/<pid>/stat pins the identity against PID reuse, and the
# cmdline check keeps an unrelated process from matching. It deliberately omits
# the parent-process test in openclaw_supervised_pid_is_live, because being
# reparented does not change which process this is; it only changes who can
# relaunch it. The watchdog uses this to report an orphaned gateway rather than
# failing the liveness test and going silent (#7377).
gateway_watchdog_pid_is_tracked_gateway() {
  local pid="$1"
  local expected_identity="$2"
  [ -n "$expected_identity" ] || return 1
  gateway_control_pid_is_live "$pid" || return 1
  openclaw_load_pid_identity "$pid" || return 1
  [ "$OPENCLAW_OBSERVED_START_IDENTITY" = "$expected_identity" ] || return 1
  gateway_pid_is_openclaw_gateway "$pid"
}

start_gateway_serving_watchdog() {
  (
    local interval not_serving_threshold armed=0 not_serving_count=0
    local pid start_identity extra tracked_identity last_identity="" msg
    local probe_rc inconclusive_logged=0 unsupervised_logged=0
    local boot_grace_probes effective_threshold since
    interval="${NEMOCLAW_GATEWAY_WATCHDOG_INTERVAL_SECONDS:-30}"
    # Environment variable name kept from #4710 for compatibility; it now
    # sets the number of not-serving probes since the last serving response
    # that triggers recovery.
    not_serving_threshold="${NEMOCLAW_GATEWAY_WATCHDOG_REFUSED_THRESHOLD:-4}"
    # Recovery bound for a gateway that has never served on this port. It is
    # deliberately much larger than the post-serving threshold: the watchdog
    # cannot tell a still-booting gateway from one that came up broken, so it
    # waits out the slowest plausible boot before acting. At the default
    # interval this is 10 minutes, well past the 90-second startup readiness
    # wait and the Docker HEALTHCHECK start period.
    boot_grace_probes="${NEMOCLAW_GATEWAY_WATCHDOG_BOOT_GRACE_PROBES:-20}"
    # All three environment values must be positive integers. A zero or invalid
    # interval would busy-loop the probe, and a zero threshold would kill on
    # the first refusal. Fall back to the defaults for invalid input.
    # gateway_watchdog_positive_int_ok uses regex (=~), not glob, so trailing
    # non-digit input like "12x" or "30abc" is rejected, not coerced.
    if ! gateway_watchdog_positive_int_ok "$interval"; then
      echo "[gateway-watchdog] invalid NEMOCLAW_GATEWAY_WATCHDOG_INTERVAL_SECONDS='${interval}'; defaulting to 30" >&2
      interval=30
    fi
    if ! gateway_watchdog_positive_int_ok "$not_serving_threshold"; then
      echo "[gateway-watchdog] invalid NEMOCLAW_GATEWAY_WATCHDOG_REFUSED_THRESHOLD='${not_serving_threshold}'; defaulting to 4" >&2
      not_serving_threshold=4
    fi
    if ! gateway_watchdog_positive_int_ok "$boot_grace_probes"; then
      echo "[gateway-watchdog] invalid NEMOCLAW_GATEWAY_WATCHDOG_BOOT_GRACE_PROBES='${boot_grace_probes}'; defaulting to 20" >&2
      boot_grace_probes=20
    fi
    [ -n "${_DASHBOARD_PORT:-}" ] || exit 0
    if ! command -v curl >/dev/null 2>&1; then
      echo "[gateway-watchdog] curl is unavailable; serving watchdog disabled (#7377)" >&2
      exit 0
    fi
    while :; do
      sleep "$interval"
      pid=""
      start_identity=""
      extra=""
      IFS=' ' read -r pid start_identity extra <"$GATEWAY_PID_FILE" 2>/dev/null || true
      case "$pid" in
        '' | *[!0-9]*)
          last_identity=""
          armed=0
          not_serving_count=0
          continue
          ;;
      esac
      case "$start_identity" in
        '' | *[!0-9]*)
          last_identity=""
          armed=0
          not_serving_count=0
          continue
          ;;
      esac
      if [ -n "$extra" ]; then
        last_identity=""
        armed=0
        not_serving_count=0
        continue
      fi
      tracked_identity="${pid}:${start_identity}"
      # A respawned gateway must earn its own armed state. It must not inherit
      # the previous process identity's serving history, even if the kernel
      # has already recycled the same numeric PID for the replacement.
      if [ "$tracked_identity" != "$last_identity" ]; then
        last_identity="$tracked_identity"
        armed=0
        not_serving_count=0
      fi
      if ! openclaw_supervised_pid_is_live "$pid" "$start_identity"; then
        # Process exit is the respawn loop's signal, not ours. A tracked
        # gateway that is still alive and still matches its recorded identity
        # is a different case: this shell is no longer its parent, so the
        # respawn loop that recovery depends on is gone. Say so once. Staying
        # silent there is what left #7377 with an unrecoverable gateway and no
        # explanation in the container log.
        if [ "$unsupervised_logged" -eq 0 ] \
          && gateway_watchdog_pid_is_tracked_gateway "$pid" "$start_identity"; then
          echo "[gateway-watchdog] CRITICAL: gateway pid $pid is alive and still matches its recorded identity, but this supervisor is no longer its parent (ppid ${OPENCLAW_OBSERVED_PARENT_PID:-unknown}, expected $$); the respawn loop cannot relaunch it, so the watchdog is standing down (#7377)" >&2
          unsupervised_logged=1
        fi
        last_identity=""
        armed=0
        not_serving_count=0
        continue
      fi
      unsupervised_logged=0
      probe_rc=0
      gateway_watchdog_probe_gateway "$_DASHBOARD_PORT" || probe_rc=$?
      if [ "$probe_rc" -eq 2 ]; then
        # A probe that could not run tells us nothing about the gateway.
        # Preserve the current armed state and not-serving count. Log once
        # until a conclusive probe so silence is not mistaken for a serving
        # gateway.
        if [ "$inconclusive_logged" -eq 0 ]; then
          echo "[gateway-watchdog] health probe inconclusive (${GATEWAY_WATCHDOG_PROBE_REASON}); leaving gateway pid $pid untouched (#7377)" >&2
          inconclusive_logged=1
        fi
        continue
      fi
      inconclusive_logged=0
      if [ "$probe_rc" -eq 0 ]; then
        armed=1
        not_serving_count=0
        continue
      fi
      not_serving_count=$((not_serving_count + 1))
      if [ "$armed" -eq 1 ]; then
        effective_threshold="$not_serving_threshold"
        since="since the last serving response"
      else
        # The gateway has never answered on this port. Before #7377 the
        # watchdog simply never acted here, so a sandbox whose gateway came up
        # already unable to serve stayed wedged forever with nothing logged.
        # A slow boot still must not be killed, so an unproven gateway gets a
        # much longer grace window than one that served and then stopped.
        effective_threshold="$boot_grace_probes"
        since="since launch, having never served"
      fi
      if [ "$not_serving_count" -lt "$effective_threshold" ]; then
        echo "[gateway-watchdog] gateway pid $pid alive but not serving port ${_DASHBOARD_PORT}: ${GATEWAY_WATCHDOG_PROBE_REASON} ($not_serving_count/$effective_threshold $since) (#7377)" >&2
        continue
      fi
      if ! gateway_pid_is_openclaw_gateway "$pid"; then
        echo "[gateway-watchdog] pid $pid no longer looks like the openclaw gateway; not killing (#4710)" >&2
        armed=0
        not_serving_count=0
        continue
      fi
      if ! openclaw_supervised_pid_is_live "$pid" "$start_identity"; then
        echo "[gateway-watchdog] pid $pid start identity changed; not killing (#4710)" >&2
        last_identity=""
        armed=0
        not_serving_count=0
        continue
      fi
      msg="[gateway-watchdog] CRITICAL: gateway pid $pid is alive but not serving port ${_DASHBOARD_PORT}: ${GATEWAY_WATCHDOG_PROBE_REASON} ($not_serving_count not-serving probes $since); killing it so the respawn loop can relaunch (#7377)"
      echo "$msg" >&2
      append_openclaw_gateway_log_line "$msg" || true
      record_gateway_watchdog_kill "$tracked_identity"
      kill -TERM "$pid" 2>/dev/null || true
      for _ in 1 2 3 4 5 6 7 8 9 10; do
        openclaw_supervised_pid_is_live "$pid" "$start_identity" || break
        sleep 1
      done
      if openclaw_supervised_pid_is_live "$pid" "$start_identity"; then
        kill -KILL "$pid" 2>/dev/null || true
      fi
      armed=0
      not_serving_count=0
    done
  ) &
  GATEWAY_WATCHDOG_PID=$!
  if ! capture_openclaw_pid_start_identity "$GATEWAY_WATCHDOG_PID" GATEWAY_WATCHDOG_PID_START_IDENTITY; then
    echo "[gateway-watchdog] could not capture watchdog process identity" >&2
    return 1
  fi
}

openclaw_gateway_pid_owns_listener() {
  local pid="$1"
  local port="$2"
  if [ "$(id -u)" -ne 0 ]; then
    gateway_control_pid_owns_tcp_listener "$pid" "$port"
    return $?
  fi
  # shellcheck disable=SC2016  # positional args expand in the inner bash
  "${STEP_DOWN_PREFIX_GATEWAY[@]}" env -u BASH_ENV \
    bash --noprofile --norc -c \
    'source "$1"; gateway_control_pid_owns_tcp_listener "$2" "$3"' \
    bash "$_GATEWAY_SUPERVISOR" "$pid" "$port"
}

openclaw_gateway_healthy() {
  local pid="$1"
  local expected_identity="$2"
  local code
  openclaw_supervised_pid_is_live "$pid" "$expected_identity" || return 1
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "http://127.0.0.1:${_DASHBOARD_PORT}/health" 2>/dev/null || true)"
  case "$code" in
    200 | 401)
      openclaw_supervised_pid_is_live "$pid" "$expected_identity" \
        && openclaw_gateway_pid_owns_listener "$pid" "$_DASHBOARD_PORT" \
        && openclaw_supervised_pid_is_live "$pid" "$expected_identity"
      ;;
    *) return 1 ;;
  esac
}

wait_for_openclaw_gateway_internal() {
  local pid="$1"
  local expected_identity="$2"
  local deadline=$((SECONDS + 90))
  while [ "$SECONDS" -lt "$deadline" ]; do
    openclaw_supervised_pid_is_live "$pid" "$expected_identity" || return 1
    openclaw_gateway_healthy "$pid" "$expected_identity" && return 0
    sleep 1
  done
  return 1
}

arm_openclaw_gateway_supervisor_cleanup() {
  # Bash does not run an EXIT trap when an untrapped SIGTERM/SIGINT terminates
  # the shell, so both traps must be live before the marker is written.
  trap cleanup_openclaw_on_signal SIGTERM SIGINT
  trap clear_in_container_gateway_marker EXIT
}

launch_openclaw_gateway_process() {
  local log_mode="$1"
  local launch_identity="$2"
  local -a gateway_launch_prefix=()
  shift 2
  case "$launch_identity" in
    current) ;;
    gateway)
      gateway_launch_prefix=(
        "${STEP_DOWN_PREFIX_GATEWAY[@]}" env HOME=/sandbox sh -c
        'umask 0007; exec "$@"' sh
      )
      ;;
    *)
      echo "[gateway] invalid gateway launch identity: $launch_identity" >&2
      return 1
      ;;
  esac
  case "$log_mode" in
    append) ;;
    truncate)
      # Replace the predictable log path immediately before the initial launch.
      # The descriptor-safe launcher below then pins that exact regular file.
      if [ "$launch_identity" = gateway ] && [ "$(id -u)" -eq 0 ]; then
        _nemoclaw_safe_create_tmp_file /tmp/gateway.log 644 gateway:gateway || return 1
      else
        _nemoclaw_safe_create_tmp_file /tmp/gateway.log 644 || return 1
      fi
      ;;
    *)
      echo "[gateway] invalid gateway log mode: $log_mode" >&2
      return 1
      ;;
  esac

  nohup /usr/bin/env -u OPENCLAW_GATEWAY_TOKEN \
    "${gateway_launch_prefix[@]+"${gateway_launch_prefix[@]}"}" \
    python3 -I - "$log_mode" "$@" <<'PYGATEWAYLAUNCH' &
import os
import stat
import sys

log_path = "/tmp/gateway.log"
log_mode = sys.argv[1]
argv = sys.argv[2:]
if not argv:
    print("[gateway] refusing empty gateway launch command", file=sys.stderr)
    raise SystemExit(1)
if not hasattr(os, "O_NOFOLLOW"):
    print("[SECURITY] refusing gateway launch because O_NOFOLLOW is unavailable", file=sys.stderr)
    raise SystemExit(1)

try:
    before = os.lstat(log_path)
except OSError as exc:
    print(f"[SECURITY] refusing unavailable gateway log path: {log_path}: {exc}", file=sys.stderr)
    raise SystemExit(1)
if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1:
    print(f"[SECURITY] refusing unsafe gateway log path: {log_path}", file=sys.stderr)
    raise SystemExit(1)

flags = os.O_WRONLY | os.O_NOFOLLOW
for optional_flag in ("O_CLOEXEC", "O_NONBLOCK"):
    flags |= getattr(os, optional_flag, 0)
if log_mode == "append":
    flags |= os.O_APPEND
elif log_mode != "truncate":
    print(f"[gateway] invalid gateway log mode: {log_mode}", file=sys.stderr)
    raise SystemExit(1)

try:
    descriptor = os.open(log_path, flags)
except OSError as exc:
    print(f"[SECURITY] refusing unsafe gateway log path: {log_path}: {exc}", file=sys.stderr)
    raise SystemExit(1)
try:
    opened = os.fstat(descriptor)
    if (
        not stat.S_ISREG(opened.st_mode)
        or opened.st_nlink != 1
        or (opened.st_dev, opened.st_ino) != (before.st_dev, before.st_ino)
    ):
        print(f"[SECURITY] refusing replaced gateway log path: {log_path}", file=sys.stderr)
        raise SystemExit(1)
    if log_mode == "truncate":
        os.ftruncate(descriptor, 0)
    os.dup2(descriptor, 1)
    os.dup2(descriptor, 2)
finally:
    if descriptor > 2:
        os.close(descriptor)

environment = os.environ.copy()
environment.pop("OPENCLAW_GATEWAY_TOKEN", None)
os.execvpe(argv[0], argv, environment)
PYGATEWAYLAUNCH
  GATEWAY_PID=$!
}

launch_openclaw_gateway() {
  # Drop the gateway marker whenever this supervisor exits -- clean gateway
  # exit (`exit 0` below), a forwarded signal (cleanup_openclaw_on_signal ends
  # in `cleanup_on_signal` -> `exit`), or errexit. This is the #4952 fix: on
  # docker-driver sandboxes this script is not PID 1, so it can exit while the
  # container lives on; a surviving marker would leave the HEALTHCHECK trusting
  # a stale pidfile. Arm this before marking so early launch failures cannot
  # leave the marker behind. The marker is re-dropped at each launch
  # (mark_in_container_gateway), so the respawn loop -- which never exits the
  # script -- keeps it in place.
  arm_openclaw_gateway_supervisor_cleanup
  mark_in_container_gateway
  launch_openclaw_gateway_process truncate gateway \
    "$OPENCLAW" gateway run --port "${_DASHBOARD_PORT}" || return 1
  if ! capture_openclaw_pid_start_identity "$GATEWAY_PID" GATEWAY_PID_START_IDENTITY; then
    # An uncaptured numeric PID is never safe to signal: Bash may already have
    # reaped the short-lived child and the kernel may have reused its PID. Fail
    # PID 1 so the container/runtime tears down any surviving untracked child.
    GATEWAY_PID=0
    GATEWAY_PID_START_IDENTITY=""
    clear_gateway_pid_record
    echo "[gateway] could not capture gateway process identity" >&2
    exit 1
  fi
  record_gateway_pid "$GATEWAY_PID" "$GATEWAY_PID_START_IDENTITY"
  # shellcheck disable=SC2034  # read by cleanup_on_signal from sandbox-init.sh
  SANDBOX_WAIT_PID="$GATEWAY_PID"
  echo "[gateway] openclaw gateway launched as 'gateway' user (pid $GATEWAY_PID)" >&2
}

launch_openclaw_gateway_non_root() {
  arm_openclaw_gateway_supervisor_cleanup
  mark_in_container_gateway
  launch_openclaw_gateway_process truncate current \
    "$OPENCLAW" gateway run --port "${_DASHBOARD_PORT}" || return 1
  capture_openclaw_pid_start_identity "$GATEWAY_PID" GATEWAY_PID_START_IDENTITY || exit 1
  record_gateway_pid "$GATEWAY_PID" "$GATEWAY_PID_START_IDENTITY"
  _nemoclaw_capture_epoch_realtime _NEMOCLAW_GATEWAY_SPAWN_FINISHED_EPOCH
  record_portable_openclaw_gateway_startup_timing
  echo "[gateway] openclaw gateway launched (pid $GATEWAY_PID)" >&2
}

openclaw_supervised_aux_pid_is_live() {
  local pid="$1"
  local expected_identity="$2"
  openclaw_supervised_pid_is_live "$pid" "$expected_identity"
}

stop_openclaw_supervised_gateway() {
  local pid="$1"
  local expected_identity="$2"
  openclaw_supervised_pid_is_live "$pid" "$expected_identity" || return 1
  gateway_control_stop_tracked_pid "$pid" "$expected_identity" || return 1
  if kill -0 "$pid" 2>/dev/null; then
    # The shared helper returns success when a later identity read says the
    # numeric PID changed. Before clearing the gateway identity or relaunching,
    # require the stronger postcondition that no process occupies that PID.
    echo "[SECURITY] OpenClaw gateway pid ${pid} remains live after tracked stop; refusing to treat it as stopped" >&2
    return 1
  fi
}

refresh_openclaw_supervised_child_pids() {
  SANDBOX_CHILD_PIDS=()
  openclaw_supervised_pid_is_live \
    "${GATEWAY_PID:-}" "${GATEWAY_PID_START_IDENTITY:-}" \
    && SANDBOX_CHILD_PIDS+=("$GATEWAY_PID")
  openclaw_supervised_aux_pid_is_live \
    "${AUTO_PAIR_PID:-}" "${AUTO_PAIR_PID_START_IDENTITY:-}" \
    && SANDBOX_CHILD_PIDS+=("$AUTO_PAIR_PID")
  openclaw_supervised_aux_pid_is_live \
    "${GATEWAY_LOG_TAIL_PID:-}" "${GATEWAY_LOG_TAIL_PID_START_IDENTITY:-}" \
    && SANDBOX_CHILD_PIDS+=("$GATEWAY_LOG_TAIL_PID")
  openclaw_supervised_aux_pid_is_live \
    "${GATEWAY_LOG_PERSIST_PID:-}" "${GATEWAY_LOG_PERSIST_PID_START_IDENTITY:-}" \
    && SANDBOX_CHILD_PIDS+=("$GATEWAY_LOG_PERSIST_PID")
  openclaw_supervised_aux_pid_is_live \
    "${PLUGIN_REFRESH_PID:-}" "${PLUGIN_REFRESH_PID_START_IDENTITY:-}" \
    && SANDBOX_CHILD_PIDS+=("$PLUGIN_REFRESH_PID")
  openclaw_supervised_aux_pid_is_live \
    "${GATEWAY_WATCHDOG_PID:-}" "${GATEWAY_WATCHDOG_PID_START_IDENTITY:-}" \
    && SANDBOX_CHILD_PIDS+=("$GATEWAY_WATCHDOG_PID")
  return 0
}

mark_openclaw_gateway_stopped() {
  GATEWAY_PID=0
  GATEWAY_PID_START_IDENTITY=""
  [ -n "${GATEWAY_PID_FILE:-}" ] && clear_gateway_pid_record
  # shellcheck disable=SC2034  # read by cleanup_on_signal from sandbox-init.sh
  SANDBOX_WAIT_PID=""
  refresh_openclaw_supervised_child_pids
}

stop_openclaw_gateway_fail_closed() {
  if ! stop_openclaw_supervised_gateway \
    "${GATEWAY_PID:-0}" "${GATEWAY_PID_START_IDENTITY:-}"; then
    echo "[CRITICAL] OpenClaw gateway revocation could not prove and stop the tracked child; exiting PID 1 for whole-container cleanup without signaling the unproven PID" >&2
    exit 1
  fi
  mark_openclaw_gateway_stopped
}

OPENCLAW_REAP_EXIT_STATUS=0
openclaw_reap_exited_gateway() {
  local pid="${GATEWAY_PID:-0}"
  local expected_start_identity="${GATEWAY_PID_START_IDENTITY:-}"
  local current_start_identity state
  local rc=0
  case "$pid" in
    '' | 0 | 1 | *[!0-9]*) return 1 ;;
  esac
  [ -n "$expected_start_identity" ] || return 1

  current_start_identity="$(openclaw_pid_start_identity "$pid" 2>/dev/null || true)"
  if [ -n "$current_start_identity" ] \
    && [ "$current_start_identity" != "$expected_start_identity" ]; then
    echo "[SECURITY] OpenClaw gateway pid $pid no longer matches its captured start identity; refusing to poll or reap it" >&2
    return 2
  fi

  # kill -0 also succeeds for zombies. Only that exact matching zombie is
  # safe to reap. A live process, or a process whose state/identity cannot be
  # proven, must not send PID 1 into an unbounded wait on a recycled PID.
  if kill -0 "$pid" 2>/dev/null; then
    state="$(gateway_control_pid_state "$pid" 2>/dev/null || true)"
    case "$state" in
      Z*) [ "$current_start_identity" = "$expected_start_identity" ] || return 2 ;;
      *)
        if [ "${GATEWAY_CONTROL_SIGNAL_PENDING:-0}" -eq 1 ] \
          && openclaw_supervised_pid_is_live "$pid" "$expected_start_identity" \
          && gateway_pid_is_openclaw_gateway "$pid"; then
          return 3
        fi
        echo "[SECURITY] OpenClaw gateway pid $pid cannot be proven exited with its captured start identity; refusing to reap it" >&2
        return 2
        ;;
    esac
  fi

  wait "$pid" 2>/dev/null || rc=$?
  # USR1 may interrupt wait without reaping the exact tracked child. Leave its
  # identity intact so the authenticated request handler can stop it.
  if [ "${GATEWAY_CONTROL_SIGNAL_PENDING:-0}" -eq 1 ] \
    && openclaw_supervised_pid_is_live "$pid" "$expected_start_identity" \
    && gateway_pid_is_openclaw_gateway "$pid"; then
    return 3
  fi
  # shellcheck disable=SC2034 # start.sh reads the completed reap status.
  OPENCLAW_REAP_EXIT_STATUS="$rc"
  mark_openclaw_gateway_stopped
}

cleanup_openclaw_on_signal() {
  # Revalidate every PID immediately before the shared cleanup helper signals
  # it.  Clear the primary wait PID too if the tracked gateway identity has
  # disappeared or the numeric PID was recycled.
  if ! openclaw_supervised_pid_is_live \
    "${GATEWAY_PID:-}" "${GATEWAY_PID_START_IDENTITY:-}"; then
    SANDBOX_WAIT_PID=""
  fi
  refresh_openclaw_supervised_child_pids
  cleanup_on_signal
}

OPENCLAW_RESTART_FAILURE_CODE=internal
_OPENCLAW_CONFIG_GUARD=/usr/local/lib/nemoclaw/openclaw-config-guard.py
OPENCLAW_CONFIG_GUARD_LAST_OUTPUT=""
run_openclaw_config_guard() {
  local action="$1"
  local startup_owner=0
  local arg output_file rc
  shift
  for arg in "$@"; do
    [ "$arg" = "--startup-owner" ] && startup_owner=1
  done
  if [ "$startup_owner" -eq 1 ]; then
    # The readiness contract authenticates this helper as a direct PID 1
    # child. A `timeout` wrapper or command substitution would become Python's
    # parent and invalidate that identity, so capture through a root-private
    # file while invoking Python directly.
    install -d -o root -g root -m 755 /run/nemoclaw || return 1
    install -d -o root -g root -m 700 /run/nemoclaw/openclaw-config-guard || return 1
    output_file="/run/nemoclaw/openclaw-config-guard/.$$.output"
    : >"$output_file"
    chmod 600 "$output_file"
    rc=0
    python3 -I "$_OPENCLAW_CONFIG_GUARD" "$action" \
      --config-dir /sandbox/.openclaw "$@" >"$output_file" 2>&1 || rc=$?
    OPENCLAW_CONFIG_GUARD_LAST_OUTPUT="$(<"$output_file")"
    rm -f "$output_file"
    if [ "$rc" -ne 0 ]; then
      printf '[config-guard] %s failed: %s\n' "$action" "$OPENCLAW_CONFIG_GUARD_LAST_OUTPUT" >&2
      return "$rc"
    fi
    return 0
  fi
  OPENCLAW_CONFIG_GUARD_LAST_OUTPUT="$(
    timeout --signal=TERM --kill-after=5s 5m \
      python3 -I "$_OPENCLAW_CONFIG_GUARD" "$action" \
      --config-dir /sandbox/.openclaw "$@" 2>&1
  )" || {
    printf '[config-guard] %s failed: %s\n' "$action" "$OPENCLAW_CONFIG_GUARD_LAST_OUTPUT" >&2
    return 1
  }
}

restore_openclaw_restart_config() {
  run_openclaw_config_guard unseal-restart \
    || run_openclaw_config_guard recover
}

cleanup_openclaw_gateway_locks() {
  timeout --signal=TERM --kill-after=1s 5s python3 -I - <<'PYLOCKS'
import os
import re
import stat
import sys
import time

deadline = time.monotonic() + 3
parent_limit = 64
entry_limit = 10000
lock_limit = 128
lock_pattern = re.compile(r"gateway[.][^/]+[.]lock\Z")
directory_flags = (
    os.O_RDONLY
    | getattr(os, "O_DIRECTORY", 0)
    | getattr(os, "O_NOFOLLOW", 0)
    | getattr(os, "O_CLOEXEC", 0)
)
tmp_fd = os.open("/tmp", directory_flags)
tmp_stat = os.fstat(tmp_fd)
parents = 0
locks = 0
observed = 0
try:
    with os.scandir(tmp_fd) as entries:
        for entry in entries:
            observed += 1
            if observed > entry_limit or time.monotonic() > deadline:
                raise RuntimeError("bounded /tmp gateway-lock inventory exceeded")
            if not entry.name.startswith("openclaw-"):
                continue
            parents += 1
            if parents > parent_limit:
                raise RuntimeError("too many OpenClaw lock directories")
            parent_fd = os.open(entry.name, directory_flags, dir_fd=tmp_fd)
            try:
                parent_stat = os.fstat(parent_fd)
                if parent_stat.st_dev != tmp_stat.st_dev:
                    print(
                        f"[gateway] refusing cross-device lock directory: /tmp/{entry.name}",
                        file=sys.stderr,
                    )
                    continue
                child_observed = 0
                with os.scandir(parent_fd) as children:
                    for child in children:
                        child_observed += 1
                        if child_observed > entry_limit or time.monotonic() > deadline:
                            raise RuntimeError("bounded gateway-lock directory inventory exceeded")
                        if not lock_pattern.fullmatch(child.name):
                            continue
                        locks += 1
                        if locks > lock_limit:
                            raise RuntimeError("too many gateway lock entries")
                        metadata = os.stat(
                            child.name, dir_fd=parent_fd, follow_symlinks=False
                        )
                        if (
                            metadata.st_dev != parent_stat.st_dev
                            or not stat.S_ISREG(metadata.st_mode)
                        ):
                            print(
                                f"[gateway] refusing non-regular lock entry: /tmp/{entry.name}/{child.name}",
                                file=sys.stderr,
                            )
                            continue
                        os.unlink(child.name, dir_fd=parent_fd)
                os.fsync(parent_fd)
            finally:
                os.close(parent_fd)
finally:
    os.close(tmp_fd)
PYLOCKS
}

openclaw_runtime_guard_chain_complete() {
  local targets=(
    "$_SANDBOX_SAFETY_NET"
    "$_NEMOTRON_FIX_SCRIPT"
    "$_CIAO_GUARD_SCRIPT"
    "$_RUNTIME_SHELL_ENV_FILE"
  )
  local target
  [ "${NODE_USE_ENV_PROXY:-}" = "1" ] && targets+=("$_PROXY_FIX_SCRIPT")
  for target in "${targets[@]}"; do
    [ -f "$target" ] && [ ! -L "$target" ] || return 1
  done
}

append_openclaw_gateway_log_line() {
  local log_file="/tmp/gateway.log"
  local line="$1"
  python3 -I - "$log_file" "$line" <<'PYAPPEND'
import os
import stat
import sys

# Source boundary: production startup owns /tmp/gateway.log creation through
# _nemoclaw_safe_create_tmp_file before any PID 1 recovery path runs. This
# permanent defensive append policy never creates the log, never honors an
# inherited alternate-path environment variable, and refuses link/swap targets
# before writing recovery breadcrumbs.
path = sys.argv[1]
line = sys.argv[2].replace("\r", " ").replace("\n", " ")
flags = (
    os.O_WRONLY
    | os.O_APPEND
    | getattr(os, "O_CLOEXEC", 0)
    | getattr(os, "O_NOFOLLOW", 0)
    | getattr(os, "O_NONBLOCK", 0)
)
try:
    before = os.lstat(path)
    if not stat.S_ISREG(before.st_mode):
        print(f"[SECURITY] refusing unsafe gateway log path: {path}", file=sys.stderr)
        raise SystemExit(1)
    fd = os.open(path, flags)
except FileNotFoundError:
    # Production pre-creates /tmp/gateway.log with _nemoclaw_safe_create_tmp_file.
    # Do not create it here from a PID 1/root recovery path.
    raise SystemExit(0)
except OSError as exc:
    print(f"[SECURITY] refusing unsafe gateway log path: {path}: {exc}", file=sys.stderr)
    raise SystemExit(1)
try:
    current = os.fstat(fd)
    if not stat.S_ISREG(current.st_mode) or (current.st_dev, current.st_ino) != (before.st_dev, before.st_ino):
        print(f"[SECURITY] refusing replaced gateway log path: {path}", file=sys.stderr)
        raise SystemExit(1)
    os.write(fd, (line + "\n").encode("utf-8"))
finally:
    os.close(fd)
PYAPPEND
}

restore_openclaw_runtime_guard_chain() {
  if ! openclaw_runtime_guard_chain_complete; then
    local _guard_warn="[gateway-recovery] WARNING: /tmp guard chain missing or unsafe - restoring library guards from packaged preloads (#2478/#2701)"
    echo "$_guard_warn" >&2
    local _append_rc=0
    append_openclaw_gateway_log_line "$_guard_warn" || _append_rc=$?
    if [ "$_append_rc" -ne 0 ] && [ "$_append_rc" -ne 1 ]; then
      return "$_append_rc"
    fi
  fi

  # Preserve startup ordering: immutable core preloads first, then the
  # manifest-declared messaging layer, then the shell environment that refers
  # to both. Permission validation is the final gate before any relaunch.
  install_core_runtime_preloads || return 1
  write_messaging_runtime_setup_plan || return 1
  install_messaging_runtime_preloads || return 1
  verify_messaging_runtime_secret_scans || return 1
  write_runtime_shell_env || return 1
  validate_nemoclaw_tmp_permissions || return 1
}

prepare_openclaw_automatic_respawn() {
  if restore_openclaw_runtime_guard_chain; then
    return 0
  fi
  echo "[gateway] CRITICAL: runtime guard restoration failed; refusing automatic respawn" >&2
  return 1
}

prepare_openclaw_gateway_restart() {
  OPENCLAW_RESTART_FAILURE_CODE=unsafe-config
  # Restart preflight is deliberately read-only. The gateway and sandbox code
  # may still hold descriptors into a mutable tree, so pathname recovery,
  # chmod/chown normalization, and placeholder rewrites here would be root
  # TOCTOU primitives. The descriptor guard validates the exact config/hash
  # pair and refuses incoherent or substituted paths; mutation belongs to a
  # serialized host config command before restart.
  run_openclaw_config_guard preflight-restart || return 1
  OPENCLAW_RESTART_FAILURE_CODE=preload-missing
  restore_openclaw_runtime_guard_chain || return 1
}

retire_openclaw_supervised_gateway() {
  local pid="$1"
  local expected_identity="$2"
  local reap_status=0

  # A recover request can arrive after the respawn loop has already reaped the
  # failed child and entered its backoff. Only the canonical stopped state may
  # bypass retirement; every nonzero tracked PID must still be stopped or
  # identity-safely reaped before a replacement is launched.
  [ "${GATEWAY_PID:-0}" = "$pid" ] \
    && [ "${GATEWAY_PID_START_IDENTITY:-}" = "$expected_identity" ] \
    || return 1
  if [ "$pid" = "0" ] \
    && [ -z "$expected_identity" ] \
    && [ -z "${SANDBOX_WAIT_PID:-}" ]; then
    return 0
  fi
  if openclaw_supervised_pid_is_live "$pid" "$expected_identity" \
    && stop_openclaw_supervised_gateway "$pid" "$expected_identity"; then
    return 0
  fi
  openclaw_reap_exited_gateway || reap_status=$?
  [ "$reap_status" -eq 0 ] \
    && [ "${GATEWAY_PID:-0}" = "0" ] \
    && [ -z "${GATEWAY_PID_START_IDENTITY:-}" ] \
    && [ -z "${SANDBOX_WAIT_PID:-}" ]
}

handle_openclaw_gateway_control_request() {
  gateway_control_take_request || return 1
  local old_pid="${GATEWAY_PID:-0}"
  local old_identity="${GATEWAY_PID_START_IDENTITY:-}"

  if [ "$GATEWAY_CONTROL_ACTION" = "probe" ]; then
    if ! run_openclaw_config_guard preflight-restart; then
      gateway_control_fail unsafe-config "$old_pid"
      return 1
    fi
    if ! openclaw_gateway_healthy "$old_pid" "$old_identity"; then
      gateway_control_fail health-timeout "$old_pid"
      return 1
    fi
    gateway_control_complete already-running "$old_pid" "$old_pid"
    return 0
  fi

  if [ "$GATEWAY_CONTROL_ACTION" = "recover" ] \
    && openclaw_gateway_healthy "$old_pid" "$old_identity"; then
    if ! run_openclaw_config_guard recover; then
      gateway_control_fail unsafe-config "$old_pid"
      return 1
    fi
    gateway_control_complete already-running "$old_pid" "$old_pid"
    return 0
  fi

  # Validate every mutable/security input while the currently healthy gateway
  # is still serving. Refusal must not turn a recoverable config error into an
  # outage.
  if ! prepare_openclaw_gateway_restart; then
    gateway_control_fail "$OPENCLAW_RESTART_FAILURE_CODE" "$old_pid"
    return 1
  fi

  # Seal while the old healthy gateway is still serving. This fresh-replaces
  # the canonical config/hash pair and revokes old writable descriptors before
  # any outage is introduced. Unseal restores the mutable posture.
  if ! run_openclaw_config_guard seal-restart; then
    if ! restore_openclaw_restart_config; then
      echo "[SECURITY] OpenClaw restart seal failed and deterministic recovery also failed; stopping the old gateway to revoke stale config descriptors" >&2
      stop_openclaw_gateway_fail_closed
    fi
    gateway_control_fail unsafe-config "$old_pid"
    return 1
  fi

  if ! retire_openclaw_supervised_gateway "$old_pid" "$old_identity"; then
    restore_openclaw_restart_config || true
    gateway_control_fail internal "$old_pid"
    return 1
  fi
  mark_openclaw_gateway_stopped
  cleanup_openclaw_gateway_locks \
    || echo "[gateway] warning: bounded stale gateway-lock cleanup was incomplete" >&2

  if ! launch_openclaw_gateway; then
    stop_openclaw_gateway_fail_closed
    restore_openclaw_restart_config || true
    gateway_control_fail health-timeout "$old_pid"
    return 1
  fi
  # Register the replacement before its bounded health wait. A container stop
  # in this window must signal the new child, never the already-reaped old PID.
  refresh_openclaw_supervised_child_pids
  if ! wait_for_openclaw_gateway_internal \
    "$GATEWAY_PID" "$GATEWAY_PID_START_IDENTITY"; then
    stop_openclaw_gateway_fail_closed
    restore_openclaw_restart_config || true
    gateway_control_fail health-timeout "$old_pid"
    return 1
  fi

  if ! restore_openclaw_restart_config; then
    # The replacement is healthy and the canonical pair remains fail-closed,
    # but the mutable posture could not be restored. Keep the
    # service running and make the host operation fail loudly for recovery.
    refresh_openclaw_supervised_child_pids
    gateway_control_fail unsafe-config "$old_pid"
    return 1
  fi

  # PLUGIN_REFRESH_PID remains set after its best-effort background job exits.
  # Never signal that potentially stale PID during a later gateway restart:
  # PID reuse could otherwise terminate an unrelated process. A still-running
  # prior refresh is harmless and will exit on its own.
  start_plugin_registry_refresh
  refresh_openclaw_supervised_child_pids
  gateway_control_complete ok "$old_pid" "$GATEWAY_PID"
}
