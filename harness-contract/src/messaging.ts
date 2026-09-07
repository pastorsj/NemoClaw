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

/** One non-secret rendered value that core may inspect for channel status. */
export interface HarnessMessagingConfigVisibility {
  readonly key?: string;
  readonly inputId: string;
  readonly target: string;
  readonly kind: "structured" | "env";
  readonly path?: readonly string[];
  readonly envKey?: string;
  /** Replace this token in target with the matching bounded config input. */
  readonly targetInputId?: string;
  /** Include the read only when the effective config input has this value. */
  readonly whenInput?: {
    readonly inputId: string;
    readonly equals: string;
    readonly defaultValue?: string;
  };
}

export interface HarnessMessagingPolicyEntry {
  readonly presetName: string;
  readonly policyKeys: readonly string[];
  readonly requiredAtCreate?: boolean;
  readonly validationWarningLines?: readonly string[];
}

/** Gateway-owned credential projection selected by one package channel profile. */
export interface HarnessMessagingCredentialProvider {
  /** Package-relative OpenShell provider-profile asset. */
  readonly profilePath: string;
  /** Exact OpenShell provider type declared by the profile asset. */
  readonly profileId: string;
  /** Environment key injected by the OpenShell provider. */
  readonly credentialEnv: string;
  /** Core-owned channel input whose secret material creates or refreshes the provider. */
  readonly sourceInputId: string;
  /** Absence means the source credential is installed directly into an endpointless profile. */
  readonly refresh?: {
    /** Canonical OpenShell profile value; core converts it only for the CLI flag. */
    readonly strategy: "google_service_account_jwt";
    readonly scopes: readonly string[];
    readonly secretMaterialKeys: readonly string[];
  };
}

/** Fixed argv command. Core quotes each argument and owns its execution deadline. */
export interface HarnessMessagingCommand {
  readonly argv: readonly string[];
}

/** WhatsApp status probe selected by package data, not by the package identifier. */
export type HarnessWhatsappStatusProbe =
  | {
      /** Command must emit the bounded channel-status JSON shape consumed by the WhatsApp hook. */
      readonly kind: "channel-status-json";
      readonly command: HarnessMessagingCommand;
      readonly timeoutOption?: string;
      readonly pairingCommand: HarnessMessagingCommand;
    }
  | {
      /** Core checks only file presence and reads one configured session path value. */
      readonly kind: "session-files";
      readonly primaryCredentialPath: string;
      readonly alternateCredentialPath: string;
      readonly primaryLabel: string;
      readonly alternateLabel: string;
      readonly pairingCommand: HarnessMessagingCommand;
      readonly configuredSessionPath?: {
        readonly configPath: string;
        readonly valuePath: readonly string[];
      };
    };

/** One package-owned build file produced from bounded messaging inputs. */
export interface HarnessMessagingBuildFileTemplate {
  readonly id: string;
  readonly required?: boolean;
  /** Safe relative path with optional `{{input:<id>}}` substitutions. */
  readonly pathTemplate: string;
  readonly mode?: string;
  readonly content?: HarnessMessagingValue;
  readonly merge?: HarnessMessagingValue;
}

/**
 * Finite package behavior attached to a core-owned messaging hook.
 *
 * A package can select config fields, run one fixed in-sandbox probe that emits
 * NemoClaw's bounded JSON protocol, or materialize declarative build files. It
 * cannot register an arbitrary host callback.
 */
export type HarnessMessagingHookOperation =
  | {
      readonly hookId: string;
      readonly kind: "config-prompt";
      readonly outputIds: readonly string[];
    }
  | {
      readonly hookId: string;
      readonly kind: "sandbox-command";
      readonly command: HarnessMessagingCommand;
      readonly output: "bridge-health" | "channel-health";
      /** Append NemoClaw's bounded, non-secret channel-health facts as one encoded argument. */
      readonly context?: "channel-health";
    }
  | {
      readonly hookId: string;
      readonly kind: "build-files";
      readonly inputIds: readonly string[];
      readonly outputs: readonly HarnessMessagingBuildFileTemplate[];
    };

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

export interface HarnessMessagingNodePackageInstaller {
  readonly kind: "verified-archive-command";
  /** Fixed argv containing exactly one `{{archive}}` insertion point. */
  readonly command: readonly string[];
  /** Optional fixed prefix applied to the verified archive argv value. */
  readonly archiveArgumentPrefix?: "npm-pack:";
  /** Optional environment variable used to resolve one `{{package.version}}` package-spec token. */
  readonly packageVersionEnvironment?: string;
}

export interface HarnessMessagingPythonPackageInstaller {
  readonly kind: "batched-command";
  /** Fixed argv containing exactly one `{{packages}}` insertion point. */
  readonly command: readonly string[];
  /** Fixed, non-secret environment overrides required by the package manager. */
  readonly environment?: Readonly<Record<string, string>>;
}

export interface HarnessMessagingPackageInstallers {
  readonly "node-package"?: HarnessMessagingNodePackageInstaller;
  readonly "python-package"?: HarnessMessagingPythonPackageInstaller;
}

/** Build behavior selected by a receipt-bound package, never by its package ID. */
export interface HarnessMessagingBuildProfile {
  readonly configRoot: string;
  readonly packageManagers: readonly ("node-package" | "python-package")[];
  /** Finite package-owned installation strategies for each declared manager. */
  readonly packageInstallers?: HarnessMessagingPackageInstallers;
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

/** Integrity-bound data consumed by the generic materialized messaging runtime. */
export interface HarnessMessagingBuildRuntimeProfile {
  readonly packageId: string;
  readonly build: HarnessMessagingBuildProfile;
  /** Profile-relative path to the already validated package channel declarations. */
  readonly channelsPath: string;
}

/** Package-native behavior for one core-owned messaging channel service. */
export interface HarnessMessagingChannelProfile {
  readonly channelId: string;
  /** Optional custom provider boundary; ordinary channel credentials use core's generic profile. */
  readonly credentialProvider?: HarnessMessagingCredentialProvider;
  readonly config: {
    readonly renders: readonly HarnessMessagingConfigRender[];
    readonly visibility: readonly HarnessMessagingConfigVisibility[];
    readonly statePaths?: readonly string[];
  };
  readonly policy: readonly HarnessMessagingPolicyEntry[];
  readonly lifecycle: {
    readonly runtime?: HarnessMessagingRuntimeProfile;
    readonly packageInstalls?: readonly HarnessMessagingPackageInstall[];
    /** Finite host-side status operation used by a selected status hook. */
    readonly statusProbe?: HarnessWhatsappStatusProbe;
    /** Typed, finite behavior for selected hooks; each hook may have at most one operation. */
    readonly hookOperations?: readonly HarnessMessagingHookOperation[];
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
