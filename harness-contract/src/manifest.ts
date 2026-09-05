// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { HarnessInferenceConfigDeclaration } from "./config.js";
import type { HarnessMcpCapability } from "./mcp.js";
import type { HarnessMessagingCapability } from "./messaging.js";
import type { HarnessSessionCapability } from "./session.js";

/** Package identity, declared capabilities, and managed-image requirements. */
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

export type HarnessSkillActivation =
  | { readonly kind: "new-session"; readonly path?: never }
  | { readonly kind: "gateway-restart-required"; readonly path?: never }
  | { readonly kind: "reset-session-index"; readonly path: `/sandbox/${string}` };

export type HarnessSkillCapability =
  | {
      readonly support: "managed";
      readonly install_root: `/sandbox/${string}`;
      readonly mirror_root?: `$HOME/${string}`;
      readonly collision: "replace" | "refuse";
      readonly removal: "remove" | "refuse";
      readonly activation: HarnessSkillActivation;
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

/** One non-secret process input a receipt-pinned package may read while preparing startup state. */
export interface HarnessStartupEnvironmentInputDeclaration {
  readonly name: string;
  readonly value_type: "string" | "positive-integer";
  readonly max_bytes: number;
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
  /** Defaults to runtime ownership and mode 0755 when omitted. */
  readonly workspace?: HarnessManagedImageWorkspace;
  /** Omit when the harness keeps its state in the shared workspace filesystem. */
  readonly state_root?: HarnessManagedImageStateRoot;
  /** Optional, bounded non-secret compatibility inputs projected to the startup adapter. */
  readonly startup_profile_environment?: readonly HarnessStartupEnvironmentInputDeclaration[];
  readonly startup_profile_contract_version: 1;
  readonly capability_contract_version: 1;
}

export type HarnessInferenceManifest = HarnessManifestRecord & {
  readonly config_update: HarnessInferenceConfigDeclaration;
};

export type HarnessAgentManifest = HarnessManifestRecord & {
  readonly name: string;
  readonly display_name?: string;
  readonly description?: string;
  readonly aliases?: string[];
  readonly onboarding?: HarnessManifestRecord;
  readonly runtime?: HarnessManifestRecord;
  readonly config?: HarnessManifestRecord;
  readonly inference?: HarnessInferenceManifest;
  readonly mcp?: HarnessMcpCapability;
  readonly messaging: HarnessMessagingCapability;
  readonly sessions?: HarnessSessionCapability;
  readonly skills: HarnessSkillCapability;
  readonly managed_image?: HarnessManagedImageDeclaration;
};
