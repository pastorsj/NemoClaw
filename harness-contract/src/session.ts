// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Session discovery, mutation, export, and output interpretation. */
export type HarnessSessionOperation = "list" | "delete" | "reset" | "export";

export interface HarnessSessionCapability {
  readonly operations: readonly HarnessSessionOperation[];
}

export interface HarnessSessionListPlanRequest {
  /** Arguments after the public session-list command. */
  readonly arguments: readonly string[];
  /** Preserve the legacy parent-command shorthand when the native CLI supports it. */
  readonly useListSubcommand: boolean;
}

export type HarnessSessionListPlan =
  | { readonly kind: "unsupported"; readonly reason: string }
  | { readonly kind: "stream"; readonly command: readonly string[] }
  | { readonly kind: "capture"; readonly command: readonly string[] };

export interface HarnessSessionListOutputRequest {
  readonly output: string;
  readonly jsonOutput: boolean;
  readonly hiddenSessionIdPrefix: string;
}

export type HarnessSessionListOutput =
  | { readonly kind: "output"; readonly output: string }
  | { readonly kind: "refused"; readonly reason: string };

export type HarnessSessionJsonScalar = string | number | boolean | null;
export type HarnessSessionJsonValue =
  | HarnessSessionJsonScalar
  | HarnessSessionJsonObject
  | readonly HarnessSessionJsonValue[];
export interface HarnessSessionJsonObject {
  readonly [key: string]: HarnessSessionJsonValue;
}

export interface HarnessSessionDeletePlanRequest {
  readonly operation: "delete";
  readonly key: string;
  readonly agent: string | null;
  readonly keepTranscript: boolean;
  readonly jsonOutput: boolean;
  readonly verboseOutput: boolean;
}

export interface HarnessSessionResetPlanRequest {
  readonly operation: "reset";
  readonly key: string;
  readonly agent: string | null;
  readonly reason: "reset" | "new";
  readonly jsonOutput: boolean;
  readonly verboseOutput: boolean;
}

export type HarnessSessionMutationPlanRequest =
  | HarnessSessionDeletePlanRequest
  | HarnessSessionResetPlanRequest;

export interface HarnessSessionAdminRpcPlan {
  readonly kind: "admin-rpc";
  readonly method: "sessions.delete" | "sessions.reset";
  readonly params: HarnessSessionJsonObject;
}

export type HarnessSessionMutationPlan =
  | { readonly kind: "unsupported"; readonly reason: string }
  | { readonly kind: "refused"; readonly reason: string }
  | { readonly kind: "stream"; readonly command: readonly string[] }
  | HarnessSessionAdminRpcPlan;

export interface HarnessSessionMutationOutputRequest {
  readonly request: HarnessSessionMutationPlanRequest;
  readonly plan: HarnessSessionAdminRpcPlan;
  readonly payload: HarnessSessionJsonObject;
}

export type HarnessSessionMutationOutput =
  | { readonly kind: "refused"; readonly reason: string }
  | {
      readonly kind: "completed";
      readonly operation: "delete";
      readonly key: string;
      readonly removedTranscript: boolean;
      readonly entry: HarnessSessionJsonValue;
    }
  | {
      readonly kind: "completed";
      readonly operation: "reset";
      readonly key: string;
      readonly reason: "reset" | "new";
      readonly entry: HarnessSessionJsonValue;
    };

export interface HarnessSessionExportPlanRequest {
  readonly agent: string | null;
  readonly keys: readonly string[];
  readonly format: "dir" | "tar";
  readonly includeTrajectory: boolean;
  /** Core-generated, sandbox-contained destinations; packages may only select one. */
  readonly stagingFiles: {
    readonly tar: string;
    readonly jsonl: string;
  };
}

export type HarnessSessionExportPlan =
  | { readonly kind: "unsupported"; readonly reason: string }
  | { readonly kind: "refused"; readonly reason: string }
  | {
      readonly kind: "indexed-files";
      readonly agent: string;
      readonly format: "dir" | "tar";
      readonly selectedKeys: readonly string[] | "all";
      readonly sourceDirectory: string;
      readonly indexCommand: readonly string[];
    }
  | {
      readonly kind: "native-file";
      readonly agent: string;
      readonly format: "jsonl";
      readonly selectedKeys: "all";
      readonly remoteFile: string;
      readonly command: readonly string[];
      readonly allowEmpty: boolean;
    };

export interface HarnessSessionExportIndexRequest {
  readonly output: string;
  readonly agent: string;
  readonly selectedKeys: readonly string[] | "all";
  readonly includeTrajectory: boolean;
  readonly hiddenSessionIdPrefix: string;
}

export type HarnessSessionExportIndexOutput =
  | { readonly kind: "refused"; readonly reason: string }
  | {
      readonly kind: "selection";
      readonly sessions: readonly { readonly key: string; readonly sessionId: string }[];
      readonly relativeFiles: readonly string[];
    };

export interface HarnessSessionAdapterModule {
  readonly buildSessionListPlan: (request: HarnessSessionListPlanRequest) => HarnessSessionListPlan;
  readonly interpretSessionListOutput: (
    request: HarnessSessionListOutputRequest,
  ) => HarnessSessionListOutput;
  readonly buildSessionMutationPlan: (
    request: HarnessSessionMutationPlanRequest,
  ) => HarnessSessionMutationPlan;
  readonly interpretSessionMutationOutput: (
    request: HarnessSessionMutationOutputRequest,
  ) => HarnessSessionMutationOutput;
  readonly buildSessionExportPlan: (
    request: HarnessSessionExportPlanRequest,
  ) => HarnessSessionExportPlan;
  readonly interpretSessionExportIndex: (
    request: HarnessSessionExportIndexRequest,
  ) => HarnessSessionExportIndexOutput;
}
