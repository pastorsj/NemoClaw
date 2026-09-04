// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { AgentDefinition, AgentMcpAdapter } from "../../../agent/defs";
import type { McpBridgeEntry } from "../../../state/registry";
import {
  registerDeepAgentsAdapter,
  unregisterDeepAgentsAdapter,
} from "../mcp-bridge-adapter-deepagents";
import { registerHermesAdapter, unregisterHermesAdapter } from "../mcp-bridge-adapter-hermes";
import type {
  AdapterMutationOptions,
  AdapterRemovalOutcome,
} from "../mcp-bridge-adapter-inspection";
import { registerOpenClawAdapter, unregisterOpenClawAdapter } from "../mcp-bridge-adapter-openclaw";
import type { McpProviderInspectionRuntimeSelection } from "../mcp-bridge-provider-inspection";
import type { McpAttachedCredentialRevision } from "../mcp-bridge-provider-readiness";
import { McpBridgeError } from "./error";

interface LegacyMcpRegistrationOptions {
  readonly replaceExisting?: boolean;
  readonly teardownRollback?: boolean;
  readonly credentialRevision?: McpAttachedCredentialRevision;
}

/** Preserve native mutations for registry entries created before package authority existed. */
export function registerLegacyMcpAdapter(
  sandboxName: string,
  adapter: AgentMcpAdapter,
  entry: McpBridgeEntry,
  runtimeSelection: McpProviderInspectionRuntimeSelection,
  envValues: Record<string, string>,
  options: LegacyMcpRegistrationOptions,
  agentDefinition?: AgentDefinition,
): void {
  switch (adapter) {
    case "mcporter":
      registerOpenClawAdapter(
        sandboxName,
        entry,
        runtimeSelection,
        envValues,
        options.replaceExisting === true,
        options.credentialRevision,
        agentDefinition?.configPaths.dir,
      );
      return;
    case "hermes-config":
      registerHermesAdapter(
        sandboxName,
        entry,
        runtimeSelection,
        envValues,
        options.replaceExisting === true,
        options.credentialRevision,
      );
      return;
    case "deepagents-config":
      registerDeepAgentsAdapter(
        sandboxName,
        entry,
        runtimeSelection,
        envValues,
        options.replaceExisting === true,
        options.teardownRollback === true,
        options.credentialRevision,
      );
      return;
  }
  throw new McpBridgeError(`MCP adapter '${adapter}' is not installed.`);
}

/** Preserve native removals for registry entries created before package authority existed. */
export function unregisterLegacyMcpAdapter(
  sandboxName: string,
  adapter: AgentMcpAdapter,
  entry: McpBridgeEntry,
  runtimeSelection: McpProviderInspectionRuntimeSelection,
  options: AdapterMutationOptions,
  agentDefinition?: AgentDefinition,
): AdapterRemovalOutcome {
  switch (adapter) {
    case "mcporter":
      unregisterOpenClawAdapter(
        sandboxName,
        entry,
        runtimeSelection,
        options,
        agentDefinition?.configPaths.dir,
      );
      return "removed";
    case "hermes-config":
      unregisterHermesAdapter(sandboxName, entry, runtimeSelection, options);
      return "removed";
    case "deepagents-config":
      return unregisterDeepAgentsAdapter(sandboxName, entry, runtimeSelection, options);
  }
  throw new McpBridgeError(`MCP adapter '${adapter}' is not installed.`);
}
