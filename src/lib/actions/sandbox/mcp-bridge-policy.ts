// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isDeepStrictEqual } from "node:util";

import {
  listAgents,
  loadAgent,
  type AgentDefinition,
  type AgentMcpAdapter,
} from "../../agent/defs";
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
import { getSandboxAgent, getSandboxHarnessPackage, getSandboxOrThrow } from "./mcp-bridge-state";

export { MCP_BRIDGE_POLICY_SOURCE } from "./mcp-bridge-contracts";
export {
  buildMcpBridgePolicyKey,
  buildMcpBridgePolicyName,
  buildMcpBridgePolicyYaml,
  MCP_BRIDGE_ALLOWED_METHODS,
  MCP_BRIDGE_POLICY_MAX_BODY_BYTES,
} from "./mcp-bridge-policy-render";

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
  const addresses = assertMcpBridgePolicyTarget(entry, target);
  if (addresses.length === 0) {
    throw new McpBridgeError(
      `Refusing to apply generated MCP policy '${entry.policyName}' without address pins.`,
    );
  }
  const content = buildGeneratedMcpPolicyContent(sandboxName, entry, target, options);
  if (
    !policies.applyPresetContent(sandboxName, entry.policyName, content, {
      nonFatal: true,
      runtimeSelection: options.runtimeSelection,
    }) ||
    policies.getPresetContentGatewayState(
      sandboxName,
      content,
      undefined,
      options.runtimeSelection,
    ) !== "match"
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
  const harnessPackage = getSandboxHarnessPackage(sandboxName);
  if (harnessPackage) {
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

  const matchingAgents = listAgents()
    .map((name) => loadAgent(name))
    .filter(
      (agent) =>
        agent.mcpCapability.support === "bridge" && agent.mcpCapability.adapter === adapter,
    );
  if (matchingAgents.length === 0) {
    throw new McpBridgeError(`No installed agent manifest declares MCP adapter '${adapter}'.`);
  }
  if (matchingAgents.length > 1) {
    throw new McpBridgeError(
      `Multiple installed agent manifests declare MCP adapter '${adapter}'.`,
    );
  }
  return policyBinariesFromDefinition(matchingAgents[0]!, entry, adapter);
}

export function buildGeneratedMcpPolicyContent(
  sandboxName: string,
  entry: McpBridgeEntry,
  target: McpBridgeTargetValidation,
  options: { bindCredential?: boolean; agentDefinition?: AgentDefinition } = {},
): string {
  assertMcpBridgePolicyTarget(entry, target);
  const adapter = isAgentMcpAdapter(entry.adapter) ? entry.adapter : "mcporter";
  const policyBinaries = resolveMcpPolicyBinaryPaths(
    sandboxName,
    entry,
    adapter,
    options.agentDefinition,
  );
  return options.bindCredential === false
    ? buildMcpBridgeCapabilityPolicyYaml(entry.server, entry.url, target, policyBinaries)
    : buildMcpBridgePolicyYaml(
        entry.server,
        entry.url,
        target,
        policyBinaries,
        entry.providerName ?? "",
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

export function getPolicyPresence(
  sandboxName: string,
  entry: McpBridgeEntry | undefined,
  runtimeSelection: McpProviderInspectionRuntimeSelection,
): boolean | null {
  const registered = getRegisteredGeneratedPolicy(sandboxName, entry);
  if (!registered) return entry ? null : false;
  const state = policies.getPresetContentGatewayState(
    sandboxName,
    registered.content,
    undefined,
    runtimeSelection,
  );
  return state === "match" ? true : state === "absent" ? false : null;
}
