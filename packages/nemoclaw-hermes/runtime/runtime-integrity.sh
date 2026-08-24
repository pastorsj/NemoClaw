# shellcheck shell=bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
# Migrate legacy state and protect configuration across managed restarts.
# shellcheck disable=SC2034 # Globals are consumed by the sourced gateway workflow.

# ── Legacy layout migration ──────────────────────────────────────
path_has_immutable_bit() {
  local target="$1"
  command -v lsattr >/dev/null 2>&1 || return 1
  [ -e "$target" ] || [ -L "$target" ] || return 1
  lsattr -d "$target" 2>/dev/null | awk '{print $1}' | grep -q 'i'
}

ensure_mutable_for_migration() {
  local target="$1" label="$2"
  if ! path_has_immutable_bit "$target"; then
    return 0
  fi
  if command -v chattr >/dev/null 2>&1 && chattr -i "$target" 2>/dev/null; then
    return 0
  fi
  echo "[SECURITY] ${label}: ${target} is immutable; run 'nemoclaw <sandbox> shields down' before migration" >&2
  return 1
}

chown_tree_no_symlink_follow() {
  local owner="$1" target="$2"
  [ -d "$target" ] || return 0
  find -P "$target" \( -type d -o -type f \) -exec chown "$owner" {} + 2>/dev/null || true
}

legacy_symlinks_exist() {
  local config_dir="$1" data_dir="$2"
  local data_real entry target
  data_real="$(readlink -f "$data_dir" 2>/dev/null || echo "$data_dir")"
  for entry in "$config_dir"/.[!.]* "$config_dir"/..?* "$config_dir"/*; do
    [ -L "$entry" ] || continue
    target="$(readlink -f "$entry" 2>/dev/null || readlink "$entry" 2>/dev/null || true)"
    case "$target" in
      "$data_real"/* | "$data_dir"/*) return 0 ;;
    esac
  done
  return 1
}

assert_no_legacy_layout() {
  local config_dir="$1" data_dir="$2" label="$3"
  local data_real entry target
  if [ -e "$data_dir" ] || [ -L "$data_dir" ]; then
    echo "[SECURITY] ${label}: legacy data dir still exists after migration: ${data_dir}" >&2
    return 1
  fi
  data_real="$(readlink -f "$data_dir" 2>/dev/null || echo "$data_dir")"
  for entry in "$config_dir"/.[!.]* "$config_dir"/..?* "$config_dir"/*; do
    [ -L "$entry" ] || continue
    target="$(readlink -f "$entry" 2>/dev/null || readlink "$entry" 2>/dev/null || true)"
    case "$target" in
      "$data_real"/* | "$data_dir"/*)
        echo "[SECURITY] ${label}: legacy symlink remains after migration: ${entry} -> ${target}" >&2
        return 1
        ;;
    esac
  done
}

migrate_legacy_layout() {
  local config_dir="$1" data_dir="$2" label="$3"
  if [ -L "$config_dir" ]; then
    echo "[SECURITY] ${label}: refusing migration because ${config_dir} is a symlink" >&2
    return 1
  fi
  if [ -L "$data_dir" ]; then
    echo "[SECURITY] ${label}: refusing migration because ${data_dir} is a symlink" >&2
    return 1
  fi

  local sentinel="${config_dir}/.migration-complete"
  if [ -e "$sentinel" ] || [ -L "$sentinel" ]; then
    local sentinel_uid sentinel_mode
    sentinel_uid="$(stat -c '%u' "$sentinel" 2>/dev/null || stat -f '%u' "$sentinel" 2>/dev/null || echo "unknown")"
    sentinel_mode="$(stat -c '%a' "$sentinel" 2>/dev/null || stat -f '%Lp' "$sentinel" 2>/dev/null || echo "unknown")"
    if [ -f "$sentinel" ] && [ ! -L "$sentinel" ] && [ "$sentinel_uid" = "0" ] && [ "$sentinel_mode" != "unknown" ] && (((8#$sentinel_mode & 0222) == 0)); then
      if [ ! -d "$data_dir" ] && ! legacy_symlinks_exist "$config_dir" "$data_dir"; then
        echo "[migration] ${label}: already migrated (trusted sentinel exists), skipping" >&2
        return 0
      fi
      echo "[migration] ${label}: trusted sentinel exists but legacy artifacts remain; repairing" >&2
      ensure_mutable_for_migration "$sentinel" "$label" || return 1
      rm -f "$sentinel" || return 1
    else
      echo "[SECURITY] ${label}: ignoring untrusted migration sentinel ${sentinel}" >&2
      ensure_mutable_for_migration "$sentinel" "$label" || return 1
      rm -f "$sentinel" || return 1
    fi
  fi

  if [ ! -d "$data_dir" ]; then
    assert_no_legacy_layout "$config_dir" "$data_dir" "$label"
    return $?
  fi

  if [ "$(id -u)" -ne 0 ]; then
    echo "[SECURITY] ${label}: migration skipped — requires root" >&2
    return 0
  fi

  local data_owner
  data_owner="$(stat -c '%U' "$data_dir" 2>/dev/null || stat -f '%Su' "$data_dir" 2>/dev/null || echo "unknown")"
  if [ "$data_owner" = "sandbox" ] && ! legacy_symlinks_exist "$config_dir" "$data_dir"; then
    echo "[SECURITY] ${label}: sandbox-owned ${data_dir} has no legacy symlink bridge — refusing migration (possible agent-planted trigger)" >&2
    return 1
  fi

  if [ "$(stat -c '%U' "$config_dir" 2>/dev/null || stat -f '%Su' "$config_dir" 2>/dev/null || echo "unknown")" = "root" ]; then
    echo "[SECURITY] ${label}: legacy layout appears shielded; run 'nemoclaw <sandbox> shields down' before migration" >&2
    return 1
  fi

  ensure_mutable_for_migration "$config_dir" "$label" || return 1
  ensure_mutable_for_migration "$data_dir" "$label" || return 1

  echo "[migration] Detected legacy ${label} layout (${data_dir} exists), migrating..." >&2
  for entry in "$data_dir"/.[!.]* "$data_dir"/..?* "$data_dir"/*; do
    [ -e "$entry" ] || [ -L "$entry" ] || continue
    if [ -L "$entry" ]; then
      echo "[SECURITY] ${label}: refusing migration because ${entry} is a symlink" >&2
      return 1
    fi
    ensure_mutable_for_migration "$entry" "$label" || return 1
    local name
    name="$(basename "$entry")"
    local target="${config_dir}/${name}"
    if [ -L "$target" ]; then
      ensure_mutable_for_migration "$target" "$label" || return 1
      rm -f "$target"
      cp -a "$entry" "$target"
    elif [ -d "$target" ] && [ -d "$entry" ]; then
      ensure_mutable_for_migration "$target" "$label" || return 1
      cp -a "$entry"/. "$target"/
    elif [ ! -e "$target" ]; then
      cp -a "$entry" "$target"
    fi
  done
  for entry in "$config_dir"/.[!.]* "$config_dir"/..?* "$config_dir"/*; do
    [ -L "$entry" ] && continue
    [ -d "$entry" ] || continue
    chown_tree_no_symlink_follow sandbox:sandbox "$entry"
  done
  rm -rf "$data_dir"
  assert_no_legacy_layout "$config_dir" "$data_dir" "$label" || return 1
  printf 'migrated=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$sentinel"
  chown root:root "$sentinel" 2>/dev/null || true
  chmod 444 "$sentinel" 2>/dev/null || true
  echo "[migration] Completed ${label} layout migration (${data_dir} removed)" >&2
}

refresh_hermes_provider_placeholders() {
  local mode="${1:-strict}"
  local env_file="${HERMES_DIR}/.env"
  local runtime_plan="/usr/local/share/nemoclaw/messaging-runtime-plan.json"
  [ -f "$env_file" ] || return 0

  local args=(
    "$_HERMES_RUNTIME_CONFIG_GUARD" provider-placeholders
    --hermes-dir "$HERMES_DIR"
    --hash-file "$HERMES_HASH_FILE"
    --boundary-validator "$_HERMES_BOUNDARY_VALIDATOR"
    --mode "$mode"
    --startup-owner
  )
  if [ -f "$runtime_plan" ]; then
    args+=(--runtime-plan "$runtime_plan")
  fi
  "$_HERMES_PYTHON" -I "${args[@]}"
  validate_hermes_env_secret_boundary
}

refresh_hermes_runtime_config_hashes() {
  local mode="${1:-strict}"
  # A locked root seals config.yaml, .env, and .config-hash as root-owned, and
  # the lock transaction already wrote a coherent hash for them. The compat
  # refresh runs as the sandbox identity, which by design cannot replace a
  # sealed hash: the sticky config root refuses the rename, so every launch
  # under shields failed here and the supervisor stopped respawning (#7865).
  # There is also nothing to refresh, because the sealed inputs cannot drift.
  # The MCP integrity inspection that follows still validates the sealed hash,
  # so a genuinely incoherent locked tree keeps failing closed.
  if [ "$mode" = "compat" ] && hermes_config_root_is_locked; then
    return 0
  fi
  local cmd=(
    "$_HERMES_PYTHON" -I "$_HERMES_RUNTIME_CONFIG_GUARD" refresh-hashes
    --hermes-dir "$HERMES_DIR"
    --hash-file "$HERMES_HASH_FILE"
    --mode "$mode"
    --startup-owner
  )
  if [ "$mode" = "compat" ] && [ "$(id -u)" -eq 0 ]; then
    "${STEP_DOWN_PREFIX_SANDBOX[@]}" "${cmd[@]}"
    return $?
  fi
  "${cmd[@]}"
}

inspect_hermes_mcp_integrity() {
  local hash_file="${1:-}"
  local guard_status
  local -a guard_command
  [ -n "$hash_file" ] || {
    if [ "$(id -u)" -eq 0 ]; then
      hash_file="$HERMES_HASH_FILE"
    else
      hash_file="${HERMES_DIR}/.config-hash"
    fi
  }
  # Keep the guard as the startup owner's direct child. A command
  # substitution here would interpose a shell process and invalidate the
  # exact-parent proof used by --startup-owner. State is returned only through
  # the kernel-owned exit status: 0=current, 10=pending, anything else=failure.
  # This avoids a same-UID writable result file or ambiguous shell byte parsing.
  guard_command=(
    "$_HERMES_PYTHON" -I "$_HERMES_RUNTIME_CONFIG_GUARD" inspect-mcp-integrity
    --hermes-dir "$HERMES_DIR"
    --hash-file "$hash_file"
    --startup-owner
    --mcp-state-exit-code
  )
  if [ "$(id -u)" -eq 0 ]; then
    # Hardened managed runtimes can remove root's DAC override before startup.
    # Read the sandbox-owned mutable config through its owning identity; the
    # step-down exec still leaves the guard as the startup owner's direct child.
    guard_command=("${STEP_DOWN_PREFIX_SANDBOX[@]}" "${guard_command[@]}")
  fi
  if "${guard_command[@]}" >/dev/null; then
    guard_status=0
  else
    guard_status=$?
  fi
  case "$guard_status" in
    0) HERMES_MCP_RECONCILE_PENDING=0 ;;
    10) HERMES_MCP_RECONCILE_PENDING=1 ;;
    *)
      HERMES_MCP_INTEGRITY_FAILED=1
      echo "[SECURITY] HERMES_MCP_CONFIG_DRIFT: MCP intent cannot be matched to the persisted gateway state; rebuild the sandbox from its NemoClaw registry state" >&2
      return 1
      ;;
  esac
  HERMES_MCP_INTEGRITY_FAILED=0
}

commit_hermes_mcp_applied_if_pending() {
  local mode=compat
  [ "$HERMES_MCP_RECONCILE_PENDING" -eq 1 ] || return 0
  [ "$(id -u)" -eq 0 ] && mode=both
  "$_HERMES_PYTHON" -I "$_HERMES_RUNTIME_CONFIG_GUARD" commit-mcp-applied \
    --hermes-dir "$HERMES_DIR" \
    --hash-file "$HERMES_HASH_FILE" \
    --mode "$mode" \
    --startup-owner >/dev/null || return 1
  HERMES_MCP_RECONCILE_PENDING=0
}

ensure_hermes_runtime_api_server_key() {
  local mode="${1:-strict}"
  local env_file="${HERMES_DIR}/.env"
  local result_file
  local guard_status
  [ -f "$env_file" ] || return 0

  local result
  if [ "$EUID" -eq 0 ] && [ -d /run/nemoclaw ] && [ -w /run/nemoclaw ]; then
    result_file="$(mktemp /run/nemoclaw/hermes-api-key-result.XXXXXX)" || return 1
  else
    result_file="$(mktemp "${TMPDIR:-/tmp}/hermes-api-key-result.XXXXXX")" || return 1
  fi
  chmod 600 "$result_file" || {
    rm -f "$result_file"
    return 1
  }
  # Keep the guard as the startup owner's direct child: --startup-owner is
  # authenticated by exact parent identity. Its own alarm bounds this call;
  # wrapping it in `timeout` would interpose a different parent process.
  if "$_HERMES_PYTHON" -I "$_HERMES_RUNTIME_CONFIG_GUARD" ensure-api-key \
    --hermes-dir "$HERMES_DIR" \
    --hash-file "$HERMES_HASH_FILE" \
    --mode "$mode" \
    --startup-owner >"$result_file"; then
    guard_status=0
  else
    guard_status=$?
  fi
  IFS= read -r result <"$result_file" || result=""
  rm -f "$result_file"
  [ "$guard_status" -eq 0 ] || return "$guard_status"

  case "$result" in
    minted=0) return 0 ;;
    updated=1)
      if [ "$mode" = "strict" ]; then
        refresh_hermes_runtime_config_hashes compat
      fi
      return 0
      ;;
    minted=1) ;;
    *)
      echo "[config] Unexpected Hermes API key mint result: ${result}" >&2
      return 1
      ;;
  esac

  if [ "$mode" = "strict" ]; then
    refresh_hermes_runtime_config_hashes compat
  fi
  echo "[config] Minted Hermes API_SERVER_KEY for this sandbox and refreshed config hash" >&2
}

validate_hermes_env_secret_boundary() {
  local env_file="${HERMES_DIR}/.env"
  if [ -L "$env_file" ]; then
    echo "[SECURITY] Refusing Hermes startup because ${env_file} is a symlink" >&2
    return 1
  fi
  # `_HERMES_PYTHON` was resolved from the trusted absolute-path list earlier;
  # use it here so a PATH-shadowed `python3` cannot substitute the validator.
  "${_HERMES_BOUNDARY_TIMEOUT[@]}" \
    "$_HERMES_PYTHON" -I "$_HERMES_BOUNDARY_VALIDATOR" env-file "$env_file"
}

validate_hermes_runtime_env_secret_boundary() {
  "${_HERMES_BOUNDARY_TIMEOUT[@]}" \
    "$_HERMES_PYTHON" -I "$_HERMES_BOUNDARY_VALIDATOR" runtime-env
}

hermes_gateway_healthy() {
  local pid="$1"
  local code
  local service_user=current
  [ "$(id -u)" -eq 0 ] && service_user=gateway
  hermes_tracked_role_is_current gateway "$pid" "$service_user" "$INTERNAL_PORT" || return 1
  code="$(curl -so /dev/null -w '%{http_code}' --max-time 2 \
    "http://127.0.0.1:${INTERNAL_PORT}/health" 2>/dev/null || echo 000)"
  case "$code" in
    200 | 401) hermes_tracked_service_owns_listener "$pid" "$INTERNAL_PORT" gateway ;;
    *) return 1 ;;
  esac
}

HERMES_RESTART_FAILURE_CODE=internal

hermes_restart_failure_revokes_gateway() {
  case "${1:-}" in
    secret-boundary-refusal | mcp-integrity) return 0 ;;
    *) return 1 ;;
  esac
}

validate_running_hermes_boundary() {
  HERMES_RESTART_FAILURE_CODE=validator-missing
  [ -f "$_HERMES_BOUNDARY_VALIDATOR" ] || return 1
  HERMES_RESTART_FAILURE_CODE=secret-boundary-refusal
  validate_hermes_env_secret_boundary || return 1
  validate_hermes_runtime_env_secret_boundary || return 1
  HERMES_RESTART_FAILURE_CODE=preload-missing
  # shellcheck disable=SC2119
  validate_tmp_permissions || return 1
}

prepare_hermes_gateway_restart() {
  if ! validate_running_hermes_boundary; then
    return 1
  fi

  # A restart is a lifecycle action, not authority to bless arbitrary bytes
  # written by the sandbox user. Supported host config commands refresh the
  # root-owned strict hash when they make a change; direct in-sandbox edits do
  # not. Require that trusted anchor for both mutable-default and shields-up
  # sandboxes instead of chowning attacker-controlled paths or adopting a new
  # hash here.
  HERMES_RESTART_FAILURE_CODE=hash-mismatch
  verify_hermes_config_integrity || return 1
  prepare_hermes_lazy_dependencies
}

hermes_restart_unseal_on_exit() {
  [ "$HERMES_RESTART_SEALED" -eq 1 ] || return 0
  [ "$HERMES_RESTART_UNSEALING" -eq 0 ] || return 1
  unseal_hermes_restart_inputs || true
}

hermes_restart_cleanup_on_signal() {
  if [ "$HERMES_RESTART_UNSEALING" -eq 1 ]; then
    HERMES_RESTART_SIGNAL_PENDING=1
    return 0
  fi
  stop_hermes_gateway_fail_closed
  if [ "$HERMES_RESTART_SEALED" -eq 1 ]; then
    unseal_hermes_restart_inputs || true
  fi
  refresh_hermes_supervised_child_pids
  hermes_cleanup_on_signal
}

install_hermes_restart_seal_traps() {
  trap hermes_restart_unseal_on_exit EXIT
  trap hermes_restart_cleanup_on_signal SIGTERM SIGINT HUP
}

restore_hermes_runtime_traps() {
  trap - EXIT HUP
  trap hermes_cleanup_on_signal SIGTERM SIGINT
}

seal_hermes_restart_inputs() {
  local output
  local owner_output
  local original_failure_code
  HERMES_RESTART_FAILURE_CODE=unsafe-config
  HERMES_RESTART_SEALED=0
  install_hermes_restart_seal_traps
  if ! output="$(
    ${_HERMES_GUARD_TIMEOUT[@]+"${_HERMES_GUARD_TIMEOUT[@]}"} "$_HERMES_PYTHON" -I "$_HERMES_RUNTIME_CONFIG_GUARD" seal-restart \
      --hermes-dir "$HERMES_DIR" \
      --hash-file "$HERMES_HASH_FILE" \
      --state-file "$HERMES_RESTART_SEAL_STATE" \
      --lock-token "$GATEWAY_CONTROL_NONCE" 2>&1
  )"; then
    printf '%s\n' "$output" >&2
    case "$output" in
      *"strict hash verification failed"*) HERMES_RESTART_FAILURE_CODE=hash-mismatch ;;
    esac
    # The guard normally rolls back failures it owns. If rollback itself was
    # interrupted, recover only a state whose cryptographic token is this
    # request nonce. A concurrent config/shields transaction has a different
    # token and must never be unsealed or used as authority to stop the healthy
    # gateway.
    original_failure_code="$HERMES_RESTART_FAILURE_CODE"
    if owner_output="$(
      ${_HERMES_GUARD_TIMEOUT[@]+"${_HERMES_GUARD_TIMEOUT[@]}"} "$_HERMES_PYTHON" -I "$_HERMES_RUNTIME_CONFIG_GUARD" inspect-mutation-owner \
        --hermes-dir "$HERMES_DIR" \
        --state-file "$HERMES_RESTART_SEAL_STATE" \
        --lock-token "$GATEWAY_CONTROL_NONCE" 2>&1
    )"; then
      case "$owner_output" in
        *"token_match=1"*)
          case "$owner_output" in
            *"original_locked=1"*) HERMES_RESTART_ORIGINAL_LOCKED=1 ;;
            *) HERMES_RESTART_ORIGINAL_LOCKED=0 ;;
          esac
          HERMES_RESTART_SEALED=1
          if unseal_hermes_restart_inputs; then
            HERMES_RESTART_FAILURE_CODE="$original_failure_code"
          fi
          return 1
          ;;
      esac
    else
      printf '%s\n' "$owner_output" >&2
    fi
    restore_hermes_runtime_traps
    return 1
  fi
  case "$output" in
    *"original_locked=1"*) HERMES_RESTART_ORIGINAL_LOCKED=1 ;;
    *) HERMES_RESTART_ORIGINAL_LOCKED=0 ;;
  esac
  HERMES_RESTART_SEALED=1
}

unseal_hermes_restart_inputs() {
  local output
  if [ "$HERMES_RESTART_SEALED" -ne 1 ] && [ ! -e "$HERMES_RESTART_SEAL_STATE" ]; then
    return 0
  fi
  if [ "$HERMES_RESTART_UNSEALING" -eq 1 ]; then
    HERMES_RESTART_FAILURE_CODE=unsafe-config
    return 1
  fi
  HERMES_RESTART_UNSEALING=1
  trap 'HERMES_RESTART_SIGNAL_PENDING=1' SIGTERM SIGINT HUP
  if ! output="$(
    ${_HERMES_GUARD_TIMEOUT[@]+"${_HERMES_GUARD_TIMEOUT[@]}"} "$_HERMES_PYTHON" -I "$_HERMES_RUNTIME_CONFIG_GUARD" unseal-restart \
      --hermes-dir "$HERMES_DIR" \
      --state-file "$HERMES_RESTART_SEAL_STATE" 2>&1
  )"; then
    printf '%s\n' "$output" >&2
    HERMES_RESTART_FAILURE_CODE=unsafe-config
    HERMES_RESTART_UNSEALING=0
    trap hermes_restart_cleanup_on_signal SIGTERM SIGINT HUP
    if [ "$HERMES_RESTART_SIGNAL_PENDING" -eq 1 ]; then
      # Do not recursively retry an unseal that just failed. Retain the token,
      # clear the EXIT retry, and honor the deferred stop signal fail-closed.
      HERMES_RESTART_SIGNAL_PENDING=0
      trap - EXIT HUP TERM INT
      refresh_hermes_supervised_child_pids
      hermes_cleanup_on_signal
    fi
    return 1
  fi
  HERMES_RESTART_SEALED=0
  HERMES_RESTART_UNSEALING=0
  restore_hermes_runtime_traps
  if [ "$HERMES_RESTART_SIGNAL_PENDING" -eq 1 ]; then
    HERMES_RESTART_SIGNAL_PENDING=0
    hermes_cleanup_on_signal
  fi
}

stop_hermes_gateway_fail_closed() {
  if ! hermes_stop_tracked_role gateway "${GATEWAY_PID:-0}" gateway "$INTERNAL_PORT"; then
    echo "[CRITICAL] Hermes gateway revocation could not prove and stop the tracked child; exiting PID 1 for whole-container cleanup without signaling the unproven PID" >&2
    exit 1
  fi
  mark_hermes_gateway_stopped
}

hermes_restart_seal_orphaned() {
  local marker_meta
  local sandbox_meta

  [ ! -e "$HERMES_RESTART_SEAL_STATE" ] || return 1
  marker_meta="$(stat -c '%u:%g %a' "$HERMES_RESTART_ORPHAN_MARKER" 2>/dev/null || true)"
  sandbox_meta="$(stat -c '%u:%g %a' /sandbox 2>/dev/null || true)"
  # Mutable mode keeps /sandbox sandbox-owned. Locked mode deliberately uses
  # root:sandbox with the sticky bit so the sandbox user cannot rename the
  # root-owned .hermes entry. Only an in-flight transaction uses root:root;
  # that remains the durable discriminator when `/run` recovery state is lost.
  case "$marker_meta" in
    "0:0 400") ;;
    *)
      case "$sandbox_meta" in
        "0:0 "*) ;;
        *) return 1 ;;
      esac
      ;;
  esac

  # Hash validation only enriches the diagnostic. Never let missing/partial
  # child seal state turn the recognized orphan transaction into normal start.
  if ! verify_hermes_config_integrity; then
    echo "[SECURITY] Orphaned Hermes restart seal also failed strict hash validation" >&2
  fi
  return 0
}

resume_startup_hermes_shields_lock() {
  local result_file
  local begin_output
  local lock_token

  result_file="$(mktemp "$(dirname "$HERMES_RESTART_SEAL_STATE")/hermes-shields-resume.XXXXXX")" || return 1
  chmod 600 "$result_file" || {
    rm -f "$result_file"
    return 1
  }
  # These guard calls must remain direct PID 1 children. The internal Python
  # alarm is their deadline; the recursive helper is separately wrapped by the
  # container-side timeout because it has no startup-owner parent contract.
  if ! "$_HERMES_PYTHON" -I "$_HERMES_RUNTIME_CONFIG_GUARD" begin-shields-transition \
    --hermes-dir "$HERMES_DIR" \
    --hash-file "$HERMES_HASH_FILE" \
    --state-file "$HERMES_RESTART_SEAL_STATE" \
    --shields-mode locked \
    --startup-owner >"$result_file"; then
    rm -f "$result_file"
    return 1
  fi
  IFS= read -r begin_output <"$result_file" || begin_output=""
  rm -f "$result_file"
  case "$begin_output" in
    lock_token=*" original_locked="[01])
      lock_token="${begin_output#lock_token=}"
      lock_token="${lock_token%% *}"
      ;;
    *)
      echo "[SECURITY] Invalid Hermes shields resume response" >&2
      return 1
      ;;
  esac
  if [ "${#lock_token}" -ne 64 ]; then
    echo "[SECURITY] Invalid Hermes shields resume token" >&2
    return 1
  fi
  case "$lock_token" in
    *[!0-9a-f]*)
      echo "[SECURITY] Invalid Hermes shields resume token" >&2
      return 1
      ;;
  esac

  "$_HERMES_PYTHON" -I "$_HERMES_RUNTIME_CONFIG_GUARD" run-state-dir-transition \
    --hermes-dir "$HERMES_DIR" \
    --state-file "$HERMES_RESTART_SEAL_STATE" \
    --state-action lock \
    --lock-token "$lock_token" \
    --startup-owner || return 1
  "$_HERMES_PYTHON" -I "$_HERMES_RUNTIME_CONFIG_GUARD" apply-shields-transition \
    --hermes-dir "$HERMES_DIR" \
    --state-file "$HERMES_RESTART_SEAL_STATE" \
    --lock-token "$lock_token" \
    --startup-owner >/dev/null || return 1
  "$_HERMES_PYTHON" -I "$_HERMES_RUNTIME_CONFIG_GUARD" finish-shields-transition \
    --hermes-dir "$HERMES_DIR" \
    --hash-file "$HERMES_HASH_FILE" \
    --state-file "$HERMES_RESTART_SEAL_STATE" \
    --lock-token "$lock_token" \
    --startup-owner >/dev/null
}

recover_startup_hermes_mutation() {
  local attempts=0
  local owner_output

  while [ -e "$HERMES_CONFIG_MUTATION_LOCK" ] || [ -e "$HERMES_RESTART_SEAL_STATE" ]; do
    if ! owner_output="$(
      ${_HERMES_GUARD_TIMEOUT[@]+"${_HERMES_GUARD_TIMEOUT[@]}"} "$_HERMES_PYTHON" -I "$_HERMES_RUNTIME_CONFIG_GUARD" inspect-mutation-owner \
        --hermes-dir "$HERMES_DIR" \
        --state-file "$HERMES_RESTART_SEAL_STATE" 2>&1
    )"; then
      printf '%s\n' "$owner_output" >&2
      return 1
    fi

    case "$owner_output" in
      *"resumable_lock=1"*)
        if resume_startup_hermes_shields_lock; then
          echo "[security] Resumed interrupted Hermes shields lock before startup" >&2
          attempts=0
          continue
        fi
        echo "[SECURITY] HERMES_SHIELDS_RESUME_PENDING: the root-only shields clamp remains active; retry sandbox startup after the recursive guard can complete" >&2
        return 1
        ;;
    esac

    case "$owner_output" in
      *"owner_active=1"*)
        attempts=$((attempts + 1))
        if [ "$attempts" -ge 300 ]; then
          echo "[SECURITY] HERMES_CONFIG_MUTATION_BUSY: a root config transaction is still active; retry sandbox startup after it finishes" >&2
          return 1
        fi
        sleep 0.1
        continue
        ;;
    esac

    case "$owner_output" in
      *"state=1"*)
        case "$owner_output" in
          *"recovery_safe=0"*)
            echo "[SECURITY] HERMES_CONFIG_MUTATION_ORPHANED: an interrupted shields transition is sealed fail-closed; restore from a trusted backup and recreate the sandbox (an in-place rebuild cannot read the sealed state)" >&2
            return 1
            ;;
        esac
        # The recorded owner is gone. Recovery is now exclusively owned by PID
        # 1; restore the exact metadata/digest transaction before startup reads
        # any mutable Hermes path.
        HERMES_RESTART_SEALED=1
        install_hermes_restart_seal_traps
        unseal_hermes_restart_inputs || return 1
        ;;
      *"lock=1"*)
        if "$_HERMES_PYTHON" -I "$_HERMES_RUNTIME_CONFIG_GUARD" recover-prestate-lock \
          --hermes-dir "$HERMES_DIR" \
          --state-file "$HERMES_RESTART_SEAL_STATE" \
          --startup-owner >/dev/null; then
          echo "[security] Removed a dead Hermes pre-state mutation lock" >&2
          attempts=0
          continue
        fi
        echo "[SECURITY] HERMES_CONFIG_MUTATION_ORPHANED: mutation lock recovery failed; retry startup or restore from a trusted backup" >&2
        return 1
        ;;
      *) return 0 ;;
    esac
  done
}
