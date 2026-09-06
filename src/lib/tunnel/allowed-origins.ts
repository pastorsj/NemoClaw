// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { AgentConfigTarget } from "../sandbox/config";
import type { ConfigObject } from "../security/credential-filter";
import { isConfigObject } from "../security/credential-filter";

const TRYCLOUDFLARE_HOST = "trycloudflare.com";

/**
 * Reduce a full tunnel URL (which may carry a path or hash) to an exact
 * `scheme://host[:port]` origin. Returns null for empty input, an unparseable
 * URL, or an opaque origin ("null").
 */
export function tunnelUrlToOrigin(tunnelUrl: string): string | null {
  if (!tunnelUrl) return null;
  try {
    const { origin } = new URL(tunnelUrl);
    return origin && origin !== "null" ? origin : null;
  } catch {
    return null;
  }
}

/** True when the origin's host is trycloudflare.com or a subdomain of it. */
export function isTryCloudflareOrigin(origin: string): boolean {
  try {
    const { hostname } = new URL(origin);
    return hostname === TRYCLOUDFLARE_HOST || hostname.endsWith(`.${TRYCLOUDFLARE_HOST}`);
  } catch {
    return false;
  }
}

function normalizeOrigins(existing: unknown): string[] {
  if (!Array.isArray(existing)) return [];
  return existing.filter((entry): entry is string => typeof entry === "string");
}

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * Compute the allowedOrigins list for a tunnel start: drop every existing
 * trycloudflare origin (quick-tunnel URLs churn each start), preserve all other
 * origins in their original order, then append the current tunnel origin.
 * Pure — no I/O. `changed` is false when the result equals the normalized input,
 * so callers can skip the write + gateway reload.
 */
export function computeTunnelAllowedOrigins(
  existing: unknown,
  tunnelUrl: string,
): { origins: string[]; changed: boolean } {
  const normalized = normalizeOrigins(existing);
  const origin = tunnelUrlToOrigin(tunnelUrl);
  if (origin === null) {
    return { origins: normalized, changed: false };
  }

  const result: string[] = [];
  const seen = new Set<string>();
  const addUnique = (value: string): void => {
    if (!seen.has(value)) {
      seen.add(value);
      result.push(value);
    }
  };

  for (const entry of normalized) {
    if (!isTryCloudflareOrigin(entry)) addUnique(entry);
  }
  addUnique(origin);

  return { origins: result, changed: !arraysEqual(result, normalized) };
}

export interface RegisterTunnelOriginDeps {
  resolveAgentConfig: (sandboxName: string) => AgentConfigTarget;
  readConfig: (sandboxName: string, target: AgentConfigTarget) => ConfigObject;
  writeConfig: (sandboxName: string, target: AgentConfigTarget, config: ConfigObject) => void;
  recomputeHash: (sandboxName: string, target: AgentConfigTarget) => void;
  reloadGateway: (sandboxName: string) => void;
  info?: (msg: string) => void;
  warn?: (msg: string) => void;
}

type SandboxConfigModule = {
  resolveAgentConfig: RegisterTunnelOriginDeps["resolveAgentConfig"];
  readSandboxConfig: RegisterTunnelOriginDeps["readConfig"];
  writeSandboxConfig: RegisterTunnelOriginDeps["writeConfig"];
  recomputeSandboxConfigHash: RegisterTunnelOriginDeps["recomputeHash"];
};

/**
 * Default reload: the same managed gateway restart `config set --restart` uses.
 * A container restart re-reads the freshly written in-sandbox config on start.
 */
function defaultReloadGateway(sandboxName: string): void {
  const { restartSandboxGateway } = require("../actions/sandbox/process-recovery") as {
    restartSandboxGateway: (name: string) => { ok: boolean };
  };
  restartSandboxGateway(sandboxName);
}

function resolveDeps(deps: Partial<RegisterTunnelOriginDeps>): Required<RegisterTunnelOriginDeps> {
  const needsConfig =
    !deps.resolveAgentConfig || !deps.readConfig || !deps.writeConfig || !deps.recomputeHash;
  const config = needsConfig ? (require("../sandbox/config") as SandboxConfigModule) : undefined;
  return {
    resolveAgentConfig: deps.resolveAgentConfig ?? config!.resolveAgentConfig,
    readConfig: deps.readConfig ?? config!.readSandboxConfig,
    writeConfig: deps.writeConfig ?? config!.writeSandboxConfig,
    recomputeHash: deps.recomputeHash ?? config!.recomputeSandboxConfigHash,
    reloadGateway: deps.reloadGateway ?? defaultReloadGateway,
    info: deps.info ?? (() => {}),
    warn: deps.warn ?? (() => {}),
  };
}

function readAllowedOrigins(config: ConfigObject, path: readonly string[]): unknown {
  let current: unknown = config;
  for (const segment of path) {
    if (!isConfigObject(current)) return undefined;
    current = current[segment];
  }
  return current;
}

function ensureConfigObject(record: ConfigObject, key: string): ConfigObject {
  const existing = record[key];
  if (isConfigObject(existing)) return existing;
  const created: ConfigObject = {};
  record[key] = created;
  return created;
}

/**
 * Set the package-declared origins path in place, materializing intermediate
 * objects if absent. Mutating the object returned by readConfig preserves its
 * compare-and-swap digest and leaves sibling config keys untouched.
 */
function applyAllowedOrigins(
  config: ConfigObject,
  path: readonly string[],
  origins: string[],
): void {
  let parent = config;
  for (const segment of path.slice(0, -1)) {
    parent = ensureConfigObject(parent, segment);
  }
  parent[path.at(-1)!] = origins;
}

/**
 * Register the tunnel's public origin into the in-sandbox gateway
 * allowedOrigins so the Web UI over the tunnel is accepted. Best-effort and
 * synchronous: any failure is swallowed with a warning so a working tunnel
 * start is never turned into a hard error. Idempotent (no write/reload when the
 * origin list is unchanged). A package opts in by declaring the exact config
 * path that accepts browser origins.
 */
export function registerTunnelOrigin(
  sandboxName: string,
  tunnelUrl: string,
  deps: Partial<RegisterTunnelOriginDeps> = {},
): void {
  const origin = tunnelUrlToOrigin(tunnelUrl);
  if (origin === null) return;

  const info = deps.info ?? (() => {});
  const warn = deps.warn ?? (() => {});

  try {
    const resolved = resolveDeps(deps);
    const target = resolved.resolveAgentConfig(sandboxName);
    const allowedOriginsPath = target.tunnelAllowedOriginsPath;
    if (!allowedOriginsPath || allowedOriginsPath.length === 0) {
      info(`Harness '${target.agentName}' does not declare tunnel-origin registration; skipping.`);
      return;
    }

    const config = resolved.readConfig(sandboxName, target);
    const { origins, changed } = computeTunnelAllowedOrigins(
      readAllowedOrigins(config, allowedOriginsPath),
      tunnelUrl,
    );
    if (!changed) {
      info(`Tunnel origin already registered: ${origin}`);
      return;
    }

    applyAllowedOrigins(config, allowedOriginsPath, origins);
    resolved.writeConfig(sandboxName, target, config);
    resolved.recomputeHash(sandboxName, target);
    info(`Registered tunnel origin with gateway: ${origin}`);

    info("Reloading gateway to apply tunnel origin...");
    resolved.reloadGateway(sandboxName);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    warn(
      `Could not register tunnel origin (${message}); open the Web UI from the gateway host or set NEMOCLAW_CORS_ORIGIN.`,
    );
  }
}
