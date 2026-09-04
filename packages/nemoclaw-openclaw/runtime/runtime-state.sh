# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
# shellcheck shell=bash

# ── Mutable config permission normalize (#2681) ─────────────────
# OpenClaw's control-UI toggles (Enable Dreaming, account toggles, etc.)
# write through mutateConfigFile to /sandbox/.openclaw/openclaw.json.
# In root mode the gateway runs as the gateway UID; the file is owned
# sandbox:sandbox. Without group write, every toggle EACCESs.
#
# Make the mutable-default tree group-readable/writable + setgid so both
# `gateway` (now a member of the sandbox group via Dockerfile.base
# usermod -aG) and `sandbox` can write. Setgid means new files
# inherit group=sandbox regardless of which UID created them, so the
# agent keeps read access.
#
# This also self-heals a sandbox whose mutable config tree was tightened to
# single-user 700/600 by `openclaw doctor --fix` (#4538): every (re)start
# restores the setgid + group-writable contract. Host-side, `nemoclaw <name>
# doctor --fix` and the rebuild post-upgrade repair step apply the same
# normalization without requiring a restart.
resolve_mutable_config_normalizer() {
  local normalizer="/usr/local/lib/nemoclaw/normalize_mutable_config_perms.py"
  if [ -f "$normalizer" ]; then
    printf '%s\n' "$normalizer"
    return 0
  fi
  # A privileged repair may execute only the immutable helper installed in the
  # image. The environment and checkout fallbacks below exist solely for
  # non-root developer/test harnesses, where they cannot change ownership.
  if [ "$(id -u)" -eq 0 ]; then
    return 1
  fi
  if [ -n "${NEMOCLAW_MUTABLE_CONFIG_NORMALIZER:-}" ] \
    && [ -f "${NEMOCLAW_MUTABLE_CONFIG_NORMALIZER}" ]; then
    printf '%s\n' "${NEMOCLAW_MUTABLE_CONFIG_NORMALIZER}"
    return 0
  fi
  if [ -f "packages/nemoclaw-openclaw/runtime/config-permissions.py" ]; then
    printf '%s\n' "packages/nemoclaw-openclaw/runtime/config-permissions.py"
    return 0
  fi
  normalizer="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/config-permissions.py"
  if [ -f "$normalizer" ]; then
    printf '%s\n' "$normalizer"
    return 0
  fi
  return 1
}

normalize_mutable_config_perms() {
  local config_dir="/sandbox/.openclaw"
  local operation="${1:-normalize}"

  if [ "$operation" != "normalize" ] \
    && [ "$operation" != "capture" ] \
    && [ "$operation" != "recover" ]; then
    printf '[SECURITY] Refusing mutable config permission normalization — invalid operation %s\n' "$operation" >&2
    return 1
  fi

  local config_dir_uid
  if ! config_dir_uid="$(
    python3 -I - "$config_dir" <<'PY_CLASSIFY_MUTABLE_CONFIG'
import os
import stat
import sys

try:
    metadata = os.lstat(sys.argv[1])
except FileNotFoundError:
    print("missing")
    raise SystemExit(0)
if not stat.S_ISDIR(metadata.st_mode):
    raise SystemExit(1)
print(metadata.st_uid)
PY_CLASSIFY_MUTABLE_CONFIG
  )"; then
    printf '[SECURITY] Refusing mutable config permission normalization — descriptor-safe classification failed\n' >&2
    return 1
  fi
  [ "$config_dir_uid" = "missing" ] && return 0
  if [ "$config_dir_uid" = "0" ]; then
    [ "$operation" = "normalize" ] || return 0
    # Dockerfile and policy sources establish sandbox:sandbox 2770/660 as the
    # mutable default. #6300 establishes the root-ownership/write regression,
    # but not a broader safe-to-repair state; no in-repo producer has been
    # identified. This compatibility path therefore accepts only the narrow
    # root:root 0700/0600 fixture, under a sandbox:sandbox 0755 parent. That is
    # distinct from #6047's sandbox-owned mode collapse, which the owner-UID
    # normalizer below repairs. Every other root-owned state fails closed.
    # Remove this path once the runtime preserves the declared ownership.
    reclaim_collapsed_mutable_config "$config_dir" || return 1
    return 0
  fi

  local expected_config_dir_uid expected_config_dir_gid
  if [ "$(id -u)" -eq 0 ]; then
    if ! expected_config_dir_uid="$(id -u sandbox)" \
      || ! expected_config_dir_gid="$(id -g sandbox)"; then
      printf '[SECURITY] Refusing mutable config permission normalization — sandbox identity lookup failed\n' >&2
      return 1
    fi
  else
    expected_config_dir_uid="$(id -u)"
    expected_config_dir_gid="$(id -g)"
  fi
  if [ "$config_dir_uid" != "$expected_config_dir_uid" ]; then
    printf '[SECURITY] Refusing mutable config permission normalization — config directory owner UID %s does not match sandbox UID %s\n' \
      "$config_dir_uid" "$expected_config_dir_uid" >&2
    return 1
  fi

  local normalizer
  if ! normalizer="$(resolve_mutable_config_normalizer)"; then
    printf '[SECURITY] Refusing mutable config permission normalization — trusted normalizer is missing\n' >&2
    return 1
  fi

  # Root supervises an owner-UID child and receives the still-open config
  # directory descriptor over a private authenticated socket. The descriptor
  # stays pinned across the privilege boundary, so inode reuse cannot make the
  # root baseline phase act on a substituted tree.
  local -a normalizer_args=(
    "$config_dir"
    "$expected_config_dir_uid"
    "$expected_config_dir_gid"
  )
  if [ "$operation" = "capture" ]; then
    local node_binary
    if ! node_binary="$(command -v node)" || [ -z "$node_binary" ]; then
      printf '[config] ERROR: JSON5 baseline validator failed for openclaw.json\n' >&2
      return 1
    fi
    normalizer_args+=(
      capture
      "$node_binary"
      /opt/nemoclaw/node_modules/json5
    )
  elif [ "$operation" = "recover" ]; then
    normalizer_args+=(recover)
  fi

  if ! python3 -I "$normalizer" "${normalizer_args[@]}"; then
    printf '[SECURITY] Refusing mutable config permission normalization — descriptor-safe repair detected an unsafe link, race, owner, or metadata state\n' >&2
    return 1
  fi
}

# OpenClaw 2026.7.1 requires its startup migration checkpoint to complete
# without warnings before the gateway reports readiness. Older NemoClaw images
# persisted update-check.json as update polling and notification cache. Empty
# placeholders fail JSON parsing, while nonempty files cannot be archived by
# the separate gateway user when a stale root-owned parent remains.
# NemoClaw pins OpenClaw in the image, so discard only a descriptor-pinned,
# stable regular cache file before the mandatory checkpoint.
# Remove this repair after every supported upgrade source stops seeding the
# cache or OpenClaw can migrate it across split users and a protected parent.
remove_openclaw_legacy_update_check_state() {
  local config_dir="/sandbox/.openclaw"
  if [ ! -e "$config_dir" ] && [ ! -L "$config_dir" ]; then
    return 0
  fi

  local normalizer
  if ! normalizer="$(resolve_mutable_config_normalizer)"; then
    printf '[SECURITY] Refusing legacy update-check repair — trusted normalizer is missing\n' >&2
    return 1
  fi
  if ! python3 -I "$normalizer" remove-legacy-update-check "$config_dir"; then
    printf '[SECURITY] Refusing legacy update-check repair — expected a stable regular file or no file\n' >&2
    return 1
  fi
}

classify_openclaw_config_seal() {
  local config_dir="$1"
  local sandbox_uid sandbox_gid
  if [ "$(id -u)" -eq 0 ]; then
    sandbox_uid="$(id -u sandbox)" || return 2
    sandbox_gid="$(id -g sandbox)" || return 2
  else
    sandbox_uid="$(id -u)"
    sandbox_gid="$(id -g)"
  fi
  local normalizer
  normalizer="$(resolve_mutable_config_normalizer)" || return 2
  python3 -I "$normalizer" classify-seal \
    "$config_dir" "$sandbox_uid" "$sandbox_gid" >/dev/null
}

reclaim_collapsed_mutable_config() {
  local config_dir="$1"

  if [ "$(id -u)" -ne 0 ]; then
    if classify_openclaw_config_seal "$config_dir"; then
      return 0
    fi
    printf '[SECURITY] Refusing mutable config reclaim — root privileges are required\n' >&2
    return 1
  fi

  local sandbox_uid sandbox_gid
  if ! sandbox_uid="$(id -u sandbox)" || ! sandbox_gid="$(id -g sandbox)"; then
    printf '[SECURITY] Refusing mutable config reclaim — sandbox identity lookup failed\n' >&2
    return 1
  fi

  local normalizer
  if ! normalizer="$(resolve_mutable_config_normalizer)"; then
    printf '[SECURITY] Refusing mutable config reclaim — trusted normalizer is missing\n' >&2
    return 1
  fi

  if ! python3 -I "$normalizer" reclaim-if-unsealed "$config_dir" "$sandbox_uid" "$sandbox_gid" >/dev/null; then
    printf '[SECURITY] Refusing mutable config reclaim — descriptor-safe reclaim detected an unsafe link, race, owner, or metadata state\n' >&2
    return 1
  fi
}

# Invalid state (#4538, #6047): OpenClaw assumes a single-UID 700/600 config
# tree, while NemoClaw's separate sandbox and gateway UIDs require the mutable
# 2770/660 group contract. The tightening originates at the OpenClaw command
# boundary; NemoClaw owns restoring its multi-UID postcondition afterward.
# Regression proof lives in tests/runtime/config-permissions.test.ts. Issue
# #6047 tracks the boundary and its removal condition: remove this wrapper only
# when the pinned OpenClaw preserves 2770/660 after every command outcome.
run_oneshot_command() {
  local _nemoclaw_runtime_env_file="${_RUNTIME_SHELL_ENV_FILE:-/tmp/nemoclaw-proxy-env.sh}"
  local _nemoclaw_oneshot_child_pid=""
  local _nemoclaw_oneshot_signal=""
  local _nemoclaw_oneshot_wait_rc=0
  local _nemoclaw_oneshot_cleanup_rc=0

  # Bash gives asynchronous commands /dev/null stdin and an ignored SIGINT
  # when job control is off. The explicit stdin and signal reset preserve the
  # foreground command contract; exec keeps the launched command as our one
  # direct child rather than adding a forwarding process.
  (
    trap - TERM INT
    # Source the root-owned runtime environment before stepping down so PID-1
    # one-shot commands use the same proxy, state, and gateway routing contract
    # as connect-shell and host `exec` commands.
    # shellcheck source=/dev/null
    if [ -r "$_nemoclaw_runtime_env_file" ]; then
      builtin source "$_nemoclaw_runtime_env_file" || exit $?
    fi
    # The shared, sandbox-readable file also exports the gateway token.
    # Remove it from the child's ambient environment so ordinary one-shot argv
    # uses local device auth and does not print it accidentally. This is not a
    # secrecy boundary against a command that deliberately reads the file.
    builtin unset OPENCLAW_GATEWAY_TOKEN
    builtin exec -- "$@"
  ) <&0 &
  _nemoclaw_oneshot_child_pid=$!
  trap '_nemoclaw_oneshot_signal=TERM; kill -TERM "$_nemoclaw_oneshot_child_pid" 2>/dev/null || true' TERM
  trap '_nemoclaw_oneshot_signal=INT; kill -INT "$_nemoclaw_oneshot_child_pid" 2>/dev/null || true' INT

  # A trapped signal interrupts `wait`. Forward it above, then wait again so
  # the direct child is reaped and its final status remains authoritative.
  while :; do
    _nemoclaw_oneshot_signal=""
    if wait "$_nemoclaw_oneshot_child_pid"; then
      _nemoclaw_oneshot_wait_rc=0
    else
      _nemoclaw_oneshot_wait_rc=$?
    fi
    [ -n "$_nemoclaw_oneshot_signal" ] || break
  done
  _nemoclaw_oneshot_child_pid=""

  if normalize_mutable_config_perms; then
    _nemoclaw_oneshot_cleanup_rc=0
  else
    _nemoclaw_oneshot_cleanup_rc=$?
  fi
  trap - TERM INT

  if [ "$_nemoclaw_oneshot_cleanup_rc" -ne 0 ]; then
    printf '[one-shot] command status=%s; permission cleanup status=%s; returning cleanup failure\n' \
      "$_nemoclaw_oneshot_wait_rc" "$_nemoclaw_oneshot_cleanup_rc" >&2
    return "$_nemoclaw_oneshot_cleanup_rc"
  fi
  return "$_nemoclaw_oneshot_wait_rc"
}

openclaw_config_dir_owner() {
  local config_dir="$1"
  stat -c '%U' "$config_dir" 2>/dev/null || stat -f '%Su' "$config_dir" 2>/dev/null || echo unknown
}

prepare_openclaw_config_startup() {
  run_openclaw_config_guard revoke-startup-ready --startup-owner || return 1

  # Repair only the known #6300 root:root 0700/0600 mutable tree. Any other
  # root-owned posture requires rebuild or recreation.
  if [ "$(openclaw_config_dir_owner /sandbox/.openclaw)" = "root" ]; then
    local seal_state=0
    classify_openclaw_config_seal /sandbox/.openclaw || seal_state=$?
    case "$seal_state" in
      2) ;;
      1) reclaim_collapsed_mutable_config /sandbox/.openclaw || return 1 ;;
      *)
        printf '[SECURITY] Existing OpenClaw config is not in the supported mutable posture. Rebuild or recreate the sandbox.\n' >&2
        return 1
        ;;
    esac
  fi
  run_openclaw_config_guard recover --startup-owner || return 1
}

run_openclaw_config_as_owner() {
  if [ "$(id -u)" -eq 0 ]; then
    case "${1:-}" in
      /*) ;;
      *)
        printf '[SECURITY] Refusing privileged config I/O dispatch — executable path is not absolute\n' >&2
        return 1
        ;;
    esac
    /usr/bin/env -i HOME=/sandbox PATH=/usr/local/bin:/usr/bin:/bin \
      "${STEP_DOWN_PREFIX_SANDBOX[@]}" "$@"
    return $?
  fi
  "$@"
}

# ── Empty-config recovery and baseline (#3118) ──────────────────
# Upstream OpenShell's `openshell inference set` (run inside the sandbox to
# change the runtime model) can truncate /sandbox/.openclaw/openclaw.json to
# 0 bytes when its write fails partway through. The corrupted file then
# breaks `openclaw doctor --fix` (its own JSON5.parse crashes on empty
# input) and any other consumer of the config.
#
# These two functions are NemoClaw's defensive recovery — they don't fix the
# upstream bugs (which still need to be filed against OpenShell and OpenClaw)
# but they let a sandbox restart restore working state instead of leaving the
# sandbox unusable. The recovery applies only to the supported mutable config
# posture required by the #3118 trigger.
# Remove this recovery only after upstream writes can no longer truncate
# openclaw.json and regression coverage proves the empty-config state cannot
# recur at any supported inference-update boundary.

# Capture a known-good copy of openclaw.json for later restore. A pristine
# root-owned baseline is retained; a sandbox-owned candidate is replaced from
# the exact validated active-config descriptor. Runs at root after
# apply_model_override and apply_cors_override so the baseline reflects the
# post-override config that the user actually started with. Refuses to capture
# broken state (empty, whitespace-only, or unparseable input).
write_openclaw_config_baseline() {
  local config_dir="/sandbox/.openclaw"
  local config_file="$config_dir/openclaw.json"
  local baseline_file="$config_dir/openclaw.json.nemoclaw-baseline"

  [ -d "$config_dir" ] || return 0
  [ -f "$config_file" ] || return 0
  [ "$(id -u)" -eq 0 ] || return 0

  local baseline_existed=0
  [ -e "$baseline_file" ] && baseline_existed=1

  # Capture and lock through the same pinned directory descriptor used by
  # permission normalization. The permanently dropped child validates and
  # pins the exact active config; root copies that descriptor into a fresh
  # inode. No root path-based cp/chown/chmod operation follows an
  # attacker-swappable entry in the mutable directory.
  normalize_mutable_config_perms capture || return 1
  if [ "$baseline_existed" -eq 0 ] && [ -f "$baseline_file" ]; then
    printf '[config] Baseline snapshot created: %s\n' "$baseline_file" >&2
  fi
}

# Restore openclaw.json from a baseline when the active file has been
# truncated to 0 bytes / whitespace-only. Prefers OpenClaw's own
# openclaw.json.last-good (if it exists and is non-empty) over our
# nemoclaw-baseline so we ride OpenClaw's recovery convention when both
# are available. Recomputes .config-hash on success so subsequent
# integrity checks pass.
recover_openclaw_config_if_empty() {
  local config_dir="/sandbox/.openclaw"
  local config_file="$config_dir/openclaw.json"

  [ -d "$config_dir" ] || return 0
  [ -f "$config_file" ] || return 0

  # The owner-identity phase pins the mutable directory and recovery source,
  # then installs fresh sandbox-owned config/hash inodes with dir-fd-relative
  # atomic replaces. Root never follows, writes, chowns, or chmods an existing
  # sandbox-controlled pathname.
  normalize_mutable_config_perms recover
}

# Refresh the mutable-default .config-hash so it matches the current native
# and Fabric configs. Independent of the #3118 recovery above — this runs on
# every start after the override pipeline to keep the hash in sync with
# any in-flight config edits (model override, CORS override, provider
# placeholder refresh).
ensure_mutable_openclaw_config_hash() {
  local config_dir="/sandbox/.openclaw"
  local config_file="${config_dir}/openclaw.json"
  local fabric_file="${config_dir}/fabric.json"
  local hash_file="${config_dir}/.config-hash"

  [ -f "$config_file" ] || return 0
  [ -f "$fabric_file" ] || return 1
  if [ -L "$config_dir" ] || [ -L "$config_file" ] || [ -L "$fabric_file" ] || [ -L "$hash_file" ]; then
    printf '[SECURITY] Refusing mutable config hash refresh — config directory or file path is a symlink\n' >&2
    return 1
  fi

  # Mutable mode: $config_dir is 2770 sandbox:sandbox and
  # $hash_file is 660 sandbox:sandbox. Without CAP_DAC_OVERRIDE root
  # cannot bypass the sandbox-only write bit and the redirection
  # aborts with EACCES, so step down to the file's owner for the write.
  # shellcheck disable=SC2016  # positional params are expanded by the inner sh
  if [ "$(id -u)" -eq 0 ]; then
    if ! /usr/bin/env -i HOME=/sandbox PATH=/usr/local/bin:/usr/bin:/bin \
      "${STEP_DOWN_PREFIX_SANDBOX[@]}" /bin/sh -c '
      cd "$1" || exit 1
      /usr/bin/sha256sum openclaw.json fabric.json >".config-hash" || exit 1
      /usr/bin/chmod 660 ".config-hash" 2>/dev/null || true
    ' _ "$config_dir"; then
      printf '[SECURITY] Failed to refresh mutable OpenClaw config hash\n' >&2
      return 1
    fi
  elif ! sh -c '
    cd "$1" || exit 1
    /usr/bin/sha256sum openclaw.json fabric.json >".config-hash" || exit 1
    /usr/bin/chmod 660 ".config-hash" 2>/dev/null || true
  ' _ "$config_dir"; then
    printf '[SECURITY] Failed to refresh mutable OpenClaw config hash\n' >&2
    return 1
  fi
}
