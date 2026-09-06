// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";
import type { AgentDefinition } from "../agent-runtime/manifest-types";
import type { HarnessPackageIdentity } from "../agent-runtime/package/types";
import type { SandboxEntry } from "../state/registry/types";

const CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/;
const SANDBOX_CONFIG_ROOT = "/sandbox/";

export interface AgentConfigTarget {
  agentName: string;
  configPath: string;
  configDir: string;
  format: string;
  configFile: string;
  sensitiveFiles?: string[];
  tunnelAllowedOriginsPath?: readonly string[];
}

export interface AgentConfigDependencies {
  getSandbox: (
    name: string,
  ) => Pick<SandboxEntry, "agent" | "harnessPackage" | "harnessPackageMigration"> | null;
  loadAgent: (name: string) => {
    configPaths: {
      dir: string;
      configFile: string;
      envFile?: string | null;
      format?: string;
    };
  };
  resolveSandboxAgent: (
    entry: Pick<SandboxEntry, "agent" | "harnessPackage" | "harnessPackageMigration">,
  ) => { readonly definition: AgentDefinition };
}

export const DEFAULT_AGENT_CONFIG: AgentConfigTarget = {
  agentName: "openclaw",
  configPath: "/sandbox/.openclaw/openclaw.json",
  configDir: "/sandbox/.openclaw",
  format: "json",
  configFile: "openclaw.json",
  sensitiveFiles: ["/sandbox/.openclaw/.config-hash"],
};

function defaultDependencies(): AgentConfigDependencies {
  const registry = require("../state/registry");
  const agentDefs = require("../agent/defs");
  const packageAuthority = require("../onboard/package/package-authority");
  return {
    getSandbox: registry.getSandbox,
    loadAgent: agentDefs.loadAgent,
    resolveSandboxAgent: packageAuthority.resolvePackageBackedSandboxAgent,
  };
}

/** Read the package receipt through the config authority's existing registry boundary. */
export function getAgentConfigPackageIdentity(sandboxName: string): HarnessPackageIdentity | null {
  const registry: typeof import("../state/registry") = require("../state/registry");
  return registry.getSandbox(sandboxName)?.harnessPackage ?? null;
}

function requireCanonicalConfigDir(value: string): string {
  if (
    !path.posix.isAbsolute(value) ||
    path.posix.normalize(value) !== value ||
    CONTROL_CHAR_RE.test(value) ||
    value.includes("\\") ||
    value === SANDBOX_CONFIG_ROOT ||
    !value.startsWith(SANDBOX_CONFIG_ROOT)
  ) {
    throw new Error(
      `Agent config directory ${JSON.stringify(value)} must be a canonical absolute path below ${SANDBOX_CONFIG_ROOT}`,
    );
  }
  return value;
}

function resolveConfigFile(configDir: string, value: string, field: string): string {
  const components = value.split("/");
  if (
    value.length === 0 ||
    path.posix.isAbsolute(value) ||
    CONTROL_CHAR_RE.test(value) ||
    value.includes("\\") ||
    components.some((component) => component === "" || component === "." || component === "..")
  ) {
    throw new Error(`Agent config field '${field}' must be a canonical relative path`);
  }
  const resolved = path.posix.resolve(configDir, value);
  if (!resolved.startsWith(`${configDir}/`)) {
    throw new Error(`Agent config field '${field}' must stay below '${configDir}'`);
  }
  return resolved;
}

export function resolveAgentConfig(
  sandboxName: string,
  dependencies: AgentConfigDependencies = defaultDependencies(),
  pinnedAgentDefinition?: AgentDefinition,
): AgentConfigTarget {
  const entry = dependencies.getSandbox(sandboxName);
  const agentName = entry?.agent ?? DEFAULT_AGENT_CONFIG.agentName;
  if (pinnedAgentDefinition && pinnedAgentDefinition.name !== agentName) {
    throw new Error(
      `Pinned agent definition '${pinnedAgentDefinition.name}' does not match sandbox '${sandboxName}' agent '${agentName}'`,
    );
  }
  const agent =
    pinnedAgentDefinition ??
    (entry?.harnessPackage
      ? dependencies.resolveSandboxAgent(entry).definition
      : dependencies.loadAgent(agentName));
  const cfg = agent.configPaths;

  const dir = requireCanonicalConfigDir(cfg.dir);
  const configPath = resolveConfigFile(dir, cfg.configFile, "config_file");
  const sensitiveFiles = [resolveConfigFile(dir, ".config-hash", "config hash")];
  if (cfg.envFile !== undefined && cfg.envFile !== null) {
    sensitiveFiles.push(resolveConfigFile(dir, cfg.envFile, "env_file"));
  }
  const tunnelAllowedOriginsPath =
    "dashboard" in agent ? agent.dashboard?.tunnelAllowedOriginsPath : undefined;

  return {
    agentName,
    configPath,
    configDir: dir,
    format: cfg.format || "json",
    configFile: cfg.configFile,
    sensitiveFiles,
    ...(tunnelAllowedOriginsPath
      ? { tunnelAllowedOriginsPath: [...tunnelAllowedOriginsPath] }
      : {}),
  };
}
