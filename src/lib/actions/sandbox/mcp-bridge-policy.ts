// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isDeepStrictEqual } from "node:util";

import type { AgentDefinition, AgentMcpAdapter } from "../../agent/defs";
import * as policies from "../../policy";
import {
  assertTrustedPrivateEndpointCapability,
  replayTrustedPrivateEndpoint,
} from "../../security/trusted-private-endpoint";
import type { McpBridgeEntry } from "../../state/registry";
import {
  isAgentMcpAdapter,
  MCP_BRIDGE_POLICY_SOURCE,
  McpBridgeError,
} from "./mcp-bridge-contracts";
import {
  buildMcpBridgeCapabilityPolicyYaml,
  buildMcpBridgePolicyKey,
  buildMcpBridgePolicyName,
  buildMcpBridgePolicyYaml,
} from "./mcp-bridge-policy-render";
import type { McpProviderInspectionRuntimeSelection } from "./mcp-bridge-provider-inspection";
import type { McpBridgeTargetValidation } from "./mcp-bridge-url-validation";
import {
  getSandboxAgent,
  getSandboxOrThrow,
  requireSandboxHarnessPackage,
} from "./mcp-bridge-state";

export { MCP_BRIDGE_POLICY_SOURCE } from "./mcp-bridge-contracts";
export {
  buildMcpBridgePolicyKey,
  buildMcpBridgePolicyName,
  buildMcpBridgePolicyYaml,
  MCP_BRIDGE_ALLOWED_METHODS,
  MCP_BRIDGE_POLICY_MAX_BODY_BYTES,
} from "./mcp-bridge-policy-render";

export function materializePendingMcpDenyTools(entry: McpBridgeEntry): McpBridgeEntry {
  if (entry.pendingDenyTools === undefined) return entry;
  const {
    denyTools: _previousDenyTools,
    pendingDenyTools,
    ...entryWithoutDenyToolTransition
  } = entry;
  return {
    ...entryWithoutDenyToolTransition,
    ...(pendingDenyTools.length > 0 ? { denyTools: [...pendingDenyTools] } : {}),
  };
}

export function applyGeneratedPolicy(
  sandboxName: string,
  entry: McpBridgeEntry,
  target: McpBridgeTargetValidation,
  options: {
    bindCredential?: boolean;
    agentDefinition?: AgentDefinition;
    runtimeSelection: McpProviderInspectionRuntimeSelection;
  },
): void {
  const policyEntry = materializePendingMcpDenyTools(entry);
  const addresses = assertMcpBridgePolicyTarget(policyEntry, target);
  if (addresses.length === 0) {
    throw new McpBridgeError(
      `Refusing to apply generated MCP policy '${policyEntry.policyName}' without address pins.`,
    );
  }
  const content = buildGeneratedMcpPolicyContent(sandboxName, policyEntry, target, options);
  applyGeneratedPolicyContent(sandboxName, policyEntry, content, options.runtimeSelection);
}

function applyGeneratedPolicyContent(
  sandboxName: string,
  entry: McpBridgeEntry,
  content: string,
  runtimeSelection: McpProviderInspectionRuntimeSelection,
): void {
  if (
    !policies.applyPresetContent(sandboxName, entry.policyName, content, {
      nonFatal: true,
      runtimeSelection,
    }) ||
    policies.getPresetContentGatewayState(sandboxName, content, undefined, runtimeSelection) !==
      "match"
  ) {
    throw new McpBridgeError(`Failed to activate generated MCP policy '${entry.policyName}'.`);
  }
}

function policyBinariesFromDefinition(
  agent: AgentDefinition,
  entry: McpBridgeEntry,
  adapter: AgentMcpAdapter,
): readonly string[] {
  if (entry.agent !== agent.name) {
    throw new McpBridgeError(
      `MCP server '${entry.server}' records agent '${entry.agent}', not policy owner '${agent.name}'.`,
    );
  }
  if (
    agent.mcpCapability.support !== "bridge" ||
    agent.mcpCapability.adapter !== adapter ||
    entry.adapter !== adapter
  ) {
    throw new McpBridgeError(
      `MCP server '${entry.server}' does not match policy owner '${agent.name}' and adapter '${adapter}'.`,
    );
  }
  const policyBinaries = agent.mcpCapability.policy_binaries;
  if (!policyBinaries?.length) {
    throw new McpBridgeError(`MCP adapter '${adapter}' has no manifest-declared policy binaries.`);
  }
  return policyBinaries;
}

function resolveMcpPolicyBinaryPaths(
  sandboxName: string,
  entry: McpBridgeEntry,
  adapter: AgentMcpAdapter,
  agentDefinition?: AgentDefinition,
): readonly string[] {
  const harnessPackage = requireSandboxHarnessPackage(sandboxName);
  const agent = getSandboxAgent(getSandboxOrThrow(sandboxName));
  if (agentDefinition && !isDeepStrictEqual(agentDefinition, agent)) {
    throw new McpBridgeError(
      `Sandbox '${sandboxName}' policy owner changed after its package definition was pinned.`,
    );
  }
  if (harnessPackage.id !== agent.name) {
    throw new McpBridgeError(
      `Sandbox '${sandboxName}' package '${harnessPackage.id}' does not match policy owner '${agent.name}'.`,
    );
  }
  return policyBinariesFromDefinition(agent, entry, adapter);
}

export function buildGeneratedMcpPolicyContent(
  sandboxName: string,
  entry: McpBridgeEntry,
  target: McpBridgeTargetValidation,
  options: { bindCredential?: boolean; agentDefinition?: AgentDefinition } = {},
): string {
  const policyEntry = materializePendingMcpDenyTools(entry);
  assertMcpBridgePolicyTarget(policyEntry, target);
  if (!isAgentMcpAdapter(policyEntry.adapter)) {
    throw new McpBridgeError(
      `MCP server '${policyEntry.server}' has no valid package-owned adapter identity.`,
    );
  }
  const adapter = policyEntry.adapter;
  const policyBinaries = resolveMcpPolicyBinaryPaths(
    sandboxName,
    policyEntry,
    adapter,
    options.agentDefinition,
  );
  return options.bindCredential === false
    ? buildMcpBridgeCapabilityPolicyYaml(
        policyEntry.server,
        policyEntry.url,
        target,
        policyBinaries,
        policyEntry.denyTools,
      )
    : buildMcpBridgePolicyYaml(
        policyEntry.server,
        policyEntry.url,
        target,
        policyBinaries,
        policyEntry.providerName ?? "",
        policyEntry.denyTools,
      );
}

export function applyRecordedGeneratedPolicy(
  sandboxName: string,
  entry: McpBridgeEntry,
  runtimeSelection: McpProviderInspectionRuntimeSelection,
): void {
  const policyEntry = materializePendingMcpDenyTools(entry);
  applyGeneratedPolicyContent(
    sandboxName,
    policyEntry,
    generatedPolicyContent(sandboxName, policyEntry),
    runtimeSelection,
  );
}

export function assertMcpBridgePolicyTarget(
  entry: McpBridgeEntry,
  target: McpBridgeTargetValidation,
): readonly string[] {
  if (target.addresses.length === 0) {
    throw new McpBridgeError(
      `Refusing to apply generated MCP policy '${entry.policyName}' without exact ${entry.trustedPrivateHost ? "trusted-private" : "public"} address pins.`,
    );
  }
  if (!entry.trustedPrivateHost) {
    if (target.trustedPrivateCapability || target.trustedPrivateHost) {
      throw new McpBridgeError(
        `MCP server '${entry.server}' has no durable trusted-private intent. Refusing private policy mutation.`,
      );
    }
    return target.addresses;
  }
  let authority;
  try {
    authority = assertTrustedPrivateEndpointCapability(
      entry.trustedPrivateHost,
      target.addresses,
      target.trustedPrivateCapability,
      { requireAllPrivate: true },
    );
  } catch {
    throw new McpBridgeError(
      `MCP server '${entry.server}' has no provenance-checked capability for trusted private host '${entry.trustedPrivateHost}'.`,
    );
  }
  const recordedPins = entry.allowedIps ?? [];
  if (
    target.trustedPrivateHost !== authority.host ||
    !isDeepStrictEqual(authority.addresses, recordedPins)
  ) {
    throw new McpBridgeError(
      `MCP server '${entry.server}' no longer resolves to its recorded trusted-private address pins. Remove and re-add the server to approve changed pins.`,
      2,
    );
  }
  return recordedPins;
}

function recordedMcpTarget(entry: McpBridgeEntry): McpBridgeTargetValidation {
  if (entry.trustedPrivateHost) {
    const replay = replayTrustedPrivateEndpoint(entry.trustedPrivateHost, entry.allowedIps ?? [], {
      requireAllPrivate: true,
    });
    return {
      addresses: [...replay.addresses],
      trustedPrivateCapability: replay.trustedPrivateCapability,
      trustedPrivateHost: replay.host,
    };
  }
  return { addresses: [...(entry.allowedIps ?? [])] };
}

function generatedPolicyContent(
  sandboxName: string,
  entry: McpBridgeEntry,
  target: McpBridgeTargetValidation = recordedMcpTarget(entry),
  agentDefinition?: AgentDefinition,
): string {
  return buildGeneratedMcpPolicyContent(sandboxName, entry, target, { agentDefinition });
}

export function assertGeneratedPolicyMutationSafe(
  _sandboxName: string,
  entry: McpBridgeEntry,
): void {
  if (entry.policyName !== buildMcpBridgePolicyName(entry.server)) {
    throw new McpBridgeError("Generated MCP policy name does not match its bridge definition.");
  }
}

export function assertGeneratedPolicyRegistrationMutationSafe(
  sandboxName: string,
  entry: McpBridgeEntry,
) {
  assertGeneratedPolicyMutationSafe(sandboxName, entry);
  return {
    name: entry.policyName,
    content: generatedPolicyContent(sandboxName, entry),
    sourcePath: MCP_BRIDGE_POLICY_SOURCE,
  };
}

export function removeGeneratedPolicy(
  sandboxName: string,
  entry: McpBridgeEntry,
  options: {
    bestEffort?: boolean;
    runtimeSelection: McpProviderInspectionRuntimeSelection;
  },
): void {
  const policyKey = buildMcpBridgePolicyKey(entry.server);
  const content = `network_policies:\n  ${policyKey}: {}\n`;
  const removed = policies.removePreset(sandboxName, entry.policyName, {
    nonFatal: true,
    presetContent: content,
    runtimeSelection: options.runtimeSelection,
  });
  if (removed) return;
  if (options.bestEffort) return;
  throw new McpBridgeError(`Failed to remove generated MCP policy '${entry.policyName}'.`);
}

export function getRegisteredGeneratedPolicy(
  sandboxName: string,
  entry: McpBridgeEntry | undefined,
) {
  if (!entry?.policyName) return undefined;
  try {
    return {
      name: entry.policyName,
      content: generatedPolicyContent(sandboxName, entry),
      sourcePath: MCP_BRIDGE_POLICY_SOURCE,
    };
  } catch {
    return undefined;
  }
}

export function getPolicyGatewayState(
  sandboxName: string,
  entry: McpBridgeEntry | undefined,
  runtimeSelection: McpProviderInspectionRuntimeSelection,
): "absent" | "drift" | "match" | null {
  const registered = getRegisteredGeneratedPolicy(sandboxName, entry);
  if (!registered) return entry ? null : "absent";
  return policies.getPresetContentGatewayState(
    sandboxName,
    registered.content,
    undefined,
    runtimeSelection,
  );
}
