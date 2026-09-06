// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Messaging capability declarations and their host-side description boundary. */
export type HarnessMessagingCapability =
  | { readonly support: "channels"; readonly channels: readonly string[] }
  | { readonly support: "disabled"; readonly channels?: never };

export interface HarnessMessagingIntegrationRequest {
  readonly packageId: string;
}

export type HarnessMessagingValue =
  | string
  | number
  | boolean
  | null
  | { readonly [key: string]: HarnessMessagingValue }
  | readonly HarnessMessagingValue[];

export type HarnessMessagingConfigRender =
  | {
      readonly id: string;
      readonly kind: "json-fragment";
      readonly target: string;
      readonly when?: string;
      readonly path: string;
      readonly value: HarnessMessagingValue;
    }
  | {
      readonly id: string;
      readonly kind: "env-lines";
      readonly target: string;
      readonly when?: string;
      readonly lines: readonly string[];
    };

export interface HarnessMessagingPolicyEntry {
  readonly presetName: string;
  readonly policyKeys: readonly string[];
  readonly requiredAtCreate?: boolean;
  readonly validationWarningLines?: readonly string[];
}

export interface HarnessMessagingRuntimeProfile {
  readonly channelName?: string;
  readonly visibility?: {
    readonly configKeys: readonly string[];
    readonly logPatterns: readonly string[];
  };
  readonly nodePreloads?: readonly {
    readonly module: string;
    readonly injectInto?: readonly ("boot" | "connect")[];
    readonly optional?: boolean;
    readonly installMessage?: string;
    readonly installedMessage?: string;
  }[];
  readonly envAliases?: readonly {
    readonly envKey: string;
    readonly targetEnvKey?: string;
    readonly match: string;
    readonly value: string;
    readonly message?: string;
  }[];
  readonly secretScans?: readonly {
    readonly path: string;
    readonly pattern: string;
    readonly message?: string;
    readonly exitCode?: number;
  }[];
}

export interface HarnessMessagingPackageInstall {
  readonly id: string;
  /** Finite installation strategy executed and security-checked by NemoClaw. */
  readonly manager: "node-package" | "python-package";
  readonly spec: string;
  readonly pin?: boolean;
  readonly integrity?: string;
  readonly integrityByVersion?: Readonly<Record<string, string>>;
  readonly tarballUrl?: string;
  readonly tarballUrlByVersion?: Readonly<Record<string, string>>;
  readonly runtimeLock?: {
    readonly cachePath: string;
    readonly installCacheEnvKey: string;
    readonly lockFile: string;
    readonly projectsRoot: string;
    readonly verifierPath: string;
    readonly offline: true;
    readonly legacyPeerDeps: true;
  };
  readonly required?: boolean;
}

export type HarnessMessagingRenderFinalizer =
  | "allow-rendered-plugins"
  | "inherit-api-server-toolsets";

/** Build behavior selected by a receipt-bound package, never by its package ID. */
export interface HarnessMessagingBuildProfile {
  readonly configRoot: string;
  readonly packageManagers: readonly ("node-package" | "python-package")[];
  readonly renderFinalizers?: readonly HarnessMessagingRenderFinalizer[];
  /** Fixed package command run after core writes the rendered messaging configuration. */
  readonly postRenderRepair?: { readonly command: readonly string[] };
  readonly nodeArchiveRemediation?: "package-helper";
  /** Core-owned post-create lifecycle selected by package data. */
  readonly postCreateCredentialReconciliation?: "restart-runtime";
  /** Core-owned cross-preset credential reconciliation selected by package data. */
  readonly credentialPolicyReconciliation?: "teams-outlook-shared-login";
  /** Extra bounded diagnostics shown when a messaging bridge is degraded. */
  readonly degradedDiagnostics?: "gateway-log-tail";
}

/** Package-native behavior for one core-owned messaging channel service. */
export interface HarnessMessagingChannelProfile {
  readonly channelId: string;
  readonly config: {
    readonly renders: readonly HarnessMessagingConfigRender[];
    readonly statePaths?: readonly string[];
  };
  readonly policy: readonly HarnessMessagingPolicyEntry[];
  readonly lifecycle: {
    readonly runtime?: HarnessMessagingRuntimeProfile;
    readonly packageInstalls?: readonly HarnessMessagingPackageInstall[];
    /** Selects trusted channel workflow hooks; packages cannot inject callbacks. */
    readonly hookIds: readonly string[];
  };
}

export interface HarnessMessagingSupportedIntegration {
  readonly kind: "channels";
  readonly packageId: string;
  readonly channels: readonly HarnessMessagingChannelProfile[];
  readonly build: HarnessMessagingBuildProfile;
}

export interface HarnessMessagingProfileReference {
  readonly kind: "channels";
  readonly packageId: string;
  readonly channelIds: readonly string[];
  /** Package-relative JSON data file containing the channel profiles. */
  readonly profilePath: string;
  readonly build: HarnessMessagingBuildProfile;
}

export interface HarnessMessagingDisabledIntegration {
  readonly kind: "disabled";
  readonly packageId: string;
  readonly reason: string;
}

export type HarnessMessagingIntegration =
  | HarnessMessagingSupportedIntegration
  | HarnessMessagingDisabledIntegration;

export interface HarnessMessagingAdapterModule {
  readonly describeMessagingIntegration: (
    request: HarnessMessagingIntegrationRequest,
  ) => HarnessMessagingProfileReference | HarnessMessagingDisabledIntegration;
}
