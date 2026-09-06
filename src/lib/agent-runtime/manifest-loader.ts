// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { DASHBOARD_PORT } from "../core/ports";
import { type AgentDashboardUi, readDashboardUi } from "./dashboard-ui";
import type {
  AgentConfigPaths,
  AgentDashboard,
  AgentDefinition,
  AgentHealthProbe,
  AgentLegacyPaths,
  AgentMcpCapability,
  HarnessSkillCapability,
  AgentStateDirectory,
  AgentStateFile,
  AgentVersionScheme,
  ManifestRecord,
} from "./manifest-types";
import {
  readBoolean,
  readDashboard,
  readHealthProbe,
  readInference,
  readMcpCapability,
  readObject,
  readPortArray,
  readStateFiles,
  readString,
  readStringArray,
  readStringMap,
  readUserManagedFiles,
  readVersionScheme,
} from "./manifest-readers";
import { readAgentRuntime } from "./runtime/manifest";
import { readManagedImageDeclaration } from "./managed-image";
import { readSandboxCreateDeclaration } from "./sandbox-create";
import { readSkillCapability } from "./skill-capability";
import { readStateLifecycle } from "./state/lifecycle";
import {
  readStateDirectories,
  stateDirectoryPaths,
  stateDirectoryPrefixes,
} from "./state/directories";
import { type AgentWebAuth, readWebAuth } from "./web-auth";
import { readWebSearchCapability } from "./web-search";

export interface BuildAgentDefinitionInput {
  readonly manifest: ManifestRecord;
  readonly manifestPath: string;
  readonly packageRoot: string;
}

const WINDOWS_ABSOLUTE_PATH_PATTERN = /^(?:[A-Za-z]:[\\/]|\\\\)/u;
const AGENT_SELECTOR_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const AGENT_ALIAS_LIMIT = 64;

function readAgentAliases(raw: ManifestRecord, agentName: string): readonly string[] {
  const value = raw.aliases;
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value) || value.length > AGENT_ALIAS_LIMIT) {
    throw new Error(
      `Agent manifest field 'aliases' must contain at most ${String(AGENT_ALIAS_LIMIT)} strings`,
    );
  }
  const aliases = value.map((entry, index) => {
    if (typeof entry !== "string" || !AGENT_SELECTOR_PATTERN.test(entry)) {
      throw new Error(
        `Agent manifest field 'aliases[${String(index)}]' must be a canonical lowercase selector`,
      );
    }
    if (entry === agentName) {
      throw new Error(`Agent manifest alias '${entry}' duplicates the canonical agent name`);
    }
    return entry;
  });
  if (new Set(aliases).size !== aliases.length) {
    throw new Error("Agent manifest field 'aliases' must not contain duplicates");
  }
  return Object.freeze(aliases);
}

function readOnboardingDefaults(raw: ManifestRecord): {
  readonly defaultChoice: boolean;
  readonly sandboxName: string;
} {
  const onboarding = readObject(raw, "onboarding");
  if (!onboarding) return { defaultChoice: false, sandboxName: "my-assistant" };
  const defaultChoice = readBoolean(onboarding, "default") ?? false;
  const sandboxName = readString(onboarding, "sandbox_name") ?? "my-assistant";
  if (!AGENT_SELECTOR_PATTERN.test(sandboxName)) {
    throw new Error(
      "Agent manifest field 'onboarding.sandbox_name' must be a canonical lowercase hyphen-separated name",
    );
  }
  return { defaultChoice, sandboxName };
}

function requireCanonicalAbsolutePath(value: string, label: string): string {
  if (!path.isAbsolute(value) || path.resolve(value) !== value) {
    throw new Error(`${label} must be a canonical absolute path`);
  }
  return value;
}

function requireContainedPath(packageRoot: string, target: string, label: string): string {
  const relative = path.relative(packageRoot, target);
  if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..")) {
    return target;
  }
  throw new Error(`${label} must remain inside the agent package root`);
}

function rejectSymlinksBelowRoot(packageRoot: string, target: string, label: string): void {
  const relative = path.relative(packageRoot, target);
  let current = packageRoot;
  const segments = relative === "" ? [] : relative.split(path.sep);
  for (const segment of segments) {
    current = path.join(current, segment);
    let stats: fs.Stats;
    try {
      stats = fs.lstatSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw new Error(`${label} could not be validated`, { cause: error });
    }
    if (stats.isSymbolicLink()) {
      throw new Error(`${label} must not use symbolic links`);
    }
  }
}

function requirePackageRoot(packageRootValue: string): string {
  const packageRoot = requireCanonicalAbsolutePath(packageRootValue, "Agent package root");
  let rootStats: fs.Stats;
  try {
    rootStats = fs.lstatSync(packageRoot);
  } catch (error) {
    throw new Error("Agent package root must be an existing directory", { cause: error });
  }
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw new Error("Agent package root must be a directory without symbolic links");
  }
  return packageRoot;
}

function requireManifestAuthority(packageRoot: string, manifestPathValue: string): string {
  const manifestPath = requireCanonicalAbsolutePath(manifestPathValue, "Agent manifest path");
  requireContainedPath(packageRoot, manifestPath, "Agent manifest path");
  rejectSymlinksBelowRoot(packageRoot, manifestPath, "Agent manifest path");
  let manifestStats: fs.Stats;
  try {
    manifestStats = fs.lstatSync(manifestPath);
  } catch (error) {
    throw new Error("Agent manifest path must identify one regular file", { cause: error });
  }
  if (!manifestStats.isFile()) {
    throw new Error("Agent manifest path must identify one regular file");
  }
  return manifestPath;
}

function resolveOrdinaryAsset(
  packageRoot: string,
  agentDir: string,
  fileName: string,
  label: string,
): string {
  const target = requireContainedPath(packageRoot, path.join(agentDir, fileName), label);
  rejectSymlinksBelowRoot(packageRoot, target, label);
  return target;
}

function readOptionalOrdinaryAsset(
  packageRoot: string,
  target: string,
  label: string,
): string | null {
  rejectSymlinksBelowRoot(packageRoot, target, label);
  return fs.existsSync(target) ? target : null;
}

function resolveLegacyAsset(packageRoot: string, value: string, label: string): string {
  const canonicalValue = value.endsWith("/") ? value.slice(0, -1) : value;
  if (
    canonicalValue.length === 0 ||
    canonicalValue.endsWith("/") ||
    canonicalValue.includes("\\") ||
    path.posix.isAbsolute(canonicalValue) ||
    WINDOWS_ABSOLUTE_PATH_PATTERN.test(canonicalValue) ||
    path.posix.normalize(canonicalValue) !== canonicalValue ||
    canonicalValue
      .split("/")
      .some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error(`${label} must be a canonical relative path`);
  }
  const target = requireContainedPath(
    packageRoot,
    path.join(packageRoot, ...canonicalValue.split("/")),
    label,
  );
  rejectSymlinksBelowRoot(packageRoot, target, label);
  return target;
}

function resolveLegacyPaths(
  packageRoot: string,
  legacyPathConfig: Record<string, string> | undefined,
): AgentLegacyPaths | null {
  if (!legacyPathConfig) return null;
  const resolved = new Map(
    Object.entries(legacyPathConfig).map(([key, value]) => [
      key,
      resolveLegacyAsset(packageRoot, value, `Agent manifest _legacy_paths.${key}`),
    ]),
  );
  return {
    dockerfileBase: resolved.get("dockerfile_base") ?? null,
    dockerfile: resolved.get("dockerfile") ?? null,
    startScript: resolved.get("start_script") ?? null,
    policy: resolved.get("policy") ?? null,
    plugin: resolved.get("plugin") ?? null,
  };
}

/** Build one data-only agent definition from an explicitly trusted package root. */
export function buildAgentDefinition(input: BuildAgentDefinitionInput): AgentDefinition {
  const packageRoot = requirePackageRoot(input.packageRoot);
  const manifestPath = requireManifestAuthority(packageRoot, input.manifestPath);
  const agentDir = path.dirname(manifestPath);
  const raw = input.manifest;
  const manifestName = readString(raw, "name") ?? path.basename(agentDir);
  const agentAliases = readAgentAliases(raw, manifestName);
  const rawAliasSummary = readString(raw, "alias_summary");
  const agentAliasSummary = rawAliasSummary === undefined ? null : rawAliasSummary.trim();
  const onboardingDefaults = readOnboardingDefaults(raw);
  const description = readString(raw, "description");
  const displayName = readString(raw, "display_name");
  const binaryPath = readString(raw, "binary_path");
  const versionCommand = readString(raw, "version_command");
  const expectedVersion = readString(raw, "expected_version");
  const versionScheme = readVersionScheme(raw);
  const gatewayCommand = readString(raw, "gateway_command");
  const runtime = readAgentRuntime(raw);
  const sandboxCreate = readSandboxCreateDeclaration(raw);
  const forwardPorts = readPortArray(raw, "forward_ports");
  const dashboard = readDashboard(raw);
  const webAuth = readWebAuth(raw);
  const healthProbe = readHealthProbe(raw);
  const config = readObject(raw, "config");
  const inference = readInference(raw);
  const mcp = readMcpCapability(raw);
  const webSearch = readWebSearchCapability(raw);
  const skills = readSkillCapability(raw);
  const stateLifecycle = readStateLifecycle(raw);
  const managedImage = readManagedImageDeclaration(raw);
  if (raw.runtime_auth_state_dirs !== undefined) {
    throw new Error(
      "Agent manifest field 'runtime_auth_state_dirs' was replaced by state_dirs entries with backup: false",
    );
  }
  const stateDirectories = readStateDirectories(raw);
  const stateDirs = stateDirectoryPaths(stateDirectories);
  const stateDirPrefixes = stateDirectoryPrefixes(stateDirectories);
  const backupStateDirs = stateDirectoryPaths(stateDirectories, { backup: true });
  const backupStateDirPrefixes = stateDirectoryPrefixes(stateDirectories, { backup: true });
  const nonBackupStateDirs = stateDirectoryPaths(stateDirectories, { backup: false });
  const nonBackupStateDirPrefixes = stateDirectoryPrefixes(stateDirectories, { backup: false });
  const stateFiles = readStateFiles(raw);
  const userManagedFiles = readUserManagedFiles(raw);
  const phoneHomeHosts = readStringArray(raw, "phone_home_hosts");
  const legacyPathConfig = readStringMap(raw, "_legacy_paths");
  const dashboardUi = readDashboardUi(raw);
  const dockerfileBaseTarget = resolveOrdinaryAsset(
    packageRoot,
    agentDir,
    "Dockerfile.base",
    "Agent base Dockerfile",
  );
  const dockerfileTarget = resolveOrdinaryAsset(
    packageRoot,
    agentDir,
    "Dockerfile",
    "Agent Dockerfile",
  );
  const startScriptTarget = resolveOrdinaryAsset(
    packageRoot,
    agentDir,
    "start.sh",
    "Agent start script",
  );
  const policyAdditionsTarget = resolveOrdinaryAsset(
    packageRoot,
    agentDir,
    "policy-additions.yaml",
    "Agent baseline policy",
  );
  const pluginTarget = resolveOrdinaryAsset(
    packageRoot,
    agentDir,
    "plugin",
    "Agent plugin directory",
  );
  resolveLegacyPaths(packageRoot, legacyPathConfig);

  const agent: AgentDefinition = {
    ...raw,
    name: manifestName,
    aliases: [...agentAliases],
    alias_summary: agentAliasSummary ?? undefined,
    description,
    display_name: displayName,
    binary_path: binaryPath,
    version_command: versionCommand,
    expected_version: expectedVersion,
    version_scheme: versionScheme,
    gateway_command: gatewayCommand,
    runtime,
    sandbox_create: sandboxCreate,
    device_pairing: readBoolean(raw, "device_pairing"),
    phone_home_hosts: phoneHomeHosts,
    forward_ports: forwardPorts,
    health_probe: healthProbe,
    config,
    inference,
    mcp,
    web_search: webSearch,
    skills,
    state_lifecycle: stateLifecycle,
    managed_image: managedImage ?? undefined,
    state_files: stateFiles,
    user_managed_files: userManagedFiles,
    _legacy_paths: legacyPathConfig,
    agentDir,
    manifestPath,
    packageRoot,

    get displayName(): string {
      return displayName ?? manifestName;
    },

    get agentAliases(): readonly string[] {
      return agentAliases;
    },

    get agentAliasSummary(): string | null {
      return agentAliasSummary;
    },

    get isDefaultOnboardingChoice(): boolean {
      return onboardingDefaults.defaultChoice;
    },

    get defaultSandboxName(): string {
      return onboardingDefaults.sandboxName;
    },

    get healthProbe(): AgentHealthProbe | null {
      if (runtime.kind === "terminal" && !healthProbe) return null;
      return (
        healthProbe ?? {
          url: `http://localhost:${String(DASHBOARD_PORT)}/`,
          port: DASHBOARD_PORT,
          timeout_seconds: 30,
        }
      );
    },

    get forwardPort(): number {
      if (runtime.kind === "terminal" && !forwardPorts?.[0]) return 0;
      return forwardPorts?.[0] ?? DASHBOARD_PORT;
    },

    get dashboard(): AgentDashboard {
      return dashboard;
    },

    get webAuth(): AgentWebAuth {
      return webAuth;
    },

    get dashboardUi(): AgentDashboardUi | null {
      return dashboardUi;
    },

    get configPaths(): AgentConfigPaths {
      return {
        dir: readString(config ?? {}, "dir") ?? `/sandbox/.${manifestName}`,
        configFile: readString(config ?? {}, "config_file") ?? "config.json",
        envFile: readString(config ?? {}, "env_file") ?? null,
        format: readString(config ?? {}, "format") ?? "json",
      };
    },

    get inferenceProviderOptions(): string[] {
      return inference?.provider_options ?? [];
    },

    get mcpCapability(): AgentMcpCapability {
      return mcp;
    },

    get skillCapability(): HarnessSkillCapability {
      return skills;
    },

    get stateLifecycle() {
      return stateLifecycle;
    },

    get managedImage() {
      return managedImage;
    },

    get stateDirectories(): AgentStateDirectory[] {
      return stateDirectories;
    },

    get stateDirs(): string[] {
      return stateDirs;
    },

    get stateDirPrefixes(): string[] {
      return stateDirPrefixes;
    },

    get backupStateDirs(): string[] {
      return backupStateDirs;
    },

    get backupStateDirPrefixes(): string[] {
      return backupStateDirPrefixes;
    },

    get nonBackupStateDirs(): string[] {
      return nonBackupStateDirs;
    },

    get nonBackupStateDirPrefixes(): string[] {
      return nonBackupStateDirPrefixes;
    },

    get stateFiles(): AgentStateFile[] {
      return stateFiles ?? [];
    },

    get userManagedFiles(): string[] {
      return userManagedFiles ?? [];
    },

    get versionCommand(): string {
      return versionCommand ?? `${binaryPath ?? "unknown"} --version`;
    },

    get expectedVersion(): string | null {
      return expectedVersion ?? null;
    },

    get versionScheme(): AgentVersionScheme | null {
      return versionScheme ?? null;
    },

    get hasDevicePairing(): boolean {
      return readBoolean(raw, "device_pairing") === true;
    },

    get phoneHomeHosts(): string[] {
      return phoneHomeHosts ?? [];
    },

    get dockerfileBasePath(): string | null {
      return readOptionalOrdinaryAsset(packageRoot, dockerfileBaseTarget, "Agent base Dockerfile");
    },

    get dockerfilePath(): string | null {
      return readOptionalOrdinaryAsset(packageRoot, dockerfileTarget, "Agent Dockerfile");
    },

    get startScriptPath(): string | null {
      return readOptionalOrdinaryAsset(packageRoot, startScriptTarget, "Agent start script");
    },

    get policyAdditionsPath(): string | null {
      const packagePolicy = readOptionalOrdinaryAsset(
        packageRoot,
        policyAdditionsTarget,
        "Agent baseline policy",
      );
      if (packagePolicy) return packagePolicy;
      const legacyPolicy = resolveLegacyPaths(packageRoot, legacyPathConfig)?.policy;
      return legacyPolicy
        ? readOptionalOrdinaryAsset(packageRoot, legacyPolicy, "Agent legacy baseline policy")
        : null;
    },

    get pluginDir(): string | null {
      return readOptionalOrdinaryAsset(packageRoot, pluginTarget, "Agent plugin directory");
    },

    get legacyPaths(): AgentLegacyPaths | null {
      return resolveLegacyPaths(packageRoot, legacyPathConfig);
    },
  };

  Object.defineProperties(agent, {
    agentDir: { configurable: false, enumerable: true, value: agentDir, writable: false },
    manifestPath: { configurable: false, enumerable: true, value: manifestPath, writable: false },
    packageRoot: { configurable: false, enumerable: true, value: packageRoot, writable: false },
  });
  return agent;
}
