// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Durable startup intent, package-owned configuration, and finite startup plans. */
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

/** Core-owned approval choices that a package can consume through its startup profile. */
export type HarnessStartupApprovalMode = "disabled" | "thread-opt-in";

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
  readonly autoApprovalMode?: HarnessStartupApprovalMode;
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

export interface HarnessStartupInferenceCandidate {
  /** API requested from core when this route candidate was resolved; null means provider default. */
  readonly requestedApi: HarnessStartupInferenceApi | null;
  readonly routeProvider: string;
  readonly routedBaseUrl: string;
  readonly api: HarnessStartupInferenceApi;
  readonly primaryModelRef: string;
  readonly compatibility: HarnessStartupJsonObject | null;
}

/** Finite, credential-free operator input from which a package prepares normalized startup intent. */
export interface HarnessStartupProfileInput {
  readonly inference: {
    readonly selectedProvider: string | null;
    readonly model: string;
    readonly endpointUrl: string | null;
    /** Core-owned model metadata; the package decides whether its harness consumes it. */
    readonly resolvedContextWindow: number | null;
    readonly reasoningEnabled: boolean | null;
    readonly reasoningEffort: "low" | "medium" | "high" | null;
    readonly candidates: readonly HarnessStartupInferenceCandidate[];
  };
  readonly dashboard: {
    readonly managed: boolean;
    readonly url: string;
    readonly port: number;
    readonly bindAddress: string | null;
    readonly wslExposure: boolean;
    readonly forwarding: {
      readonly enabled: boolean;
      readonly publicPort: number | null;
      readonly internalPort: number | null;
      readonly tuiEnabled: boolean;
    };
  };
  readonly webSearch: {
    readonly enabled: boolean;
    readonly provider: "brave" | "tavily" | null;
  } | null;
  readonly tools: {
    readonly disclosure: "progressive" | "direct";
    readonly enabledGateways: readonly string[];
  };
  readonly messagingPlan: HarnessStartupJsonObject | null;
  readonly approvalMode: HarnessStartupApprovalMode;
  readonly observabilityEnabled: boolean;
  readonly proxy: HarnessStartupProxySettings;
  /** A fixed allowlist of non-secret compatibility inputs; arbitrary process environment is excluded. */
  readonly environment: Readonly<Record<string, string>>;
  readonly corporateCa: { readonly bundleSha256: string | null };
  readonly credentialProxyPresent: boolean;
}

export interface HarnessPrepareStartupProfileRequest {
  readonly packageId: string;
  readonly harnessPackage: HarnessStartupPackageIdentity;
  readonly phase: "initial" | "rebuild";
  readonly input: HarnessStartupProfileInput;
  readonly previousDesiredState: HarnessStartupSettings | null;
}

export type HarnessPrepareStartupProfileResult =
  | { readonly kind: "unsupported"; readonly reason: string }
  | {
      readonly kind: "prepared";
      readonly desiredState: HarnessStartupSettings;
      readonly credentialProxyReplayRequired: boolean;
      readonly dashboardRemoteBindPrepared: boolean;
    };

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

/**
 * Sandbox-shared paths that a startup plan may create or replace.
 *
 * Core snapshots these paths before it executes the finite startup actions.
 * The root is an absolute path below `/sandbox`; every child is a normalized
 * relative path below that root. Packages declare effects, while NemoClaw owns
 * path validation, backup, rollback, and commit.
 */
export interface HarnessStartupManagedStatePlan {
  readonly root: `/sandbox/${string}`;
  readonly files: readonly string[];
  readonly directories: readonly string[];
}

export type HarnessStartupAction =
  | { readonly kind: "generate-config"; readonly runAs: "sandbox" }
  /** Core executes the package-owned sealer at its one fixed image path. */
  | {
      readonly kind: "seal-config";
      readonly runAs: "root" | "sandbox";
      readonly committedReplay: "run" | "skip";
    }
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

export interface HarnessStartupPlan {
  readonly schemaVersion: 1;
  readonly packageId: string;
  readonly configurationEnvironment: Readonly<Record<string, HarnessStartupEnvironmentValue>>;
  readonly runtimeEnvironment: Readonly<Record<string, HarnessStartupEnvironmentValue>>;
  readonly applicationRuntime: HarnessStartupApplicationRuntimePlan;
  readonly managedState: HarnessStartupManagedStatePlan;
  readonly materials: readonly HarnessStartupMaterial[];
  readonly actions: readonly HarnessStartupAction[];
}

/** Receipt-bound normalized intent used to construct package-owned durable startup state. */
export interface HarnessInitialStartupProfileRequest {
  readonly packageId: string;
  readonly harnessPackage: HarnessStartupPackageIdentity;
  readonly desiredState: HarnessStartupSettings;
}

/** Package-owned reconciliation keeps the current durable config opaque to core. */
export interface HarnessReconcileStartupProfileRequest extends HarnessInitialStartupProfileRequest {
  readonly currentPackageConfig: HarnessStartupJsonObject;
}

export type HarnessInitialStartupProfileResult =
  | { readonly kind: "unsupported"; readonly reason: string }
  | {
      readonly kind: "package-config";
      readonly packageConfig: HarnessStartupJsonObject;
    };

export type HarnessReconcileStartupProfileResult =
  | { readonly kind: "unsupported"; readonly reason: string }
  | {
      readonly kind: "package-config";
      readonly packageConfig: HarnessStartupJsonObject;
      readonly changed: boolean;
    };

export interface HarnessStartupAdapterModule<
  Request extends HarnessStartupAdapterRequest = HarnessStartupRequest,
> {
  readonly buildStartupPlan: (request: Request) => HarnessStartupPlan;
  readonly prepareStartupProfile: (
    request: HarnessPrepareStartupProfileRequest,
  ) => HarnessPrepareStartupProfileResult;
  readonly buildInitialStartupProfile: (
    request: HarnessInitialStartupProfileRequest,
  ) => HarnessInitialStartupProfileResult;
  readonly reconcileStartupProfile: (
    request: HarnessReconcileStartupProfileRequest,
  ) => HarnessReconcileStartupProfileResult;
}
