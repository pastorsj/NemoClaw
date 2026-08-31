# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
# shellcheck shell=bash

# ── Messaging runtime setup from manifest metadata ───────────────
# Channel-owned runtime setup is compiled from manifests at image build time.
# The entrypoint consumes only generic declarations: envAliases, nodePreloads,
# and secretScans. Prefer a forwarded env plan when present; otherwise load the
# reduced image artifact written by the messaging build applier.
_MESSAGING_RUNTIME_PLAN_ARTIFACT="${NEMOCLAW_MESSAGING_RUNTIME_PLAN_PATH:-/usr/local/share/nemoclaw/messaging-runtime-plan.json}"
_MESSAGING_RUNTIME_SETUP_PLAN="/tmp/nemoclaw-messaging-runtime-setup.json"
_MESSAGING_CONNECT_PRELOADS_FILE="/tmp/nemoclaw-messaging-connect-preloads.list"

write_messaging_runtime_setup_plan() {
  python3 - "$_MESSAGING_RUNTIME_PLAN_ARTIFACT" <<'PYMESSAGINGRUNTIME' | emit_sandbox_sourced_file "$_MESSAGING_RUNTIME_SETUP_PLAN"
import base64
import json
import os
import re
import sys

EMPTY = {"nodePreloads": [], "envAliases": [], "secretScans": []}
PRELOAD_SOURCE_PREFIX = "/usr/local/lib/nemoclaw/preloads/"
PRELOAD_TARGET_PREFIX = "/tmp/nemoclaw-"
ENV_KEY_RE = re.compile(r"^[A-Z][A-Z0-9_]{0,127}$")


def fail(message):
    print(f"[channels] Invalid messaging runtime setup plan: {message}", file=sys.stderr)
    raise SystemExit(1)


def clean_string(value, field, *, allow_empty=False):
    if not isinstance(value, str):
        fail(f"{field} must be a string")
    if not allow_empty and not value:
        fail(f"{field} must not be empty")
    if any(ch in value for ch in "\x00\r\n\t"):
        fail(f"{field} contains a control character")
    return value


def clean_message(value, field):
    if value is None:
        return ""
    if not isinstance(value, str):
        fail(f"{field} must be a string")
    if any(ch in value for ch in "\x00\r\n\t"):
        fail(f"{field} contains a control character")
    return value


def clean_node_preload(entry, index):
    if not isinstance(entry, dict):
        fail(f"nodePreloads[{index}] must be an object")
    source = clean_string(entry.get("source"), f"nodePreloads[{index}].source")
    target = clean_string(entry.get("target"), f"nodePreloads[{index}].target")
    if not source.startswith(PRELOAD_SOURCE_PREFIX) or not source.endswith(".js"):
        fail(f"nodePreloads[{index}].source must be a preload JavaScript file under {PRELOAD_SOURCE_PREFIX}")
    if not target.startswith(PRELOAD_TARGET_PREFIX) or not target.endswith(".js"):
        fail(f"nodePreloads[{index}].target must be a JavaScript file under {PRELOAD_TARGET_PREFIX}*")
    inject_into = entry.get("injectInto", [])
    if not isinstance(inject_into, list):
        fail(f"nodePreloads[{index}].injectInto must be a list")
    normalized_scopes = []
    for scope in inject_into:
        if scope not in ("boot", "connect"):
            fail(f"nodePreloads[{index}].injectInto contains unsupported value {scope!r}")
        if scope not in normalized_scopes:
            normalized_scopes.append(scope)
    optional = entry.get("optional", False)
    if not isinstance(optional, bool):
        fail(f"nodePreloads[{index}].optional must be a boolean")
    return {
        "source": source,
        "target": target,
        "injectInto": normalized_scopes,
        "optional": optional,
        "installMessage": clean_message(entry.get("installMessage"), f"nodePreloads[{index}].installMessage"),
        "installedMessage": clean_message(entry.get("installedMessage"), f"nodePreloads[{index}].installedMessage"),
    }


def clean_env_alias(entry, index):
    if not isinstance(entry, dict):
        fail(f"envAliases[{index}] must be an object")
    env_key = clean_string(entry.get("envKey"), f"envAliases[{index}].envKey")
    if not ENV_KEY_RE.match(env_key):
        fail(f"envAliases[{index}].envKey is not a safe environment key")
    pattern = clean_string(entry.get("match"), f"envAliases[{index}].match")
    try:
        re.compile(pattern)
    except re.error as exc:
        fail(f"envAliases[{index}].match is not a valid regex: {exc}")
    return {
        "envKey": env_key,
        "match": pattern,
        "value": clean_string(entry.get("value"), f"envAliases[{index}].value", allow_empty=True),
        "message": clean_message(entry.get("message"), f"envAliases[{index}].message"),
    }


def clean_secret_scan(entry, index):
    if not isinstance(entry, dict):
        fail(f"secretScans[{index}] must be an object")
    path = clean_string(entry.get("path"), f"secretScans[{index}].path")
    if not path.startswith("/sandbox/"):
        fail(f"secretScans[{index}].path must be under /sandbox")
    pattern = clean_string(entry.get("pattern"), f"secretScans[{index}].pattern")
    try:
        re.compile(pattern)
    except re.error as exc:
        fail(f"secretScans[{index}].pattern is not a valid regex: {exc}")
    exit_code = entry.get("exitCode", 78)
    if not isinstance(exit_code, int) or exit_code < 1 or exit_code > 255:
        fail(f"secretScans[{index}].exitCode must be an integer from 1 to 255")
    return {
        "path": path,
        "pattern": pattern,
        "message": clean_message(entry.get("message"), f"secretScans[{index}].message") or "[SECURITY] Runtime secret scan failed for {path}",
        "exitCode": exit_code,
    }


def load_messaging_plan():
    raw_plan = os.environ.get("NEMOCLAW_MESSAGING_PLAN_B64", "").strip()
    if raw_plan:
        try:
            return json.loads(base64.b64decode(raw_plan, validate=True).decode("utf-8"))
        except Exception as exc:
            fail(f"NEMOCLAW_MESSAGING_PLAN_B64 is not valid base64 JSON: {exc}")
    artifact_path = sys.argv[1] if len(sys.argv) > 1 else ""
    if not artifact_path or not os.path.isfile(artifact_path):
        return None
    try:
        with open(artifact_path, encoding="utf-8") as handle:
            return json.load(handle)
    except Exception as exc:
        fail(f"messaging runtime plan artifact {artifact_path} is not valid JSON: {exc}")


plan = load_messaging_plan()
if plan is None:
    print(json.dumps(EMPTY, sort_keys=True))
    raise SystemExit(0)
if not isinstance(plan, dict):
    fail("decoded plan must be an object")

disabled_channels = {
    channel_id
    for channel_id in plan.get("disabledChannels", [])
    if isinstance(channel_id, str)
}
active_channel_ids = set()
for channel in plan.get("channels", []):
    if not isinstance(channel, dict):
        continue
    channel_id = channel.get("channelId")
    if not isinstance(channel_id, str):
        continue
    if channel.get("active") is True and channel.get("disabled") is not True and channel_id not in disabled_channels:
        active_channel_ids.add(channel_id)

runtime_setup = plan.get("runtimeSetup", EMPTY)
if runtime_setup is None:
    runtime_setup = EMPTY
if not isinstance(runtime_setup, dict):
    fail("runtimeSetup must be an object")


def runtime_setup_entries(key):
    entries = runtime_setup.get(key, [])
    if not isinstance(entries, list):
        fail(f"runtimeSetup.{key} must be a list")
    for index, entry in enumerate(entries):
        if not isinstance(entry, dict):
            fail(f"runtimeSetup.{key}[{index}] must be an object")
        channel_id = entry.get("channelId")
        if not isinstance(channel_id, str) or not channel_id:
            fail(f"runtimeSetup.{key}[{index}].channelId must be a string")
        if channel_id not in active_channel_ids:
            continue
        yield entry


node_preloads = []
env_aliases = []
secret_scans = []
seen_node_preloads = set()
seen_aliases = set()
seen_scans = set()

for entry in runtime_setup_entries("nodePreloads"):
    preload = clean_node_preload(entry, len(node_preloads))
    preload_key = (preload["source"], preload["target"])
    if preload_key not in seen_node_preloads:
        seen_node_preloads.add(preload_key)
        node_preloads.append(preload)
for entry in runtime_setup_entries("envAliases"):
    alias = clean_env_alias(entry, len(env_aliases))
    alias_key = (alias["envKey"], alias["match"], alias["value"])
    if alias_key not in seen_aliases:
        seen_aliases.add(alias_key)
        env_aliases.append(alias)
for entry in runtime_setup_entries("secretScans"):
    scan = clean_secret_scan(entry, len(secret_scans))
    scan_key = (scan["path"], scan["pattern"])
    if scan_key not in seen_scans:
        seen_scans.add(scan_key)
        secret_scans.append(scan)

print(json.dumps({"nodePreloads": node_preloads, "envAliases": env_aliases, "secretScans": secret_scans}, sort_keys=True))
PYMESSAGINGRUNTIME
}

apply_messaging_runtime_env_aliases() {
  [ -f "$_MESSAGING_RUNTIME_SETUP_PLAN" ] || return 0
  local _rows
  _rows="$(
    python3 - "$_MESSAGING_RUNTIME_SETUP_PLAN" <<'PYMESSAGINGALIASES'
import json
import os
import re
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    plan = json.load(handle)
for alias in plan.get("envAliases", []):
    if not re.search(alias["match"], os.environ.get(alias["envKey"], "")):
        continue
    print("\t".join([
        alias["envKey"],
        alias["value"],
        alias.get("message", ""),
    ]))
PYMESSAGINGALIASES
  )" || return $?
  [ -n "$_rows" ] || return 0

  local _env_key _value _message
  while IFS=$'\t' read -r _env_key _value _message; do
    export "$_env_key=$_value"
    [ -n "$_message" ] && printf '%s\n' "$_message" >&2
  done <<<"$_rows"
}

node_options_has_require() {
  local wanted="$1"
  local previous=""
  local token
  local tokens=()
  IFS=$' \t\n' read -r -a tokens <<<"${NODE_OPTIONS:-}"
  # Iterating "${tokens[@]}" on an empty array trips `set -u` on bash 3.2
  # (macOS default); guard so the local unit harnesses run there too.
  [ "${#tokens[@]}" -gt 0 ] || return 1
  for token in "${tokens[@]}"; do
    if [ "$previous" = "--require" ] && [ "$token" = "$wanted" ]; then
      return 0
    fi
    [ "$token" = "--require=$wanted" ] && return 0
    previous="$token"
  done
  return 1
}

append_node_require_once() {
  local wanted="$1"
  if ! node_options_has_require "$wanted"; then
    export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--require $wanted"
  fi
}

install_messaging_runtime_preloads() {
  [ -f "$_MESSAGING_RUNTIME_SETUP_PLAN" ] || return 0
  local _rows
  _rows="$(
    python3 - "$_MESSAGING_RUNTIME_SETUP_PLAN" <<'PYMESSAGINGPRELOADS'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    plan = json.load(handle)
for preload in plan.get("nodePreloads", []):
    print("\t".join([
        preload["source"],
        preload["target"],
        ",".join(preload.get("injectInto", [])),
        "1" if preload.get("optional") else "0",
        preload.get("installMessage", ""),
        preload.get("installedMessage", ""),
    ]))
PYMESSAGINGPRELOADS
  )" || return $?

  local _connect_preloads=()
  if [ -n "$_rows" ]; then
    local _source _target _inject_into _optional _install_message _installed_message
    while IFS=$'\t' read -r _source _target _inject_into _optional _install_message _installed_message; do
      if [ ! -f "$_source" ]; then
        [ "$_optional" = "1" ] && continue
        printf '[channels] Missing runtime preload source: %s\n' "$_source" >&2
        return 1
      fi
      [ -n "$_install_message" ] && printf '%s\n' "$_install_message" >&2
      emit_sandbox_sourced_file "$_target" <"$_source" || return 1
      case ",$_inject_into," in
        *,boot,*)
          append_node_require_once "$_target"
          ;;
      esac
      case ",$_inject_into," in
        *,connect,*)
          _connect_preloads+=("$_target")
          ;;
      esac
      [ -n "$_installed_message" ] && printf '%s\n' "$_installed_message" >&2
    done <<<"$_rows"
  fi

  if [ "${#_connect_preloads[@]}" -gt 0 ]; then
    printf '%s\n' "${_connect_preloads[@]}" \
      | emit_sandbox_sourced_file "$_MESSAGING_CONNECT_PRELOADS_FILE" || return 1
  else
    : | emit_sandbox_sourced_file "$_MESSAGING_CONNECT_PRELOADS_FILE" || return 1
  fi
}

emit_messaging_connect_runtime_preload_exports() {
  cat <<CONNECTPRELOADSEOF
if [ -f "$_MESSAGING_CONNECT_PRELOADS_FILE" ]; then
  while IFS= read -r _nemoclaw_preload; do
    [ -n "\$_nemoclaw_preload" ] || continue
    [ -f "\$_nemoclaw_preload" ] || continue
    export NODE_OPTIONS="\${NODE_OPTIONS:+\$NODE_OPTIONS }--require \$_nemoclaw_preload"
  done < "$_MESSAGING_CONNECT_PRELOADS_FILE"
fi
CONNECTPRELOADSEOF
}

messaging_runtime_preload_targets() {
  printf '%s\n' "$_MESSAGING_RUNTIME_SETUP_PLAN" "$_MESSAGING_CONNECT_PRELOADS_FILE"
  [ -f "$_MESSAGING_RUNTIME_SETUP_PLAN" ] || return 0
  python3 - "$_MESSAGING_RUNTIME_SETUP_PLAN" <<'PYMESSAGINGTARGETS'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    plan = json.load(handle)
for preload in plan.get("nodePreloads", []):
    target = preload.get("target")
    if target:
        print(target)
PYMESSAGINGTARGETS
}

validate_nemoclaw_tmp_permissions() {
  local _dynamic_targets=()
  local _target
  while IFS= read -r _target; do
    [ -n "$_target" ] && _dynamic_targets+=("$_target")
  done < <(messaging_runtime_preload_targets)

  validate_tmp_permissions "$_SANDBOX_SAFETY_NET" "$_PROXY_FIX_SCRIPT" "$_NEMOTRON_FIX_SCRIPT" "$_CIAO_GUARD_SCRIPT" "${_dynamic_targets[@]+"${_dynamic_targets[@]}"}"
}

verify_messaging_runtime_secret_scans() {
  [ -f "$_MESSAGING_RUNTIME_SETUP_PLAN" ] || return 0
  python3 - "$_MESSAGING_RUNTIME_SETUP_PLAN" <<'PYMESSAGINGSECRETS'
import json
import re
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    plan = json.load(handle)

for scan in plan.get("secretScans", []):
    path = scan["path"]
    try:
        with open(path, "r", encoding="utf-8", errors="ignore") as handle:
            content = handle.read()
    except FileNotFoundError:
        continue
    if re.search(scan["pattern"], content):
        print(scan["message"].replace("{path}", path), file=sys.stderr)
        raise SystemExit(scan["exitCode"])
PYMESSAGINGSECRETS
}

_read_gateway_token() {
  node - <<'NODETOKEN'
const fs = require("fs");

const configPath = "/sandbox/.openclaw/openclaw.json";

function loadJson5() {
  try {
    const JSON5 = require("/opt/nemoclaw/node_modules/json5");
    if (JSON5 && typeof JSON5.parse === "function") {
      return JSON5;
    }
  } catch {
    // Fall through to the caller's empty-token behavior.
  }
  return undefined;
}

function parseConfig(text) {
  try {
    return JSON.parse(text);
  } catch (jsonError) {
    const JSON5 = loadJson5();
    if (!JSON5) {
      throw jsonError;
    }
    return JSON5.parse(text);
  }
}

try {
  const cfg = parseConfig(fs.readFileSync(configPath, "utf8"));
  console.log(cfg?.gateway?.auth?.token || "");
} catch {
  console.log("");
}
NODETOKEN
}

ensure_gateway_token() {
  local config_file="/sandbox/.openclaw/openclaw.json"
  local hash_file="/sandbox/.openclaw/.config-hash"
  local config_dir
  config_dir="$(dirname "$config_file")"

  if [ -L "$config_dir" ] || [ -L "$config_file" ] || [ -L "$hash_file" ]; then
    printf '[SECURITY] Refusing gateway token generation — config or hash path is a symlink\n' >&2
    return 1
  fi

  if [ "$(id -u)" -eq 0 ]; then
    prepare_openclaw_config_for_write "$config_file" "$hash_file"
  fi

  local _write_rc=0
  node - "$config_file" <<'NODETOKEN' || _write_rc=$?
const crypto = require("crypto");
const fs = require("fs");
const pathModule = require("path");

const path = process.argv[2];

function loadJson5() {
  const candidate = "/opt/nemoclaw/node_modules/json5";
  const JSON5 = require(candidate);
  if (!JSON5 || typeof JSON5.parse !== "function") {
    throw new Error(`JSON5 parser at ${candidate} is missing parse()`);
  }
  return JSON5;
}

function parseConfig(text) {
  try {
    return JSON.parse(text);
  } catch {
    return loadJson5().parse(text);
  }
}

function tokenUrlSafe(bytes) {
  return crypto
    .randomBytes(bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function makeTempPath(dirPath) {
  for (let i = 0; i < 16; i += 1) {
    const suffix = crypto.randomBytes(12).toString("hex");
    const tmpPath = pathModule.join(dirPath, `.openclaw.${process.pid}.${suffix}.tmp`);
    try {
      const fd = fs.openSync(tmpPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
      return { fd, tmpPath };
    } catch (error) {
      if (error && error.code === "EEXIST") {
        continue;
      }
      throw error;
    }
  }
  throw new Error("unable to allocate temporary OpenClaw config path");
}

try {
  const cfg = parseConfig(fs.readFileSync(path, "utf8"));
  const gateway = cfg.gateway && typeof cfg.gateway === "object" ? cfg.gateway : (cfg.gateway = {});
  const auth = gateway.auth && typeof gateway.auth === "object" ? gateway.auth : (gateway.auth = {});
  auth.token = tokenUrlSafe(32);
  const meta = cfg.meta && typeof cfg.meta === "object" ? cfg.meta : (cfg.meta = {});
  // Record OpenClaw's configuration-write metadata. Without this field,
  // OpenClaw 2026.7 can classify the authenticated configuration as overwritten
  // and restore the tokenless build-time backup before gateway authentication resolves.
  meta.lastTouchedAt = new Date().toISOString();

  const dirPath = pathModule.dirname(path);
  let fd;
  let tmpPath;
  try {
    ({ fd, tmpPath } = makeTempPath(dirPath));
    fs.fchmodSync(fd, 0o600);
    fs.writeFileSync(fd, JSON.stringify(cfg, null, 2));
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmpPath, path);

    let dirFlags = fs.constants.O_RDONLY;
    if (fs.constants.O_DIRECTORY) {
      dirFlags |= fs.constants.O_DIRECTORY;
    }
    const dirFd = fs.openSync(dirPath, dirFlags);
    try {
      fs.fsyncSync(dirFd);
    } finally {
      fs.closeSync(dirFd);
    }
  } catch (error) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // Ignore cleanup failure and report the original error below.
      }
    }
    if (tmpPath) {
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        // Ignore cleanup failure and report the original error below.
      }
    }
    throw error;
  }
} catch (error) {
  console.error(`[SECURITY] Failed to ensure OpenClaw gateway token: ${error.message || error}`);
  process.exit(1);
}
NODETOKEN

  if [ "$_write_rc" -eq 0 ] && [ -f "$hash_file" ]; then
    (cd "$(dirname "$config_file")" && sha256sum "$(basename "$config_file")" >"$hash_file") || _write_rc=$?
  fi

  if [ "$(id -u)" -eq 0 ]; then
    restore_openclaw_config_after_write "$config_file" "$hash_file" || _write_rc=$?
  fi

  [ "$_write_rc" -eq 0 ] || return "$_write_rc"
  printf '[token] Gateway auth token refreshed for startup\n' >&2
}

ensure_gateway_token_if_missing() {
  if [ -n "$(_read_gateway_token)" ]; then
    return 0
  fi

  ensure_gateway_token
}

export_gateway_token() {
  local token
  token="$(_read_gateway_token)"

  if [ -z "$token" ]; then
    unset OPENCLAW_GATEWAY_TOKEN
    return
  fi
  export OPENCLAW_GATEWAY_TOKEN="$token"
}

needs_gateway_token_for_current_command() {
  # Startup and direct OpenClaw CLI commands need the token before auto-pair or
  # agent subprocesses run. Arbitrary explicit commands do not, and non-root
  # smoke paths may not be able to mutate the baked OpenClaw config.
  if [ ${#NEMOCLAW_CMD[@]} -eq 0 ]; then
    return 0
  fi

  case "${NEMOCLAW_CMD[0]##*/}" in
    openclaw) return 0 ;;
    *) return 1 ;;
  esac
}

prepare_gateway_token_for_current_command() {
  if [ ${#NEMOCLAW_CMD[@]} -eq 0 ]; then
    # OpenShell launches the persisted workload as the sandbox user. When
    # Shields are up, the root-owned config seal deliberately prevents that
    # identity from replacing openclaw.json. Preserve the sealed startup token
    # rather than weakening the lock; mutable and root-owned startup paths keep
    # rotating it. A sealed config without a token cannot be repaired safely by
    # this identity, so fail before attempting a write.
    if [ "$(id -u)" -ne 0 ] \
      && [ "$(openclaw_config_dir_owner /sandbox/.openclaw)" = "root" ]; then
      if [ -n "$(_read_gateway_token)" ]; then
        printf '[token] Shields are up; preserving the sealed gateway token for startup\n' >&2
        return 0
      fi
      printf '[SECURITY] Shields are up but the sealed OpenClaw config has no gateway token; lower Shields before restarting\n' >&2
      return 1
    fi
    ensure_gateway_token
    return $?
  fi

  if needs_gateway_token_for_current_command; then
    ensure_gateway_token_if_missing
  fi
}

# Write an auth profile JSON for the NVIDIA API key so the gateway can authenticate.
write_auth_profile() {
  if [ -z "${NVIDIA_INFERENCE_API_KEY:-}" ] && [ -n "${NVIDIA_API_KEY:-}" ]; then
    export NVIDIA_INFERENCE_API_KEY="$NVIDIA_API_KEY"
  fi

  if [ -z "${NVIDIA_INFERENCE_API_KEY:-}" ]; then
    return
  fi

  # Read the route identifier from the NEMOCLAW_INFERENCE_PROVIDER_ID env var
  # (exported from the build-time ARG). This avoids parsing openclaw.json and
  # ensures the auth profile matches the route identifier in the model config.
  # NEMOCLAW_PROVIDER_KEY is the legacy image-variable name, read as a fallback
  # through v0.0.89 so pre-existing custom images keep routing. Remove this
  # fallback in v0.0.90.
  # See: https://github.com/NVIDIA/NemoClaw/issues/1332
  local provider_key="${NEMOCLAW_INFERENCE_PROVIDER_ID:-${NEMOCLAW_PROVIDER_KEY:-inference}}"
  local auth_profile_path="${HOME}/.openclaw/agents/main/agent/auth-profiles.json"

  if [ "$(id -u)" -ne 0 ] \
    && [ "$(openclaw_config_dir_owner "${HOME}/.openclaw")" = "root" ]; then
    if [ -L "$auth_profile_path" ] || [ ! -f "$auth_profile_path" ]; then
      printf '[SECURITY] Shields are up but the sealed OpenClaw auth profile is unavailable; lower Shields before restarting\n' >&2
      return 1
    fi
    printf '[auth] Shields are up; preserving the sealed OpenClaw auth profile\n' >&2
    return 0
  fi

  python3 - "$provider_key" <<'PYAUTH'
import json
import os
import sys

provider_key = sys.argv[1]

path = os.path.expanduser('~/.openclaw/agents/main/agent/auth-profiles.json')
os.makedirs(os.path.dirname(path), exist_ok=True)
json.dump({
    f'{provider_key}:manual': {
        'type': 'api_key',
        'provider': provider_key,
        'keyRef': {'source': 'env', 'id': 'NVIDIA_INFERENCE_API_KEY'},
        'profileId': f'{provider_key}:manual',
    }
}, open(path, 'w'))
os.chmod(path, 0o600)
PYAUTH
}

harden_auth_profiles() {
  if [ -d "${HOME}/.openclaw" ]; then
    # Enforce 600 for all auth profiles across all agents
    find -L "${HOME}/.openclaw" -type f -name "auth-profiles.json" -exec chmod 600 {} + 2>/dev/null || true
  fi
}

# configure_messaging_channels is provided by sandbox-init.sh (shared).

# Print the local and remote dashboard URLs without the auth token fragment.
print_dashboard_urls() {
  local token chat_ui_base local_url remote_url

  token="$(_read_gateway_token)"

  chat_ui_base="${CHAT_UI_URL%%#*}"
  chat_ui_base="${chat_ui_base%/}"
  local_url="http://127.0.0.1:${PUBLIC_PORT}/"
  remote_url="${chat_ui_base}/"

  echo "[gateway] Local UI: ${local_url}" >&2
  echo "[gateway] Remote UI: ${remote_url}" >&2
  if [ -n "$token" ]; then
    echo "[gateway] Dashboard auth token redacted from startup logs." >&2
  fi
}

start_persistent_gateway_log_mirror() {
  local log_dir="/sandbox/.openclaw/logs"
  local log_file="${log_dir}/gateway-persistent.log"

  if [ -L "$log_dir" ]; then
    echo "[SECURITY] refusing symlinked persistent log directory: $log_dir" >&2
    return 1
  fi

  if [ "$(id -u)" -eq 0 ]; then
    install -d -o root -g root -m 755 "$log_dir" 2>/dev/null || return 1
  else
    mkdir -p "$log_dir" 2>/dev/null || return 1
    chmod 755 "$log_dir" 2>/dev/null || true
  fi

  if [ -L "$log_file" ] || { [ -e "$log_file" ] && [ ! -f "$log_file" ]; }; then
    echo "[SECURITY] refusing unsafe persistent log path: $log_file" >&2
    return 1
  fi

  if [ "$(id -u)" -eq 0 ]; then
    if [ ! -e "$log_file" ]; then
      install -o root -g root -m 644 /dev/null "$log_file" 2>/dev/null || return 1
    else
      chown root:root "$log_file" 2>/dev/null || return 1
      chmod 644 "$log_file" 2>/dev/null || return 1
    fi
  else
    touch "$log_file" 2>/dev/null || return 1
    chmod 644 "$log_file" 2>/dev/null || true
  fi

  if [ -L "$log_file" ] || [ ! -f "$log_file" ]; then
    echo "[SECURITY] refusing unsafe persistent log path after create: $log_file" >&2
    return 1
  fi

  { tail -n +1 -F /tmp/gateway.log 2>/dev/null >>"$log_file"; } &
  GATEWAY_LOG_PERSIST_PID=$!
  if ! capture_openclaw_pid_start_identity \
    "$GATEWAY_LOG_PERSIST_PID" GATEWAY_LOG_PERSIST_PID_START_IDENTITY; then
    echo "[gateway] could not capture persistent-log process identity" >&2
    return 1
  fi
}

start_auto_pair() {
  # Run auto-pair as sandbox user (it talks to the gateway via CLI)
  # SECURITY: Pass resolved openclaw path to prevent PATH hijacking
  # When running as non-root, skip privilege step-down (we're already
  # the sandbox user). When root, step down via STEP_DOWN_PREFIX_SANDBOX
  # which uses setpriv to drop load-bearing caps from the bounding set
  # atomically with reuid (issue #3280 follow-up).
  local run_prefix=()
  if [ "$(id -u)" -eq 0 ]; then
    run_prefix=("${STEP_DOWN_PREFIX_SANDBOX[@]}")
  fi
  # The gateway must retain NemoClaw's private-interface URL, but the watcher
  # is an ordinary OpenClaw CLI client. Source the trusted runtime environment
  # in this child only so an injected private URL is removed before the first
  # `devices list`. The first list call keeps shared gateway auth but uses the
  # reviewed child-only marker to retain CLI identity, allowing OpenClaw's
  # canonical local-loopback pairing bootstrap. Later calls use device auth.
  # An explicit URL override is preserved by write_runtime_shell_env().
  (
    if [ -r "$_RUNTIME_SHELL_ENV_FILE" ]; then
      # shellcheck source=/dev/null
      builtin source "$_RUNTIME_SHELL_ENV_FILE" || exit $?
    fi
    export OPENCLAW_BIN="$OPENCLAW"
    exec nohup "${run_prefix[@]+"${run_prefix[@]}"}" \
      python3 -u "$_OPENCLAW_AUTO_PAIR_SCRIPT" </dev/null
  ) >>/tmp/auto-pair.log 2>&1 &
  AUTO_PAIR_PID=$!
  if ! capture_openclaw_pid_start_identity "$AUTO_PAIR_PID" AUTO_PAIR_PID_START_IDENTITY; then
    echo "[gateway] could not capture auto-pair process identity" >&2
    return 1
  fi
  echo "[gateway] auto-pair watcher launched (pid $AUTO_PAIR_PID)" >&2
}

prepare_auto_pair_log() {
  if [ "$(id -u)" -eq 0 ]; then
    # PID 1 opens the redirection after CAP_DAC_OVERRIDE is gone, then passes
    # the already-open descriptor to the stepped-down watcher.
    _nemoclaw_safe_create_tmp_file /tmp/auto-pair.log 600 root:root || return 1
    # The watcher owns this credential-free diagnostic channel. The host reads
    # it through OpenShell as the same sandbox policy user.
    _nemoclaw_safe_create_tmp_file /tmp/nemoclaw-auto-pair-status.json 600 sandbox:sandbox || return 1
  else
    _nemoclaw_safe_create_tmp_file /tmp/auto-pair.log 600 || return 1
    _nemoclaw_safe_create_tmp_file /tmp/nemoclaw-auto-pair-status.json 600 || return 1
  fi
}
