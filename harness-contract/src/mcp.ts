// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** MCP capabilities, finite execution plans, and package adapter operations. */
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

export interface HarnessMcpRuntimePlan {
  readonly command: readonly string[];
  readonly environmentVariablesToRemove: readonly string[];
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
  readonly buildMcpRuntimePlan: (request: HarnessMcpRuntimeRequest) => HarnessMcpRuntimePlan;
  readonly buildMcpSnapshotRestorePlan: (
    request: HarnessMcpSnapshotRestoreRequest,
  ) => HarnessMcpSnapshotRestorePlan;
}
