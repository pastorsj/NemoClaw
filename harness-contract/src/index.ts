// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export interface HarnessPackageEnvelope {
  readonly schemaVersion: 1;
  readonly kind: "agent-runtime";
  readonly id: string;
  readonly displayName: string;
  readonly packageVersion: string;
  readonly minimumNemoClawVersion: string;
  readonly manifest: string;
}

export type HarnessManifestScalar = string | number | boolean | null | Date;
export type HarnessManifestValue =
  | HarnessManifestScalar
  | HarnessManifestRecord
  | HarnessManifestValue[];
export type HarnessManifestRecord = { [key: string]: HarnessManifestValue };

export type HarnessMcpSupport = "bridge" | "disabled";
export type HarnessMcpAdapter = string;

export type HarnessManagedImagePlatform = "linux/amd64" | "linux/arm64";

export interface HarnessManagedImageRuntimeIdentity {
  readonly uid: number;
  readonly gid: number;
  readonly workdir: "/sandbox";
}

/**
 * Harness-native image requirements declared by a package. This declaration
 * describes how to compose an already-qualified image; it does not authorize
 * an image, publisher, digest, or release by itself.
 */
export interface HarnessManagedImageDeclaration {
  readonly repository: string;
  readonly architectures: readonly HarnessManagedImagePlatform[];
  readonly runtime_identity: HarnessManagedImageRuntimeIdentity;
  readonly startup_profile_contract_version: 1;
  readonly capability_contract_version: 1;
}

export type HarnessMcpCapability =
  | {
      support: "bridge";
      adapter: HarnessMcpAdapter;
      policy_binaries?: readonly string[];
      reason?: string;
    }
  | {
      support: "disabled";
      adapter?: never;
      policy_binaries?: never;
      reason?: string;
    };

/** Known manifest fields plus the bounded data record accepted by core. */
export type HarnessAgentManifest = HarnessManifestRecord & {
  readonly name: string;
  readonly display_name?: string;
  readonly description?: string;
  readonly aliases?: string[];
  readonly onboarding?: HarnessManifestRecord;
  readonly runtime?: HarnessManifestRecord;
  readonly config?: HarnessManifestRecord;
  readonly inference?: HarnessManifestRecord;
  readonly mcp?: HarnessMcpCapability;
  readonly managed_image?: HarnessManagedImageDeclaration;
};

export interface HarnessConfigTarget {
  readonly directory: string;
  readonly file: string;
  readonly format: string;
  readonly sensitiveFiles: readonly string[];
}

interface HarnessConfigCommandFields {
  readonly command: readonly string[];
  readonly timeoutSeconds: number;
  readonly failureMessage: string;
  readonly recoveryGuidance?: readonly string[];
}

export interface HarnessExitZeroCommand extends HarnessConfigCommandFields {
  readonly success: { readonly kind: "exit-zero" };
}

export interface HarnessConfigTransactionCommand extends HarnessConfigCommandFields {
  readonly success: {
    readonly kind: "config-transaction";
    readonly action: string;
    readonly configDirectory: string;
    readonly protectedFiles: readonly string[];
  };
}

export type HarnessConfigCommand = HarnessExitZeroCommand | HarnessConfigTransactionCommand;
export type HarnessConfigCommandSuccess = HarnessConfigCommand["success"];

export interface HarnessConfigUpdateRequest {
  readonly config: Readonly<Record<string, unknown>>;
  readonly serializedConfig: string;
  readonly expectedConfigSha256: string;
  readonly target: HarnessConfigTarget;
}

export type HarnessConfigUpdatePlan =
  | { readonly kind: "immutable"; readonly reason: string }
  | {
      readonly kind: "transaction";
      readonly content: string;
      readonly validation: HarnessExitZeroCommand | null;
      readonly write: HarnessConfigCommand;
      readonly restart: {
        readonly kind: "managed" | "external";
        readonly guidance: readonly string[];
      };
    };

export interface HarnessConfigUrlRequest {
  readonly config: Readonly<Record<string, unknown>>;
  readonly key: string;
  readonly relativePath: readonly string[];
}

export interface HarnessConfigUrlPolicy {
  readonly allowPrivateUrls: boolean;
  readonly allowOpenShellBridge: boolean;
}

export interface HarnessMutableConfigRequest {
  readonly target: HarnessConfigTarget;
  readonly sandboxUid: string | null;
  readonly sandboxGid: string | null;
}

export type HarnessMutableConfigPlan =
  | { readonly kind: "not-required"; readonly reason: string }
  | {
      readonly kind: "stat";
      readonly directoryMode: string;
      readonly directoryOwner: string;
      readonly fileMode: string;
      readonly fileOwner: string;
      readonly repair: HarnessExitZeroCommand | null;
    }
  | { readonly kind: "probe"; readonly probe: HarnessExitZeroCommand };

export interface HarnessImagePluginInstall {
  readonly id: string;
  readonly loadPaths: readonly string[];
}

export interface HarnessConfigRestoreRequest {
  readonly backupContent: string;
  readonly currentContent: string | null;
  readonly managedChannelNames: readonly string[];
  readonly previousImagePluginInstalls: readonly HarnessImagePluginInstall[] | null;
  readonly freshImagePluginInstalls: readonly HarnessImagePluginInstall[] | null;
}

export type HarnessConfigRestoreWritePlan =
  | { readonly kind: "atomic" }
  | { readonly kind: "config-anchors"; readonly hashFiles: readonly string[] };

export type HarnessConfigRestoreResult =
  | {
      readonly kind: "merged";
      readonly content: string;
      readonly write: HarnessConfigRestoreWritePlan;
    }
  | { readonly kind: "refused"; readonly reason: string };

export interface HarnessMcpAdapterEntry {
  readonly server: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
}

export interface HarnessMcpRegistrationRequest {
  readonly entry: HarnessMcpAdapterEntry;
  readonly managedEntries: readonly HarnessMcpAdapterEntry[];
  readonly replaceExisting: boolean;
  readonly teardownRollback: boolean;
  readonly configDirectory: string | null;
}

export interface HarnessMcpRemovalRequest {
  readonly entry: HarnessMcpAdapterEntry;
  readonly force: boolean;
  readonly adaptiveTeardown: boolean;
  readonly configDirectory: string | null;
}

export type HarnessMcpAdapterCommand = string | readonly string[];
export type HarnessMcpExecutionSuccess =
  | { readonly kind: "exit-zero" }
  | {
      readonly kind: "lifecycle-json";
      readonly requireReload: boolean;
      readonly invalidResponseMessage: string;
      readonly reloadRequiredMessage: string;
    };

export interface HarnessMcpExecutionPlan {
  readonly command: HarnessMcpAdapterCommand;
  readonly timeoutSeconds: number;
  readonly success: HarnessMcpExecutionSuccess;
  readonly failureMessage: string;
}

export type HarnessMcpRegistrationVerification =
  | { readonly kind: "inspection"; readonly failureMessage: string }
  | { readonly kind: "rollback-restored"; readonly failureMessage: string };

export type HarnessMcpCredentialConvergence =
  | { readonly kind: "none" }
  | {
      readonly kind: "after-runtime-reload";
      readonly unavailableMessage: string;
      readonly unstableMessage: string;
    };

export interface HarnessMcpRegistrationPlan {
  readonly execution: HarnessMcpExecutionPlan;
  readonly verification: HarnessMcpRegistrationVerification;
  readonly credentialConvergence: HarnessMcpCredentialConvergence;
}

export type HarnessMcpRemovalOutcome =
  | { readonly kind: "removed" }
  | { readonly kind: "stdout-removal-outcome" };

export interface HarnessMcpRemovalPlan {
  readonly execution: HarnessMcpExecutionPlan;
  readonly outcome: HarnessMcpRemovalOutcome;
}

export interface HarnessMcpInspectionRequest {
  readonly entry: HarnessMcpAdapterEntry;
  readonly failOnMismatch: boolean;
  readonly configDirectory: string | null;
}

export interface HarnessMcpCapabilityRequest {
  readonly sandboxName: string;
}

export type HarnessMcpCapabilityProbe =
  | { readonly kind: "not-required" }
  | {
      readonly kind: "command";
      readonly command: HarnessMcpAdapterCommand;
      readonly success:
        | { readonly kind: "exit-zero" }
        | { readonly kind: "stdout-trimmed-equals"; readonly value: string }
        | { readonly kind: "last-json-line-ok" };
      readonly timeoutSeconds: number;
      readonly failureMessage: string;
      readonly retry?: {
        readonly outputExact: string;
        readonly initialAttempts: number;
        readonly intervalMilliseconds: number;
        readonly recovery?: {
          readonly kind: "agent-gateway";
          readonly timeoutSeconds: number;
          readonly postRecoveryAttempts: number;
        };
      };
    };

export interface HarnessMcpRuntimeRequest {
  readonly command: readonly string[];
}

export interface HarnessMcpRuntimeIntentRequest {
  readonly entries: readonly HarnessMcpAdapterEntry[];
  readonly managedServerNames: readonly string[];
}

export interface HarnessMcpSnapshotRestoreRequest {
  readonly sandboxName: string;
  readonly entries: readonly HarnessMcpAdapterEntry[];
}

export interface HarnessMcpSnapshotApplicability {
  readonly command: HarnessMcpAdapterCommand;
  readonly timeoutSeconds: number;
  readonly repairWhenOutput: string;
  readonly skipWhenOutput: string;
  readonly failureMessage: string;
}

export type HarnessMcpSnapshotRestorePlan =
  | { readonly kind: "not-required" }
  | {
      readonly kind: "conditional-repair";
      readonly applicability: HarnessMcpSnapshotApplicability;
      readonly capability: HarnessMcpCapabilityProbe;
      readonly execution: HarnessMcpExecutionPlan & {
        readonly success: { readonly kind: "exit-zero" };
      };
      readonly verificationFailureMessage: string;
    };

export interface HarnessConfigAdapterModule {
  readonly prepareConfigUpdate: (request: HarnessConfigUpdateRequest) => HarnessConfigUpdatePlan;
  readonly classifyConfigUrl: (request: HarnessConfigUrlRequest) => HarnessConfigUrlPolicy;
  readonly describeMutableConfig: (
    request: HarnessMutableConfigRequest,
  ) => HarnessMutableConfigPlan;
}

export interface HarnessConfigRestoreModule {
  readonly mergeConfigState: (request: HarnessConfigRestoreRequest) => HarnessConfigRestoreResult;
}

export interface HarnessMcpAdapterModule {
  readonly buildMcpRegistrationPlan: (
    request: HarnessMcpRegistrationRequest,
  ) => HarnessMcpRegistrationPlan;
  readonly buildMcpRemovalPlan: (request: HarnessMcpRemovalRequest) => HarnessMcpRemovalPlan;
  readonly buildMcpInspectionCommand: (request: HarnessMcpInspectionRequest) => string;
  readonly describeMcpMutationCapability: (
    request: HarnessMcpCapabilityRequest,
  ) => HarnessMcpCapabilityProbe;
  readonly describeMcpTeardownCapability: (
    request: HarnessMcpCapabilityRequest,
  ) => HarnessMcpCapabilityProbe;
  readonly describeMcpRuntimeIntentVerification: (
    request: HarnessMcpRuntimeIntentRequest,
  ) => HarnessMcpCapabilityProbe;
  readonly buildMcpRuntimeCommand: (request: HarnessMcpRuntimeRequest) => readonly string[];
  readonly buildMcpSnapshotRestorePlan: (
    request: HarnessMcpSnapshotRestoreRequest,
  ) => HarnessMcpSnapshotRestorePlan;
}

export type HarnessStartupJsonScalar = string | number | boolean | null;
export type HarnessStartupJsonValue =
  | HarnessStartupJsonScalar
  | HarnessStartupJsonObject
  | readonly HarnessStartupJsonValue[];
export interface HarnessStartupJsonObject {
  readonly [key: string]: HarnessStartupJsonValue;
}

export type HarnessStartupInferenceApi =
  | "openai-completions"
  | "openai-responses"
  | "anthropic-messages";

export interface HarnessStartupInferenceSettings {
  readonly routeProvider: string;
  readonly upstreamProvider: string;
  readonly model: string;
  readonly routedBaseUrl: string;
  readonly upstreamEndpointUrl: string | null;
  readonly api: HarnessStartupInferenceApi;
  readonly primaryModelRef: string | null;
  readonly compatibility: HarnessStartupJsonObject | null;
  readonly inputModalities: readonly ("text" | "image")[] | null;
}

export interface HarnessStartupProxySettings {
  readonly managedHost: string;
  readonly managedPort: number;
  readonly hostHttpUrl: string | null;
  readonly hostHttpsUrl: string | null;
  readonly hostNoProxy: readonly string[];
}

/**
 * Optional, finite settings available to a package startup adapter. Core owns
 * their validation before this normalized request crosses the image boundary.
 * A package checks the subset required by its native runtime.
 */
export interface HarnessStartupConfigSettings {
  readonly agent?: string;
  readonly webSearch?: { readonly enabled: boolean; readonly provider: "brave" | "tavily" };
  readonly otel?: {
    readonly enabled: boolean;
    readonly endpointUrl: string;
    readonly serviceName: string;
    readonly sampleRate: number;
  };
  readonly agentTimeoutSeconds?: number;
  readonly heartbeatEvery?: string | null;
  readonly extraAgents?: {
    readonly agents: readonly HarnessStartupJsonObject[];
    readonly defaults: HarnessStartupJsonObject;
    readonly main: HarnessStartupJsonObject;
  };
  readonly deviceAuth?: {
    readonly disabled: boolean;
    readonly optOutSource: "operator" | "managed-onboard";
  };
  readonly minimalBootstrap?: boolean;
  readonly autoApprovalMode?: "disabled" | "thread-opt-in";
  readonly observabilityEnabled?: boolean;
}

export interface HarnessStartupDashboardSettings {
  readonly agent?: string;
  readonly mode: "disabled" | "loopback" | "remote" | "loopback-forwarded";
  readonly url?: string;
  readonly browserUrl?: string;
  readonly port?: number;
  readonly bindAddress?: "127.0.0.1" | "0.0.0.0";
  readonly wslExposure?: boolean;
  readonly publicPort?: number | null;
  readonly internalPort?: number | null;
  readonly tuiEnabled?: boolean;
}

export interface HarnessStartupSettings {
  readonly configuration: HarnessStartupConfigSettings;
  readonly inference: HarnessStartupInferenceSettings;
  readonly proxy: HarnessStartupProxySettings;
  readonly dashboard: HarnessStartupDashboardSettings;
  readonly tools: {
    readonly disclosure: "progressive" | "direct";
    readonly enabledGateways: readonly string[];
  };
  readonly messaging: { readonly plan: HarnessStartupJsonObject | null };
  readonly tuning: {
    readonly contextWindow: number | null;
    readonly maxTokens: number | null;
    readonly reasoning: boolean | null;
    readonly reasoningEffort: "default" | "low" | "medium" | "high" | null;
  };
  readonly corporateCa: { readonly bundleSha256: string | null };
}

export interface HarnessStartupRequest {
  /** Legacy stock startup requests intentionally retain their existing shape. */
  readonly profileKind?: never;
  readonly packageId: string;
  readonly settings: HarnessStartupSettings;
  /** Only core-reviewed, non-secret launch controls are exposed here. */
  readonly applicationEnvironment: Readonly<Record<string, string>>;
}

/** Exact installed package authority carried by a receipt-backed startup profile. */
export interface HarnessStartupPackageIdentity {
  readonly kind: "agent-runtime";
  readonly id: string;
  readonly packageVersion: string;
  readonly contentDigest: string;
}

/**
 * Generic package startup request. The package validates its own typed config;
 * core has already bounded it, rejected credential-shaped data, and bound it
 * to the complete installed package identity.
 */
export interface HarnessPackageStartupRequest<
  PackageConfig extends HarnessStartupJsonObject = HarnessStartupJsonObject,
> {
  readonly profileKind: "package";
  readonly packageId: string;
  readonly harnessPackage: HarnessStartupPackageIdentity;
  readonly packageConfig: PackageConfig;
  readonly corporateCa: { readonly bundleSha256: string | null };
  /** Only core-reviewed, non-secret launch controls are exposed here. */
  readonly applicationEnvironment: Readonly<Record<string, string>>;
}

export type HarnessStartupAdapterRequest = HarnessStartupRequest | HarnessPackageStartupRequest;

export type HarnessStartupEnvironmentValue =
  | string
  | {
      readonly kind: "canonical-json-base64";
      readonly value: HarnessStartupJsonValue;
    };

export interface HarnessStartupApplicationRuntimePlan {
  readonly exportEnvironment: Readonly<Record<string, string>>;
  readonly unsetEnvironment: readonly string[];
}

export interface HarnessStartupCorporateCaMaterial {
  readonly kind: "corporate-ca-handoff";
  readonly legacyInput: "NEMOCLAW_CORPORATE_CA_B64";
  readonly expectedSha256: string | null;
}

export interface HarnessStartupRootFileMaterial {
  readonly kind: "root-owned-file";
  readonly legacyInput: string;
  readonly path: `/usr/local/share/nemoclaw/${string}`;
  readonly contents: string;
  readonly owner: "root";
  readonly group: "root";
  readonly mode: 0o444;
}

export type HarnessStartupMaterial =
  | HarnessStartupCorporateCaMaterial
  | HarnessStartupRootFileMaterial;

export type HarnessStartupAction =
  | { readonly kind: "generate-config"; readonly runAs: "sandbox" }
  | {
      readonly kind: "apply-messaging";
      readonly mode: "apply" | "clear";
      readonly phase: "runtime-setup";
      readonly runAs: "root";
    }
  | {
      readonly kind: "apply-messaging";
      readonly mode: "apply" | "clear";
      readonly phase: "post-agent-install";
      readonly runAs: "sandbox";
    };

/** Finite built-in integrity workflows; adapters cannot return a command. */
export type HarnessStartupIntegrityPlan =
  | { readonly kind: "none" }
  | { readonly kind: "validated-json-config" }
  | { readonly kind: "managed-config-set" };

export interface HarnessStartupPlan {
  readonly schemaVersion: 1;
  readonly packageId: string;
  readonly configurationEnvironment: Readonly<Record<string, HarnessStartupEnvironmentValue>>;
  readonly runtimeEnvironment: Readonly<Record<string, HarnessStartupEnvironmentValue>>;
  readonly applicationRuntime: HarnessStartupApplicationRuntimePlan;
  readonly materials: readonly HarnessStartupMaterial[];
  readonly actions: readonly HarnessStartupAction[];
  readonly integrity: HarnessStartupIntegrityPlan;
}

export interface HarnessStartupAdapterModule<
  Request extends HarnessStartupAdapterRequest = HarnessStartupRequest,
> {
  readonly buildStartupPlan: (request: Request) => HarnessStartupPlan;
}
