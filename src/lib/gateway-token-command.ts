// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `nemoclaw <name> gateway-token` -- print the running sandbox agent's auth
 * token to stdout so automation can capture it. The installed package declares
 * whether that token is dashboard URL auth or bearer-token web auth.
 *
 * Output contract (intended to be pipe-friendly):
 *   stdout: the token, followed by a single newline.
 *   stderr: a one-line security warning, suppressed by --quiet / -q.
 *   exit 0: token printed.
 *   exit 1: token unavailable; diagnostics written to stderr.
 */

export interface GatewayTokenUnavailable {
  readonly kind: "unavailable";
  readonly displayName: string;
  readonly dashboard: {
    readonly kind: "ui" | "api";
    readonly label: string;
    readonly auth: "url_token" | "session" | "none";
  };
}

export type GatewayTokenResolution =
  | { readonly kind: "available"; readonly token: string | null }
  | GatewayTokenUnavailable;

export interface GatewayTokenCommandDeps {
  /** Legacy no-receipt token fetcher. */
  fetchToken?: (sandboxName: string) => string | null;
  /** Resolve token behavior from the exact package definition for this sandbox. */
  resolveToken?: (sandboxName: string) => GatewayTokenResolution;
  /**
   * Resolve the agent name registered for the sandbox (e.g. "openclaw",
   * "hermes"). When omitted -- or when the lookup throws -- the OpenClaw
   * code path is used unchanged so callers without registry access keep
   * working. Returning null is treated the same as "openclaw" since the
   * registry stored that as the implicit default before the agent field
   * existed.
   */
  getSandboxAgent?: (sandboxName: string) => string | null;
  /**
   * Whether the resolved agent exposes a retrievable auth token. OpenClaw
   * (gateway token) and bearer_token agents like Hermes (API key) return
   * true; agents with no token mechanism return false and get the
   * not-applicable message. Defaults to "openclaw only" when omitted so
   * callers without agent metadata keep the historical behaviour.
   */
  agentExposesToken?: (agentName: string | null) => boolean;
  /** Optional stdout sink -- defaults to console.log. */
  log?: (message: string) => void;
  /** Optional stderr sink -- defaults to console.error. */
  error?: (message: string) => void;
}

export interface GatewayTokenCommandOptions {
  /** Suppress the stderr security warning when set (`--quiet` / `-q`). */
  quiet?: boolean;
}

export class GatewayTokenCommandError extends Error {
  readonly lines: readonly string[];
  readonly exitCode: number;

  constructor(lines: string | readonly string[], exitCode = 1) {
    const normalized = Array.isArray(lines) ? lines : [lines];
    super(normalized.join("\n"));
    this.name = "GatewayTokenCommandError";
    this.lines = normalized;
    this.exitCode = exitCode;
  }
}

function gatewayTokenFail(lines: string | readonly string[], exitCode = 1): never {
  throw new GatewayTokenCommandError(lines, exitCode);
}

const SECURITY_WARNING = "Treat this token like a password -- do not log, share, or commit it.";

/**
 * Build package-metadata-driven guidance when no retrievable token is declared.
 */
function notApplicableLines(
  sandboxName: string,
  unavailable: GatewayTokenUnavailable,
): readonly string[] {
  const lines = [
    `  gateway-token is not applicable for sandbox '${sandboxName}': ${unavailable.displayName} does not declare a retrievable auth token.`,
  ];
  if (unavailable.dashboard.kind === "ui") {
    lines.push(
      `  For ${unavailable.dashboard.label} access, run: nemoclaw ${sandboxName} dashboard-url`,
    );
  }
  if (unavailable.dashboard.auth === "session") {
    lines.push("  The dashboard uses session authentication rather than a retrievable token.");
  } else if (unavailable.dashboard.auth === "none") {
    lines.push("  The dashboard does not require a token.");
  }
  return lines;
}

/**
 * Run the gateway-token command. Throws {@link GatewayTokenCommandError} on
 * failure. The caller is responsible for rendering failures and for having
 * validated that the sandbox exists in the registry.
 */
export function runGatewayTokenCommand(
  sandboxName: string,
  options: GatewayTokenCommandOptions,
  deps: GatewayTokenCommandDeps,
): void {
  const log = deps.log ?? ((m: string) => console.log(m));
  const error = deps.error ?? ((m: string) => console.error(m));

  // Receipt-backed callers resolve through package metadata. The older callback
  // pair remains only for registry rows that predate package receipts.
  let resolution: GatewayTokenResolution | null = null;
  if (deps.resolveToken) {
    try {
      resolution = deps.resolveToken(sandboxName);
    } catch {
      resolution = { kind: "available", token: null };
    }
    if (resolution.kind === "unavailable") {
      gatewayTokenFail(notApplicableLines(sandboxName, resolution));
    }
  }

  let resolvedAgent: string | null = null;
  if (deps.getSandboxAgent) {
    try {
      resolvedAgent = deps.getSandboxAgent(sandboxName);
    } catch {
      resolvedAgent = null;
    }
  }
  const exposesToken = resolution
    ? true
    : deps.agentExposesToken
      ? deps.agentExposesToken(resolvedAgent)
      : resolvedAgent === null || resolvedAgent === "openclaw";
  if (!exposesToken) {
    gatewayTokenFail(
      notApplicableLines(sandboxName, {
        kind: "unavailable",
        displayName: resolvedAgent ?? "Unknown agent",
        dashboard: { kind: "api", label: "API", auth: "none" },
      }),
    );
  }

  let token: string | null;
  try {
    token =
      resolution?.kind === "available"
        ? resolution.token
        : (deps.fetchToken?.(sandboxName) ?? null);
  } catch {
    token = null;
  }

  if (!token) {
    gatewayTokenFail([
      `  Could not retrieve the gateway auth token for sandbox '${sandboxName}'.`,
      `  Make sure the sandbox is running: nemoclaw ${sandboxName} status`,
    ]);
  }

  log(token);
  if (!options.quiet) {
    error(SECURITY_WARNING);
  }
}

/** Parse the raw `gateway-token` action arguments. */
export function parseGatewayTokenArgs(actionArgs: readonly string[]): {
  options: GatewayTokenCommandOptions;
  unknown: string[];
} {
  const options: GatewayTokenCommandOptions = { quiet: false };
  const unknown: string[] = [];
  for (const arg of actionArgs) {
    if (arg === "--quiet" || arg === "-q") {
      options.quiet = true;
    } else {
      unknown.push(arg);
    }
  }
  return { options, unknown };
}
