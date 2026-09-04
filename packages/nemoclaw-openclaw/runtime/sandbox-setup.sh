# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
# shellcheck shell=bash

# ── Legacy layout migration ──────────────────────────────────────
# Sandboxes created with the OLD base image have:
#   .openclaw/ containing symlinks → .openclaw-data/<subdir>
#   .openclaw-data/ containing real state data
# Migrate to the new layout: real data lives directly in .openclaw/.
# Idempotent: no-op if .openclaw-data doesn't exist.
#
# SECURITY (NC-2227-01): Guard against agent-planted data dirs.
# Only migrate if (a) we are running as root (the agent cannot call
# this path), (b) the data directory is NOT agent-writable (root-owned),
# and (c) a migration-complete sentinel does not already exist.
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
  echo "[SECURITY] ${label}: ${target} cannot be made writable; rebuild or recreate the sandbox" >&2
  return 1
}

chown_tree_no_symlink_follow() {
  local owner="$1" target="$2"
  [ -d "$target" ] || return 0
  find -P "$target" \( -type d -o -type f \) -exec chown "$owner" {} + 2>/dev/null || true
}

legacy_symlinks_exist() {
  local config_dir="$1" data_dir="$2"
  local data_real entry raw_target resolved_target
  data_real="$(readlink -f "$data_dir" 2>/dev/null || echo "$data_dir")"
  for entry in "$config_dir"/.[!.]* "$config_dir"/..?* "$config_dir"/*; do
    [ -L "$entry" ] || continue
    raw_target="$(readlink "$entry" 2>/dev/null || true)"
    resolved_target="$(readlink -f "$entry" 2>/dev/null || true)"
    case "$raw_target" in
      "$data_real"/* | "$data_dir"/*) return 0 ;;
    esac
    case "$resolved_target" in
      "$data_real"/* | "$data_dir"/*) return 0 ;;
    esac
  done
  return 1
}

assert_no_legacy_layout() {
  local config_dir="$1" data_dir="$2" label="$3"
  local data_real entry raw_target resolved_target
  if [ -e "$data_dir" ] || [ -L "$data_dir" ]; then
    echo "[SECURITY] ${label}: legacy data dir still exists after migration: ${data_dir}" >&2
    return 1
  fi
  data_real="$(readlink -f "$data_dir" 2>/dev/null || echo "$data_dir")"
  for entry in "$config_dir"/.[!.]* "$config_dir"/..?* "$config_dir"/*; do
    [ -L "$entry" ] || continue
    raw_target="$(readlink "$entry" 2>/dev/null || true)"
    resolved_target="$(readlink -f "$entry" 2>/dev/null || true)"
    case "$raw_target" in
      "$data_real"/* | "$data_dir"/*)
        echo "[SECURITY] ${label}: legacy symlink remains after migration: ${entry} -> ${raw_target}" >&2
        return 1
        ;;
    esac
    case "$resolved_target" in
      "$data_real"/* | "$data_dir"/*)
        echo "[SECURITY] ${label}: legacy symlink remains after migration: ${entry} -> ${resolved_target}" >&2
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

  # Guard 1: Already migrated — the sentinel proves a prior trusted run.
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

  # Guard 2: Only root may run migration. The sandbox user cannot reach
  # this code path (entrypoint runs as root or the non-root branch never
  # calls migrate), but be explicit.
  if [ "$(id -u)" -ne 0 ]; then
    echo "[SECURITY] ${label}: migration skipped — requires root" >&2
    return 0
  fi

  # Guard 3: Reject agent-planted data directories. A legitimate legacy
  # data dir was created by the image build (root-owned). If the data dir
  # is owned by sandbox, the agent may have planted it to trigger migration.
  local data_owner
  data_owner="$(stat -c '%U' "$data_dir" 2>/dev/null || stat -f '%Su' "$data_dir" 2>/dev/null || echo "unknown")"
  if [ "$data_owner" = "sandbox" ] && ! legacy_symlinks_exist "$config_dir" "$data_dir"; then
    echo "[SECURITY] ${label}: sandbox-owned ${data_dir} has no legacy symlink bridge — refusing migration (possible agent-planted trigger)" >&2
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

  # Only chown state subdirectories, not the config files.
  for entry in "$config_dir"/.[!.]* "$config_dir"/..?* "$config_dir"/*; do
    [ -L "$entry" ] && continue
    [ -d "$entry" ] || continue
    chown_tree_no_symlink_follow sandbox:sandbox "$entry"
  done

  rm -rf "$data_dir"
  assert_no_legacy_layout "$config_dir" "$data_dir" "$label" || return 1

  # Write the migration sentinel (root-owned, read-only) so we never
  # re-run migration on this sandbox.
  printf 'migrated=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$sentinel"
  chown root:root "$sentinel" 2>/dev/null || true
  chmod 444 "$sentinel" 2>/dev/null || true

  echo "[migration] Completed ${label} layout migration (${data_dir} removed)" >&2
}

# Seed default OpenClaw workspace template files when the workspace is
# pristine. OpenClaw normally writes these from bundled templates at first
# agent boot via ensureAgentWorkspace(), but when
# `agents.defaults.skipBootstrap=true` (set by NemoClaw to suppress the
# interactive identity-setup turn) that path short-circuits before any
# template is written, leaving /sandbox/.openclaw/workspace/ empty.
# Reuse OpenClaw's own bundled templates so seeded content matches what
# upstream would have produced. BOOTSTRAP.md is intentionally excluded —
# its presence is what triggers the interactive turn we are skipping.
# Ref: https://github.com/NVIDIA/NemoClaw/issues/3240
seed_default_workspace_templates() {
  local workspace_dir="${1:-/sandbox/.openclaw/workspace}"
  local templates_dir="${2:-}"
  local config_file="${3:-/sandbox/.openclaw/openclaw.json}"

  # #2598: opt-in flag that skips default workspace template seeding for
  # new/pristine workspaces (does NOT delete files already present). Cuts
  # ~3k tokens off OpenClaw's per-turn bootstrap context injection.
  if [ "${NEMOCLAW_MINIMAL_BOOTSTRAP:-}" = "1" ]; then
    echo "[setup] NEMOCLAW_MINIMAL_BOOTSTRAP=1; skipping default workspace template seed" >&2
    return 0
  fi

  if [ ! -f "$config_file" ]; then
    return 0
  fi
  if ! command -v node >/dev/null 2>&1; then
    return 0
  fi
  local skip_bootstrap_check='const fs = require("fs"); const configPath = process.argv[1]; const cfg = JSON.parse(fs.readFileSync(configPath, "utf8")); process.exit(cfg?.agents?.defaults?.skipBootstrap === true ? 0 : 1);'
  if ! node -e "$skip_bootstrap_check" "$config_file" >/dev/null 2>&1; then
    return 0
  fi

  [ -e "$workspace_dir" ] || return 0
  if [ -L "$workspace_dir" ]; then
    echo "[SECURITY] refusing to seed symlinked workspace dir: $workspace_dir" >&2
    return 0
  fi
  [ -d "$workspace_dir" ] || return 0
  # Only seed pristine workspaces — never clobber user content.
  if [ -n "$(ls -A "$workspace_dir" 2>/dev/null)" ]; then
    return 0
  fi
  if [ -z "$templates_dir" ]; then
    local npm_root openclaw_bin openclaw_real openclaw_pkg candidate searched_template_dirs=""
    local openclaw_pkg_roots=()
    npm_root="$(npm root -g 2>/dev/null || true)"
    if [ -n "$npm_root" ]; then
      openclaw_pkg_roots+=("${npm_root}/openclaw")
    fi
    openclaw_pkg_roots+=("/usr/local/lib/node_modules/openclaw")
    if openclaw_bin="$(command -v openclaw 2>/dev/null)"; then
      openclaw_real="$(readlink -f "$openclaw_bin" 2>/dev/null || printf '%s\n' "$openclaw_bin")"
      openclaw_pkg="$(
        if cd "$(dirname "$openclaw_real")/.." 2>/dev/null; then
          pwd -P
        fi
      )"
      if [ -n "$openclaw_pkg" ]; then
        openclaw_pkg_roots+=("$openclaw_pkg")
      fi
    fi

    templates_dir=""
    for openclaw_pkg in "${openclaw_pkg_roots[@]}"; do
      for candidate in \
        "${openclaw_pkg}/docs/reference/templates" \
        "${openclaw_pkg}/dist/docs/reference/templates"; do
        searched_template_dirs="${searched_template_dirs}${searched_template_dirs:+, }${candidate}"
        if [ -d "$candidate" ]; then
          templates_dir="$candidate"
          break
        fi
      done
      [ -n "$templates_dir" ] && break
    done
  fi
  if [ -z "$templates_dir" ] || [ ! -d "$templates_dir" ]; then
    if [ -n "${searched_template_dirs:-}" ]; then
      echo "[setup] openclaw workspace templates dir not found; tried: ${searched_template_dirs}; skipping default workspace seed" >&2
    else
      echo "[setup] openclaw workspace templates dir not found: ${templates_dir}; skipping default workspace seed" >&2
    fi
    return 0
  fi
  local file src dst tmp seeded=0
  for file in AGENTS.md SOUL.md IDENTITY.md USER.md TOOLS.md HEARTBEAT.md; do
    src="$templates_dir/$file"
    dst="$workspace_dir/$file"
    if [ -f "$src" ] && [ ! -e "$dst" ]; then
      tmp="${dst}.tmp.$$"
      if awk '
        NR == 1 && $0 == "---" { in_frontmatter = 1; next }
        in_frontmatter && $0 == "---" { in_frontmatter = 0; next }
        !in_frontmatter { print }
      ' "$src" >"$tmp" 2>/dev/null && mv "$tmp" "$dst" 2>/dev/null; then
        seeded=$((seeded + 1))
      else
        rm -f "$tmp" 2>/dev/null || true
      fi
    fi
  done
  if [ "$seeded" -gt 0 ]; then
    echo "[setup] seeded ${seeded} default workspace template(s) into ${workspace_dir}" >&2
  fi
}

# Extract the literal source of a bash function from its defining file.
#
# Uses `shopt -s extdebug` + `declare -F` to look up the function's
# source location, then prints the function definition byte-exact from
# disk. The opener line MUST match ^<name>\(\) \{$ and the body MUST
# end with a single `}` at column 0; every function dispatched through
# run_step_down_as_sandbox follows that style.
#
# This bypasses `declare -f`'s serialiser, which mis-orders the body of
# functions whose `if`/`while`/`until` condition is a here-doc command:
# `declare -f` places the indented `then`-body command immediately after
# the `<<TAG` opener and before the here-doc body. The step-down shell
# then absorbs the displaced command into the here-doc body, leaves the
# `then` block empty, and aborts on the closing `fi` with
#   syntax error near unexpected token `fi'
# Reading the source bytes off disk preserves the original layout and
# is robust to every here-doc shape, not only the
# here-doc-as-last-statement shape `declare -f` happens to round-trip.
#
# Returns 1 on any of: function not a function, source file unreadable,
# opener line shape unrecognised, or matching closing `}` not found.
_step_down_extract_function() {
  local fn="$1"
  local info src_lineno src_path
  if ! shopt -s extdebug 2>/dev/null; then
    return 1
  fi
  info="$(declare -F "$fn" 2>/dev/null)"
  shopt -u extdebug 2>/dev/null || true
  if [ -z "$info" ]; then
    return 1
  fi
  src_lineno="${info#* }"
  src_lineno="${src_lineno%% *}"
  src_path="${info#* * }"
  if [ -z "$src_lineno" ] || [ -z "$src_path" ] || [ ! -r "$src_path" ]; then
    return 1
  fi
  awk -v start="$src_lineno" -v fn="$fn" '
    NR == start {
      # One-liner shape: `name() { body; }` — entire definition on one line.
      # No heredoc is possible in this shape, so emit and stop.
      if ($0 ~ "^"fn"[[:space:]]*\\(\\)[[:space:]]*\\{.*\\}[[:space:]]*$") {
        print
        exit 0
      }
      # Multi-line shape: `name() {` opener, with the matching `}` on its
      # own line at column 0 at the end of the body. Both production
      # call sites and the test stubs that exercise here-docs follow
      # this convention.
      if ($0 !~ "^"fn"[[:space:]]*\\(\\)[[:space:]]*\\{[[:space:]]*$") {
        exit 1
      }
      in_fn = 1
      print
      next
    }
    !in_fn { next }
    in_heredoc {
      print
      if ($0 == heredoc_tag) in_heredoc = 0
      next
    }
    {
      print
      if (match($0, /<<-?[[:space:]]*['"'"'"]?[A-Za-z_][A-Za-z0-9_]*['"'"'"]?/)) {
        tag = substr($0, RSTART, RLENGTH)
        sub(/^<<-?[[:space:]]*/, "", tag)
        sub(/^['"'"'"]/, "", tag)
        sub(/['"'"'"]$/, "", tag)
        in_heredoc = 1
        heredoc_tag = tag
        next
      }
      if ($0 == "}") exit
    }
    END { if (in_fn && in_heredoc) exit 1 }
  ' "$src_path"
}

# Run one or more locally-defined bash functions as the sandbox user
# without round-tripping through `bash -c "$(declare -f ...) ..."` and
# without going through `declare -f`'s serialiser at all.
#
# The interpolated argv form was fragile because the step-down shell
# could not always re-parse a here-doc-bearing function body carried
# through `bash -c`'s argv. The earlier in-house fix routed function
# bodies through `declare -f` plus a temp file, which removed the argv
# round-trip but kept `declare -f`'s body-reordering bug for here-doc
# `if` conditions. This helper now copies each named function's source
# verbatim from `${BASH_SOURCE[0]}` (resolved per function via the
# extdebug machinery), so every here-doc shape — condition, body,
# trailing — survives the dispatch unchanged.
#
# The temp script lives directly under /tmp (sticky-bit, world-writable
# but unlink-protected) with an unguessable mktemp suffix, so an
# attacker cannot swap the file between mktemp and the step-down bash
# invocation. The directory is intentionally not configurable.
#
# A `bash -n` syntax check runs on the assembled script before the
# step-down invocation. It is a fail-closed guard: if a future change
# ever produces a malformed temp script (for example, a dispatched
# function that violates the opener/closer style assumption), we abort
# before handing the broken script to step-down, surfacing a clean
# error instead of the obscure `unexpected token 'fi'` failure that
# this helper exists to prevent.
#
# Usage: run_step_down_as_sandbox <invocation-snippet> <fn>...
#
# SECURITY CONTRACT: <invocation-snippet> is appended verbatim to the
# generated bash script and parsed by the step-down shell. It MUST be
# a trusted literal authored alongside this script — never derived
# from environment, file contents, sandbox-uid input, or any
# non-static source. Pass arguments through positional parameters of
# the dispatched functions, not through string interpolation into the
# snippet, and keep the snippet to the minimum set of function calls
# (plus the explicit `export HOME=...` the auth-profile path needs).
run_step_down_as_sandbox() {
  local invocation="$1"
  shift
  local script
  script="$(mktemp /tmp/nemoclaw-step-down-XXXXXX.sh)" || return 1
  if ! chmod 0644 "$script" 2>/dev/null; then
    rm -f "$script" 2>/dev/null || true
    return 1
  fi
  if ! (
    printf 'set -euo pipefail\n'
    for fn in "$@"; do
      _step_down_extract_function "$fn" || exit 1
    done
    printf '%s\n' "$invocation"
  ) >"$script"; then
    rm -f "$script" 2>/dev/null || true
    printf '[step-down] failed to assemble dispatch script\n' >&2
    return 1
  fi
  if ! bash -n "$script" 2>/dev/null; then
    rm -f "$script" 2>/dev/null || true
    printf '[step-down] generated dispatch script failed bash -n syntax check\n' >&2
    return 1
  fi
  local rc=0
  "${STEP_DOWN_PREFIX_SANDBOX[@]}" bash "$script" || rc=$?
  rm -f "$script" 2>/dev/null || true
  return "$rc"
}

seed_default_workspace_templates_as_sandbox() {
  run_step_down_as_sandbox \
    "seed_default_workspace_templates /sandbox/.openclaw/workspace '' /sandbox/.openclaw/openclaw.json" \
    seed_default_workspace_templates
}

# Root-mode entry point for the post-gateway auth-profile setup. The
# step-down shell needs HOME=/sandbox explicitly because setpriv keeps
# the parent entrypoint's HOME=/root, which would push
# write_auth_profile's `~/.openclaw/...` expansion outside the sandbox.
# The non-root path exports HOME=/sandbox up front, so the equivalent
# call there does not need the wrapper.
setup_auth_profile_as_sandbox() {
  run_step_down_as_sandbox \
    "export HOME=/sandbox; write_auth_profile; harden_auth_profiles" \
    openclaw_config_dir_owner \
    write_auth_profile \
    harden_auth_profiles
}

PLUGIN_REFRESH_LOG="/tmp/nemoclaw-plugin-refresh.log"

prepare_plugin_refresh_log() {
  local dir base tmp
  dir="$(dirname "$PLUGIN_REFRESH_LOG")"
  base="$(basename "$PLUGIN_REFRESH_LOG")"

  if [ -L "$PLUGIN_REFRESH_LOG" ]; then
    echo "[SECURITY] refusing to use symlinked plugin-refresh log: $PLUGIN_REFRESH_LOG" >&2
    return 1
  fi
  if [ -e "$PLUGIN_REFRESH_LOG" ] && [ ! -f "$PLUGIN_REFRESH_LOG" ]; then
    echo "[SECURITY] refusing to use non-regular plugin-refresh log: $PLUGIN_REFRESH_LOG" >&2
    return 1
  fi

  # Create the log through a same-directory temp file and rename it into place.
  # Root never opens the sandbox-controlled final /tmp path, and the refresh
  # command below performs its redirection after dropping to the sandbox user.
  tmp="$(mktemp "${dir}/.${base}.tmp.XXXXXX")" || return 1
  if [ "$(id -u)" -eq 0 ] && ! chown sandbox:sandbox "$tmp"; then
    rm -f "$tmp"
    return 1
  fi
  if ! chmod 600 "$tmp"; then
    rm -f "$tmp"
    return 1
  fi
  if ! mv -f "$tmp" "$PLUGIN_REFRESH_LOG"; then
    rm -f "$tmp"
    return 1
  fi
}

start_plugin_registry_refresh() {
  (
    local ready=0
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      if [ "$(id -u)" -eq 0 ]; then
        if "${STEP_DOWN_PREFIX_SANDBOX[@]}" env HOME=/sandbox "$OPENCLAW" gateway status >/dev/null 2>&1; then
          ready=1
          break
        fi
      elif env HOME=/sandbox "$OPENCLAW" gateway status >/dev/null 2>&1; then
        ready=1
        break
      fi
      sleep 1
    done
    if [ "$ready" -ne 1 ]; then
      echo "[plugin-refresh] gateway did not become ready; skipping registry refresh" >&2
      exit 0
    fi
    if [ "$(id -u)" -eq 0 ]; then
      "${STEP_DOWN_PREFIX_SANDBOX[@]}" env HOME=/sandbox PLUGIN_REFRESH_LOG="$PLUGIN_REFRESH_LOG" \
        sh -c "exec \"\$@\" >\"\$PLUGIN_REFRESH_LOG\" 2>&1" sh \
        "$OPENCLAW" plugins registry --refresh || true
    else
      env HOME=/sandbox PLUGIN_REFRESH_LOG="$PLUGIN_REFRESH_LOG" \
        sh -c "exec \"\$@\" >\"\$PLUGIN_REFRESH_LOG\" 2>&1" sh \
        "$OPENCLAW" plugins registry --refresh || true
    fi

    # The registry refresh may rewrite openclaw.json after the gateway reports
    # ready. Keep the mutable integrity metadata ordered after that writer so a
    # rebuild cannot observe the refreshed config with its previous hash. Run
    # this even when the best-effort refresh fails because it may have written
    # part of the config before returning nonzero.
    if ! ensure_mutable_openclaw_config_hash; then
      echo "[plugin-refresh] mutable OpenClaw config hash refresh failed" >&2
    fi
  ) &
  PLUGIN_REFRESH_PID=$!
  if ! capture_openclaw_pid_start_identity "$PLUGIN_REFRESH_PID" PLUGIN_REFRESH_PID_START_IDENTITY; then
    # The best-effort refresh may legitimately finish before PID 1 can read
    # its stat record.  An uncaptured PID is never admitted or signalled.
    # shellcheck disable=SC2034 # process-control.sh reads this shared process identity.
    PLUGIN_REFRESH_PID_START_IDENTITY=""
  fi
}
