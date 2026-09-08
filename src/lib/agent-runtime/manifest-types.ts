// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  HarnessAgentRosterCapability,
  HarnessManifestRecord,
  HarnessManifestScalar,
  HarnessManifestValue,
  HarnessManagedImageDeclaration,
  HarnessInferenceApiOverride,
  HarnessMcpAdapterIdentifier,
  HarnessMcpCapability,
  HarnessMcpSupport,
  HarnessPolicyCapability,
  HarnessProviderAuthCapability,
  HarnessToolGatewayCapability,
  HarnessSecondaryForwardAllocationDeclaration,
  HarnessSandboxCreateDeclaration,
  HarnessSkillCapability,
  HarnessStateLifecycleDeclaration,
  HarnessWebSearchCapability,
} from "@nvidia/nemoclaw-harness-contract";

import type { AgentDashboardUi } from "./dashboard-ui";
import type { AgentSkillIntegration } from "../agent/skill-integration";
import type { AgentRuntime } from "./runtime/manifest";
import type { AgentWebAuth } from "./web-auth";

export type {
  HarnessAgentRosterCapability,
  HarnessAgentManifest,
  HarnessManagedBaseImageDeclaration,
  HarnessManagedBaseImagePin,
  HarnessManifestRecord,
  HarnessManifestScalar,
  HarnessManifestValue,
  HarnessManagedImageDeclaration,
  HarnessManagedImagePlatform,
  HarnessManagedImagePublicationDeclaration,
  HarnessManagedImageRuntimeIdentity,
  HarnessMcpAdapter,
  HarnessMcpAdapterIdentifier,
  HarnessMcpCapability,
  HarnessMcpSupport,
  HarnessPolicyCapability,
  HarnessProviderAuthCapability,
  HarnessToolGatewayCapability,
  HarnessSecondaryForwardAllocationDeclaration,
  HarnessSandboxCreateDeclaration,
  HarnessSandboxDriver,
  HarnessSandboxTmpfsMountDeclaration,
  HarnessSkillActivation,
  HarnessSkillCapability,
  HarnessStateLifecycleDeclaration,
  HarnessWebSearchCapability,
  HarnessWebSearchProvider,
  HarnessWebSearchToolGatewayConflict,
} from "@nvidia/nemoclaw-harness-contract";

export type ManifestScalar = HarnessManifestScalar;
export type ManifestValue = HarnessManifestValue;
export type ManifestRecord = HarnessManifestRecord;
export type StringMap = { [key: string]: string };

export interface AgentHealthProbe {
  url: string;
  port: number;
  timeout_seconds: number;
  success_statuses?: readonly number[];
  port_resolution?: "sandbox-secondary-forward";
  secondary_forward?: HarnessSecondaryForwardAllocationDeclaration;
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

export type StateFileBackupFallback = "privileged-copy";

export interface StateFileBackupOwnership {
  fallback: StateFileBackupFallback;
}

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
  backup?: StateFileBackupOwnership;
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
  /** Config-object path that accepts public tunnel origins, or null when unsupported. */
  tunnelAllowedOriginsPath?: readonly string[] | null;
}

export interface AgentInference {
  provider_type?: string;
  provider_options?: string[];
  default_model?: string;
  /** Receipt-backed requirements for core-owned local inference runtimes. */
  contextWindowRequirements?: readonly {
    readonly provider: "ollama-local";
    readonly minimumTokens: number;
  }[];
  refresh_route_for_messaging_providers?: readonly string[];
  /** Core-owned compatibility bridge from NEMOCLAW_PROVIDER_KEY to hosted inference. */
  provider_key_credential_alias?: "hosted-inference";
  sandbox_smoke?: {
    readonly kind: "compatible-endpoint";
    readonly config_path: `/sandbox/${string}`;
  };
  route_probe?: {
    readonly terminal_connect?: "required";
    readonly rebuild_preflight?: "inference-invocation";
    readonly models_404?: "inference-invocation";
  };
  /** Provider/API requirements declared by the selected package's config adapter. */
  providerApiOverrides?: readonly HarnessInferenceApiOverride[];
}

export type AgentMcpSupport = HarnessMcpSupport;
export type AgentMcpAdapterIdentifier = HarnessMcpAdapterIdentifier;
/** Compatibility name retained while callers adopt the descriptive identifier type. */
export type AgentMcpAdapter = AgentMcpAdapterIdentifier;

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
  sandbox_create?: HarnessSandboxCreateDeclaration;
  device_pairing?: boolean;
  phone_home_hosts?: string[];
  forward_ports?: number[];
  health_probe?: AgentHealthProbe;
  config?: ManifestRecord;
  inference?: AgentInference;
  mcp?: AgentMcpCapability;
  agent_roster?: HarnessAgentRosterCapability;
  policy?: HarnessPolicyCapability;
  provider_auth?: HarnessProviderAuthCapability;
  tool_gateways?: HarnessToolGatewayCapability;
  web_search?: HarnessWebSearchCapability;
  skills?: HarnessSkillCapability;
  state_lifecycle?: HarnessStateLifecycleDeclaration;
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
  readonly agentRosterCapability: HarnessAgentRosterCapability | null;
  readonly policyCapability: HarnessPolicyCapability;
  readonly providerAuthCapability?: HarnessProviderAuthCapability | null;
  readonly toolGatewayCapability?: HarnessToolGatewayCapability | null;
  readonly skillCapability: HarnessSkillCapability;
  /** Native argv projection derived from the validated package skill capability. */
  readonly skillIntegration?: AgentSkillIntegration | null;
  readonly stateLifecycle: HarnessStateLifecycleDeclaration;
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
