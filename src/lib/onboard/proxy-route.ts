// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const PROXY_HOST_RE = /^[A-Za-z0-9._-]+$/u;

/** Public, credential-free route from a sandbox to the OpenShell-managed proxy. */
export interface ManagedProxyRoute {
  readonly host: string;
  readonly port: number;
}

export const DEFAULT_MANAGED_PROXY_ROUTE: ManagedProxyRoute = Object.freeze({
  host: "10.200.0.1",
  port: 3128,
});

export function isValidProxyHost(value: string): boolean {
  return PROXY_HOST_RE.test(value);
}

export function isValidProxyPort(value: string): boolean {
  if (!/^[0-9]{1,5}$/u.test(value)) return false;
  const port = Number(value);
  return port >= 1 && port <= 65_535;
}

function presentEnvironmentValue(
  environment: NodeJS.ProcessEnv,
  name: "NEMOCLAW_PROXY_HOST" | "NEMOCLAW_PROXY_PORT",
): string | null {
  const value = environment[name];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * Resolve the core-owned managed proxy route for a package startup command.
 * Missing values use the OpenShell bridge defaults. Any supplied malformed
 * value invalidates the complete pair so a package entrypoint can fail closed.
 */
export function resolveManagedProxyRoute(environment: NodeJS.ProcessEnv): ManagedProxyRoute | null {
  const host =
    presentEnvironmentValue(environment, "NEMOCLAW_PROXY_HOST") ?? DEFAULT_MANAGED_PROXY_ROUTE.host;
  const portText =
    presentEnvironmentValue(environment, "NEMOCLAW_PROXY_PORT") ??
    String(DEFAULT_MANAGED_PROXY_ROUTE.port);
  if (!isValidProxyHost(host) || !isValidProxyPort(portText)) return null;
  return Object.freeze({ host, port: Number(portText) });
}
