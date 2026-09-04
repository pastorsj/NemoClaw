// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import YAML from "yaml";

import {
  type McpBridgeTargetValidation,
  parseMcpUrlWithValidatedTarget,
} from "./mcp-bridge-url-validation";
import { validateMcpServerName } from "./mcp-bridge-validation";

export const MCP_BRIDGE_POLICY_MAX_BODY_BYTES = 131_072;
const MCP_POLICY_BINARY_PATH_RE = /^\/(?:[A-Za-z0-9._+-]+\/)*[A-Za-z0-9._+-]+\*?$/u;
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

function validatePolicyBinaryPaths(policyBinaries: readonly string[]): readonly string[] {
  if (policyBinaries.length === 0) {
    throw new Error("Generated MCP policy requires at least one manifest-declared binary path.");
  }
  const seen = new Set<string>();
  return policyBinaries.map((binaryPath, index) => {
    const segments = typeof binaryPath === "string" ? binaryPath.slice(1).split("/") : [];
    if (
      typeof binaryPath !== "string" ||
      !MCP_POLICY_BINARY_PATH_RE.test(binaryPath) ||
      binaryPath.includes("\\") ||
      segments.some((segment) => segment === "." || segment === "..")
    ) {
      throw new Error(
        `Generated MCP policy binary path ${String(index)} must be canonical and absolute.`,
      );
    }
    if (seen.has(binaryPath)) {
      throw new Error(`Generated MCP policy binary path ${String(index)} is duplicated.`);
    }
    seen.add(binaryPath);
    return binaryPath;
  });
}

function renderMcpBridgePolicyYaml(
  server: string,
  url: string,
  target: McpBridgeTargetValidation,
  policyBinaries: readonly string[],
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
        binaries: validatePolicyBinaryPaths(policyBinaries).map((path) => ({ path })),
      },
    },
  });
}

export function buildMcpBridgePolicyYaml(
  server: string,
  url: string,
  target: McpBridgeTargetValidation,
  policyBinaries: readonly string[],
  providerName: string,
): string {
  if (providerName.trim() !== providerName || providerName.length === 0) {
    throw new Error("Generated MCP credential binding requires an exact provider name.");
  }
  return renderMcpBridgePolicyYaml(server, url, target, policyBinaries, providerName);
}

/** Render the temporary credential-free policy used before first provider attachment. */
export function buildMcpBridgeCapabilityPolicyYaml(
  server: string,
  url: string,
  target: McpBridgeTargetValidation,
  policyBinaries: readonly string[],
): string {
  return renderMcpBridgePolicyYaml(server, url, target, policyBinaries);
}
