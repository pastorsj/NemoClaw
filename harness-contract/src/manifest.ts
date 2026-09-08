// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  HarnessInferenceConfigDeclaration,
  HarnessInferenceContextWindowRequirement,
} from "./config.js";
import type {
  HarnessDevicePairingSettlementDeclaration,
  HarnessGatewayRuntimeCommandDeclaration,
  HarnessRuntimeCommandDeclaration,
  HarnessSessionQualificationDeclaration,
  HarnessTerminalRuntimeCommandDeclaration,
} from "./command.js";
import type { HarnessMcpCapability } from "./mcp.js";
import type { HarnessAgentRosterCapability } from "./agent-roster.js";
import type { HarnessMessagingCapability } from "./messaging.js";
import type { HarnessSessionCapability } from "./session.js";
import type { HarnessStateLifecycleDeclaration } from "./state.js";
import type { HarnessProviderBrokerCapability } from "./provider-broker.js";
import type { HarnessProviderAuthCapability } from "./provider-auth.js";
import type { HarnessToolGatewayCapability } from "./tool-gateway.js";
import type { HarnessPolicyCapability } from "./policy.js";

/** Package identity, declared capabilities, and managed-image requirements. */
export interface HarnessPackageEnvelope {
  readonly schemaVersion: 1;
  readonly kind: "agent-runtime";
  readonly id: string;
  readonly displayName: string;
  readonly packageVersion: string;
  readonly minimumNemoClawVersion: string;
  readonly maximumNemoClawVersionExclusive: string;
  readonly manifest: string;
}

export type HarnessManifestScalar = string | number | boolean | null | Date;
export type HarnessManifestValue =
  | HarnessManifestScalar
  | HarnessManifestRecord
  | readonly HarnessManifestValue[];
export type HarnessManifestRecord = { [key: string]: HarnessManifestValue };

export interface HarnessOnboardingDeclaration {
  readonly default?: boolean;
  readonly sandbox_name?: string;
}

export type HarnessSandboxDriver = "docker" | "podman";

/** Operator controls that core can project into the package-owned startup profile. */
export type HarnessSandboxStartupControl = "approval-mode" | "observability";

/** One Docker process limit required by every process in the package's managed image. */
export interface HarnessSandboxDockerUlimitDeclaration {
  readonly name: string;
  readonly soft: number;
  readonly hard: number;
}

/** One bounded tmpfs mount that a package needs when OpenShell creates its sandbox. */
export interface HarnessSandboxTmpfsMountDeclaration {
  readonly type: "tmpfs";
  readonly drivers: readonly HarnessSandboxDriver[];
  readonly target: `/run/${string}`;
  readonly options: readonly "noexec"[];
  readonly size_bytes: number;
  readonly mode: number;
}

/** Package-owned requirements for the core-owned sandbox-create operation. */
export interface HarnessSandboxCreateDeclaration {
  readonly generated_image_build?: "local-buildkit-required";
  readonly driver_mounts?: readonly HarnessSandboxTmpfsMountDeclaration[];
  readonly startup_controls?: readonly HarnessSandboxStartupControl[];
  readonly docker_ulimits?: readonly HarnessSandboxDockerUlimitDeclaration[];
}

export type HarnessWebSearchProvider = "brave" | "tavily";

export interface HarnessWebSearchToolGatewayConflict {
  readonly provider: HarnessWebSearchProvider;
  readonly tool_gateway: string;
}

export interface HarnessWebSearchConfigAssertion {
  readonly path: readonly string[];
  readonly equals: string | boolean;
}

/** Package-native config evidence that core reads without knowing the harness schema. */
export interface HarnessWebSearchConfigVerification {
  readonly path: `/sandbox/${string}`;
  readonly format: "json" | "yaml";
  readonly assertions: readonly HarnessWebSearchConfigAssertion[];
  /** First present string is used as the egress credential placeholder. Empty means derive it. */
  readonly credential_paths: readonly (readonly string[])[];
}

export interface HarnessWebSearchRequestParameter {
  readonly name: string;
  readonly value: string | number;
}

export type HarnessWebSearchCredentialPlacement =
  | {
      readonly kind: "header";
      readonly name: string;
      readonly prefix: "none" | "bearer";
    }
  | {
      readonly kind: "json-body";
      readonly name: string;
    };

/** One finite HTTPS request whose response proves the selected search provider is usable. */
export interface HarnessWebSearchEgressVerification {
  readonly method: "GET" | "POST";
  readonly url: `https://${string}`;
  readonly parameters: readonly HarnessWebSearchRequestParameter[];
  readonly credential: HarnessWebSearchCredentialPlacement;
  readonly result_array_path: readonly string[];
}

export interface HarnessWebSearchProviderBinding {
  readonly provider: HarnessWebSearchProvider;
  readonly credential_env: string;
  readonly profile_type: string;
  readonly config_verification: HarnessWebSearchConfigVerification;
  readonly egress_verification: HarnessWebSearchEgressVerification;
}

/** Web-search bindings and tool-gateway conflicts declared by one package. */
export type HarnessWebSearchCapability =
  | {
      readonly support: "providers";
      readonly providers: readonly HarnessWebSearchProviderBinding[];
      readonly tool_gateway_conflicts?: readonly HarnessWebSearchToolGatewayConflict[];
      readonly reason?: never;
    }
  | {
      readonly support: "disabled";
      readonly reason: string;
      readonly providers?: never;
      readonly tool_gateway_conflicts?: never;
    };

export interface HarnessPackageRegistryDeclaration {
  /** Informational egress inventory only; core never installs or authorizes from this list. */
  readonly hosts: readonly string[];
  /** Package-manager executable used by the package itself, not a NemoClaw install command. */
  readonly binary: string;
}

export interface HarnessSecondaryForwardAllocationDeclaration {
  /** Non-secret environment value that receives the selected port inside the sandbox. */
  readonly environment_variable: string;
  /** First port selected when it is available. This must match the declared health-probe port. */
  readonly preferred_port: number;
  readonly range_start: number;
  readonly range_end: number;
  /** Short package-owned resource name used in allocation diagnostics. */
  readonly label: string;
  /** Bounded package-owned recovery guidance used when the allocation range is exhausted. */
  readonly remedy: string;
}

interface HarnessHealthProbeBaseDeclaration {
  readonly url: string;
  readonly port: number;
  readonly timeout_seconds: number;
  /** Exact HTTP statuses that prove this package's gateway is alive. Defaults to 200. */
  readonly success_statuses?: readonly number[];
}

/**
 * A health probe either uses its fixed manifest port or owns one bounded secondary-forward
 * allocation. Keeping the allocation beside the probe lets core allocate, persist, and recover
 * the port without learning the harness identity.
 */
export type HarnessHealthProbeDeclaration = HarnessHealthProbeBaseDeclaration &
  (
    | {
        readonly port_resolution: "sandbox-secondary-forward";
        readonly secondary_forward: HarnessSecondaryForwardAllocationDeclaration;
      }
    | {
        readonly port_resolution?: never;
        readonly secondary_forward?: never;
      }
  );

export interface HarnessDashboardDeclaration {
  readonly kind?: "ui" | "api";
  readonly label?: string;
  readonly path?: string;
  readonly health_path?: string;
  readonly auth?: "url_token" | "session" | "none";
  readonly token_path?: string;
  /** Config-object path that receives browser origins created by `nemoclaw tunnel`. */
  readonly tunnel_allowed_origins_path?: string;
}

export interface HarnessConfigDeclaration {
  readonly dir: string;
  readonly config_file: string;
  readonly env_file?: string;
  readonly auth_file?: string;
  readonly mutable_access?: "private";
  readonly shields_files?: readonly string[];
  readonly format: string;
}

export type HarnessStateDirectoryDeclaration =
  | string
  | {
      readonly path: string;
      readonly prefix?: never;
      readonly backup?: boolean;
    }
  | {
      readonly path?: never;
      readonly prefix: string;
      readonly backup?: boolean;
    };

export interface HarnessStateFileUserKey {
  readonly key: string;
  readonly type: "boolean" | "string" | "integer" | "number" | "enum";
  readonly values?: readonly (string | number | boolean)[];
  readonly min?: number;
  readonly max?: number;
  readonly max_length?: number;
}

export type HarnessStateFileFreshHeader =
  | string
  | { readonly match?: "exact" | "prefix"; readonly value: string };

export type HarnessStateFileRestoreDeclaration =
  | {
      readonly merge: "package-config";
      readonly user_keys?: never;
      readonly require_fresh_tables?: never;
      readonly require_fresh_headers?: never;
    }
  | {
      readonly merge: "key-allowlist";
      readonly user_keys: readonly HarnessStateFileUserKey[];
      readonly require_fresh_tables?: readonly string[];
      readonly require_fresh_headers?: readonly HarnessStateFileFreshHeader[];
    };

export interface HarnessStateFileDeclaration {
  readonly path: string;
  readonly strategy?: "copy" | "sqlite_backup";
  readonly backup?: { readonly fallback: "privileged-copy" };
  readonly restore?: HarnessStateFileRestoreDeclaration;
}

export interface HarnessDashboardUiDeclaration {
  /** Operator-facing name used in forward and recovery diagnostics. */
  readonly label?: string;
  /** Browser path appended to the forwarded loopback origin. */
  readonly path?: `/${string}`;
  /** Default public port before core allocates the sandbox's effective dashboard port. */
  readonly port: number;
  /** Package-owned opt-in environment value. */
  readonly enable_env: string;
  /** Package-owned compatibility alias for the selected public port. */
  readonly port_env: string;
  /** Private in-sandbox listener used behind the public forward. */
  readonly internal_port: number;
  /** Package-owned environment value that receives the private listener port. */
  readonly internal_port_env: string;
  /** Optional package-owned environment value that enables a native terminal UI. */
  readonly tui_env?: string;
}

export type HarnessSkillActivation =
  | { readonly kind: "new-session"; readonly path?: never }
  | { readonly kind: "gateway-restart-required"; readonly path?: never }
  | { readonly kind: "reset-session-index"; readonly path: `/sandbox/${string}` };

/** Native agent argv appended to the manifest's absolute binary path. */
export type HarnessSkillCommand = readonly string[];

export type HarnessSkillCapability =
  | {
      readonly support: "managed";
      /** Canonical package-owned root used by the bounded filesystem fallback. */
      readonly install_root: `/sandbox/${string}`;
      readonly mirror_root?: `$HOME/${string}`;
      readonly collision: "replace" | "refuse";
      readonly removal: "remove" | "refuse";
      readonly activation: HarnessSkillActivation;
      /** Native discovery command. It must not contain replacement tokens. */
      readonly list_command: HarnessSkillCommand;
      /** Optional native add command containing exactly one `{source}` argument. */
      readonly add_command?: HarnessSkillCommand;
      /** Optional native remove command containing exactly one `{name}` argument. */
      readonly remove_command?: HarnessSkillCommand;
      readonly reason?: never;
    }
  | {
      readonly support: "disabled";
      readonly reason: string;
      readonly install_root?: never;
      readonly mirror_root?: never;
      readonly collision?: never;
      readonly removal?: never;
      readonly activation?: never;
      readonly list_command?: never;
      readonly add_command?: never;
      readonly remove_command?: never;
    };

export type HarnessManagedImagePlatform = "linux/amd64" | "linux/arm64";

export interface HarnessManagedImageRuntimeIdentity {
  readonly uid: number;
  readonly gid: number;
  readonly workdir: "/sandbox";
}

export interface HarnessManagedImageWorkspace {
  /** Select either the sandbox runtime UID or root for the shared workspace directory. */
  readonly owner: "runtime" | "root";
  readonly mode: "0755" | "1775";
}

export interface HarnessManagedImageStateRoot {
  /** One package-owned state volume mounted directly below /sandbox. */
  readonly mount_target: `/sandbox/${string}`;
  readonly mode: "0770" | "2770" | "3770";
}

/** One immutable base reference that the final package Dockerfile must declare. */
export interface HarnessManagedBaseImagePin {
  /** The contract currently permits only Docker's conventional base-image argument. */
  readonly argument: "BASE_IMAGE";
  readonly ref: `${string}@sha256:${string}`;
}

/**
 * Finite base-image behavior selected by package data rather than package identity.
 *
 * A package probe, when enabled, always lives at `checks/image-probe.py` in the
 * package and `/usr/local/lib/nemoclaw/checks/image-probe.py` in the image. Its
 * output is bound to the package file digest; manifests cannot provide commands
 * or executable paths.
 */
export interface HarnessManagedBaseImageDeclaration {
  readonly corporate_ca?: boolean;
  readonly security_inventory?: boolean;
  readonly package_probe?: boolean;
  readonly pinned_remote?: HarnessManagedBaseImagePin;
}

/** Immutable image digests published by the exact package source revision. */
export interface HarnessManagedImagePublicationDeclaration {
  readonly source: {
    /** Bounded source repository identity in owner/name form. */
    readonly repository: string;
    readonly revision: string;
    readonly release: string;
    readonly cohort: string;
  };
  /** Runtime validation requires these keys to exactly match architectures. */
  readonly digests: Readonly<Partial<Record<HarnessManagedImagePlatform, `sha256:${string}`>>>;
}

/** One non-secret process input a receipt-pinned package may read while preparing startup state. */
export interface HarnessStartupEnvironmentInputDeclaration {
  readonly name: string;
  readonly value_type: "string" | "positive-integer";
  readonly max_bytes: number;
}

/**
 * Harness-native image requirements declared by a package. Composition may
 * point at a receipt-bound immutable publication, but does not authenticate an
 * external publisher or establish product support.
 */
export interface HarnessManagedImageDeclaration {
  readonly repository: string;
  readonly architectures: readonly HarnessManagedImagePlatform[];
  readonly runtime_identity: HarnessManagedImageRuntimeIdentity;
  /** Optional base-build and validation requirements. Omission is neutral. */
  readonly base_image?: HarnessManagedBaseImageDeclaration;
  /** Defaults to runtime ownership and mode 0755 when omitted. */
  readonly workspace?: HarnessManagedImageWorkspace;
  /** Omit when the harness keeps its state in the shared workspace filesystem. */
  readonly state_root?: HarnessManagedImageStateRoot;
  /** Optional, bounded non-secret compatibility inputs projected to the startup adapter. */
  readonly startup_profile_environment?: readonly HarnessStartupEnvironmentInputDeclaration[];
  /** How rebuild resolves a base beneath the package-owned Dockerfile. Defaults to resolve. */
  readonly rebuild_base_image?: "not-required" | "resolve" | "pinned-remote";
  /** Optional receipt-bound publication used without NemoClaw's stock image catalogue. */
  readonly publication?: HarnessManagedImagePublicationDeclaration;
}

export interface HarnessInferenceManifest {
  readonly config_update: HarnessInferenceConfigDeclaration;
  /** Requirements applied by core-owned local inference runtimes during package onboarding. */
  readonly context_window_requirements?: readonly HarnessInferenceContextWindowRequirement[];
  readonly provider_type?: string;
  readonly provider_options?: readonly string[];
  readonly default_model?: string;
  readonly base_url_config_key?: string;
  readonly model_config_key?: string;
  readonly proxy_support?: "implicit" | "explicit";
  /** Enables the core-owned compatibility bridge from NEMOCLAW_PROVIDER_KEY to hosted inference. */
  readonly provider_key_credential_alias?: "hosted-inference";
  /** Gateway providers whose route must be refreshed when messaging is active. */
  readonly refresh_route_for_messaging_providers?: readonly string[];
  /** Selects a core-owned sandbox proof without identifying the package. */
  readonly sandbox_smoke?: {
    readonly kind: "compatible-endpoint";
    readonly config_path: `/sandbox/${string}`;
  };
  /** Finite core-owned route checks required by this harness. */
  readonly route_probe?: {
    readonly terminal_connect?: "required";
    /** Require one inference request from the retained sandbox before rebuild mutates it. */
    readonly rebuild_preflight?: "inference-invocation";
    readonly models_404?: "inference-invocation";
  };
}

/**
 * Complete data-only package declaration accepted by the public authoring contract.
 *
 * This intentionally has no string index signature. A package author gets editor and compiler
 * feedback for misspelled or invented fields instead of silently widening the contract. Runtime
 * validation remains authoritative for untyped YAML input.
 */
interface HarnessAgentManifestFields {
  readonly name: string;
  readonly display_name?: string;
  readonly description?: string;
  readonly aliases?: readonly string[];
  readonly alias_summary?: string;
  readonly onboarding?: HarnessOnboardingDeclaration;
  /** Package-owned upstream compatibility metadata; exact runtime qualification uses expected_version. */
  readonly version_constraint?: string;
  readonly language?: string;
  readonly license?: string;
  readonly homepage?: string;
  readonly install_method?: string;
  readonly binary_path?: string;
  readonly version_command?: string;
  readonly expected_version?: string;
  readonly version_scheme?: "semver" | "calendar";
  /** Non-authoritative package-manager inventory; it is neither discovery nor an egress grant. */
  readonly package_registry?: HarnessPackageRegistryDeclaration;
  readonly sandbox_create?: HarnessSandboxCreateDeclaration;
  readonly dashboard?: HarnessDashboardDeclaration;
  readonly dashboard_ui?: HarnessDashboardUiDeclaration;
  readonly forward_ports?: readonly number[];
  readonly config: HarnessConfigDeclaration;
  readonly inference: HarnessInferenceManifest;
  readonly mcp?: HarnessMcpCapability;
  readonly agent_roster?: HarnessAgentRosterCapability;
  readonly messaging: HarnessMessagingCapability;
  readonly provider_broker?: HarnessProviderBrokerCapability;
  readonly provider_auth?: HarnessProviderAuthCapability;
  readonly tool_gateways?: HarnessToolGatewayCapability;
  /** Explicit package policy surface. Empty arrays and records declare that no additions apply. */
  readonly policy: HarnessPolicyCapability;
  readonly web_search?: HarnessWebSearchCapability;
  readonly sessions?: HarnessSessionCapability;
  readonly skills?: HarnessSkillCapability;
  readonly state_lifecycle: HarnessStateLifecycleDeclaration;
  readonly state_dirs?: readonly HarnessStateDirectoryDeclaration[];
  readonly state_files?: readonly (string | HarnessStateFileDeclaration)[];
  readonly user_managed_files?: readonly string[];
  readonly managed_image?: HarnessManagedImageDeclaration;
  /** Informational upstream-host inventory; policy files remain the egress authority. */
  readonly phone_home_hosts?: readonly string[];
  readonly web_auth_method?: "device_pairing" | "bearer_token" | "none";
  readonly web_auth_env?: string;
}

type HarnessDevicePairingManifestDeclaration =
  | {
      readonly device_pairing: true;
      readonly runtime: HarnessGatewayRuntimeCommandDeclaration & {
        readonly device_pairing_settlement: HarnessDevicePairingSettlementDeclaration;
        readonly session_qualification: HarnessSessionQualificationDeclaration;
      };
    }
  | {
      readonly device_pairing?: false;
      readonly runtime: HarnessRuntimeCommandDeclaration & {
        readonly device_pairing_settlement?: never;
        readonly session_qualification?: never;
      };
    };

type HarnessRuntimeManifestDeclaration =
  | {
      readonly runtime: HarnessGatewayRuntimeCommandDeclaration;
      readonly gateway_command: string;
      readonly health_probe: HarnessHealthProbeDeclaration;
    }
  | {
      readonly runtime: HarnessTerminalRuntimeCommandDeclaration;
      readonly gateway_command?: never;
      readonly health_probe?: never;
    };

export type HarnessAgentManifest = HarnessAgentManifestFields &
  HarnessDevicePairingManifestDeclaration &
  HarnessRuntimeManifestDeclaration;
