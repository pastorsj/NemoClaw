// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const SANDBOX_RUNTIME_ENV_FILE = "/tmp/nemoclaw-proxy-env.sh";

// Runtime env credentials that ordinary caller argv must not inherit ambiently.
//
// Source-of-truth for this guard (#6291 / PRA-2):
//   - Invalid state: a package-generated runtime env file can export an internal
//     gateway credential. Leaving it exported before `exec -- "$@"` makes every
//     general command inherit it, so diagnostics can print it accidentally and
//     a native CLI can select administrative auth instead of local user auth.
//   - Source boundary: the runtime env file is a single shared trusted file;
//     splitting it per-consumer belongs to the package that emits it. This
//     wrapper therefore removes exported gateway credential names after
//     sourcing. The file remains sandbox-readable by design, so this guard is
//     not a secrecy boundary against a command that deliberately re-reads it.
//   - Credential audit: HTTP_PROXY/HTTPS_PROXY are required egress settings
//     with no userinfo. State paths, gateway ports, private URL aliases, and
//     insecure-transport markers are routing metadata. Only exported variable
//     names ending in GATEWAY_TOKEN, GATEWAY_PASSWORD, GATEWAY_SECRET, or
//     GATEWAY_CREDENTIAL are removed from ordinary caller argv.
//   - Owned exception: the gateway admin RPC path builds its own shell
//     (buildGatewayAdminRpcShell) that sources the same file and legitimately
//     needs the token; it does not use this wrapper, so no reinjection is
//     required here.
//   - Regression coverage: runtime-env.test.ts, passthrough-json.test.ts, and
//     nemoclaw-start-perms.test.ts cover exec, JSON-agent, and PID-1 one-shot
//     command boundaries respectively.
//   - Removal condition: if every package emits gateway credentials into a
//     separate owner-only env file that arbitrary commands never source, this
//     scrub becomes redundant and can be removed.
const SANDBOX_RUNTIME_ENV_UNSET_GATEWAY_CREDENTIALS =
  'while IFS= read -r _nemoclaw_runtime_env_name; do case "$_nemoclaw_runtime_env_name" in GATEWAY_TOKEN|GATEWAY_PASSWORD|GATEWAY_SECRET|GATEWAY_CREDENTIAL|*_GATEWAY_TOKEN|*_GATEWAY_PASSWORD|*_GATEWAY_SECRET|*_GATEWAY_CREDENTIAL) builtin unset "$_nemoclaw_runtime_env_name" ;; esac; done < <(builtin compgen -e); builtin unset _nemoclaw_runtime_env_name';
const SANDBOX_RUNTIME_ENV_EXEC_SCRIPT = `if [ -r "${SANDBOX_RUNTIME_ENV_FILE}" ]; then builtin source "${SANDBOX_RUNTIME_ENV_FILE}" || exit $?; fi; ${SANDBOX_RUNTIME_ENV_UNSET_GATEWAY_CREDENTIALS}; builtin exec -- "$@"`;
const OPENCLAW_AGENT_NODE_OPTIONS =
  'builtin export NODE_OPTIONS="${NODE_OPTIONS:+${NODE_OPTIONS} }--disable-warning=UNDICI-EHPA"';
const SANDBOX_RUNTIME_ENV_OPENCLAW_AGENT_EXEC_SCRIPT = `if [ -r "${SANDBOX_RUNTIME_ENV_FILE}" ]; then builtin source "${SANDBOX_RUNTIME_ENV_FILE}" || exit $?; fi; ${SANDBOX_RUNTIME_ENV_UNSET_GATEWAY_CREDENTIALS}; ${OPENCLAW_AGENT_NODE_OPTIONS}; builtin exec -- "$@"`;

function wrapExecCommand(command: readonly string[], script: string): string[] {
  return [
    "/bin/bash",
    "--noprofile",
    "--norc",
    "-p",
    "-c",
    script,
    "nemoclaw-runtime-env",
    ...command,
  ];
}

/**
 * Source NemoClaw's trusted runtime env without flattening the caller's argv.
 * Gateway credentials are removed after sourcing so ordinary caller argv does
 * not inherit them ambiently; owned helpers that need one source their package
 * file directly.
 * @internal Only NemoClaw-owned exec paths may source the root-generated file.
 */
export function wrapExecCommandWithRuntimeEnv(command: readonly string[]): string[] {
  return wrapExecCommand(command, SANDBOX_RUNTIME_ENV_EXEC_SCRIPT);
}

export function wrapOpenClawAgentCommandWithRuntimeEnv(command: readonly string[]): string[] {
  return wrapExecCommand(command, SANDBOX_RUNTIME_ENV_OPENCLAW_AGENT_EXEC_SCRIPT);
}
