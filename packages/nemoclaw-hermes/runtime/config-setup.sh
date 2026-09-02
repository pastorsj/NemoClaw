# shellcheck shell=bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
# Validate ports and prepare Hermes configuration, logs, and durable state.
# shellcheck disable=SC2034,SC2153 # Globals are shared with the sourced workflow modules.

truthy_env() {
  case "$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')" in
    1 | true | yes | on) return 0 ;;
    *) return 1 ;;
  esac
}

validate_tcp_port() {
  local name="$1"
  local value="$2"
  case "$value" in
    '' | *[!0-9]*)
      echo "[gateway] ERROR: ${name} must be an integer TCP port, got '${value}'" >&2
      exit 1
      ;;
  esac
  if [ "$value" -lt 1024 ] || [ "$value" -gt 65535 ]; then
    echo "[gateway] ERROR: ${name} must be between 1024 and 65535, got '${value}'" >&2
    exit 1
  fi
}

validate_port_configuration() {
  validate_tcp_port PUBLIC_PORT "$PUBLIC_PORT"
  validate_tcp_port INTERNAL_PORT "$INTERNAL_PORT"
  validate_tcp_port DASHBOARD_PUBLIC_PORT "$DASHBOARD_PUBLIC_PORT"
  validate_tcp_port DASHBOARD_INTERNAL_PORT "$DASHBOARD_INTERNAL_PORT"
  if [ "$DASHBOARD_PUBLIC_PORT" -eq "$PUBLIC_PORT" ]; then
    echo "[gateway] ERROR: DASHBOARD_PUBLIC_PORT must not equal PUBLIC_PORT (${PUBLIC_PORT})" >&2
    exit 1
  fi
  if [ "$DASHBOARD_INTERNAL_PORT" -eq "$INTERNAL_PORT" ]; then
    echo "[gateway] ERROR: DASHBOARD_INTERNAL_PORT must not equal INTERNAL_PORT (${INTERNAL_PORT})" >&2
    exit 1
  fi
  if [ "$DASHBOARD_PUBLIC_PORT" -eq "$INTERNAL_PORT" ]; then
    echo "[gateway] ERROR: DASHBOARD_PUBLIC_PORT must not equal INTERNAL_PORT (${INTERNAL_PORT})" >&2
    exit 1
  fi
  if [ "$DASHBOARD_INTERNAL_PORT" -eq "$PUBLIC_PORT" ]; then
    echo "[gateway] ERROR: DASHBOARD_INTERNAL_PORT must not equal PUBLIC_PORT (${PUBLIC_PORT})" >&2
    exit 1
  fi
}

validate_port_configuration

hermes_dashboard_tui_enabled() {
  truthy_env "$HERMES_DASHBOARD_TUI"
}

# verify_config_integrity is provided by sandbox-init.sh (parameterized).

verify_hermes_config_integrity() {
  if [ "$(id -u)" -eq 0 ]; then
    # Docker may start UID 0 without the supplementary groups declared in
    # /etc/group, and hardened runtimes can drop CAP_DAC_OVERRIDE before this
    # entrypoint runs. Verify the root-owned hash through the sandbox identity
    # that owns the mutable Hermes home.
    export -f verify_config_integrity
    "${STEP_DOWN_PREFIX_SANDBOX[@]}" bash -c "verify_config_integrity \"\$1\" \"\$2\"" bash \
      "${HERMES_DIR}" "${HERMES_HASH_FILE}" || return 1
    if ! inspect_hermes_mcp_integrity "${HERMES_HASH_FILE}"; then
      HERMES_RESTART_FAILURE_CODE=mcp-integrity
      return 1
    fi
    return 0
  fi
  verify_config_integrity "${HERMES_DIR}" "${HERMES_HASH_FILE}" || return 1
  if ! inspect_hermes_mcp_integrity "${HERMES_HASH_FILE}"; then
    HERMES_RESTART_FAILURE_CODE=mcp-integrity
    return 1
  fi
}

prepare_hermes_lazy_dependencies() {
  local -a installer=(
    env
    HOME=/sandbox
    UV_CACHE_DIR=/sandbox/.hermes/cache/uv
    UV_NO_CACHE=1
    HERMES_HOME="$HERMES_DIR"
    HERMES_LAZY_INSTALL_TARGET=/sandbox/.hermes/lazy-packages
  )

  # The separated gateway identity deliberately has no write access to the
  # durable dependency tree. Route the allowlisted installer through sandbox;
  # same-UID OpenShell startup is already running under that identity.
  if [ "$(id -u)" -eq 0 ]; then
    installer+=("${STEP_DOWN_PREFIX_SANDBOX[@]}")
  fi
  installer+=("$_HERMES_PYTHON" -I -c)

  "${installer[@]}" '
import os
from pathlib import Path

import yaml

config_path = Path(os.environ["HERMES_HOME"]) / "config.yaml"
try:
    config = yaml.safe_load(config_path.read_text(encoding="utf-8")) or {}
except Exception as exc:
    raise SystemExit(f"[SECURITY] Unable to inspect Hermes memory configuration: {exc}") from exc

memory = config.get("memory") if isinstance(config, dict) else None
provider = memory.get("provider") if isinstance(memory, dict) else None
if provider != "hindsight":
    raise SystemExit(0)

from tools.lazy_deps import activate_durable_lazy_target, ensure

activate_durable_lazy_target()
try:
    ensure("memory.hindsight", prompt=False)
except Exception as exc:
    raise SystemExit(
        "[SECURITY] Unable to prepare the approved Hindsight dependency "
        f"under the sandbox-owned lazy-install target: {exc}"
    ) from exc
'
}

# configure_messaging_channels is provided by sandbox-init.sh (shared).

print_dashboard_urls() {
  local api_url dashboard_url
  api_url="http://127.0.0.1:${PUBLIC_PORT}/v1"
  dashboard_url="http://127.0.0.1:${DASHBOARD_PUBLIC_PORT}/"
  echo "[gateway] Hermes Dashboard: ${dashboard_url}" >&2
  echo "[gateway] Hermes API:       ${api_url}" >&2
  echo "[gateway] Health:           ${api_url%/v1}/health" >&2
  echo "[gateway] Connect any OpenAI-compatible frontend to this endpoint." >&2
}

hermes_fatal_unproven_child() {
  local role="$1"
  local pid="$2"
  if [ "${HERMES_STARTUP_SUPERVISOR_PID:-$$}" -eq 1 ]; then
    echo "[CRITICAL] Newly launched Hermes ${role} pid ${pid} failed exact role identity capture; exiting PID 1 for whole-container cleanup without signaling or waiting on the unproven PID" >&2
    exit 1
  fi

  # In managed OpenShell, exiting this non-root supervisor would leave PID 1
  # and the unproven child alive. Bash's job table can still wait for the exact
  # `$!` child without treating a reused numeric PID as authority to signal it.
  # Quarantine the supervisor after that child exits; only sandbox destruction
  # may tear down a process tree whose identities could not be established.
  echo "[CRITICAL] Newly launched Hermes ${role} pid ${pid} failed exact role identity capture; quarantining the managed startup supervisor without signaling the unproven child" >&2
  trap ':' TERM INT
  wait "$pid" 2>/dev/null || true
  echo "[CRITICAL] Unproven Hermes ${role} child exited; managed supervisor remains quarantined until sandbox recreation" >&2
  while :; do
    sleep 60 || true
  done
}

start_gateway_log_stream() {
  tail -n +1 -F /tmp/gateway.log 2>/dev/null | sed -u 's/^/[gateway-log:] /' >&2 &
  GATEWAY_LOG_TAIL_PID=$!
  if ! hermes_capture_tracked_role gateway-log "$GATEWAY_LOG_TAIL_PID" current; then
    hermes_fatal_unproven_child gateway-log "$GATEWAY_LOG_TAIL_PID"
  fi
}

start_dashboard_log_stream() {
  tail -n +1 -F /tmp/dashboard.log 2>/dev/null | sed -u 's/^/[dashboard-log:] /' >&2 &
  DASHBOARD_LOG_TAIL_PID=$!
  if ! hermes_capture_tracked_role dashboard-log "$DASHBOARD_LOG_TAIL_PID" current; then
    hermes_fatal_unproven_child dashboard-log "$DASHBOARD_LOG_TAIL_PID"
  fi
}

ensure_dashboard_log_stream() {
  if ! hermes_tracked_role_is_current dashboard-log "${DASHBOARD_LOG_TAIL_PID:-}" current; then
    start_dashboard_log_stream
  fi
}

ensure_gateway_log_stream() {
  if ! hermes_tracked_role_is_current gateway-log "${GATEWAY_LOG_TAIL_PID:-}" current; then
    start_gateway_log_stream
  fi
}

TIRITH_RETRY_MARKER_CLEARED=0

retry_tirith_marker_if_needed() {
  local marker="${HERMES_DIR}/.tirith-install-failed"
  local rc

  if "$_HERMES_PYTHON" -I "$_HERMES_TIRITH_MARKER_FINALIZER" "$marker"; then
    echo "[tirith-bootstrap] download_failed marker present; letting Hermes runtime fallback retry Tirith" >&2
    TIRITH_RETRY_MARKER_CLEARED=1
    return 0
  else
    rc=$?
  fi
  if [ "$rc" -eq 10 ]; then
    if [ -e "$marker" ]; then
      echo "[tirith-bootstrap] WARNING: Tirith install marker reason is not retryable; Hermes gateway startup will continue" >&2
    fi
    return 0
  fi
  if [ "$rc" -eq 11 ]; then
    echo "[tirith-bootstrap] WARNING: unsafe Tirith install marker at ${marker}; not reading it" >&2
    return 0
  fi
  echo "[tirith-bootstrap] WARNING: could not safely inspect or remove retryable Tirith marker; Hermes gateway startup will continue" >&2
}

prepare_tirith_marker_retry() {
  TIRITH_RETRY_MARKER_CLEARED=0
  retry_tirith_marker_if_needed
}

# sourceBoundary: Hermes runtime fallback recreates download_failed when its background Tirith fetch fails.
# whyNotSourceFix: Hermes is an upstream image dependency; this entrypoint owns restart recovery only.
# regressionTest: tests/compat/tirith-retry.test.ts covers cleanup and unsafe-marker preservation.
# removalCondition: Remove when Hermes no longer recreates the marker after a handled startup retry.
finalize_tirith_marker_retry() {
  local marker="${HERMES_DIR}/.tirith-install-failed"
  local rc

  [ "$TIRITH_RETRY_MARKER_CLEARED" -eq 1 ] || return 0
  if "$_HERMES_PYTHON" -I "$_HERMES_TIRITH_MARKER_FINALIZER" "$marker"; then
    echo "[tirith-bootstrap] Tirith retry completed with download_failed; clearing the handled retry marker" >&2
    return 0
  else
    rc=$?
  fi
  if [ "$rc" -eq 10 ]; then
    return 0
  fi
  if [ "$rc" -eq 11 ]; then
    echo "[tirith-bootstrap] WARNING: unsafe Tirith install marker recreated during retry; not reading it" >&2
    return 0
  fi
  echo "[tirith-bootstrap] WARNING: could not safely inspect or clear handled Tirith retry marker; Hermes gateway startup will continue" >&2
}

cmdline_is_hermes_gateway() {
  local cmdline=" $1 "

  case "$cmdline" in
    *"/hermes gateway run "* | *" hermes gateway run "* | *"/hermes.real gateway run "* | *" hermes.real gateway run "*) return 0 ;;
  esac
  return 1
}

has_live_hermes_gateway() {
  local proc_root="${NEMOCLAW_PROC_ROOT:-/proc}"
  local expected_uid cmdline_file pid process_uid cmdline

  expected_uid="$(id -u)"
  if [ "$expected_uid" -eq 0 ]; then
    expected_uid="$(id -u gateway 2>/dev/null || true)"
  fi
  case "$expected_uid" in
    '' | *[!0-9]*) return 1 ;;
  esac

  for cmdline_file in "${proc_root}"/[0-9]*/cmdline; do
    [ -r "$cmdline_file" ] || continue
    pid="${cmdline_file%/cmdline}"
    process_uid="$(awk '$1 == "Uid:" { print $2; exit }' "${pid}/status" 2>/dev/null || true)"
    [ "$process_uid" = "$expected_uid" ] || continue
    cmdline="$(tr '\0' ' ' <"$cmdline_file" 2>/dev/null || true)"
    if cmdline_is_hermes_gateway "$cmdline"; then
      return 0
    fi
  done
  return 1
}

cleanup_orphan_socat_forwarders() {
  local proc_root="${NEMOCLAW_PROC_ROOT:-/proc}"
  local dashboard_public_port="${DASHBOARD_PUBLIC_PORT:-}"
  local dashboard_internal_port="${DASHBOARD_INTERNAL_PORT:-}"
  local cmdline_file pid cmdline

  for cmdline_file in "${proc_root}"/[0-9]*/cmdline; do
    [ -r "$cmdline_file" ] || continue
    pid="$(basename "$(dirname "$cmdline_file")")"
    cmdline="$(tr '\0' ' ' <"$cmdline_file" 2>/dev/null || true)"
    case "$cmdline" in
      *socat*"TCP-LISTEN:${PUBLIC_PORT}"*"TCP:127.0.0.1:${INTERNAL_PORT}"*)
        if [ "$pid" = "${SOCAT_PID:-}" ] \
          && hermes_tracked_role_is_current \
            api-socat "$pid" current "$PUBLIC_PORT"; then
          # A managed gateway reload temporarily leaves no gateway process,
          # but its exact tracked relay may still be safe to reuse. Preserve
          # only the fully identity-proven parent; listener ownership and
          # public readiness are re-proven before convergence, while every
          # other matching socat is still removed below.
          continue
        fi
        echo "[gateway] Removing orphaned socat forwarder for ${PUBLIC_PORT}->${INTERNAL_PORT} (pid ${pid})" >&2
        kill "$pid" 2>/dev/null || true
        ;;
      *socat*"TCP-LISTEN:${dashboard_public_port}"*"TCP:127.0.0.1:${dashboard_internal_port}"*)
        if [ -z "$dashboard_public_port" ] || [ -z "$dashboard_internal_port" ]; then
          continue
        fi
        if [ "$pid" = "${DASHBOARD_SOCAT_PID:-}" ] \
          && hermes_tracked_role_is_current \
            dashboard-socat "$pid" current "$dashboard_public_port"; then
          continue
        fi
        echo "[gateway] Removing orphaned dashboard socat forwarder for ${dashboard_public_port}->${dashboard_internal_port} (pid ${pid})" >&2
        kill "$pid" 2>/dev/null || true
        ;;
    esac
  done
}

remove_stale_gateway_file() {
  local path="$1"
  local label="$2"

  if [ -L "$path" ]; then
    echo "[gateway] Removing unsafe stale Hermes ${label} symlink: ${path}" >&2
    rm -f "$path" 2>/dev/null || echo "[gateway] WARNING: could not remove stale ${label}: ${path}" >&2
    return
  fi
  if [ -f "$path" ]; then
    echo "[gateway] Removing stale Hermes ${label}: ${path}" >&2
    rm -f "$path" 2>/dev/null || echo "[gateway] WARNING: could not remove stale ${label}: ${path}" >&2
  fi
}

hermes_config_path_is_locked() {
  local path="$1"
  local owner mode

  [ -f "$path" ] || return 1
  [ ! -L "$path" ] || return 1

  owner="$(stat -c '%U:%G' "$path" 2>/dev/null || stat -f '%Su:%Sg' "$path" 2>/dev/null || true)"
  mode="$(stat -c '%a' "$path" 2>/dev/null || stat -f '%Lp' "$path" 2>/dev/null || true)"
  mode="${mode#0}"
  [ -n "$mode" ] || return 1

  [ "$owner" = "root:root" ] || return 1
  (((8#$mode & 0222) == 0))
}

hermes_config_root_is_locked() {
  local owner mode

  owner="$(stat -c '%U:%G' "$HERMES_DIR" 2>/dev/null || stat -f '%Su:%Sg' "$HERMES_DIR" 2>/dev/null || true)"
  mode="$(stat -c '%a' "$HERMES_DIR" 2>/dev/null || stat -f '%Lp' "$HERMES_DIR" 2>/dev/null || true)"

  # The locked root is root-owned in the sandbox group and keeps the set-id and
  # sticky bits so the gateway can still write its top-level runtime state while
  # the sticky bit protects the sealed entries (#7865) — the same shape
  # hermes_locked_parent_is_protected expects one level up. `root:root 755` is
  # the pre-#7865 posture; keep detecting it so an existing shields-up sandbox
  # still takes the locked branches until `shields up` repairs the root.
  case "${owner} ${mode}" in
    "root:sandbox 3770" | "root:sandbox 03770") ;;
    "root:root 755" | "root:root 0755") ;;
    *) return 1 ;;
  esac

  hermes_config_path_is_locked "${HERMES_DIR}/config.yaml" \
    && hermes_config_path_is_locked "${HERMES_DIR}/.env"
}

hermes_locked_parent_is_protected() {
  local owner mode
  owner="$(stat -c '%U:%G' /sandbox 2>/dev/null || stat -f '%Su:%Sg' /sandbox 2>/dev/null || true)"
  mode="$(stat -c '%a' /sandbox 2>/dev/null || stat -f '%Lp' /sandbox 2>/dev/null || true)"
  case "${owner} ${mode}" in
    "root:sandbox 1775" | "root:sandbox 01775") return 0 ;;
    *) return 1 ;;
  esac
}

apply_shields_up_runtime_env() {
  local config_locked=0
  if [ "${HERMES_RESTART_SEALED:-0}" -eq 1 ]; then
    config_locked="${HERMES_RESTART_ORIGINAL_LOCKED:-0}"
  elif hermes_config_root_is_locked; then
    config_locked=1
  fi

  if [ "$config_locked" -eq 1 ]; then
    if [ -z "${HERMES_KANBAN_DISPATCH_IN_GATEWAY:-}" ]; then
      export HERMES_KANBAN_DISPATCH_IN_GATEWAY=0
      _NEMOCLAW_SET_KANBAN_DISPATCH=1
      echo "[gateway] Shields-up: HERMES_KANBAN_DISPATCH_IN_GATEWAY=0 (embedded kanban dispatcher suspended; kanban.db on locked config root is read-only)" >&2
    fi
    return 0
  fi

  if [ "${_NEMOCLAW_SET_KANBAN_DISPATCH:-0}" -eq 1 ]; then
    unset HERMES_KANBAN_DISPATCH_IN_GATEWAY
    _NEMOCLAW_SET_KANBAN_DISPATCH=0
  fi
}

ensure_hermes_config_root_mode() {
  if [ -L "$HERMES_DIR" ] || [ ! -d "$HERMES_DIR" ]; then
    echo "[SECURITY] Refusing Hermes layout repair because ${HERMES_DIR} is not a safe directory" >&2
    return 1
  fi

  if hermes_config_root_is_locked; then
    echo "[gateway] Hermes config root is locked; preserving shields-up permissions" >&2
    return 0
  fi

  if [ "$(id -u)" -eq 0 ]; then
    chown sandbox:sandbox "$HERMES_DIR" || return 1
  fi
  chmod 3770 "$HERMES_DIR"
}

ensure_hermes_state_dir() {
  local dir="$1"
  local mode="$2"

  if [ -L "$dir" ]; then
    echo "[SECURITY] Refusing Hermes layout repair because ${dir} is a symlink" >&2
    return 1
  fi
  if [ -e "$dir" ] && [ ! -d "$dir" ]; then
    echo "[SECURITY] Refusing Hermes layout repair because ${dir} is not a directory" >&2
    return 1
  fi

  mkdir -p "$dir" || return 1

  if [ -L "$dir" ] || [ ! -d "$dir" ]; then
    echo "[SECURITY] Refusing Hermes layout repair because ${dir} did not resolve to a safe directory" >&2
    return 1
  fi

  if [ "$(id -u)" -eq 0 ]; then
    chown sandbox:sandbox "$dir" || return 1
  fi
  chmod "$mode" "$dir"
}

ensure_hermes_cross_uid_state_dir() {
  local state_name="${1:?Hermes state directory name required}"
  # Gateway state defaults to the gateway identity. Callers that provision a
  # sandbox-owned cross-UID boundary, such as Fabric artifacts, name it here.
  local owner_name="${2:-gateway}"
  NEMOCLAW_HERMES_CONFIG_ROOT="$HERMES_DIR" \
    NEMOCLAW_HERMES_STATE_DIR_NAME="$state_name" \
    NEMOCLAW_HERMES_STATE_DIR_OWNER="$owner_name" \
    python3 -I - <<'PYCROSSUIDDIR'
import errno
import grp
import os
import pwd
import stat
import sys

root = os.environ["NEMOCLAW_HERMES_CONFIG_ROOT"]
name = os.environ["NEMOCLAW_HERMES_STATE_DIR_NAME"]
owner_name = os.environ["NEMOCLAW_HERMES_STATE_DIR_OWNER"]
desired_mode = 0o2770


def fail(message: str) -> None:
    print(
        f"[SECURITY] Refusing Hermes cross-UID state repair because {message}",
        file=sys.stderr,
    )
    sys.exit(1)


if not hasattr(os, "O_NOFOLLOW") or not hasattr(os, "O_DIRECTORY"):
    fail("descriptor-safe directory flags are unavailable")

try:
    root_before = os.lstat(root)
except OSError as exc:
    fail(f"{root} could not be inspected: {exc.strerror}")
if stat.S_ISLNK(root_before.st_mode) or not stat.S_ISDIR(root_before.st_mode):
    fail(f"{root} is not a safe directory")

open_flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
open_flags |= getattr(os, "O_CLOEXEC", 0)
root_fd = -1
state_fd = -1
try:
    try:
        root_fd = os.open(root, open_flags)
    except OSError as exc:
        fail(f"{root} could not be opened safely: {exc.strerror}")
    root_open = os.fstat(root_fd)
    if (root_open.st_dev, root_open.st_ino) != (
        root_before.st_dev,
        root_before.st_ino,
    ):
        fail(f"{root} changed while it was opened")

    try:
        state_fd = os.open(name, open_flags, dir_fd=root_fd)
    except FileNotFoundError:
        try:
            os.mkdir(name, desired_mode, dir_fd=root_fd)
        except FileExistsError:
            pass
        except OSError as exc:
            fail(f"{root}/{name} could not be created: {exc.strerror}")
        try:
            state_fd = os.open(name, open_flags, dir_fd=root_fd)
        except OSError as exc:
            fail(f"{root}/{name} could not be opened after creation: {exc.strerror}")
    except OSError as exc:
        try:
            unsafe = os.stat(name, dir_fd=root_fd, follow_symlinks=False)
        except OSError:
            unsafe = None
        if unsafe is not None and stat.S_ISLNK(unsafe.st_mode):
            fail(f"{root}/{name} is a symlink")
        if unsafe is not None and not stat.S_ISDIR(unsafe.st_mode):
            fail(f"{root}/{name} is not a directory")
        detail = exc.strerror or errno.errorcode.get(exc.errno, str(exc.errno))
        fail(f"{root}/{name} could not be opened safely: {detail}")

    if os.geteuid() == 0:
        try:
            owner_uid = pwd.getpwnam(owner_name).pw_uid
            sandbox_gid = grp.getgrnam("sandbox").gr_gid
        except KeyError as exc:
            fail(f"{owner_name}/sandbox account lookup failed: {exc}")
        os.fchown(state_fd, owner_uid, sandbox_gid)
        os.fchmod(state_fd, desired_mode)
    else:
        # OpenShell's non-root topology runs the workload as the current user.
        # Repair the mode when this user owns the directory. If an ordinary
        # Linux image still has the root-prepared requested owner, fchmod is
        # expected to fail and the exact existing mode is verified below.
        try:
            os.fchmod(state_fd, desired_mode)
        except PermissionError:
            pass

    current = os.fstat(state_fd)
    if not stat.S_ISDIR(current.st_mode):
        fail(f"{root}/{name} is not a directory")
    if stat.S_IMODE(current.st_mode) != desired_mode:
        fail(
            f"{root}/{name} mode is {stat.S_IMODE(current.st_mode):04o}, "
            f"expected {desired_mode:04o}"
        )

    if os.geteuid() == 0:
        allowed_uids = {owner_uid}
        expected_gid = sandbox_gid
    else:
        allowed_uids = {os.geteuid()}
        expected_gid = os.getegid()
        try:
            prepared_owner_uid = pwd.getpwnam(owner_name).pw_uid
            allowed_uids.add(prepared_owner_uid)
            if current.st_uid == prepared_owner_uid:
                expected_gid = grp.getgrnam("sandbox").gr_gid
        except KeyError:
            # Host-side unit fixtures need not have the image's account pair.
            # A deployed image always has both accounts; when the requested
            # account is absent, current-user ownership and exact mode remain
            # the complete non-root topology contract.
            pass
    if current.st_uid not in allowed_uids:
        fail(f"{root}/{name} has an unexpected owner uid {current.st_uid}")
    if expected_gid is not None and current.st_gid != expected_gid:
        fail(
            f"{root}/{name} has group gid {current.st_gid}, "
            f"expected sandbox gid {expected_gid}"
        )

    try:
        named = os.stat(name, dir_fd=root_fd, follow_symlinks=False)
    except OSError as exc:
        fail(f"{root}/{name} no longer names the opened directory: {exc.strerror}")
    if (named.st_dev, named.st_ino) != (current.st_dev, current.st_ino):
        fail(f"{root}/{name} changed during repair")

    try:
        root_after = os.lstat(root)
    except OSError as exc:
        fail(f"{root} disappeared during repair: {exc.strerror}")
    if (root_after.st_dev, root_after.st_ino) != (
        root_open.st_dev,
        root_open.st_ino,
    ):
        fail(f"{root} changed during repair")
finally:
    if state_fd >= 0:
        os.close(state_fd)
    if root_fd >= 0:
        os.close(root_fd)
PYCROSSUIDDIR
}

repair_hermes_log_permissions() {
  ensure_hermes_state_dir "${HERMES_DIR}/logs" 2770 || return 1
  ensure_hermes_state_dir "${HERMES_DIR}/logs/curator" 2770 || return 1

  NEMOCLAW_HERMES_LOG_DIR="${HERMES_DIR}/logs" \
    python3 - <<'PYLOGS'
import errno
import grp
import os
import pwd
import stat
import sys

root = os.environ["NEMOCLAW_HERMES_LOG_DIR"]
mode = 0o660

if not hasattr(os, "O_NOFOLLOW"):
    print("[SECURITY] Refusing Hermes log repair because O_NOFOLLOW is unavailable", file=sys.stderr)
    sys.exit(1)

root_real = os.path.realpath(root)
flags = os.O_RDONLY | os.O_NOFOLLOW
for optional_flag in ("O_CLOEXEC", "O_NONBLOCK"):
    flags |= getattr(os, optional_flag, 0)


def fail(message: str) -> None:
    print(f"[SECURITY] Refusing Hermes log repair because {message}", file=sys.stderr)
    sys.exit(1)


def describe_unsafe_existing_path(path: str) -> str:
    try:
        st = os.lstat(path)
    except OSError:
        return "could not be opened safely"
    if stat.S_ISLNK(st.st_mode):
        return "is a symlink"
    if not stat.S_ISREG(st.st_mode):
        return "is not a regular file"
    return "could not be opened safely"


def repair_file(path: str) -> None:
    try:
        current = os.lstat(path)
    except OSError as exc:
        fail(f"{path} could not be statted safely: {exc.strerror}")
    if stat.S_ISLNK(current.st_mode):
        fail(f"{path} is a symlink")
    if not stat.S_ISREG(current.st_mode):
        fail(f"{path} is not a regular file")

    try:
        fd = os.open(path, flags)
    except OSError as exc:
        reason = describe_unsafe_existing_path(path)
        detail = exc.strerror or errno.errorcode.get(exc.errno, str(exc.errno))
        fail(f"{path} {reason}: {detail}")

    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode):
            fail(f"{path} is not a regular file")
        if st.st_nlink != 1:
            fail(f"{path} has hard-link count {st.st_nlink}")
        current = os.stat(path, follow_symlinks=False)
        if (current.st_dev, current.st_ino) != (st.st_dev, st.st_ino):
            fail(f"{path} changed during repair")
        if os.geteuid() == 0:
            try:
                uid = pwd.getpwnam("sandbox").pw_uid
                gid = grp.getgrnam("sandbox").gr_gid
            except KeyError as exc:
                fail(f"sandbox account lookup failed: {exc}")
            os.fchown(fd, uid, gid)
        os.fchmod(fd, mode)
        current = os.stat(path, follow_symlinks=False)
        if (current.st_dev, current.st_ino) != (st.st_dev, st.st_ino):
            fail(f"{path} changed during repair")
    finally:
        os.close(fd)


def on_walk_error(exc: OSError) -> None:
    fail(f"{exc.filename} could not be scanned safely: {exc.strerror}")


for dirpath, dirnames, filenames in os.walk(root, topdown=True, onerror=on_walk_error, followlinks=False):
    dir_real = os.path.realpath(dirpath)
    if os.path.commonpath([root_real, dir_real]) != root_real:
        fail(f"{dirpath} escapes {root}")
    for dirname in list(dirnames):
        entry = os.path.join(dirpath, dirname)
        try:
            st = os.lstat(entry)
        except OSError as exc:
            fail(f"{entry} could not be statted safely: {exc.strerror}")
        if stat.S_ISLNK(st.st_mode):
            fail(f"{entry} is a symlink")
        if not stat.S_ISDIR(st.st_mode):
            fail(f"{entry} is not a directory")
    for filename in filenames:
        repair_file(os.path.join(dirpath, filename))
PYLOGS
}

ensure_hermes_history_file() {
  local file="$1"
  local mode="$2"

  # Use a no-follow fd workflow instead of check-then-use shell path
  # operations. /sandbox/.hermes is intentionally sandbox-writable while
  # shields are down, so root must not validate the pathname and then later
  # chown/chmod whatever an agent swaps into that path. Python gives us
  # O_NOFOLLOW + fstat/fchown/fchmod against the actual opened inode.
  NEMOCLAW_HERMES_HISTORY_FILE="$file" \
    NEMOCLAW_HERMES_HISTORY_MODE="$mode" \
    python3 - <<'PYHISTORY'
import errno
import grp
import os
import pwd
import stat
import sys

path = os.environ["NEMOCLAW_HERMES_HISTORY_FILE"]
mode_text = os.environ["NEMOCLAW_HERMES_HISTORY_MODE"]
try:
    mode = int(mode_text, 8)
except ValueError:
    print(f"[SECURITY] Refusing Hermes layout repair because requested mode {mode_text!r} is invalid", file=sys.stderr)
    sys.exit(1)

if not hasattr(os, "O_NOFOLLOW"):
    print("[SECURITY] Refusing Hermes layout repair because O_NOFOLLOW is unavailable", file=sys.stderr)
    sys.exit(1)

flags = os.O_WRONLY | os.O_CREAT | os.O_APPEND | os.O_NOFOLLOW
for optional_flag in ("O_CLOEXEC", "O_NONBLOCK"):
    flags |= getattr(os, optional_flag, 0)


def describe_unsafe_existing_path() -> str:
    try:
        st = os.lstat(path)
    except OSError:
        return "could not be opened safely"
    if stat.S_ISLNK(st.st_mode):
        return "is a symlink"
    if not stat.S_ISREG(st.st_mode):
        return "is not a regular file"
    return "could not be opened safely"

try:
    fd = os.open(path, flags, mode)
except OSError as exc:
    reason = describe_unsafe_existing_path()
    detail = exc.strerror or errno.errorcode.get(exc.errno, str(exc.errno))
    print(f"[SECURITY] Refusing Hermes layout repair because {path} {reason}: {detail}", file=sys.stderr)
    sys.exit(1)

try:
    st = os.fstat(fd)
    if not stat.S_ISREG(st.st_mode):
        print(f"[SECURITY] Refusing Hermes layout repair because {path} is not a regular file", file=sys.stderr)
        sys.exit(1)

    # Reject hard-linked targets. An attacker who controls the sandbox user
    # before shields-up can pre-create .hermes_history as a hard link to
    # config.yaml or .env. O_NOFOLLOW and regular-file checks pass, so without
    # this guard fchown/fchmod would walk the shared inode and silently undo
    # the shields-up root:root 0444 lock on the config file after
    # verify_config_integrity has already passed.
    if st.st_nlink != 1:
        print(f"[SECURITY] Refusing Hermes layout repair because {path} has hard-link count {st.st_nlink}", file=sys.stderr)
        sys.exit(1)

    if os.geteuid() == 0:
        try:
            uid = pwd.getpwnam("sandbox").pw_uid
            gid = grp.getgrnam("sandbox").gr_gid
        except KeyError as exc:
            print(f"[SECURITY] Refusing Hermes layout repair because sandbox account lookup failed: {exc}", file=sys.stderr)
            sys.exit(1)
        os.fchown(fd, uid, gid)
    os.fchmod(fd, mode)

    st = os.fstat(fd)
    try:
        current = os.stat(path, follow_symlinks=False)
    except OSError as exc:
        print(f"[SECURITY] Refusing Hermes layout repair because {path} no longer names the opened history file: {exc.strerror}", file=sys.stderr)
        sys.exit(1)
    if (current.st_dev, current.st_ino) != (st.st_dev, st.st_ino):
        print(f"[SECURITY] Refusing Hermes layout repair because {path} changed during repair", file=sys.stderr)
        sys.exit(1)
finally:
    os.close(fd)
PYHISTORY
}

repair_hermes_startup_layout() {
  # The cron execution and Discord recovery ledgers are created by gateway and
  # backed up/restored by sandbox. Maintain their descriptor-verified,
  # group-writable runtime and gateway parents even when the rest of the config
  # root is locked while Shields up is active or was wiped. The cron directory
  # contains cron job definitions and must remain sealed.
  # The Fabric adapter writes artifacts as the sandbox identity. Provision its
  # directory before checking the locked-root posture so the first Fabric turn
  # after Shields up does not need to create a child beneath root-owned .hermes.
  if ! ensure_hermes_cross_uid_state_dir fabric-artifacts sandbox; then
    echo "[gateway] Hermes pre-launch layout repair failed at Fabric artifacts directory" >&2
    return 1
  fi
  if ! ensure_hermes_cross_uid_state_dir gateway; then
    echo "[gateway] Hermes pre-launch layout repair failed at gateway state directory" >&2
    return 1
  fi
  if ! ensure_hermes_cross_uid_state_dir runtime; then
    echo "[gateway] Hermes pre-launch layout repair failed at runtime state directory" >&2
    return 1
  fi

  if hermes_config_root_is_locked; then
    # The locked-root posture seals config.yaml/.env, not the dir. The gateway
    # and runtime state parents were maintained above; also bring a missing
    # prompt_toolkit history file into existence as a sandbox-owned regular
    # file. Sandboxes built before the precreate landed would otherwise stay
    # broken until the next `shields down` cycle.
    # Refusal (symlink, non-regular, create failure) is a hard stop: starting
    # the gateway with an unsafe .hermes_history under a locked root would
    # either let the TUI clobber an attacker-pointed path or repeat the
    # original keypress traceback.
    echo "[gateway] Hermes layout repair limited to history file because config root is locked" >&2
    if ! ensure_hermes_history_file "${HERMES_DIR}/.hermes_history" 660; then
      echo "[gateway] Hermes pre-launch layout repair failed at history file" >&2
      return 1
    fi
    return 0
  fi

  ensure_hermes_config_root_mode || return 1
  repair_hermes_log_permissions || return 1
  ensure_hermes_state_dir "${HERMES_DIR}/hooks" 770 || return 1
  ensure_hermes_state_dir "${HERMES_DIR}/image_cache" 770 || return 1
  ensure_hermes_state_dir "${HERMES_DIR}/audio_cache" 770 || return 1
  ensure_hermes_history_file "${HERMES_DIR}/.hermes_history" 660 || return 1
}

cleanup_stale_hermes_gateway_runtime() {
  local runtime_dir="${HERMES_DIR}/runtime"

  if has_live_hermes_gateway; then
    echo "[gateway] Existing Hermes gateway process detected; preserving runtime lock state" >&2
    return 0
  fi

  repair_hermes_startup_layout || return 1

  # Hermes can leave gateway.lock behind after Docker GPU recreation kills the
  # old process namespace. Clear it only after confirming no gateway is alive.
  remove_stale_gateway_file "${runtime_dir}/gateway.pid" "runtime PID file"
  remove_stale_gateway_file "${HERMES_DIR}/gateway.pid" "legacy PID file"
  remove_stale_gateway_file "${runtime_dir}/gateway.lock" "lock file"
  cleanup_orphan_socat_forwarders
}
