# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
# shellcheck shell=bash

# ── Proxy environment ────────────────────────────────────────────
# OpenShell injects HTTP_PROXY/HTTPS_PROXY/NO_PROXY into the sandbox, but its
# NO_PROXY is limited to 127.0.0.1,localhost,::1 — missing the gateway IP.
# The gateway IP itself must bypass the proxy to avoid proxy loops.
#
# Do NOT add inference.local here. OpenShell intentionally routes that hostname
# through the proxy path; bypassing the proxy forces a direct DNS lookup inside
# the sandbox, which breaks inference.local resolution.
#
# NEMOCLAW_PROXY_HOST / NEMOCLAW_PROXY_PORT can be overridden at sandbox
# creation time if the gateway IP or port changes in a future OpenShell release.
# Ref: https://github.com/NVIDIA/NemoClaw/issues/626
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
# #1828 OpenShell CA behavior stays intact) — and repoint the CA env vars at
# the merged bundle so curl/python/git/node all trust both roots.
_NEMOCLAW_CORPORATE_CA_FILE="/usr/local/share/nemoclaw/corporate-ca.pem"
_NEMOCLAW_CORPORATE_CA_HELPER="/usr/local/lib/nemoclaw/corporate-ca-runtime.sh"
if [ ! -f "$_NEMOCLAW_CORPORATE_CA_HELPER" ]; then
  _NEMOCLAW_CORPORATE_CA_HELPER="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../../../scripts/lib/corporate-ca-runtime.sh"
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
# Git TLS CA bundle fix (NemoClaw#2270).
# OpenShell's L7 proxy does MITM TLS termination and re-signs with its own CA.
# OpenShell injects SSL_CERT_FILE and CURL_CA_BUNDLE pointing at the CA bundle,
# but git does not read those — it needs GIT_SSL_CAINFO.  Without it, git clone
# fails with "server certificate verification failed".
# Use SSL_CERT_FILE (set by OpenShell) as the canonical CA bundle path.
if [ -n "${SSL_CERT_FILE:-}" ] && [ -f "${SSL_CERT_FILE}" ]; then
  export GIT_SSL_CAINFO="$SSL_CERT_FILE"
fi

# HTTP library + NODE_USE_ENV_PROXY double-proxy fix (NemoClaw#2109).
# Node.js 22 sets NODE_USE_ENV_PROXY=1 in the OpenShell base image, which
# intercepts https.request() calls and handles proxying via CONNECT tunnel.
# HTTP libraries (axios, follow-redirects, proxy-from-env) also read
# HTTPS_PROXY and configure HTTP FORWARD mode, double-processing the
# request — the L7 proxy rejects with "FORWARD rejected: HTTPS requires
# CONNECT".
#
# The preload wraps http.request() — the lowest common denominator every
# HTTP client bottoms out at — and rewrites FORWARD-mode requests back to
# https.request() so NODE_USE_ENV_PROXY can handle the CONNECT tunnel.
#
# Earlier PR #2110 intercepted require('axios') via a Module._load hook;
# that could not catch follow-redirects + proxy-from-env bundled as ESM
# in OpenClaw's dist/ (no require() calls to intercept).
#
# Node runtime preload modules are copied into /usr/local/lib/nemoclaw/preloads/
# at image build time, then copied to /tmp before NODE_OPTIONS=--require so
# the sandbox user can read them under Landlock-constrained runtimes.
# ── Global sandbox safety net ──────────────────────────────────
# Last-resort handler for uncaught exceptions and unhandled rejections
# that would otherwise crash the gateway. The gateway is shared sandbox
# infrastructure; user-initiated actions must not be able to take it down.
#
# This is intentionally NOT a catch-all swallow. Known-benign error
# patterns are documented inline in the script; unknown patterns are
# logged with full stack so they can be diagnosed and either fixed
# upstream or added to the allow-list with explicit justification.
# Specific guards (Slack, ciao) pre-empt their own error patterns;
# this is the backstop for everything else.
#
# Only active when OPENSHELL_SANDBOX=1 (set by OpenShell at runtime),
# and only for gateway processes. Outside a sandbox or in CLI processes
# (agent, doctor, plugins, tui, etc.) normal Node.js crash behavior is
# preserved so errors surface promptly to users running short-lived tools.
_SANDBOX_SAFETY_NET="/tmp/nemoclaw-sandbox-safety-net.js"
_SANDBOX_SAFETY_NET_SOURCE="/usr/local/lib/nemoclaw/preloads/sandbox-safety-net.js"

_PROXY_FIX_SCRIPT="/tmp/nemoclaw-http-proxy-fix.js"
_PROXY_FIX_SOURCE="/usr/local/lib/nemoclaw/preloads/http-proxy-fix.js"

# NVIDIA endpoint model-specific inference parameter injection
# (NemoClaw#1193, NemoClaw#2051).
# Nemotron models may return empty content (tool call instead of text) or
# thinking-only blocks (stalls the conversation) when the model's chat
# template produces an empty assistant turn. The vLLM / NIM chat template
# kwarg `force_nonempty_content` prevents this by ensuring the template
# always emits a non-empty content field.
#
# DeepSeek V4 Pro and Kimi K2.6 on NVIDIA Build expect chat template
# thinking mode disabled for NemoClaw's OpenAI-compatible
# chat-completions path.
#
# The preload wraps http.request()/https.request() plus fetch() because modern
# OpenAI-compatible clients may use either transport. It buffers JSON bodies for
# POST requests to /v1/chat/completions and injects model-specific kwargs for the
# affected NVIDIA endpoint models. Backends that do not recognise the extra
# field silently ignore it (OpenAI-compatible contract).
#
# Scoped strictly to known affected models: unrelated requests pass through
# completely untouched. This sandbox preload is the source-boundary workaround
# until upstream clients/providers always emit these model-specific kwargs; see
# packages/nemoclaw-openclaw/runtime/preloads/nemotron-inference-fix.js for the invalid state,
# regression proof, and removal condition.
_NEMOTRON_FIX_SCRIPT="/tmp/nemoclaw-nemotron-inference-fix.js"
_NEMOTRON_FIX_SOURCE="/usr/local/lib/nemoclaw/preloads/nemotron-inference-fix.js"

# mDNS / ciao network interface guard.
# The @homebridge/ciao mDNS library calls os.networkInterfaces() which
# throws a SystemError (uv_interface_addresses) inside sandboxes with
# restricted network namespaces (seccomp/Landlock). This crashes the
# gateway even though mDNS is not needed. The guard monkey-patches
# os.networkInterfaces to return an empty object on failure instead
# of throwing, and catches the uncaughtException as a fallback.
# Ref: https://github.com/NVIDIA/NemoClaw/issues/2340
_CIAO_GUARD_SCRIPT="/tmp/nemoclaw-ciao-network-guard.js"
_CIAO_GUARD_SOURCE="/usr/local/lib/nemoclaw/preloads/ciao-network-guard.js"

# Stage the immutable, image-packaged preload set into /tmp. Startup and
# authenticated PID 1 recovery share this exact path so a pod-recreate-style
# /tmp wipe cannot drift from the initial security boundary. The shared emit
# helper atomically replaces each target as root:root 0444 in root mode.
install_core_runtime_preloads() {
  emit_sandbox_sourced_file "$_SANDBOX_SAFETY_NET" <"$_SANDBOX_SAFETY_NET_SOURCE" || return 1
  append_node_require_once "$_SANDBOX_SAFETY_NET"

  if [ "${NODE_USE_ENV_PROXY:-}" = "1" ]; then
    emit_sandbox_sourced_file "$_PROXY_FIX_SCRIPT" <"$_PROXY_FIX_SOURCE" || return 1
    append_node_require_once "$_PROXY_FIX_SCRIPT"
  fi

  emit_sandbox_sourced_file "$_NEMOTRON_FIX_SCRIPT" <"$_NEMOTRON_FIX_SOURCE" || return 1
  append_node_require_once "$_NEMOTRON_FIX_SCRIPT"

  emit_sandbox_sourced_file "$_CIAO_GUARD_SCRIPT" <"$_CIAO_GUARD_SOURCE" || return 1
  append_node_require_once "$_CIAO_GUARD_SCRIPT"
}

install_core_runtime_preloads || exit 1

# OpenShell re-injects narrow NO_PROXY/no_proxy=127.0.0.1,localhost,::1 every
# time a user connects via `openshell sandbox connect`. Dynamic connect-session
# config lives in /tmp/nemoclaw-proxy-env.sh and is sourced by system-wide shell
# hooks from the base image, keeping per-user rc files free of proxy entries.
#
# SECURITY: The proxy-env file is written via emit_sandbox_sourced_file()
# which ensures root:root 444 in root mode (sandbox cannot modify) and
# best-effort 444 in non-root mode. The /tmp sticky bit prevents the
# sandbox user from deleting or replacing the root-owned file.
# Ref: https://github.com/NVIDIA/NemoClaw/issues/2181
#
# Both uppercase and lowercase variants are required: Node.js undici prefers
# lowercase (no_proxy) over uppercase (NO_PROXY) when both are set.
# curl/wget use uppercase.  gRPC C-core uses lowercase.
_RUNTIME_SHELL_ENV_FILE="/tmp/nemoclaw-proxy-env.sh"
_RUNTIME_SHELL_ENV_SHIM="[ -f ${_RUNTIME_SHELL_ENV_FILE} ] && . ${_RUNTIME_SHELL_ENV_FILE}"

write_runtime_shell_env() {
  _PROXY_ENV_FILE="/tmp/nemoclaw-proxy-env.sh"
  _emit_gateway_token_reconcile() {
    local _escaped_intended_gateway_token="$1"
    cat <<'GATEWAYTOKENRECONCILESTART'
# nemoclaw-gateway-token-reconcile start
# The proxy-env file is the trust anchor for OPENCLAW_GATEWAY_TOKEN. Probe
# writability in a subshell so a readonly pin cannot abort sourcing: advance the
# anchor when writable (also the fresh-source and repeated-source paths), stay
# silent when it already holds the intended value, and otherwise emit a
# controlled conflict diagnostic that never echoes the trusted token.
GATEWAYTOKENRECONCILESTART
    printf "if ( OPENCLAW_GATEWAY_TOKEN='%s' ) 2>/dev/null; then\n" \
      "$_escaped_intended_gateway_token"
    printf "  OPENCLAW_GATEWAY_TOKEN='%s'\n" "$_escaped_intended_gateway_token"
    printf "else\n  case \"\${OPENCLAW_GATEWAY_TOKEN-}\" in\n"
    printf "    '%s') : ;;\n" "$_escaped_intended_gateway_token"
    cat <<'GATEWAYTOKENRECONCILEEND'
    *)
      /usr/bin/printf '%s\n' 'Error: conflicting trust anchor' >&2
      /usr/bin/false
      ;;
  esac
fi
# nemoclaw-gateway-token-reconcile end
GATEWAYTOKENRECONCILEEND
  }
  {
    cat <<PROXYEOF
# Proxy configuration (overrides narrow OpenShell defaults on connect)
export HTTP_PROXY="$_PROXY_URL"
export HTTPS_PROXY="$_PROXY_URL"
export NO_PROXY="$_NO_PROXY_VAL"
export http_proxy="$_PROXY_URL"
export https_proxy="$_PROXY_URL"
export no_proxy="$_NO_PROXY_VAL"
export AWS_EC2_METADATA_DISABLED="true"
export JITI_FS_CACHE="false"
PROXYEOF
    local _openclaw_env_name _openclaw_env_value _escaped_openclaw_env_value
    local _escaped_gateway_port _escaped_gateway_url _escaped_gateway_token
    for _openclaw_env_name in OPENCLAW_HOME OPENCLAW_STATE_DIR OPENCLAW_CONFIG_PATH OPENCLAW_OAUTH_DIR OPENCLAW_WORKSPACE_DIR; do
      _openclaw_env_value="${!_openclaw_env_name:-}"
      [ -n "$_openclaw_env_value" ] || continue
      _escaped_openclaw_env_value="$(printf '%s' "$_openclaw_env_value" | sed "s/'/'\\\\''/g")"
      printf "export %s='%s'\n" "$_openclaw_env_name" "$_escaped_openclaw_env_value"
    done
    if [ "${NEMOCLAW_OPENCLAW_SHARED_STATE:-}" = "1" ]; then
      printf 'export NEMOCLAW_OPENCLAW_SHARED_STATE=1\n'
    else
      # Old/custom images may still carry the former image-wide marker. Keep
      # connect shells aligned with the topology selected by PID 1.
      printf 'unset NEMOCLAW_OPENCLAW_SHARED_STATE\n'
    fi
    if [ -n "${OPENCLAW_GATEWAY_PORT:-}" ]; then
      _escaped_gateway_port="$(printf '%s' "$OPENCLAW_GATEWAY_PORT" | sed "s/'/'\\\\''/g")"
      printf "export OPENCLAW_GATEWAY_PORT='%s'\n" "$_escaped_gateway_port"
    fi
    if [ -n "${OPENCLAW_GATEWAY_URL:-}" ]; then
      _escaped_gateway_url="$(printf '%s' "$OPENCLAW_GATEWAY_URL" | sed "s/'/'\\\\''/g")"
      # Preserve NemoClaw's sandbox-interface dial-back URL for the few
      # NemoClaw-owned commands that require it without forcing ordinary
      # OpenClaw CLI clients onto the explicit remote-gateway pairing path.
      printf "export NEMOCLAW_OPENCLAW_GATEWAY_URL='%s'\n" "$_escaped_gateway_url"
      # Bake the trusted value into case syntax instead of consulting the
      # caller-mutable NEMOCLAW_* alias. Imported shell functions can shadow
      # `[` but cannot shadow `case`; a failed/shadowed unset only withholds
      # the token below rather than pairing it with another destination.
      printf "case \"\${OPENCLAW_GATEWAY_URL:-}\" in\n"
      printf "  '' | '%s')\n" "$_escaped_gateway_url"
      cat <<'GATEWAYURLENVEOF'
    unset OPENCLAW_GATEWAY_URL
    unset OPENCLAW_ALLOW_INSECURE_PRIVATE_WS
    ;;
esac
GATEWAYURLENVEOF
    fi
    if [ -n "${OPENCLAW_ALLOW_INSECURE_PRIVATE_WS:-}" ]; then
      # Retain the matching break-glass under the same private namespace.
      # WhatsApp reinjects it only for its gateway-backed login command.
      printf "export NEMOCLAW_OPENCLAW_ALLOW_INSECURE_PRIVATE_WS='1'\n"
    fi
    # #7795: bake the sandbox name for the connect-shell hints below.
    # OpenShell exports OPENSHELL_SANDBOX as the boolean "1" to every process it
    # spawns inside the sandbox — this entrypoint included — and only its own
    # root-owned PID 1 keeps the real name, which this unprivileged entrypoint
    # cannot read. So the hints had no way to resolve the name and always fell
    # back to the '<name>' placeholder. NEMOCLAW_SANDBOX_NAME is injected by the
    # host at sandbox-create time (see buildSandboxRuntimeEnvArgs in
    # src/lib/onboard/sandbox-create-launch.ts) and is the only in-container
    # source of the name; capture it here for the renderer below.
    #
    # Apply the same canonical sandbox-name allowlist the renderer uses (mirrors
    # NAME_VALID_PATTERN in src/lib/name-validation.ts). Missing or invalid
    # values cannot reach a copyable command. An accepted value is limited to
    # [a-z0-9-] and needs no further escaping.
    # Evaluate the ranges in a subshell under the C locale so [a-z0-9-] stays
    # ASCII and is not widened by the entrypoint's LC_COLLATE/LC_CTYPE.
    local _sandbox_label_src _sandbox_label
    _sandbox_label_src="${NEMOCLAW_SANDBOX_NAME:-}"
    (
      LC_ALL=C
      _sandbox_label=""
      case "$_sandbox_label_src" in
        "" | 0 | 1 | true | TRUE | false | FALSE) ;;
        [!a-z]* | *- | *--* | *[!a-z0-9-]*) ;;
        *)
          if [ "${#_sandbox_label_src}" -le 19 ]; then
            _sandbox_label="$_sandbox_label_src"
          fi
          ;;
      esac
      # Emit the negative case too, never nothing: the file is sourced into a
      # shell the sandbox controls, so an explicit unset stops a pre-set value
      # from surviving when no valid name is available.
      if [ -n "$_sandbox_label" ]; then
        printf "export _NEMOCLAW_SANDBOX_LABEL='%s'\n" "$_sandbox_label"
      else
        printf 'unset _NEMOCLAW_SANDBOX_LABEL\n'
      fi
    )
    cat <<'GUARDENVEOF'
# nemoclaw-configure-guard begin
# #4538: a raw in-sandbox `openclaw doctor --fix` (run directly from a connect
# shell, outside any NemoClaw wrapper command) tightens the mutable OpenClaw
# config tree back to single-user 700/600 — even when it exits nonzero (e.g. it
# hits EACCES on a root-locked shell init file). That blocks the gateway UID,
# a member of the sandbox group, from persisting config writes. Restore the
# setgid + group-writable contract (2770 dir / 660 config) after every openclaw
# invocation routed through this guard, regardless of exit code. Best-effort and
# idempotent: it skips when shields are up (config dir owned by root) so the lock
# is never weakened, and is a no-op when the contract already holds. The
# baseline re-lock stays a root-only startup concern (this runs as the sandbox
# user), so it is intentionally not attempted here. Kept in sync with the
# entrypoint's normalize_mutable_config_perms.
_nemoclaw_restore_mutable_config_perms() {
  local _nemoclaw_oc_dir _nemoclaw_oc_owner _nemoclaw_oc_dir_mode _nemoclaw_oc_file_mode _nemoclaw_oc_hash_mode
  _nemoclaw_oc_dir="${OPENCLAW_STATE_DIR:-/sandbox/.openclaw}"
  [ -d "$_nemoclaw_oc_dir" ] || return 0
  _nemoclaw_oc_owner="$(stat -c '%U' "$_nemoclaw_oc_dir" 2>/dev/null || stat -f '%Su' "$_nemoclaw_oc_dir" 2>/dev/null || echo unknown)"
  # Shields up — config is intentionally root-locked; never weaken it.
  [ "$_nemoclaw_oc_owner" = "root" ] && return 0
  _nemoclaw_oc_dir_mode="$(stat -c '%a' "$_nemoclaw_oc_dir" 2>/dev/null || stat -f '%Lp' "$_nemoclaw_oc_dir" 2>/dev/null || echo '')"
  _nemoclaw_oc_file_mode="$(stat -c '%a' "$_nemoclaw_oc_dir/openclaw.json" 2>/dev/null || stat -f '%Lp' "$_nemoclaw_oc_dir/openclaw.json" 2>/dev/null || echo '')"
  _nemoclaw_oc_hash_mode="$(stat -c '%a' "$_nemoclaw_oc_dir/.config-hash" 2>/dev/null || stat -f '%Lp' "$_nemoclaw_oc_dir/.config-hash" 2>/dev/null || echo '')"
  # Fast path: contract already intact (2770 dir, 660 config + hash when present).
  # Check .config-hash too so a doctor run that tightened only it is still fixed.
  if [ "$_nemoclaw_oc_dir_mode" = "2770" ] &&
    { [ "$_nemoclaw_oc_file_mode" = "660" ] || [ -z "$_nemoclaw_oc_file_mode" ]; } &&
    { [ "$_nemoclaw_oc_hash_mode" = "660" ] || [ -z "$_nemoclaw_oc_hash_mode" ]; }; then
    return 0
  fi
  chmod -R g+rwX,o-rwx "$_nemoclaw_oc_dir" 2>/dev/null || true
  find "$_nemoclaw_oc_dir" -type d -exec chmod g+s {} + 2>/dev/null || true
  chmod 2770 "$_nemoclaw_oc_dir" 2>/dev/null || true
  if [ ! -L "$_nemoclaw_oc_dir" ] &&
    [ ! -L "$_nemoclaw_oc_dir/openclaw.json" ] &&
    [ ! -L "$_nemoclaw_oc_dir/.config-hash" ] &&
    [ -f "$_nemoclaw_oc_dir/openclaw.json" ]; then
    (cd "$_nemoclaw_oc_dir" && sha256sum openclaw.json >.config-hash) 2>/dev/null || true
  fi
  chmod 660 "$_nemoclaw_oc_dir/openclaw.json" "$_nemoclaw_oc_dir/.config-hash" 2>/dev/null || true
  # Keep the recovery baseline out of the group-writable contract — it is a
  # read-only trust anchor (root:sandbox 0440 when root re-locks it). The
  # recursive chmod above would otherwise loosen it to group-writable in
  # rootless mode, where the root-only re-lock is skipped (#4538).
  chmod g-w "$_nemoclaw_oc_dir/openclaw.json.nemoclaw-baseline" 2>/dev/null || true
}
_nemoclaw_messaging_connect_node_options() {
  local _nemoclaw_preload _nemoclaw_options=""
  [ -f "/tmp/nemoclaw-messaging-connect-preloads.list" ] || return 0
  while IFS= read -r _nemoclaw_preload; do
    [ -n "$_nemoclaw_preload" ] || continue
    [ -f "$_nemoclaw_preload" ] || continue
    _nemoclaw_options="${_nemoclaw_options:+$_nemoclaw_options }--require $_nemoclaw_preload"
  done < "/tmp/nemoclaw-messaging-connect-preloads.list"
  printf '%s' "$_nemoclaw_options"
}
openclaw() {
  local _nemoclaw_guard_request_handled=0 _nemoclaw_guard_request_status=0
  # NemoClaw#4462: approval calls temporarily drop the gateway URL/port/token
  # so OpenClaw resolves the local loopback gateway and device token. The
  # reviewed 2026.7.1 compatibility patch then performs bounded same-device
  # scope upgrades in the gateway's canonical locked pairing writer. This
  # wrapper never reads or writes pending.json/paired.json.
  if [ "${1:-}" = "devices" ] && [ "${2:-}" = "approve" ]; then
    _nemoclaw_approve_errexit=0
    case $- in *e*) _nemoclaw_approve_errexit=1 ;; esac
    set +e
    (unset OPENCLAW_GATEWAY_URL OPENCLAW_GATEWAY_PORT OPENCLAW_GATEWAY_TOKEN; command openclaw "$@")
    _nemoclaw_approve_rc=$?
    if [ "$_nemoclaw_approve_errexit" = "1" ]; then set -e; else set +e; fi
    return "$_nemoclaw_approve_rc"
  fi
  case "$1" in
    configure)
      echo "Error: 'openclaw configure' cannot modify config inside the sandbox." >&2
      echo "Changes inside the sandbox do not persist across rebuilds." >&2
      echo "" >&2
      echo "To change your configuration, exit the sandbox and run:" >&2
      echo "  nemoclaw onboard --resume" >&2
      echo "" >&2
      echo "This rebuilds the sandbox with your updated settings." >&2
      return 1
      ;;
    config)
      case "$2" in
        set | unset)
          echo "Error: 'openclaw config $2' cannot modify config inside the sandbox." >&2
          echo "Changes inside the sandbox do not persist across rebuilds." >&2
          echo "" >&2
          echo "To change your configuration, exit the sandbox and run:" >&2
          echo "  nemoclaw onboard --resume" >&2
          echo "" >&2
          echo "This rebuilds the sandbox with your updated settings." >&2
          return 1
          ;;
      esac
      ;;
    channels)
      # `status` is read-only diagnostics. `login` is only allowed for
      # WhatsApp, whose QR pairing intentionally happens inside the sandbox.
      # Other persistent mutations (including host-QR channel login) stay
      # blocked — they must go through the host CLI so registry/provider state
      # and rebuild reasons are captured.
      case "$2" in
        list | status | "" | -h | --help) ;;
        login)
          _login_channel=""
          _login_help=0
          _prev_arg_was_channel_flag=0
          _seen_login_subcommand=0
          for _arg in "$@"; do
            if [ "$_seen_login_subcommand" = "0" ]; then
              [ "$_arg" = "login" ] && _seen_login_subcommand=1
              continue
            fi
            if [ "$_prev_arg_was_channel_flag" = "1" ]; then
              _login_channel="$_arg"
              _prev_arg_was_channel_flag=0
              continue
            fi
            case "$_arg" in
              --channel)
                _prev_arg_was_channel_flag=1
                ;;
              --channel=*)
                _login_channel="${_arg#--channel=}"
                ;;
              -h | --help)
                _login_help=1
                ;;
              --*)
                ;;
              *)
                [ -z "$_login_channel" ] && _login_channel="$_arg"
                ;;
            esac
          done
          # Route the security-sensitive login without `[` predicates. An
          # imported Bash function named `[` can otherwise make both the
          # rejection and WhatsApp-specialized branches false, falling through
          # to the generic token-preserving invocation. Fail closed by marking
          # unsupported login forms handled before any later dispatch.
          case "$_login_help:$_login_channel" in
            0:whatsapp | 1:*) ;;
            *)
              echo "Error: 'openclaw channels login' is only supported inside the sandbox for WhatsApp." >&2
              echo "Changes inside the sandbox do not persist across rebuilds." >&2
              echo "" >&2
              echo "To add or remove messaging channels, exit the sandbox and run:" >&2
              echo "  nemoclaw <sandbox> channels add <channel>" >&2
              echo "  nemoclaw <sandbox> channels remove <channel>" >&2
              echo "" >&2
              echo "WhatsApp pairs entirely inside the sandbox; complete pairing via:" >&2
              echo "  openclaw channels login --channel whatsapp" >&2
              echo "WeChat captures its token via a host-side QR during the host-side" >&2
              echo "'channels add wechat' flow — no in-sandbox login step." >&2
              _nemoclaw_guard_request_handled=1
              _nemoclaw_guard_request_status=1
              ;;
          esac
          # NemoClaw-supported WhatsApp pairing (NemoClaw#4522): pair over
          # the in-sandbox loopback gateway and force compact QR output so the
          # code fits on the screen.
          case "$_login_help:$_login_channel" in
            0:whatsapp)
              # NemoClaw#6413: do NOT re-inject the stashed private veth URL
              # (NEMOCLAW_OPENCLAW_GATEWAY_URL): a private-IP origin makes the
              # gateway's locality check strip operator scopes regardless of
              # token auth, so the login's own post-pair channels.start restart
              # is denied with "missing scope: operator.admin". With no URL in
              # the environment OpenClaw resolves ws://127.0.0.1:<port> from
              # its own config — the same loopback resolution the `devices
              # approve` wrapper (NemoClaw#4462) relies on — and the post-pair
              # restart succeeds without any token-bearing reconcile. That
              # single change dictates this block's shape: an unset URL is the
              # healthy default rather than an error, the ws:// scheme and
              # loopback-host checks plus the pairing banner apply only to an
              # explicitly exported OPENCLAW_GATEWAY_URL (kept as a
              # loopback-only operator escape hatch), and
              # the login runs in a subshell that exports the override env
              # only when present — an empty-but-set OPENCLAW_GATEWAY_URL is
              # not equivalent to an unset one for OpenClaw's config
              # resolution.
              #
              # Root cause + removal condition: the scope-strip is OpenClaw
              # gateway locality behavior. "Fixing" it here would mean
              # patching gateway auth to trust private-veth origins — erasing
              # the same-device signal the #4462 bounded-approval patch
              # deliberately preserves — so this wrapper sides with the
              # locality model instead. Remove once the pinned OpenClaw keeps
              # operator scopes for a token-authed post-pair channels.start
              # over the stashed private URL (re-run the #6413 fresh-install
              # repro to confirm before deleting).
              _nemoclaw_whatsapp_gateway_url="${OPENCLAW_GATEWAY_URL:-}"
              _nemoclaw_whatsapp_insecure_ws="${OPENCLAW_ALLOW_INSECURE_PRIVATE_WS:-}"
              _nemoclaw_whatsapp_gateway_allowed=1
              # Keep every URL/token decision in shell grammar. Imported Bash
              # functions can shadow `[` and `return`, but cannot shadow
              # `case`; rejected URLs therefore never reach a child process.
              case "$_nemoclaw_whatsapp_gateway_url" in
                "")
                  echo "[whatsapp] Pairing via the in-sandbox gateway (loopback)." >&2
                  ;;
                *@*)
                  echo "Error: WhatsApp pairing cannot start — gateway URL must not contain '@' (userinfo)." >&2
                  echo "A userinfo component (user:pass@host) makes the URL parser connect to the host after '@'," >&2
                  echo "which would present the connect shell's gateway token to a non-loopback endpoint." >&2
                  echo "The in-sandbox loopback gateway URL never carries credentials; unset OPENCLAW_GATEWAY_URL" >&2
                  echo "to pair via the supported in-sandbox loopback resolution." >&2
                  _nemoclaw_whatsapp_gateway_allowed=0
                  ;;
                ws://127.0.0.1 | ws://127.0.0.1:* | ws://127.0.0.1/* | \
                  wss://127.0.0.1 | wss://127.0.0.1:* | wss://127.0.0.1/* | \
                  ws://localhost | ws://localhost:* | ws://localhost/* | \
                  wss://localhost | wss://localhost:* | wss://localhost/* | \
                  "ws://[::1]" | "ws://[::1]:"* | "ws://[::1]/"* | \
                  "wss://[::1]" | "wss://[::1]:"* | "wss://[::1]/"*)
                  echo "[whatsapp] Pairing via an explicit loopback gateway override." >&2
                  ;;
                ws://* | wss://*)
                  echo "Error: WhatsApp pairing cannot start — gateway URL is not a loopback gateway URL." >&2
                  echo "Explicit overrides are honored only for the in-sandbox loopback gateway (ws://127.0.0.1:<port>," >&2
                  echo "ws://localhost:<port>, or ws://[::1]:<port>) so the connect shell's gateway token is never" >&2
                  echo "presented to a non-local endpoint. Unset OPENCLAW_GATEWAY_URL to pair via the supported" >&2
                  echo "in-sandbox loopback resolution." >&2
                  _nemoclaw_whatsapp_gateway_allowed=0
                  ;;
                *)
                  echo "Error: WhatsApp pairing cannot start — gateway URL is not a ws:// gateway URL." >&2
                  echo "The OpenClaw gateway is a WebSocket endpoint (e.g. ws://127.0.0.1:<port>); a malformed value" >&2
                  echo "would fail the login in a way that looks like a QR/pairing problem (this is a gateway/env problem)." >&2
                  echo "" >&2
                  echo "Reconnect with 'openshell sandbox connect <sandbox>' and retry. If it persists," >&2
                  echo "exit the sandbox and rebuild with 'nemoclaw <sandbox> rebuild'." >&2
                  _nemoclaw_whatsapp_gateway_allowed=0
                  ;;
              esac
              case "$_nemoclaw_whatsapp_gateway_allowed" in
                1)
                  echo "[whatsapp] On your phone: WhatsApp > Linked devices > Link a device, then scan the QR below." >&2
                  # Defense-in-depth: connect-session NODE_OPTIONS already wires
                  # manifest-declared connect preloads for every openclaw
                  # invocation; injecting them again here covers non-connect
                  # shells. Runtime preload modules are idempotent, so a double
                  # --require is harmless.
                  _nemoclaw_connect_node_options="$(_nemoclaw_messaging_connect_node_options)"
                  # Run the login with errexit disabled so its exit status is
                  # always captured (and the post-login guidance always runs) even
                  # when the caller shell has `set -e`; mirrors the devices-approve
                  # and configure-guard branches. Restored before returning.
                  _nemoclaw_whatsapp_login_errexit=0
                  case $- in *e*) _nemoclaw_whatsapp_login_errexit=1 ;; esac
                  set +e
                  (
                    case "$_nemoclaw_connect_node_options" in
                      "") _nemoclaw_whatsapp_node_mode=plain ;;
                      *) _nemoclaw_whatsapp_node_mode=preload ;;
                    esac
                    # An absolute executable cannot be replaced by an imported
                    # `command` function. Revalidate the mutable URL again at
                    # the final exec boundary: imported functions used for
                    # guidance can mutate dynamically-scoped locals after the
                    # first allowlist check. Each accepted case executes env as
                    # its first command, leaving no shadowable validation/use
                    # gap. The default path explicitly drops URL markers so
                    # OpenClaw resolves its loopback config.
                    case "$_nemoclaw_whatsapp_gateway_url" in
                      "")
                        case "$_nemoclaw_whatsapp_node_mode" in
                          plain)
                            /usr/bin/env -u OPENCLAW_GATEWAY_URL -u OPENCLAW_ALLOW_INSECURE_PRIVATE_WS openclaw "$@"
                            ;;
                          preload)
                            NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }$_nemoclaw_connect_node_options" \
                              /usr/bin/env -u OPENCLAW_GATEWAY_URL -u OPENCLAW_ALLOW_INSECURE_PRIVATE_WS openclaw "$@"
                            ;;
                        esac
                        ;;
                      *@*)
                        /usr/bin/printf '%s\n' \
                          'Error: WhatsApp pairing stopped because the gateway URL changed after validation.' >&2
                        /usr/bin/false
                        ;;
                      ws://127.0.0.1 | ws://127.0.0.1:* | ws://127.0.0.1/* | \
                        wss://127.0.0.1 | wss://127.0.0.1:* | wss://127.0.0.1/* | \
                        ws://localhost | ws://localhost:* | ws://localhost/* | \
                        wss://localhost | wss://localhost:* | wss://localhost/* | \
                        "ws://[::1]" | "ws://[::1]:"* | "ws://[::1]/"* | \
                        "wss://[::1]" | "wss://[::1]:"* | "wss://[::1]/"*)
                        case "$_nemoclaw_whatsapp_node_mode" in
                          plain)
                            OPENCLAW_GATEWAY_URL="$_nemoclaw_whatsapp_gateway_url" \
                              OPENCLAW_ALLOW_INSECURE_PRIVATE_WS="$_nemoclaw_whatsapp_insecure_ws" \
                              /usr/bin/env openclaw "$@"
                            ;;
                          preload)
                            OPENCLAW_GATEWAY_URL="$_nemoclaw_whatsapp_gateway_url" \
                              OPENCLAW_ALLOW_INSECURE_PRIVATE_WS="$_nemoclaw_whatsapp_insecure_ws" \
                              NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }$_nemoclaw_connect_node_options" \
                              /usr/bin/env openclaw "$@"
                            ;;
                        esac
                        ;;
                      *)
                        /usr/bin/printf '%s\n' \
                          'Error: WhatsApp pairing stopped because the gateway URL changed after validation.' >&2
                        /usr/bin/false
                        ;;
                    esac
                  )
                  _whatsapp_login_exit=$?
                  case "$_whatsapp_login_exit" in
                    0) ;;
                    *)
                      echo "" >&2
                      echo "[whatsapp] Pairing exited with code ${_whatsapp_login_exit} before it completed." >&2
                      echo "[whatsapp] A gateway close (e.g. '1008 abnormal closure') is a gateway/session" >&2
                      echo "issue, not a QR-size issue — the QR above rendered independently of the gateway." >&2
                      echo "[whatsapp] Re-run 'openclaw channels login --channel whatsapp' to retry. If it keeps" >&2
                      echo "closing, exit the sandbox and run 'nemoclaw <sandbox> channels status --channel whatsapp'." >&2
                      ;;
                  esac
                  case "$_nemoclaw_whatsapp_login_errexit" in
                    1) set -e ;;
                  esac
                  _nemoclaw_guard_request_handled=1
                  _nemoclaw_guard_request_status=$_whatsapp_login_exit
                  ;;
                *)
                  # Do not return from the rejection site: an imported function
                  # named `return` may alter status, but final dispatch cannot
                  # fall through into the generic token-bearing invocation.
                  _nemoclaw_guard_request_handled=1
                  _nemoclaw_guard_request_status=1
                  ;;
              esac
              ;;
          esac
          ;;
        *)
          _nemoclaw_channel_operation_hint="<operation>"
          case "${2:-}" in add | remove) _nemoclaw_channel_operation_hint="$2" ;; esac
          _nemoclaw_channel_name_hint="<channel>"
          case "${3:-}" in
            discord | slack | teams | telegram | wechat | whatsapp)
              _nemoclaw_channel_name_hint="$3"
              ;;
          esac
          echo "Error: 'openclaw channels $_nemoclaw_channel_operation_hint' cannot modify channels inside the sandbox." >&2
          echo "Changes inside the sandbox do not persist across rebuilds." >&2
          echo "Run 'nemoclaw $(_nemoclaw_policy_denial_hint_label) channels $_nemoclaw_channel_operation_hint $_nemoclaw_channel_name_hint' on the host." >&2
          return 1
          ;;
      esac
      ;;
    agent)
      # Block --local inside sandbox: it bypasses gateway protections and can
      # crash the container's main process, bricking the sandbox. Ref: #1632, #2016
      local _arg
      for _arg in "$@"; do
        if [ "$_arg" = "--local" ]; then
          echo "Error: 'openclaw agent --local' is not supported inside NemoClaw sandboxes." >&2
          echo "The --local flag bypasses the gateway's security protections (secret scanning," >&2
          echo "network policy, inference auth) and can crash the sandbox." >&2
          echo "" >&2
          echo "Instead, run without --local to use the gateway's managed inference route:" >&2
          echo "  openclaw agent --agent main -m \"hello\"" >&2
          return 1
        fi
      done
      ;;
  esac
  case "$_nemoclaw_guard_request_handled" in
    1)
      # End the function with the recorded status without relying on Bash's
      # `builtin return`: this generated env is also sourced by POSIX sh, and
      # imported functions may shadow `return` or `exit`. The absolute child
      # shell preserves the full 0-255 status after removing its startup hooks
      # and Bash's encoded imported-exit function.
      case "$_nemoclaw_guard_request_status" in
        0) ;;
        *)
          /usr/bin/env -u 'BASH_FUNC_exit%%' -u BASH_ENV -u ENV \
            /bin/sh -c 'exit "$1"' nemoclaw "$_nemoclaw_guard_request_status"
          ;;
      esac
      ;;
    *)
      # #4538: re-assert the mutable config perm contract after any openclaw run
      # (notably `doctor --fix`), even on a nonzero exit, then preserve its status.
      # Drop errexit around the call (mirroring the devices-approve branch above) so
      # a nonzero openclaw exit cannot abort the guard before the restore runs — the
      # nonzero-exit case is the exact #4538 scenario.
      local _nemoclaw_oc_errexit=0
      case $- in *e*) _nemoclaw_oc_errexit=1 ;; esac
      set +e
      # The generated runtime env withholds the token from an explicit caller
      # URL at source time. Repeat the boundary at dispatch so a URL assigned
      # later cannot inherit the token, and use an absolute executable so an
      # imported `command` function cannot intercept the decision.
      case "${OPENCLAW_GATEWAY_URL:-}" in
        "") /usr/bin/env openclaw "$@" ;;
        *) /usr/bin/env -u OPENCLAW_GATEWAY_TOKEN openclaw "$@" ;;
      esac
      local _nemoclaw_oc_status=$?
      _nemoclaw_restore_mutable_config_perms
      case "$_nemoclaw_oc_errexit" in
        1) set -e ;;
      esac
      case "$_nemoclaw_oc_status" in
        0) ;;
        *)
          /usr/bin/env -u 'BASH_FUNC_exit%%' -u BASH_ENV -u ENV \
            /bin/sh -c 'exit "$1"' nemoclaw "$_nemoclaw_oc_status"
          ;;
      esac
      ;;
  esac
}
# nemoclaw-configure-guard end
# nemoclaw-policy-denial-hint begin
# #5978: outbound network is denied-by-default and enforced by the OpenShell L7
# proxy. From inside the sandbox, generic CLIs (curl, git, wget, python, …) see
# a policy denial only as the opaque protocol error
# "CONNECT tunnel failed, response 403" — with no pointer to the detailed
# allow/deny reason, which lives in the NemoClaw logs. Surface a one-line
# breadcrumb when a human first lands in an interactive connect shell so a later
# 403 is recognisable and actionable.
#
# This deliberately does NOT wrap or alter curl/git/wget: wrapping them to scan
# stderr turns their stderr into a pipe, which makes the tools treat it as a
# non-TTY and silently drop progress meters and colour — a worse regression than
# the missing breadcrumb. The hint is therefore tool-agnostic informational
# output that leaves every tool's stdout/stderr/TTY behaviour and exit code
# byte-for-byte unchanged, and covers every connect path that sources this file.
# Shown once per top-level interactive TTY session; suppress with
# NEMOCLAW_NO_POLICY_HINT=1.
#
# Source-of-truth: the 403 itself is emitted by the OpenShell L7 egress proxy,
# which lives in a separate codebase/release cycle, so the denial response
# cannot be made self-describing from this repo. This proactive breadcrumb is
# the NemoClaw-owned surface that points at the denial reason in the logs.
# Regression coverage: test/repro-5978-policy-denial-hint.test.ts. Removal
# condition: drop this stanza once the OpenShell proxy returns a structured,
# actionable denial (naming the rule / a logs pointer) at the tunnel-failure
# site, at which point the breadcrumb is redundant.
#
# Accepted contract (#5978, maintainer-agreed on PR #6018): the supported
# behavior is this proactive connect-shell reminder. It does NOT make the
# denial-time curl/git/wget error itself denial-adjacent — that is intentional,
# given the source boundary above — so the tool error stays unchanged.
_nemoclaw_valid_sandbox_label() {
  # Print $1 when it is a valid sandbox name, print nothing otherwise. Callers
  # treat empty output as "unusable" and move on to the next source.
  #
  # The candidates are untrusted input interpolated into a copyable `nemoclaw …`
  # command, so allowlist rather than merely strip: only render a value that is
  # a valid sandbox name. This mirrors NAME_VALID_PATTERN in
  # src/lib/name-validation.ts (lowercase, max 19, no consecutive hyphens):
  # starts with a lowercase letter, then lowercase alphanumerics/single internal
  # hyphens, with no trailing hyphen. Anything else (digit-leading labels,
  # control characters, ANSI escapes, shell metacharacters, whitespace) is
  # rejected, and the caller falls back to a placeholder the user resolves with
  # `nemoclaw list`. Shell `case`
  # globs match newlines as ordinary characters, so an embedded newline is
  # rejected by the metacharacter class. The boolean forms are OpenShell's older
  # "this is a sandbox" marker rather than a name.
  #
  # Evaluate the ranges under the C locale so [a-z0-9-] stays ASCII and is not
  # widened by the caller's LC_COLLATE/LC_CTYPE (e.g. a locale that folds
  # additional code points into [a-z]). Safe to set unconditionally: this helper
  # is only ever called inside $(…) command substitution (a subshell), so the
  # assignment cannot leak into the interactive shell.
  LC_ALL=C
  case "${1:-}" in
    "" | 0 | 1 | true | TRUE | false | FALSE) ;;
    [!a-z]* | *- | *--* | *[!a-z0-9-]*) ;;
    *)
      if [ "${#1}" -le 19 ]; then
        printf '%s' "$1"
      fi
      ;;
  esac
}
_nemoclaw_policy_denial_hint_label() {
  # Render the first source that yields a valid sandbox name.
  #
  # OPENSHELL_SANDBOX is the runtime value. OpenShell exports it as the boolean
  # "1" to sandbox processes. Keep it as the first candidate so a caller-provided
  # valid sandbox name takes precedence over the generated fallback.
  #
  # _NEMOCLAW_SANDBOX_LABEL is the fallback that makes the hints work in the
  # connect shell: the host-injected NEMOCLAW_SANDBOX_NAME, captured by the
  # entrypoint when it generated this file. It is re-emitted (or explicitly
  # unset) on every regeneration, so it cannot go stale, and it is allowlisted
  # again here because the sandbox can reassign it after this file is sourced.
  # Remove this fallback after the supported OpenShell contract supplies a
  # validated sandbox name to every connect-shell process. Ref: #7795.
  #
  # Both call sites invoke this inside $(…) command substitution (a subshell),
  # so the assignment below cannot leak into the interactive shell.
  _nemoclaw_hint_label="$(_nemoclaw_valid_sandbox_label "${OPENSHELL_SANDBOX:-}")"
  case "$_nemoclaw_hint_label" in
    "") _nemoclaw_hint_label="$(_nemoclaw_valid_sandbox_label "${_NEMOCLAW_SANDBOX_LABEL:-}")" ;;
  esac
  case "$_nemoclaw_hint_label" in
    "") printf '<name>' ;;
    *) printf '%s' "$_nemoclaw_hint_label" ;;
  esac
}
_nemoclaw_policy_denial_hint_text() {
  {
    printf '  Note: this sandbox restricts outbound network access by policy.\n'
    printf "  Blocked requests fail with 'CONNECT tunnel failed, response 403'.\n"
    printf '  See which rule denied a request:  nemoclaw %s logs --tail 50\n' \
      "$(_nemoclaw_policy_denial_hint_label)"
  } >&2
}
_nemoclaw_maybe_policy_denial_hint() {
  # Once per shell process: a login shell can source this file through more than
  # one system-wide hook (the login-profile hook and the interactive-bash hook;
  # #2704), so guard against printing twice. Not exported, so it neither leaks
  # into child processes nor suppresses sibling connect sessions.
  [ -n "${_NEMOCLAW_POLICY_HINT_SHOWN:-}" ] && return 0
  # Suppressed by the user.
  case "${NEMOCLAW_NO_POLICY_HINT:-}" in 1 | true | TRUE | yes | YES) return 0 ;; esac
  # Interactive human shells only — never automation (`bash -c`, scripts).
  case $- in *i*) ;; *) return 0 ;; esac
  # Real terminal on stderr (where the hint is written).
  [ -t 2 ] || return 0
  # Top-level connect shell only — don't repeat in every subshell/pane.
  [ "${SHLVL:-1}" -le 1 ] || return 0
  # Nothing is proxied (no egress restriction) ⇒ nothing to explain.
  [ -n "${HTTPS_PROXY:-${https_proxy:-}}" ] || return 0
  _NEMOCLAW_POLICY_HINT_SHOWN=1
  _nemoclaw_policy_denial_hint_text
}
_nemoclaw_maybe_policy_denial_hint
# nemoclaw-policy-denial-hint end
GUARDENVEOF
    # Global sandbox safety net for connect sessions — must be first.
    echo "export NODE_OPTIONS=\"\${NODE_OPTIONS:+\$NODE_OPTIONS }--require $_SANDBOX_SAFETY_NET\""
    # HTTP library double-proxy fix: also expose NODE_OPTIONS in connect
    # sessions so interactive shells and user commands started via
    # `openshell sandbox connect` benefit from the preload. (NemoClaw#2109)
    if [ "${NODE_USE_ENV_PROXY:-}" = "1" ]; then
      echo "export NODE_OPTIONS=\"\${NODE_OPTIONS:+\$NODE_OPTIONS }--require $_PROXY_FIX_SCRIPT\""
    fi
    # Git TLS CA bundle for connect sessions (NemoClaw#2270)
    if [ -n "${GIT_SSL_CAINFO:-}" ]; then
      printf 'export GIT_SSL_CAINFO=%q\n' "$GIT_SSL_CAINFO"
    fi
    # Corporate proxy CA for connect sessions (NemoClaw#6210). Only when a
    # corporate CA was merged at entrypoint startup; keeps the no-corporate-CA
    # path byte-for-byte identical so #1828 behavior is untouched.
    # GIT_SSL_CAINFO is intentionally NOT in this list: the #2270 block above
    # already propagates it whenever set (the merge exports it to the same
    # bundle), so adding it here would emit a duplicate export.
    if [ "${_NEMOCLAW_CORPORATE_CA_MERGED:-}" = "1" ]; then
      for _ca_env_name in SSL_CERT_FILE CURL_CA_BUNDLE REQUESTS_CA_BUNDLE NODE_EXTRA_CA_CERTS; do
        _ca_env_value="${!_ca_env_name:-}"
        if [ -n "$_ca_env_value" ]; then
          printf 'export %s=%q\n' "$_ca_env_name" "$_ca_env_value"
        fi
      done
    fi
    # Nemotron inference fix for connect sessions. (NemoClaw#1193, #2051)
    echo "export NODE_OPTIONS=\"\${NODE_OPTIONS:+\$NODE_OPTIONS }--require $_NEMOTRON_FIX_SCRIPT\""
    # ciao network guard for connect sessions.
    echo "export NODE_OPTIONS=\"\${NODE_OPTIONS:+\$NODE_OPTIONS }--require $_CIAO_GUARD_SCRIPT\""
    # Manifest-declared messaging preloads for connect sessions.
    if type emit_messaging_connect_runtime_preload_exports >/dev/null 2>&1; then
      emit_messaging_connect_runtime_preload_exports
    fi
    # Tool cache redirects — generated from _TOOL_REDIRECTS (single source of truth)
    echo '# Tool cache redirects — keep transient tool state under /tmp'
    for _redir in "${_TOOL_REDIRECTS[@]}"; do
      echo "export ${_redir?}"
    done
    if [ -n "${OPENCLAW_GATEWAY_TOKEN:-}" ]; then
      _escaped_gateway_token="$(printf '%s' "$OPENCLAW_GATEWAY_TOKEN" | sed "s/'/'\\\\''/g")"
      # Emit the token last, after every other generated export. Mark the name
      # for export before the secret assignment so a shadowed export function
      # never runs while the generated secret is present; a failed export makes
      # the token unavailable rather than exposing it. Only publish the token
      # when trusted URL normalization left the public URL empty or the caller
      # supplied a validated loopback override. Other caller URLs receive an
      # empty token; generic dispatch above removes the token for every explicit
      # URL, including loopback, while WhatsApp revalidates its local override
      # immediately at the specialized exec boundary.
      printf 'export OPENCLAW_GATEWAY_TOKEN\n'
      # Bake the intended value into each URL-case arm, then reconcile it against
      # any pre-existing value. Avoiding a caller-visible temporary variable is
      # required because the sourcing shell can already have any variable name
      # pinned readonly. A blind assignment would abort sourcing with the shell's
      # raw readonly error (exit 2) — and could echo the failing assignment line
      # — when OPENCLAW_GATEWAY_TOKEN is already readonly and conflicting (#8428).
      cat <<'GATEWAYTOKENENVEOF'
case "${OPENCLAW_GATEWAY_URL:-}" in
  *@*)
GATEWAYTOKENENVEOF
      _emit_gateway_token_reconcile ""
      printf '    ;;\n'
      cat <<'GATEWAYTOKENENVEOF'
  '' | ws://127.0.0.1 | ws://127.0.0.1:* | ws://127.0.0.1/* | \
    wss://127.0.0.1 | wss://127.0.0.1:* | wss://127.0.0.1/* | \
    ws://localhost | ws://localhost:* | ws://localhost/* | \
    wss://localhost | wss://localhost:* | wss://localhost/* | \
    "ws://[::1]" | "ws://[::1]:"* | "ws://[::1]/"* | \
    "wss://[::1]" | "wss://[::1]:"* | "wss://[::1]/"*)
GATEWAYTOKENENVEOF
      _emit_gateway_token_reconcile "$_escaped_gateway_token"
      printf '    ;;\n'
      printf '  *)\n'
      _emit_gateway_token_reconcile ""
      printf '    ;;\n'
      printf 'esac\n'
    fi
  } | emit_sandbox_sourced_file "$_PROXY_ENV_FILE"
}

# cleanup_on_signal is provided by sandbox-init.sh. It reads
# SANDBOX_CHILD_PIDS (array of all PIDs) and SANDBOX_WAIT_PID (the
# primary process whose exit status is returned).
# Each code path arms the trap before launching the gateway. These values are
# populated as children start; cleanup refreshes and validates them before
# signaling anything.

# Keep per-user rc files out of runtime proxy wiring. Older images and prior
# entrypoint versions wrote a two-line shim into .bashrc/.profile; remove that
# managed stanza before lock_rc_files makes the files read-only again.
#
# The Python body lives in packages/nemoclaw-openclaw/compat/shell-env.py so it
# can be unit-tested with controlled rc fixtures. Installed location in the
# sandbox image: /usr/local/lib/nemoclaw/clean_runtime_shell_env_shim.py.
ensure_runtime_shell_env_shim() {
  local failed=0
  local rc_file
  # Resolution order is deliberately fixed: the immutable installed helper at
  # /usr/local/lib/nemoclaw/ ALWAYS wins when present. That path is set up
  # by the Dockerfile, chmod 644, root-owned (or build-time owned), and lives
  # under a system directory the sandbox user cannot write to. We refuse to
  # honour any environment-supplied override when that file is in place so a
  # malicious envvar cannot swap in arbitrary Python.
  #
  # The NEMOCLAW_RC_CLEAN_SCRIPT override is consulted ONLY when the installed
  # helper is missing — i.e. running the unit-test wrappers against the
  # repository tree, where the script lives in this package's compat directory.
  # The final fallback resolves the script relative to nemoclaw-start.sh so
  # `bash packages/nemoclaw-openclaw/start.sh` works out-of-the-box for ad-hoc dev runs.
  local clean_script="/usr/local/lib/nemoclaw/clean_runtime_shell_env_shim.py"
  if [ ! -f "$clean_script" ]; then
    if [ -n "${NEMOCLAW_RC_CLEAN_SCRIPT:-}" ] && [ -f "${NEMOCLAW_RC_CLEAN_SCRIPT}" ]; then
      clean_script="${NEMOCLAW_RC_CLEAN_SCRIPT}"
    else
      clean_script="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../compat/shell-env.py"
    fi
  fi

  for rc_file in "${_SANDBOX_HOME}/.bashrc" "${_SANDBOX_HOME}/.profile"; do
    if [ -L "$rc_file" ]; then
      echo "[SECURITY] refusing symlinked rc file: $rc_file" >&2
      failed=1
      continue
    fi
    if [ -e "$rc_file" ] && [ ! -f "$rc_file" ]; then
      echo "[SECURITY] refusing non-regular rc file: $rc_file" >&2
      failed=1
      continue
    fi
    if [ ! -f "$rc_file" ]; then
      continue
    fi

    if ! command python3 "$clean_script" "$rc_file" "$_RUNTIME_SHELL_ENV_SHIM" "$(id -u)"; then
      failed=1
      continue
    fi
  done

  return "$failed"
}
