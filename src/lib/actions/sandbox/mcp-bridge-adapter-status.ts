// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { McpBridgeEntry } from "../../state/registry";
import { loadDeepAgentsMcpRuntime } from "./runtime/mcp-bridge-adapter-deepagents-runtime";
import { loadHermesMcpRuntime } from "./runtime/mcp-bridge-adapter-hermes-runtime";
import { loadOpenClawMcpRuntime } from "./runtime/mcp-bridge-adapter-openclaw-runtime";
import type { McpAttachedCredentialRevision } from "./mcp-bridge-provider-readiness";

// Keep the existing public constants during the package migration. Runtime operations load the
// selected harness package only when the matching adapter runs.
export const DEEPAGENTS_MCP_CONFIG_PATH = "/sandbox/.deepagents/.nemoclaw-mcp.json";
export const DEFAULT_OPENCLAW_CONFIG_DIR = "/sandbox/.openclaw";
export const OPENCLAW_MCPORTER_ROOT = "/sandbox/.openclaw/workspace";

export function openClawDefaultConfigDir(): string {
  return loadOpenClawMcpRuntime().DEFAULT_OPENCLAW_CONFIG_DIR;
}

export function openClawDefaultMcporterRoot(): string {
  return loadOpenClawMcpRuntime().OPENCLAW_MCPORTER_ROOT;
}

export function openClawMcporterRoot(configDir?: string): string {
  return loadOpenClawMcpRuntime().openClawMcporterRoot(configDir);
}

const DEFAULT_AUTH_HEADER = "Authorization";
const DEFAULT_AUTH_SCHEME = "Bearer";

function authPlaceholder(
  entry: Pick<McpBridgeEntry, "env">,
  credentialRevision?: McpAttachedCredentialRevision,
): string | null {
  const envName = entry.env[0];
  if (!envName) return null;
  const revision =
    credentialRevision && credentialRevision !== "canonical" ? `${credentialRevision}_` : "";
  return `openshell:resolve:env:${revision}${envName}`;
}

export function authorizationValue(
  entry: Pick<McpBridgeEntry, "env">,
  credentialRevision?: McpAttachedCredentialRevision,
): string | null {
  const placeholder = authPlaceholder(entry, credentialRevision);
  return placeholder ? `${DEFAULT_AUTH_SCHEME} ${placeholder}` : null;
}

export function entryHeaders(
  entry: Pick<McpBridgeEntry, "env">,
  credentialRevision?: McpAttachedCredentialRevision,
): Record<string, string> {
  const authorization = authorizationValue(entry, credentialRevision);
  return authorization ? { [DEFAULT_AUTH_HEADER]: authorization } : {};
}

function runtimeEntry(
  entry: Pick<McpBridgeEntry, "server" | "url" | "env">,
  credentialRevision?: McpAttachedCredentialRevision,
) {
  return {
    server: entry.server,
    url: entry.url,
    headers: entryHeaders(entry, credentialRevision),
  };
}

export function mcporterHeadersMatchExpected(
  actual: unknown,
  expected: Record<string, string>,
): boolean {
  return loadOpenClawMcpRuntime().mcporterHeadersMatchExpected(actual, expected);
}

export function mcporterHeaderMatcherSource(): string {
  return loadOpenClawMcpRuntime().mcporterHeaderMatcherSource();
}

export function hermesManagedServerConfig(entry: McpBridgeEntry): Record<string, unknown> {
  return loadHermesMcpRuntime().managedServerConfig(runtimeEntry(entry));
}

export interface HermesMcpIntentPayload {
  present: Record<string, Record<string, unknown>>;
  absent: string[];
}

export function buildHermesMcpIntentPayload(
  entries: readonly McpBridgeEntry[],
  managedServerNames: readonly string[],
): HermesMcpIntentPayload {
  return loadHermesMcpRuntime().buildIntentPayload(
    entries.map((entry) => runtimeEntry(entry)),
    managedServerNames,
  );
}

export function deepAgentsManagedServerConfig(entry: McpBridgeEntry): Record<string, unknown> {
  return loadDeepAgentsMcpRuntime().managedServerConfig(runtimeEntry(entry));
}

export function buildHermesMcpStatusCommand(entry: McpBridgeEntry): string {
  return loadHermesMcpRuntime().buildStatusCommand(runtimeEntry(entry));
}

export function buildDeepAgentsMcpStatusCommand(entry: McpBridgeEntry): string {
  return loadDeepAgentsMcpRuntime().buildStatusCommand(runtimeEntry(entry));
}

export function buildOpenClawMcporterInspectCommand(
  entry: McpBridgeEntry,
  failOnMismatch: boolean,
  root?: string,
  credentialRevision?: McpAttachedCredentialRevision,
): string {
  return loadOpenClawMcpRuntime().buildInspectCommand(
    runtimeEntry(entry, credentialRevision),
    failOnMismatch,
    root,
  );
}
