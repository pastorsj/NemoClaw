// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  HarnessManifestRecord,
  HarnessManifestScalar,
  HarnessManifestValue,
  HarnessManagedImageDeclaration,
  HarnessMcpAdapter,
  HarnessMcpCapability,
  HarnessMcpSupport,
} from "@nvidia/nemoclaw-harness-contract";

import type { AgentDashboardUi } from "./dashboard-ui";
import type { AgentRuntime } from "./runtime/manifest";
import type { AgentWebAuth } from "./web-auth";

export type {
  HarnessAgentManifest,
  HarnessManifestRecord,
  HarnessManifestScalar,
  HarnessManifestValue,
  HarnessManagedImageDeclaration,
  HarnessManagedImagePlatform,
  HarnessManagedImageRuntimeIdentity,
  HarnessMcpAdapter,
  HarnessMcpCapability,
  HarnessMcpSupport,
} from "@nvidia/nemoclaw-harness-contract";

export type ManifestScalar = HarnessManifestScalar;
export type ManifestValue = HarnessManifestValue;
export type ManifestRecord = HarnessManifestRecord;
export type StringMap = { [key: string]: string };

export interface AgentHealthProbe {
  url: string;
  port: number;
  timeout_seconds: number;
}

export interface AgentConfigPaths {
  dir: string;
  configFile: string;
  envFile: string | null;
  format: string;
}

interface AgentStateDirectoryBehavior {
  backup: boolean;
}

export interface AgentStateDirectoryPath extends AgentStateDirectoryBehavior {
  kind: "path";
  path: string;
}

export interface AgentStateDirectoryPrefix extends AgentStateDirectoryBehavior {
  kind: "prefix";
  prefix: string;
}

export type AgentStateDirectory = AgentStateDirectoryPath | AgentStateDirectoryPrefix;

export type AgentStateFileStrategy = "copy" | "sqlite_backup";

export type StateFileRestoreMerge = "key-allowlist" | "package-config";

export type StateFileUserKeyType = "boolean" | "string" | "integer" | "number" | "enum";

export interface StateFileUserKey {
  key: string;
  type: StateFileUserKeyType;
  values?: readonly (string | number | boolean)[];
  min?: number;
  max?: number;
  maxLength?: number;
}

export interface StateFileFreshHeader {
  match: "exact" | "prefix";
  value: string;
}

export interface StateFileKeyAllowlistRestoreOwnership {
  merge: "key-allowlist";
  userKeys: readonly StateFileUserKey[];
  requireFreshTables?: readonly string[];
  requireFreshHeaders?: readonly StateFileFreshHeader[];
}

export interface StateFilePackageConfigRestoreOwnership {
  merge: "package-config";
  userKeys?: never;
  requireFreshTables?: never;
  requireFreshHeaders?: never;
}

export type StateFileRestoreOwnership =
  | StateFileKeyAllowlistRestoreOwnership
  | StateFilePackageConfigRestoreOwnership;

export interface AgentStateFile {
  path: string;
  strategy: AgentStateFileStrategy;
  restore?: StateFileRestoreOwnership;
}

export type AgentDashboardKind = "ui" | "api";

export interface AgentDashboard {
  kind: AgentDashboardKind;
  label: string;
  path: string;
  healthPath: string;
  auth: "url_token" | "session" | "none";
  /** Config-object path containing the URL fragment token when auth is url_token. */
  tokenPath?: readonly string[] | null;
}

export interface AgentInference {
  provider_type?: string;
  provider_options?: string[];
  default_model?: string;
}

export type AgentMcpSupport = HarnessMcpSupport;
export type AgentMcpAdapter = HarnessMcpAdapter;

const AGENT_MCP_ADAPTER_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;

/** Accept the canonical adapter identifier shared by manifests and durable state. */
export function isAgentMcpAdapter(value: unknown): value is AgentMcpAdapter {
  return typeof value === "string" && AGENT_MCP_ADAPTER_RE.test(value);
}

export type AgentMcpCapability = HarnessMcpCapability;

export interface AgentLegacyPaths {
  dockerfileBase: string | null;
  dockerfile: string | null;
  startScript: string | null;
  policy: string | null;
  plugin: string | null;
}

export type AgentVersionScheme = "semver" | "calendar";

export interface AgentDefinition {
  name: string;
  aliases?: string[];
  alias_summary?: string;
  description?: string;
  display_name?: string;
  binary_path?: string;
  version_command?: string;
  expected_version?: string;
  version_scheme?: AgentVersionScheme;
  gateway_command?: string;
  runtime?: AgentRuntime;
  device_pairing?: boolean;
  phone_home_hosts?: string[];
  forward_ports?: number[];
  health_probe?: AgentHealthProbe;
  config?: ManifestRecord;
  inference?: AgentInference;
  mcp?: AgentMcpCapability;
  managed_image?: HarnessManagedImageDeclaration;
  state_files?: AgentStateFile[];
  user_managed_files?: string[];
  _legacy_paths?: StringMap;
  readonly agentDir: string;
  readonly manifestPath: string;
  /** Trusted root that owns every package-derived manifest and image asset. */
  readonly packageRoot: string;
  readonly displayName: string;
  readonly agentAliases: readonly string[];
  readonly agentAliasSummary: string | null;
  readonly isDefaultOnboardingChoice: boolean;
  readonly defaultSandboxName: string;
  readonly healthProbe: AgentHealthProbe | null;
  readonly forwardPort: number;
  readonly dashboard: AgentDashboard;
  readonly webAuth: AgentWebAuth;
  readonly dashboardUi?: AgentDashboardUi | null;
  readonly configPaths: AgentConfigPaths;
  readonly inferenceProviderOptions: string[];
  readonly mcpCapability: AgentMcpCapability;
  readonly managedImage: HarnessManagedImageDeclaration | null;
  readonly stateDirectories: AgentStateDirectory[];
  readonly stateDirs: string[];
  readonly stateDirPrefixes: string[];
  readonly backupStateDirs: string[];
  readonly backupStateDirPrefixes: string[];
  readonly nonBackupStateDirs: string[];
  readonly nonBackupStateDirPrefixes: string[];
  readonly stateFiles: AgentStateFile[];
  readonly userManagedFiles: string[];
  readonly versionCommand: string;
  readonly expectedVersion: string | null;
  readonly versionScheme?: AgentVersionScheme | null;
  readonly hasDevicePairing: boolean;
  readonly phoneHomeHosts: string[];
  readonly dockerfileBasePath: string | null;
  readonly dockerfilePath: string | null;
  readonly startScriptPath: string | null;
  readonly policyAdditionsPath: string | null;
  readonly pluginDir: string | null;
  readonly legacyPaths: AgentLegacyPaths | null;
}

export interface AgentChoice {
  name: string;
  displayName: string;
  description: string;
}
