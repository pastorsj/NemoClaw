// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export interface HarnessPackageEnvelope {
  readonly schemaVersion: 1;
  readonly kind: "agent-runtime";
  readonly id: string;
  readonly displayName: string;
  readonly packageVersion: string;
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
}
