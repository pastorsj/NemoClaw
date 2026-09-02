# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
# shellcheck shell=bash

# ── Runtime model/provider override ──────────────────────────────
# Patches openclaw.json at startup when NEMOCLAW_MODEL_OVERRIDE is set,
# allowing model or provider changes without rebuilding the sandbox image.
# Runs AFTER integrity check (detects build-time tampering). Recomputes
# the config hash so future integrity checks pass.
#
# SECURITY: These env vars come from the host (Docker/OpenShell), not from
# inside the sandbox. The agent cannot set them.
# Ref: https://github.com/NVIDIA/NemoClaw/issues/759

apply_model_override() {
  # Only explicit override env vars trigger a config patch. NEMOCLAW_CONTEXT_WINDOW,
  # NEMOCLAW_MAX_TOKENS, NEMOCLAW_REASONING, and NEMOCLAW_REASONING_EFFORT are
  # promoted from Dockerfile build ARGs to ENV and are always set. They should only
  # take effect when accompanied by an explicit model or API override. Reasoning
  # effort is deliberately not replayed here: `inference set` owns the persisted
  # runtime value, which must survive an ordinary container restart. Ref: #2653
  [ -n "${NEMOCLAW_MODEL_OVERRIDE:-}" ] \
    || [ -n "${NEMOCLAW_INFERENCE_API_OVERRIDE:-}" ] \
    || return 0

  # SECURITY: Only root can write to /sandbox/.openclaw (root:root 444).
  # In non-root mode the sandbox user cannot modify the config.
  if [ "$(id -u)" -ne 0 ]; then
    printf '[SECURITY] Model/inference overrides ignored — requires root (non-root mode cannot write to config)\n' >&2
    return 0
  fi

  local config_file="/sandbox/.openclaw/openclaw.json"
  local fabric_file="/sandbox/.openclaw/fabric.json"
  local hash_file="/sandbox/.openclaw/.config-hash"

  # A shields-up protected-config set is a host-sealed trust anchor.
  # Startup/restart may read it, but must never temporarily chmod or rewrite it behind the host's
  # persisted content seal. Apply host overrides after shields-down instead.
  if [ "$(openclaw_config_dir_owner "$(dirname "$config_file")")" = "root" ]; then
    printf '[config] Shields are up; deferring model/inference overrides until config is mutable\n' >&2
    return 0
  fi

  # SECURITY: Refuse to write through symlinks to prevent symlink-following attacks.
  # Legacy-layout migration rejects symlinked config paths before overrides; guard here too.
  if [ -L "$config_file" ] || [ -L "$fabric_file" ] || [ -L "$hash_file" ]; then
    printf '[SECURITY] Refusing model override — protected config path is a symlink\n' >&2
    return 1
  fi
  if [ ! -f "$config_file" ] || [ ! -f "$fabric_file" ]; then
    printf '[SECURITY] Refusing model override — protected config file is missing or not regular\n' >&2
    return 1
  fi

  local model_override="${NEMOCLAW_MODEL_OVERRIDE:-}"
  local api_override="${NEMOCLAW_INFERENCE_API_OVERRIDE:-}"

  # SECURITY: Validate inputs — reject control characters and enforce length limit.
  if printf '%s' "$model_override" | grep -qP '[\x00-\x1f\x7f]'; then
    printf '[SECURITY] NEMOCLAW_MODEL_OVERRIDE contains control characters — refusing\n' >&2
    return 1
  fi
  if [ "${#model_override}" -gt 256 ]; then
    printf '[SECURITY] NEMOCLAW_MODEL_OVERRIDE exceeds 256 characters — refusing\n' >&2
    return 1
  fi

  # SECURITY: Allowlist inference API types to prevent unexpected routing.
  if [ -n "$api_override" ]; then
    case "$api_override" in
      openai-completions | anthropic-messages) ;;
      *)
        printf '[SECURITY] NEMOCLAW_INFERENCE_API_OVERRIDE must be "openai-completions" or "anthropic-messages", got "%s" — skipping override\n' "$api_override" >&2
        return 0
        ;;
    esac
  fi

  local context_window="${NEMOCLAW_CONTEXT_WINDOW:-}"
  local max_tokens="${NEMOCLAW_MAX_TOKENS:-}"
  local reasoning="${NEMOCLAW_REASONING:-}"

  # Validate supplemental override values before relaxing or writing config.
  if [ -n "$context_window" ] && ! printf '%s' "$context_window" | grep -qE '^[1-9][0-9]*$'; then
    printf '[SECURITY] NEMOCLAW_CONTEXT_WINDOW must be a positive integer, got "%s" — skipping override\n' "$context_window" >&2
    return 0
  fi
  if [ -n "$max_tokens" ] && ! printf '%s' "$max_tokens" | grep -qE '^[1-9][0-9]*$'; then
    printf '[SECURITY] NEMOCLAW_MAX_TOKENS must be a positive integer, got "%s" — skipping override\n' "$max_tokens" >&2
    return 0
  fi
  if [ -n "$reasoning" ]; then
    case "$reasoning" in
      true | false) ;;
      *)
        printf '[SECURITY] NEMOCLAW_REASONING must be "true" or "false", got "%s" — skipping override\n' "$reasoning" >&2
        return 0
        ;;
    esac
  fi
  [ -n "$model_override" ] && printf '[config] Applying model override: %s\n' "$model_override" >&2
  [ -n "$api_override" ] && printf '[config] Applying inference API override: %s\n' "$api_override" >&2
  [ -n "$context_window" ] && printf '[config] Applying context window override: %s\n' "$context_window" >&2
  [ -n "$max_tokens" ] && printf '[config] Applying max tokens override: %s\n' "$max_tokens" >&2
  [ -n "$reasoning" ] && printf '[config] Applying reasoning override: %s\n' "$reasoning" >&2

  # Shields-up configs are root-owned and re-locked after writing; mutable
  # default configs are briefly root-owned so writes still work after
  # CAP_DAC_OVERRIDE is dropped, then restored to sandbox:sandbox 2770/660.
  prepare_openclaw_config_for_write "$config_file" "$hash_file"
  local _write_rc=0

  NEMOCLAW_CONTEXT_WINDOW="$context_window" \
    NEMOCLAW_MAX_TOKENS="$max_tokens" \
    NEMOCLAW_REASONING="$reasoning" \
    python3 - "$config_file" "$model_override" "$api_override" <<'PYOVERRIDE' || _write_rc=$?
import json, os, sys

config_file, model_override, api_override = sys.argv[1], sys.argv[2], sys.argv[3]
context_window = os.environ.get("NEMOCLAW_CONTEXT_WINDOW", "")
max_tokens = os.environ.get("NEMOCLAW_MAX_TOKENS", "")
reasoning = os.environ.get("NEMOCLAW_REASONING", "")

with open(config_file) as f:
    cfg = json.load(f)

# Patch primary model reference
if model_override:
    cfg["agents"]["defaults"]["model"]["primary"] = model_override

# Patch model properties in provider config
for pkey, pval in cfg.get("models", {}).get("providers", {}).items():
    # Apply the route override before deciding whether reasoning effort is
    # valid for the resulting provider API.
    if api_override:
        pval["api"] = api_override
    effective_api = pval.get("api")
    for m in pval.get("models", []):
        if model_override:
            m["id"] = model_override
            m["name"] = model_override
        if context_window:
            m["contextWindow"] = int(context_window)
        if max_tokens:
            m["maxTokens"] = int(max_tokens)
        if reasoning:
            m["reasoning"] = reasoning == "true"
        # The image-baked NEMOCLAW_REASONING_EFFORT is an onboarding input, not
        # a startup override. Preserve the persisted model value so a runtime
        # `inference set --reasoning-effort` mutation survives restart. An
        # explicit API switch still clears an effort that the resulting API
        # cannot carry.
        if api_override and effective_api != "openai-completions":
            params = m.get("params")
            if isinstance(params, dict):
                extra_body = params.get("extra_body")
                if isinstance(extra_body, dict):
                    extra_body.pop("reasoning_effort", None)
                    if not extra_body:
                        params.pop("extra_body", None)
                if not params:
                    m.pop("params", None)

with open(config_file, "w") as f:
    json.dump(cfg, f, indent=2)
PYOVERRIDE

  if [ "$_write_rc" -eq 0 ]; then
    # Recompute config hash so integrity check passes on next startup
    if (cd /sandbox/.openclaw && sha256sum openclaw.json fabric.json >"$hash_file"); then
      printf '[SECURITY] Config hash recomputed after model override\n' >&2
    else
      _write_rc=$?
    fi
  fi

  # Always restore ownership/mode, even on write/hash failure (#2653, #2877).
  restore_openclaw_config_after_write "$config_file" "$hash_file"
  [ "$_write_rc" -eq 0 ] || return "$_write_rc"
}

# ── Agent identity reconciliation with provider routing ───────────
# After the host-side `openshell inference set` swaps the gateway's
# inference provider entry, agents.defaults.model.primary AND the
# in-sandbox models.providers.inference.models[0] entry can both go
# stale: openshell only updates the gateway, not /sandbox/.openclaw/
# openclaw.json. The gateway routes requests to the new model but
# the agent self-reports the old one, and on the next gateway
# reconciliation the file's stale entry can be pushed back, reverting
# the route.
#
# Probe the live gateway via `openshell inference get --json` and
# treat it as the source of truth: when the gateway model differs
# from the file, align both primary and the inference provider's
# first model entry so the agent identity and the gateway route stay
# consistent across the next reconcile cycle.
#
# When the gateway probe is unavailable (no openshell binary, gateway
# unreachable, malformed output), fall back to the legacy in-file
# reconcile so the function still closes primary↔models[0] drift.
#
# Runs after apply_model_override so explicit NEMOCLAW_MODEL_OVERRIDE
# values still win. No-op when already in sync.
# Ref: https://github.com/NVIDIA/NemoClaw/issues/3175

reconcile_agent_model_with_provider() {
  # apply_model_override already won; reconciling against the gateway would
  # overwrite the user's explicit choice with an inference/-prefixed variant.
  [ -z "${NEMOCLAW_MODEL_OVERRIDE:-}" ] || return 0

  if [ "$(id -u)" -ne 0 ]; then
    return 0
  fi

  local config_file="/sandbox/.openclaw/openclaw.json"
  local fabric_file="/sandbox/.openclaw/fabric.json"
  local hash_file="/sandbox/.openclaw/.config-hash"

  [ -f "$config_file" ] || return 0

  if [ "$(openclaw_config_dir_owner "$(dirname "$config_file")")" = "root" ]; then
    printf '[config] Shields are up; skipping provider-model reconciliation for the sealed config\n' >&2
    return 0
  fi

  if [ -L "$config_file" ] || [ -L "$fabric_file" ] || [ -L "$hash_file" ]; then
    return 0
  fi
  if [ ! -f "$fabric_file" ]; then
    return 0
  fi

  local gateway_model=""
  if command -v openshell >/dev/null 2>&1; then
    gateway_model="$(
      python3 - <<'PYPROBE'
import json, subprocess
try:
    result = subprocess.run(
        ["openshell", "inference", "get", "--json"],
        capture_output=True,
        timeout=3,
        check=False,
    )
except Exception:
    raise SystemExit(0)
if result.returncode != 0:
    raise SystemExit(0)
try:
    data = json.loads(result.stdout)
except Exception:
    raise SystemExit(0)
model = data.get("model") if isinstance(data, dict) else None
if isinstance(model, str) and model:
    print(model)
PYPROBE
    )"
  fi

  local provider_model_ref
  provider_model_ref="$(
    GATEWAY_MODEL="${gateway_model:-}" python3 - "$config_file" <<'PYRECONCILE_READ'
import json, os, sys

try:
    with open(sys.argv[1]) as f:
        cfg = json.load(f)
except Exception:
    sys.exit(0)

primary = cfg.get("agents", {}).get("defaults", {}).get("model", {}).get("primary")
provider = cfg.get("models", {}).get("providers", {}).get("inference", {})
models = provider.get("models") if isinstance(provider, dict) else None
first = (
    models[0]
    if isinstance(models, list) and models and isinstance(models[0], dict)
    else None
)


def qualify(model_id):
    if not isinstance(model_id, str) or not model_id:
        return None
    return model_id if model_id.startswith("inference/") else f"inference/{model_id}"


gateway_target = qualify(os.environ.get("GATEWAY_MODEL", ""))
if gateway_target is not None:
    bare = gateway_target[len("inference/"):]
    first_name = first.get("name") if first is not None else None
    first_id = first.get("id") if first is not None else None
    primary_ok = isinstance(primary, str) and primary == gateway_target
    first_name_ok = isinstance(first_name, str) and first_name == gateway_target
    first_id_ok = isinstance(first_id, str) and (first_id == bare or first_id == gateway_target)
    if primary_ok and first_name_ok and first_id_ok:
        sys.exit(0)
    print(f"gateway\t{gateway_target}")
    sys.exit(0)

# Legacy fallback: gateway probe is unavailable. Align primary with
# the in-file provider entry only (models[0] is treated as the
# source). Preserves pre-gateway-probe behavior for environments
# without openshell.
if first is None:
    sys.exit(0)
legacy_target = qualify(first.get("name") or first.get("id"))
if legacy_target is None:
    sys.exit(0)
if isinstance(primary, str) and primary == legacy_target:
    sys.exit(0)
print(f"legacy\t{legacy_target}")
PYRECONCILE_READ
  )"

  if [ -z "$provider_model_ref" ]; then
    return 0
  fi

  local source_mode="${provider_model_ref%%$'\t'*}"
  provider_model_ref="${provider_model_ref#*$'\t'}"

  printf '[config] Reconciling agent identity with provider model: %s (source=%s, #3175)\n' \
    "$provider_model_ref" "$source_mode" >&2

  prepare_openclaw_config_for_write "$config_file" "$hash_file"
  local _write_rc=0

  RECONCILE_SOURCE="$source_mode" python3 - "$config_file" "$provider_model_ref" <<'PYRECONCILE_WRITE' || _write_rc=$?
import json, os, sys
config_file, provider_model = sys.argv[1], sys.argv[2]
with open(config_file) as f:
    cfg = json.load(f)
cfg.setdefault("agents", {}).setdefault("defaults", {}).setdefault("model", {})["primary"] = provider_model
if os.environ.get("RECONCILE_SOURCE") == "gateway":
    bare = (
        provider_model[len("inference/"):]
        if provider_model.startswith("inference/")
        else provider_model
    )
    models_root = cfg.setdefault("models", {})
    providers_root = models_root.setdefault("providers", {})
    inference = providers_root.setdefault("inference", {})
    models_list = inference.get("models")
    if not isinstance(models_list, list) or not models_list:
        models_list = [{}]
        inference["models"] = models_list
    first = models_list[0]
    if not isinstance(first, dict):
        first = {}
        models_list[0] = first
    first["id"] = bare
    first["name"] = provider_model
with open(config_file, "w") as f:
    json.dump(cfg, f, indent=2)
PYRECONCILE_WRITE

  if [ "$_write_rc" -eq 0 ]; then
    if (cd /sandbox/.openclaw && sha256sum openclaw.json fabric.json >"$hash_file"); then
      printf '[SECURITY] Config hash recomputed after agent identity reconciliation\n' >&2
    else
      _write_rc=$?
    fi
  fi

  restore_openclaw_config_after_write "$config_file" "$hash_file"
  [ "$_write_rc" -eq 0 ] || return "$_write_rc"
}

# ── Runtime CORS origin override ──────────────────────────────────
# Adds a browser origin to gateway.controlUi.allowedOrigins at startup
# without rebuilding the sandbox image. Useful for custom domains/ports.
# Same trust model as model override: host-set env var, applied before
# chattr +i, hash recomputed.
# Ref: https://github.com/NVIDIA/NemoClaw/issues/719

apply_cors_override() {
  [ -n "${NEMOCLAW_CORS_ORIGIN:-}" ] || return 0

  if [ "$(id -u)" -ne 0 ]; then
    printf '[SECURITY] NEMOCLAW_CORS_ORIGIN ignored — requires root (non-root mode cannot write to config)\n' >&2
    return 0
  fi

  local config_file="/sandbox/.openclaw/openclaw.json"
  local fabric_file="/sandbox/.openclaw/fabric.json"
  local hash_file="/sandbox/.openclaw/.config-hash"

  if [ "$(openclaw_config_dir_owner "$(dirname "$config_file")")" = "root" ]; then
    printf '[config] Shields are up; deferring the CORS override until config is mutable\n' >&2
    return 0
  fi

  if [ -L "$config_file" ] || [ -L "$fabric_file" ] || [ -L "$hash_file" ]; then
    printf '[SECURITY] Refusing CORS override — protected config path is a symlink\n' >&2
    return 1
  fi
  if [ ! -f "$config_file" ] || [ ! -f "$fabric_file" ]; then
    printf '[SECURITY] Refusing CORS override — protected config file is missing or not regular\n' >&2
    return 1
  fi

  local cors_origin="$NEMOCLAW_CORS_ORIGIN"

  if printf '%s' "$cors_origin" | grep -qP '[\x00-\x1f\x7f]'; then
    printf '[SECURITY] NEMOCLAW_CORS_ORIGIN contains control characters — refusing\n' >&2
    return 1
  fi
  if [ "${#cors_origin}" -gt 256 ]; then
    printf '[SECURITY] NEMOCLAW_CORS_ORIGIN exceeds 256 characters — refusing\n' >&2
    return 1
  fi
  if ! printf '%s' "$cors_origin" | grep -qE '^https?://'; then
    printf '[SECURITY] NEMOCLAW_CORS_ORIGIN must start with http:// or https://, got "%s" — skipping override\n' "$cors_origin" >&2
    return 0
  fi

  printf '[config] Adding CORS origin: %s\n' "$cors_origin" >&2

  # See apply_model_override for the locked-vs-mutable config mode split.
  prepare_openclaw_config_for_write "$config_file" "$hash_file"
  local _write_rc=0

  python3 - "$config_file" "$cors_origin" <<'PYCORS' || _write_rc=$?
import json, sys

config_file, cors_origin = sys.argv[1], sys.argv[2]

with open(config_file) as f:
    cfg = json.load(f)

origins = cfg.get("gateway", {}).get("controlUi", {}).get("allowedOrigins", [])
if cors_origin not in origins:
    origins.append(cors_origin)
    cfg.setdefault("gateway", {}).setdefault("controlUi", {})["allowedOrigins"] = origins

with open(config_file, "w") as f:
    json.dump(cfg, f, indent=2)
PYCORS

  if [ "$_write_rc" -eq 0 ]; then
    if (cd /sandbox/.openclaw && sha256sum openclaw.json fabric.json >"$hash_file"); then
      printf '[config] Config hash recomputed after CORS override\n' >&2
    else
      _write_rc=$?
    fi
  fi

  # Always restore ownership/mode, even on write/hash failure (#2653, #2877).
  restore_openclaw_config_after_write "$config_file" "$hash_file"
  [ "$_write_rc" -eq 0 ] || return "$_write_rc"
}

refresh_openclaw_provider_placeholders() {
  local config_file="/sandbox/.openclaw/openclaw.json"
  local fabric_file="/sandbox/.openclaw/fabric.json"
  local hash_file="/sandbox/.openclaw/.config-hash"
  [ -f "$config_file" ] || return 0

  if [ "$(openclaw_config_dir_owner "$(dirname "$config_file")")" = "root" ]; then
    printf '[config] Shields are up; preserving sealed openclaw.json provider placeholders unchanged\n' >&2
    return 0
  fi

  local keys
  keys="$(
    python3 - "$config_file" <<'PYPLACEHOLDERKEYS'
import base64
import json
import os
import re
import sys

config_file = sys.argv[1]
prefix = "openshell:resolve:env:"
alias_marker = "-OPENSHELL-RESOLVE-ENV-"
env_key_re = re.compile(r"^[A-Z][A-Z0-9_]{0,127}$")
revision_re = re.compile(r"^v[0-9]+_")
keys = set()
MESSAGING_RUNTIME_PLAN_DEFAULT_PATH = "/usr/local/share/nemoclaw/messaging-runtime-plan.json"


def add_key(value):
    key = revision_re.sub("", value)
    if env_key_re.match(key):
        keys.add(key)


def walk(value):
    if isinstance(value, str):
        if value.startswith(prefix):
            add_key(value[len(prefix) :])
        alias_index = value.find(alias_marker)
        if alias_index > 0:
            add_key(value[alias_index + len(alias_marker) :])
        return
    if isinstance(value, list):
        for item in value:
            walk(item)
        return
    if isinstance(value, dict):
        for item in value.values():
            walk(item)


try:
    with open(config_file, encoding="utf-8") as f:
        walk(json.load(f))
except Exception:
    pass

def read_messaging_plan():
    raw_plan = os.environ.get("NEMOCLAW_MESSAGING_PLAN_B64", "").strip()
    if raw_plan:
        try:
            return json.loads(base64.b64decode(raw_plan).decode("utf-8"))
        except Exception:
            return None
    artifact_path = os.environ.get(
        "NEMOCLAW_MESSAGING_RUNTIME_PLAN_PATH",
        MESSAGING_RUNTIME_PLAN_DEFAULT_PATH,
    )
    if not artifact_path or not os.path.isfile(artifact_path):
        return None
    try:
        with open(artifact_path, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


plan = read_messaging_plan()
if isinstance(plan, dict):
    for binding in plan.get("credentialBindings", []):
        if isinstance(binding, dict) and isinstance(binding.get("providerEnvKey"), str):
            add_key(binding["providerEnvKey"])

base_keys = {
    key
    for key in keys
    if not any(key != candidate and key.startswith(f"{candidate}_") for candidate in keys)
}
print(" ".join(sorted(base_keys)))
PYPLACEHOLDERKEYS
  )"
  local base_keys="$keys"

  # Append operator-registered extras from NEMOCLAW_EXTRA_PLACEHOLDER_KEYS so
  # the revision-strip walk also collapses suffixed placeholders such as
  # openshell:resolve:env:v51_<ENV_KEY>_AGENT_A back to the canonical
  # form. The host-side onboard parser at
  # src/lib/onboard/extra-placeholder-keys.ts already filters by an identical
  # regex, rejects canonical-channel collisions, and requires every entry to
  # extend a canonical channel envKey with a non-empty `_<suffix>`; this loop
  # mirrors those checks against provider envKeys discovered from the messaging
  # plan and current OpenClaw config because the env var travels through one
  # extra hop and a sandbox operator could clobber it independently. Keeping the
  # sandbox parser restrictive means a host-side refusal for unrelated secrets
  # (GITHUB_TOKEN, NEMOCLAW_EXTRA_PLACEHOLDER_KEYS itself, etc.) cannot be
  # bypassed by mutating the runtime env after sandbox boot.
  local extra_token
  local _extra_raw="${NEMOCLAW_EXTRA_PLACEHOLDER_KEYS-}"
  # Normalize commas to whitespace so callers can pass either form,
  # matching the host-side parseExtraPlaceholderKeys contract.
  _extra_raw="${_extra_raw//,/ }"
  local _extras_accepted=0
  local _canon_prefix
  local _accepted_this_token
  local _canonical_collision
  local _example_key
  local _accepted_extra_keys=""
  for extra_token in $_extra_raw; do
    [ -n "$extra_token" ] || continue
    _canonical_collision=0
    for _canon_prefix in $base_keys; do
      if [ "$extra_token" = "$_canon_prefix" ]; then
        _canonical_collision=1
        break
      fi
    done
    [ "$_canonical_collision" -eq 1 ] && continue
    if ! printf '%s' "$extra_token" | grep -Eq '^[A-Z][A-Z0-9_]{0,127}$'; then
      printf "[config] Ignoring NEMOCLAW_EXTRA_PLACEHOLDER_KEYS entry '%s' — must match /^[A-Z][A-Z0-9_]{0,127}\$/\n" \
        "$extra_token" >&2
      continue
    fi
    _accepted_this_token=0
    _example_key=""
    for _canon_prefix in $base_keys; do
      [ -n "$_example_key" ] || _example_key="$_canon_prefix"
      case "$extra_token" in
        "${_canon_prefix}_"?*)
          _accepted_this_token=1
          break
          ;;
      esac
    done
    if [ "$_accepted_this_token" -ne 1 ]; then
      if [ -n "$_example_key" ]; then
        printf "[config] Ignoring NEMOCLAW_EXTRA_PLACEHOLDER_KEYS entry '%s' — must extend a discovered provider envKey such as %s_<suffix>\n" \
          "$extra_token" "$_example_key" >&2
      else
        printf "[config] Ignoring NEMOCLAW_EXTRA_PLACEHOLDER_KEYS entry '%s' — must extend a discovered provider envKey from the messaging plan or OpenClaw config\n" \
          "$extra_token" >&2
      fi
      continue
    fi
    if [ "$_extras_accepted" -ge 32 ]; then
      printf "[config] NEMOCLAW_EXTRA_PLACEHOLDER_KEYS: capped at 32 entries; ignoring remainder\n" >&2
      break
    fi
    keys="$keys $extra_token"
    _accepted_extra_keys="${_accepted_extra_keys:+$_accepted_extra_keys }$extra_token"
    _extras_accepted=$((_extras_accepted + 1))
  done
  if [ "$_extras_accepted" -gt 0 ]; then
    # Deterministic breadcrumb so e2e harnesses can prove the host-validated
    # extras list reached the in-container refresh helper even when no
    # revision-scoped placeholder has been staged yet (which is the steady
    # state for a fresh provider attach). Stripping the canonical baseline
    # prefix here keeps the log line about extras only.
    printf '[config] NEMOCLAW_EXTRA_PLACEHOLDER_KEYS accepted %d entry(ies): %s\n' \
      "$_extras_accepted" "$_accepted_extra_keys" >&2
  fi

  if [ -L "$config_file" ] || [ -L "$fabric_file" ] || [ -L "$hash_file" ]; then
    printf '[SECURITY] Refusing provider placeholder refresh — protected config path is a symlink\n' >&2
    return 1
  fi
  if [ ! -f "$fabric_file" ]; then
    printf '[SECURITY] Refusing provider placeholder refresh — Fabric config is missing or not regular\n' >&2
    return 1
  fi

  prepare_openclaw_config_for_write "$config_file" "$hash_file"
  local _write_rc=0
  local _placeholder_report=""

  _placeholder_report="$(
    NEMOCLAW_PROVIDER_PLACEHOLDER_KEYS="$keys" \
      python3 - "$config_file" <<'PYPLACEHOLDERS'
import json
import os
import re
import sys

config_file = sys.argv[1]
prefix = "openshell:resolve:env:"
alias_marker = "-OPENSHELL-RESOLVE-ENV-"
keys = os.environ.get("NEMOCLAW_PROVIDER_PLACEHOLDER_KEYS", "").split()
replacements = {}
warnings = []

for key in keys:
    value = os.environ.get(key, "")
    if value.startswith(prefix) and value != f"{prefix}{key}":
        replacements[f"{prefix}{key}"] = (key, value)

with open(config_file, encoding="utf-8") as f:
    config = json.load(f)

refreshed = set()

# Match each canonical placeholder only as an exact token. The OpenShell
# placeholder grammar is "openshell:resolve:env:[A-Za-z_][A-Za-z0-9_]*",
# so the negative-lookahead ensures replacing one provider env key does not
# also mutate a suffixed extra placeholder; sort longest-first so two keys
# sharing a strict prefix still match the more specific one when both
# replacements happen to apply to the same exact-token position (the
# lookahead already guarantees disjoint matches in practice, but keeping
# longest-first preserves the determinism the tests rely on).
replacement_patterns = [
    (re.compile(re.escape(old) + r"(?![A-Za-z0-9_])"), key, new)
    for old, (key, new) in sorted(replacements.items(), key=lambda kv: -len(kv[0]))
]


def rewrite(value):
    if isinstance(value, str):
        for pattern, key, new in replacement_patterns:
            updated, count = pattern.subn(new, value)
            if count:
                refreshed.add(key)
                value = updated
        alias_index = value.find(alias_marker)
        if alias_index > 0:
            alias_suffix = value[alias_index + len(alias_marker) :]
            for env_key in keys:
                if alias_suffix != env_key and not re.fullmatch(
                    rf"v[0-9]{{1,20}}_{re.escape(env_key)}", alias_suffix
                ):
                    continue
                runtime_value = os.environ.get(env_key, "")
                if not runtime_value.startswith(prefix):
                    continue
                runtime_suffix = runtime_value[len(prefix) :]
                if runtime_suffix != env_key and not re.fullmatch(
                    rf"v[0-9]{{1,20}}_{re.escape(env_key)}", runtime_suffix
                ):
                    continue
                updated = value[: alias_index + len(alias_marker)] + runtime_suffix
                if updated != value:
                    refreshed.add(env_key)
                    value = updated
                break
        return value
    if isinstance(value, list):
        return [rewrite(item) for item in value]
    if isinstance(value, dict):
        return {k: rewrite(v) for k, v in value.items()}
    return value

updated = rewrite(config)

def placeholder_suffix_matches_env_key(suffix, env_key):
    if suffix == env_key:
        return True
    revision = re.match(r"^v[0-9]+_", suffix)
    return bool(revision and suffix[len(revision.group(0)) :] == env_key)


def path_label(path):
    if len(path) >= 5 and path[0] == "channels" and path[2] == "accounts":
        return f"{path[1]}.{path[3]}.{path[4]}"
    return ".".join(path)


def walk_for_warnings(value, path):
    if isinstance(value, str):
        if value.startswith(prefix):
            suffix = value[len(prefix) :]
            for env_key in keys:
                if not placeholder_suffix_matches_env_key(suffix, env_key):
                    continue
                env_value = os.environ.get(env_key, "")
                label = path_label(path)
                if not env_value:
                    warnings.append(
                        f"[channels] {label} is an OpenShell placeholder but {env_key} is missing from the runtime environment"
                    )
                elif not env_value.startswith(prefix):
                    warnings.append(
                        f"[channels] {label} left unchanged because {env_key} is not an OpenShell placeholder; refusing to write raw credentials to openclaw.json"
                    )
                elif not placeholder_suffix_matches_env_key(env_value[len(prefix) :], env_key):
                    warnings.append(
                        f"[channels] {label} placeholder does not match the OpenShell runtime placeholder for {env_key}"
                    )
                elif value != env_value:
                    warnings.append(
                        f"[channels] {label} placeholder does not match the OpenShell runtime placeholder for {env_key}"
                    )
                break
        alias_index = value.find(alias_marker)
        if alias_index > 0:
            alias_env_key = value[alias_index + len(alias_marker) :]
            token_scheme = value[:alias_index] + "-"
            for env_key in keys:
                if env_key != alias_env_key:
                    continue
                label = path_label(path)
                env_value = os.environ.get(env_key, "")
                placeholder_re = re.compile(
                    rf"^{re.escape(prefix)}(v[0-9]+_)?{re.escape(env_key)}$"
                )
                if not env_value:
                    warnings.append(
                        f"[channels] {label} expects the {env_key} provider placeholder but it is missing from the runtime environment"
                    )
                elif not placeholder_re.match(env_value) and not env_value.startswith(token_scheme):
                    warnings.append(
                        f"[channels] {label} runtime {env_key} is neither the {env_key} OpenShell placeholder nor a {token_scheme} token; runtime may reject it"
                    )
                break
        return
    if isinstance(value, list):
        for index, item in enumerate(value):
            walk_for_warnings(item, path + [str(index)])
        return
    if isinstance(value, dict):
        for key, item in value.items():
            walk_for_warnings(item, path + [str(key)])


walk_for_warnings(updated, [])

if updated != config:
    with open(config_file, "w", encoding="utf-8") as f:
        json.dump(updated, f, indent=2)
        f.write("\n")

if refreshed:
    print("refreshed=" + ",".join(sorted(refreshed)))
for warning in warnings:
    print("warning=" + warning)
PYPLACEHOLDERS
  )" || _write_rc=$?

  if [ "$_write_rc" -eq 0 ]; then
    local _refreshed_keys
    _refreshed_keys="$(printf '%s\n' "$_placeholder_report" | sed -n 's/^refreshed=//p' | tail -n 1)"
    if [ -n "$_refreshed_keys" ]; then
      if (cd /sandbox/.openclaw && sha256sum openclaw.json fabric.json >"$hash_file"); then
        printf '[config] Refreshed provider placeholders from OpenShell runtime env: %s\n' "$_refreshed_keys" >&2
      else
        _write_rc=$?
      fi
    fi
    printf '%s\n' "$_placeholder_report" | sed -n 's/^warning=//p' | while IFS= read -r _warning; do
      [ -n "$_warning" ] && printf '%s\n' "$_warning" >&2
    done
  fi

  restore_openclaw_config_after_write "$config_file" "$hash_file"
  [ "$_write_rc" -eq 0 ] || return "$_write_rc"
  return 0
}
