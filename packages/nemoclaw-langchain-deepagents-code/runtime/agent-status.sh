#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Managed Deep Agents Code status and identity output. This file is sourced by
# agent-wrapper.sh after the wrapper validates the sandbox environment.

# SECURITY: managed identity/status display boundary.
# - Invalid state: config.toml and runtime environment values are mutable inside
#   the sandbox and can contain terminal controls, credentials, unsafe endpoint
#   components, or TOML forms outside the generated NemoClaw contract.
# - Source boundary: this status module is the final boundary before those
#   values are printed. Validating only the config writer would not protect
#   later sandbox mutations, and upstream dcode does not expose a validated
#   identity API.
# - Source-fix constraint: this pre-exec Bash entrypoint cannot import the
#   canonical TypeScript filters or a full TOML parser without adding a process
#   and dependency. It therefore reads only known generated sections and exact
#   quoted scalars; arrays, inline comments, and other forms are not accepted.
# - Regression: tests/runtime/identity.test.ts covers malformed scalars,
#   terminal controls, oversized and secret-shaped metadata, and unsafe endpoint
#   forms. The composed startup/status handoff has a separate integration test.
# - Removal condition: replace these local readers/filters when upstream dcode
#   provides a validated identity API or every invocation uses a Node entrypoint
#   that imports the canonical TypeScript contracts and a real TOML parser.
toml_section_scalar() {
  local section="$1"
  local key="$2"
  local line current_section=""
  [ -r "$DEEPAGENTS_CONFIG_FILE" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    line="$(trim_whitespace "$line")"
    case "$line" in
      \[*\])
        current_section="${line#\[}"
        current_section="${current_section%\]}"
        continue
        ;;
    esac
    [ "$current_section" = "$section" ] || continue
    case "$line" in
      "$key = \""*)
        line="${line#"$key = \""}"
        case "$line" in
          *\")
            printf '%s' "${line%\"}"
            return 0
            ;;
        esac
        ;;
    esac
  done <"$DEEPAGENTS_CONFIG_FILE"
  return 0
}

toml_provider_metadata() {
  local field="$1"
  local line route provider _api
  [ -r "$DEEPAGENTS_CONFIG_FILE" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      "# NemoClaw provider route: "*)
        line="${line#"# NemoClaw provider route: "}"
        IFS=';' read -r route provider _api <<<"$line"
        route="$(trim_whitespace "$route")"
        provider="$(trim_whitespace "$provider")"
        case "$provider" in
          "upstream provider: "*) provider="${provider#"upstream provider: "}" ;;
          *) provider="" ;;
        esac
        case "$field" in
          route) printf '%s' "$route" ;;
          provider) printf '%s' "$provider" ;;
        esac
        return 0
        ;;
    esac
  done <"$DEEPAGENTS_CONFIG_FILE"
  return 0
}

is_safe_dcode_agent_name() {
  local value="$1"
  local pattern='^[A-Za-z0-9_ -]+$'
  local LC_ALL=C
  [ -n "$value" ] || return 1
  [ -n "$(trim_whitespace "$value")" ] || return 1
  [[ "$value" =~ $pattern ]]
}

resolve_dcode_agent() {
  local config_dir candidate
  config_dir="${DEEPAGENTS_CONFIG_FILE%/*}"
  candidate="$(toml_section_scalar agents default)"
  if is_safe_dcode_agent_name "$candidate" && [ -d "$config_dir/$candidate" ]; then
    printf '%s' "$candidate"
    return 0
  fi
  candidate="$(toml_section_scalar agents recent)"
  if is_safe_dcode_agent_name "$candidate" && [ -d "$config_dir/$candidate" ]; then
    printf '%s' "$candidate"
    return 0
  fi
  printf '%s' 'agent (default)'
}

terminal_safe_identity_value() {
  local value="$1"
  local fallback="${2:-}"
  local LC_ALL=C
  if [ ${#value} -gt 256 ] || [[ "$value" =~ [[:cntrl:]] ]] || is_secret_shaped_value "$value"; then
    printf '%s' "$fallback"
  else
    printf '%s' "$value"
  fi
}

safe_endpoint_identity_value() {
  local value lower_value scheme authority
  value="$(terminal_safe_identity_value "$1")"
  [ -n "$value" ] || return 0
  case "$value" in
    *\\* | *\?* | *\#*) return 0 ;;
  esac
  lower_value="${value,,}"
  # Encoded query, fragment, userinfo, or percent delimiters can conceal
  # credential-bearing endpoint components from the literal checks above.
  case "$lower_value" in
    *%3f* | *%23* | *%40* | *%25*) return 0 ;;
  esac
  scheme="${value%%://*}"
  [ "$scheme" != "$value" ] || return 0
  case "${scheme,,}" in
    http | https) ;;
    *) return 0 ;;
  esac
  authority="${value#*://}"
  authority="${authority%%/*}"
  case "$authority" in
    "" | *@*) return 0 ;;
  esac
  printf '%s' "$value"
}

print_identity() {
  local sandbox_name agent model endpoint route provider
  sandbox_name="$(terminal_safe_identity_value "${NEMOCLAW_SANDBOX_NAME:-unknown}" unknown)"
  agent="$(terminal_safe_identity_value "$(resolve_dcode_agent)" 'agent (default)')"
  model="$(terminal_safe_identity_value "$(toml_section_scalar models default)")"
  [ -n "$model" ] || model="$(terminal_safe_identity_value "$(toml_section_scalar models recent)")"
  endpoint="$(toml_section_scalar models.providers.openai base_url)"
  [ -n "$endpoint" ] || endpoint="$(toml_section_scalar models.providers.openrouter base_url)"
  route="$(terminal_safe_identity_value "$(toml_provider_metadata route)")"
  provider="$(terminal_safe_identity_value "$(toml_provider_metadata provider)")"
  case "$model" in
    openrouter:*) provider="openrouter" ;;
  esac
  [ -n "$endpoint" ] || endpoint="${OPENAI_BASE_URL:-}"
  endpoint="$(safe_endpoint_identity_value "$endpoint")"
  printf 'Sandbox:  %s\n' "$sandbox_name"
  printf 'Harness:  %s\n' 'langchain-deepagents-code'
  printf 'Agent:    %s\n' "$agent"
  if [ -n "$route" ]; then
    printf 'Route:    %s\n' "$route"
  fi
  if [ -n "$provider" ]; then
    printf 'Provider: %s\n' "$provider"
  fi
  if [ -n "$model" ]; then
    printf 'Model:    %s\n' "$model"
  fi
  if [ -n "$endpoint" ]; then
    printf 'Endpoint: %s\n' "$endpoint"
  fi
  printf 'Runtime:  %s\n' 'Deep Agents Code (terminal)'
}

print_managed_help() {
  cat <<'EOF'
NemoClaw-managed commands:
  dcode status      Show managed sandbox and dcode runtime identity
  dcode whoami      Alias for dcode status
  dcode identity    Alias for dcode status
  dcode tools call-read-only TOOL --json
                    Call one exact, coherently read-only MCP tool

EOF
}

case "${1:-}" in
  status | whoami | identity)
    print_identity
    exit 0
    ;;
  --help | -h | help)
    print_managed_help
    run_dcode "$@"
    ;;
  --version | -v | -V)
    run_dcode "$@"
    ;;
esac
