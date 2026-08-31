// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import YAML from "yaml";

import { listAgents, loadAgent, type AgentMcpAdapter } from "../../agent/defs";
import {
  type McpBridgeTargetValidation,
  parseMcpUrlWithValidatedTarget,
} from "./mcp-bridge-url-validation";
import { validateMcpServerName } from "./mcp-bridge-validation";

export const MCP_BRIDGE_POLICY_MAX_BODY_BYTES = 131_072;
export const MCP_BRIDGE_ALLOWED_METHODS = [
  "initialize",
  "notifications/initialized",
  "ping",
  "tools/list",
  "tools/call",
  "resources/list",
  "resources/read",
  "resources/templates/list",
  "resources/subscribe",
  "resources/unsubscribe",
  "prompts/list",
  "prompts/get",
  "tasks/list",
  "tasks/get",
  "tasks/update",
  "tasks/result",
  "tasks/cancel",
  "completion/complete",
  "logging/setLevel",
  "server/discover",
  "messages/listen",
  "notifications/cancelled",
  "notifications/progress",
  "notifications/roots/list_changed",
  "notifications/elicitation/complete",
] as const;

export function buildMcpBridgePolicyName(server: string): string {
  validateMcpServerName(server);
  return `mcp-bridge-${server.toLowerCase().replace(/_/g, "-")}`;
}

export function buildMcpBridgePolicyKey(server: string): string {
  return buildMcpBridgePolicyName(server).replace(/-/g, "_");
}

function endpointPort(url: URL): number {
  if (url.port) return Number.parseInt(url.port, 10);
  return url.protocol === "https:" ? 443 : 80;
}

function endpointPath(url: URL): string {
  return url.pathname || "/";
}

function resolveMcpPolicyBinaryPaths(adapter: AgentMcpAdapter): readonly string[] {
  const matchingAgents = listAgents()
    .map((name) => loadAgent(name))
    .filter(
      (agent) =>
        agent.mcpCapability.support === "bridge" && agent.mcpCapability.adapter === adapter,
    );

  if (matchingAgents.length === 0) {
    throw new Error(`No installed agent manifest declares MCP adapter '${adapter}'.`);
  }
  if (matchingAgents.length > 1) {
    throw new Error(`Multiple installed agent manifests declare MCP adapter '${adapter}'.`);
  }

  const policyBinaries = matchingAgents[0]?.mcpCapability.policy_binaries;
  if (!policyBinaries?.length) {
    throw new Error(`MCP adapter '${adapter}' has no manifest-declared policy binaries.`);
  }
  return policyBinaries;
}

function renderMcpBridgePolicyYaml(
  server: string,
  url: string,
  adapter: AgentMcpAdapter,
  target: McpBridgeTargetValidation,
  providerName?: string,
): string {
  const parsed = parseMcpUrlWithValidatedTarget(url, target);
  const key = buildMcpBridgePolicyKey(server);
  // OpenShell resolves this hostname for every new connection, validates every
  // current answer against allowed_ips, and connects to that validated list.
  const allowedIps = [...target.addresses];
  return YAML.stringify({
    preset: {
      name: buildMcpBridgePolicyName(server),
      description: `Generated MCP policy for ${server}`,
    },
    network_policies: {
      [key]: {
        name: key,
        endpoints: [
          {
            host: parsed.hostname,
            port: endpointPort(parsed),
            path: endpointPath(parsed),
            protocol: "mcp",
            enforcement: "enforce",
            allowed_ips: allowedIps,
            ...(providerName ? { credential_binding: { provider: providerName } } : {}),
            mcp: {
              max_body_bytes: MCP_BRIDGE_POLICY_MAX_BODY_BYTES,
              strict_tool_names: true,
              allow_all_known_mcp_methods: false,
            },
            rules: MCP_BRIDGE_ALLOWED_METHODS.map((method) => ({ allow: { method } })),
          },
        ],
        binaries: resolveMcpPolicyBinaryPaths(adapter).map((path) => ({ path })),
      },
    },
  });
}

export function buildMcpBridgePolicyYaml(
  server: string,
  url: string,
  adapter: AgentMcpAdapter,
  target: McpBridgeTargetValidation,
  providerName: string,
): string {
  if (providerName.trim() !== providerName || providerName.length === 0) {
    throw new Error("Generated MCP credential binding requires an exact provider name.");
  }
  return renderMcpBridgePolicyYaml(server, url, adapter, target, providerName);
}

/** Render the temporary credential-free policy used before first provider attachment. */
export function buildMcpBridgeCapabilityPolicyYaml(
  server: string,
  url: string,
  adapter: AgentMcpAdapter,
  target: McpBridgeTargetValidation,
): string {
  return renderMcpBridgePolicyYaml(server, url, adapter, target);
}
