// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { McpBridgeEntry } from "../../state/registry";
import {
  type AdapterMutationOptions,
  type AdapterRegistrationInspection,
  inspectAdapterRegistrationCommand,
} from "./mcp-bridge-adapter-inspection";
import { loadOpenClawMcpRuntime } from "./runtime/mcp-bridge-adapter-openclaw-runtime";
import {
  buildOpenClawMcporterInspectCommand,
  entryHeaders,
  openClawDefaultConfigDir,
  openClawDefaultMcporterRoot,
  openClawMcporterRoot,
} from "./mcp-bridge-adapter-status";
import { McpBridgeError } from "./mcp-bridge-contracts";
import { redactBridgeSecretsForDisplay } from "./mcp-bridge-output";
import type { McpAttachedCredentialRevision } from "./mcp-bridge-provider-readiness";
import { getAgentConfigDir } from "./mcp-bridge-state";
import { executeSandboxCommand } from "./process-recovery";

// Preserve the existing public version export while runtime operations remain package-owned.
export const MCPORTER_VERSION = "0.7.3";
export { OPENCLAW_MCPORTER_ROOT } from "./mcp-bridge-adapter-status";

/** Resolve the Mcporter project root owned by an MCP bridge entry's agent. */
function mcporterRootForEntry(entry: McpBridgeEntry): string {
  return entry.agent
    ? openClawMcporterRoot(getAgentConfigDir(entry.agent, openClawDefaultConfigDir()))
    : openClawDefaultMcporterRoot();
}

function ensureMcporter(sandboxName: string): void {
  const availability = loadOpenClawMcpRuntime().mcporterAvailabilityProbe(sandboxName);
  const check = executeSandboxCommand(sandboxName, availability.command);
  if (check?.status === 0 && check.stdout.trim()) return;
  throw new McpBridgeError(availability.failureMessage);
}

export function buildOpenClawMcporterRegisterCommand(
  entry: McpBridgeEntry,
  replaceExisting = false,
  root?: string,
  credentialRevision?: McpAttachedCredentialRevision,
): string {
  return loadOpenClawMcpRuntime().buildRegisterCommand(
    { server: entry.server, url: entry.url, headers: entryHeaders(entry, credentialRevision) },
    replaceExisting,
    root,
  );
}

export function buildOpenClawMcporterRemoveCommand(
  entry: McpBridgeEntry,
  force = false,
  root?: string,
): string {
  return loadOpenClawMcpRuntime().buildRemoveCommand(
    { server: entry.server, url: entry.url, headers: entryHeaders(entry) },
    force,
    root,
  );
}

export function inspectOpenClawAdapterRegistration(
  sandboxName: string,
  entry: McpBridgeEntry,
): AdapterRegistrationInspection {
  const root = mcporterRootForEntry(entry);
  return inspectAdapterRegistrationCommand(
    sandboxName,
    entry,
    buildOpenClawMcporterInspectCommand(entry, false, root),
  );
}

export function registerOpenClawAdapter(
  sandboxName: string,
  entry: McpBridgeEntry,
  envValues: Record<string, string> = {},
  replaceExisting = false,
  credentialRevision?: McpAttachedCredentialRevision,
): void {
  ensureMcporter(sandboxName);
  const root = mcporterRootForEntry(entry);
  const result = executeSandboxCommand(
    sandboxName,
    buildOpenClawMcporterRegisterCommand(entry, replaceExisting, root, credentialRevision),
  );
  const output = redactBridgeSecretsForDisplay(
    [result?.stdout, result?.stderr].filter(Boolean).join("\n").trim(),
    entry,
    envValues,
  );
  if (!result || result.status !== 0) {
    throw new McpBridgeError(output || `mcporter config add failed for '${entry.server}'.`);
  }

  // A zero exit from `config add` proves only that mcporter accepted the
  // command. Re-read the persisted definition before claiming ownership so a
  // changed mcporter normalization/schema cannot commit an entry that differs
  // from the URL and opaque OpenShell placeholder NemoClaw intended.
  const verification = executeSandboxCommand(
    sandboxName,
    buildOpenClawMcporterInspectCommand(entry, true, root, credentialRevision),
  );
  const verificationOutput = redactBridgeSecretsForDisplay(
    [verification?.stdout, verification?.stderr].filter(Boolean).join("\n").trim(),
    entry,
    envValues,
  );
  if (
    !verification ||
    verification.status !== 0 ||
    verification.stdout.trim().split(/\r?\n/).at(-1) !== "registered"
  ) {
    throw new McpBridgeError(
      `mcporter config verification failed after adding '${entry.server}'${verificationOutput ? `: ${verificationOutput}` : "."}`,
    );
  }
}

export function unregisterOpenClawAdapter(
  sandboxName: string,
  entry: McpBridgeEntry,
  options: AdapterMutationOptions = {},
): void {
  const root = mcporterRootForEntry(entry);
  const result = executeSandboxCommand(
    sandboxName,
    buildOpenClawMcporterRemoveCommand(entry, options.force === true, root),
  );
  const output = redactBridgeSecretsForDisplay(
    [result?.stdout, result?.stderr].filter(Boolean).join("\n").trim(),
    entry,
    options.envValues ?? {},
  );
  if (!result || result.status !== 0) {
    if (options.bestEffort) return;
    throw new McpBridgeError(output || `mcporter config remove failed for '${entry.server}'.`);
  }
}
