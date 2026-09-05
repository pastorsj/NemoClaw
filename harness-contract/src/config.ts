// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Inference and mutable-configuration requests translated by a package adapter. */
export type HarnessSandboxReconcileTrigger = "after-config-sync" | "when-config-changes";

export type HarnessSandboxReconcileDeclaration =
  | { readonly kind: "not-required" }
  | {
      readonly kind: "command";
      readonly trigger: HarnessSandboxReconcileTrigger;
      readonly command: readonly string[];
      readonly timeout_seconds: number;
    };

/** Known manifest fields plus the bounded data record accepted by core. */
export interface HarnessInferencePostCommitDeclaration {
  readonly config_sync: "best-effort" | "required";
  readonly gateway_restart: "not-required" | "when-api-changes";
  readonly sandbox_reconcile: HarnessSandboxReconcileDeclaration;
}

export interface HarnessInferenceApiOverride {
  readonly provider: string;
  readonly api: HarnessInferenceApi;
}

export type HarnessInferenceConfigDeclaration =
  | {
      readonly support: "mutable";
      readonly provider_api_overrides: readonly HarnessInferenceApiOverride[];
      readonly post_commit: HarnessInferencePostCommitDeclaration;
      readonly reason?: never;
    }
  | { readonly support: "unsupported"; readonly reason: string };

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

export interface HarnessInferenceConfigRequest {
  readonly target: HarnessConfigTarget;
}

export type HarnessInferenceConfigSupport =
  | {
      readonly kind: "mutable";
      readonly providerApiOverrides: readonly HarnessInferenceApiOverride[];
    }
  | { readonly kind: "unsupported"; readonly reason: string };

export type HarnessInferenceApi = "openai-completions" | "anthropic-messages" | "openai-responses";

export interface HarnessInferenceRoute {
  readonly upstreamProvider: string;
  readonly model: string;
  readonly providerKey: string;
  readonly primaryModelRef: string | null;
  readonly baseUrl: string;
  readonly api: HarnessInferenceApi;
  readonly compatibility: Readonly<Record<string, unknown>> | null;
}

export interface HarnessInferenceReasoning {
  readonly effort: "low" | "medium" | "high" | null;
  readonly explicit: boolean;
}

export interface HarnessInferenceConfigUpdateRequest {
  readonly target: HarnessConfigTarget;
  readonly config: Readonly<Record<string, unknown>>;
  readonly route: HarnessInferenceRoute;
  readonly contextWindow: number | null;
  readonly reasoning: HarnessInferenceReasoning;
}

export interface HarnessInferenceConfigPostCommit {
  /** Whether an in-sandbox write failure is recoverable or fails the command. */
  readonly configSync: "best-effort" | "required";
  readonly gatewayRestart:
    | { readonly kind: "not-required" }
    | {
        readonly kind: "when-api-changes";
        readonly previousApi: HarnessInferenceApi | null;
      };
  readonly sandboxReconcile:
    | { readonly kind: "not-required" }
    | {
        readonly kind: "command";
        readonly trigger: HarnessSandboxReconcileTrigger;
        readonly command: readonly string[];
        readonly timeoutSeconds: number;
      };
}

/** Opaque request core sends to one receipt-pinned sandbox reconciliation command. */
export interface HarnessSandboxReconcileRequest {
  readonly requestId: string;
}

/** The only successful response accepted from a sandbox reconciliation command. */
export interface HarnessSandboxReconcileResult {
  readonly status: "converged";
  readonly requestId: string;
}

export type HarnessInferenceConfigUpdatePlan =
  | { readonly kind: "unsupported"; readonly reason: string }
  | {
      readonly kind: "mutation";
      readonly config: Readonly<Record<string, unknown>>;
      readonly changed: boolean;
      readonly postCommit: HarnessInferenceConfigPostCommit;
    };

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

export interface HarnessConfigAdapterModule {
  readonly describeInferenceConfig: (
    request: HarnessInferenceConfigRequest,
  ) => HarnessInferenceConfigSupport;
  readonly prepareInferenceConfig: (
    request: HarnessInferenceConfigUpdateRequest,
  ) => HarnessInferenceConfigUpdatePlan;
  readonly prepareConfigUpdate: (request: HarnessConfigUpdateRequest) => HarnessConfigUpdatePlan;
  readonly classifyConfigUrl: (request: HarnessConfigUrlRequest) => HarnessConfigUrlPolicy;
  readonly describeMutableConfig: (
    request: HarnessMutableConfigRequest,
  ) => HarnessMutableConfigPlan;
}

export interface HarnessConfigRestoreModule {
  readonly mergeConfigState: (request: HarnessConfigRestoreRequest) => HarnessConfigRestoreResult;
}
