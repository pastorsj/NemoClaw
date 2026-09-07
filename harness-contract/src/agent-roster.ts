// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** A package-owned agent roster implementation selected through a fixed core adapter. */
export interface HarnessAgentRosterCapability {
  readonly support: "managed";
  readonly adapter: "agent-roster";
  /** Existing bounded onboarding transport consumed by the package image build. */
  readonly onboarding_environment: "NEMOCLAW_EXTRA_AGENTS_JSON";
}

export type HarnessAgentRosterOperation = "list" | "add" | "delete";

export type HarnessAgentRosterJsonScalar = string | number | boolean | null;
export type HarnessAgentRosterJsonValue =
  | HarnessAgentRosterJsonScalar
  | HarnessAgentRosterJsonObject
  | readonly HarnessAgentRosterJsonValue[];
export interface HarnessAgentRosterJsonObject {
  readonly [key: string]: HarnessAgentRosterJsonValue;
}

/** Native pass-through request for one of core's fixed roster operations. */
export interface HarnessAgentRosterCommandRequest {
  readonly operation: HarnessAgentRosterOperation;
  readonly arguments: readonly string[];
}

export type HarnessAgentRosterCommandPlan =
  | { readonly kind: "stream"; readonly command: readonly string[] }
  | { readonly kind: "unsupported"; readonly reason: string };

export interface HarnessAgentRosterInspectionRequest {
  readonly manifest: HarnessAgentRosterJsonObject;
}

export type HarnessAgentRosterInspectionPlan =
  | { readonly kind: "capture"; readonly command: readonly string[] }
  | { readonly kind: "refused"; readonly reason: string };

export interface HarnessAgentRosterApplyRequest {
  readonly manifest: HarnessAgentRosterJsonObject;
  /** Bounded stdout from the package's inspection command. */
  readonly current_output: string;
}

export interface HarnessAgentRosterMutation {
  readonly agent_id: string;
  readonly command: readonly string[];
}

export interface HarnessAgentRosterNotice {
  readonly message: string;
}

export type HarnessAgentRosterApplyPlan =
  | { readonly kind: "refused"; readonly reason: string }
  | {
      readonly kind: "ready";
      readonly current_count: number;
      readonly additions: readonly HarnessAgentRosterMutation[];
      readonly deletions: readonly HarnessAgentRosterMutation[];
      readonly rebuild_only_fields: readonly string[];
      readonly notices: readonly HarnessAgentRosterNotice[];
    };

/** Fixed exports implemented by `host/agent-roster-adapter.cts`. */
export interface HarnessAgentRosterAdapterModule {
  readonly buildAgentRosterCommand: (
    request: HarnessAgentRosterCommandRequest,
  ) => HarnessAgentRosterCommandPlan;
  readonly buildAgentRosterInspection: (
    request: HarnessAgentRosterInspectionRequest,
  ) => HarnessAgentRosterInspectionPlan;
  readonly buildAgentRosterApplyPlan: (
    request: HarnessAgentRosterApplyRequest,
  ) => HarnessAgentRosterApplyPlan;
}
