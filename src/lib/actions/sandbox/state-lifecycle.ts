// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  HarnessSnapshotRestoreAction,
  HarnessStateCommandDeclaration,
  HarnessStateLifecycleDeclaration,
} from "@nvidia/nemoclaw-harness-contract";

import type { AgentDefinition } from "../../agent/defs";
import type { RuntimeProviderPrivilegedSandboxCommandResult } from "../../onboard/runtime-provider/contract";
import {
  executePrivilegedSandboxCommand,
  resolvePrivilegedSandboxTarget,
  withPrivilegedSandboxExecutionLease,
} from "../../sandbox/privileged-exec";
import type { HarnessPackageIdentity } from "../../agent-runtime/package/identity";
import { redact } from "../../security/redact";

type ReceiptBackedStateOwner = {
  readonly agent?: string | null;
  readonly harnessPackage?: HarnessPackageIdentity | null;
};

export type BackupQuiescencePlan =
  | { readonly kind: "legacy" }
  | { readonly kind: "not-required" }
  | { readonly kind: "command"; readonly command: readonly string[]; readonly timeoutMs: number }
  | { readonly kind: "unsupported"; readonly reason: string };

export type BackupQuiescenceResult =
  | { readonly kind: "legacy" }
  | { readonly kind: "ready" }
  | { readonly kind: "busy" }
  | { readonly kind: "unverified"; readonly detail: string };

export interface StateLifecycleExecutorDependencies {
  readonly executeCommand: typeof executePrivilegedSandboxCommand;
  readonly resolveTarget: typeof resolvePrivilegedSandboxTarget;
  readonly withExecutionLease: typeof withPrivilegedSandboxExecutionLease;
}

const STATE_LIFECYCLE_MAX_OUTPUT_BYTES = 64 * 1024;
const BACKUP_BUSY_EXIT_STATUS = 75;
const DEFAULT_STATE_LIFECYCLE_EXECUTOR_DEPENDENCIES: StateLifecycleExecutorDependencies = {
  executeCommand: executePrivilegedSandboxCommand,
  resolveTarget: resolvePrivilegedSandboxTarget,
  withExecutionLease: withPrivilegedSandboxExecutionLease,
};

/**
 * Bind one package state declaration to the exact receipt recorded for a sandbox.
 * A no-receipt row is deliberately returned to the named legacy caller.
 */
export function buildBackupQuiescencePlan(
  owner: ReceiptBackedStateOwner,
  agent: AgentDefinition | null,
): BackupQuiescencePlan {
  const receipt = owner.harnessPackage;
  if (!receipt) return Object.freeze({ kind: "legacy" });
  if (
    !agent ||
    agent.name !== receipt.id ||
    (owner.agent !== null && owner.agent !== undefined && owner.agent !== receipt.id)
  ) {
    return Object.freeze({
      kind: "unsupported",
      reason: "the exact package state lifecycle declaration is unavailable",
    });
  }
  const declaration = agent.stateLifecycle.backup_quiescence;
  if (declaration.kind === "not-required") return Object.freeze({ kind: "not-required" });
  return Object.freeze({
    kind: "command",
    command: Object.freeze([...declaration.command]),
    timeoutMs: declaration.timeout_seconds * 1000,
  });
}

function boundedFailureDetail(result: RuntimeProviderPrivilegedSandboxCommandResult): string {
  const source =
    result.error?.message || result.stderr.toString("utf8") || result.stdout.toString("utf8");
  return (
    redact(source)
      .replace(/[\u0000-\u001f\u007f]+/gu, " ")
      .replace(/\s+/gu, " ")
      .trim()
      .slice(0, 800) || `exit ${String(result.status)}`
  );
}

/** Execute only a receipt-backed package's bounded backup quiescence command. */
export function inspectReceiptBackedBackupQuiescence(
  sandboxName: string,
  owner: ReceiptBackedStateOwner,
  agent: AgentDefinition | null,
  dependencyOverrides: Partial<StateLifecycleExecutorDependencies> = {},
): BackupQuiescenceResult {
  const dependencies = {
    ...DEFAULT_STATE_LIFECYCLE_EXECUTOR_DEPENDENCIES,
    ...dependencyOverrides,
  };
  const plan = buildBackupQuiescencePlan(owner, agent);
  if (plan.kind === "legacy") return plan;
  if (plan.kind === "not-required") return Object.freeze({ kind: "ready" });
  if (plan.kind === "unsupported") {
    return Object.freeze({ kind: "unverified", detail: plan.reason });
  }
  let result: RuntimeProviderPrivilegedSandboxCommandResult;
  try {
    result = dependencies.executeCommand(sandboxName, plan.command, {
      sanitizeEnvironment: true,
      timeout: plan.timeoutMs,
      maxOutputBytes: STATE_LIFECYCLE_MAX_OUTPUT_BYTES,
    });
  } catch (error) {
    return Object.freeze({
      kind: "unverified",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
  if (result.status === 0 && result.signal === null && !result.error) {
    return Object.freeze({ kind: "ready" });
  }
  if (result.status === BACKUP_BUSY_EXIT_STATUS && result.signal === null && !result.error) {
    return Object.freeze({ kind: "busy" });
  }
  return Object.freeze({ kind: "unverified", detail: boundedFailureDetail(result) });
}

export type ReceiptBackedStateCommandResult =
  | { readonly kind: "completed" }
  | { readonly kind: "unsupported"; readonly reason: string }
  | { readonly kind: "failed"; readonly detail: string };

/**
 * Execute one fixed state command selected by an exact installed-package
 * receipt. The package owns argv; core owns the runtime identity, resource
 * pin, sanitized environment, deadline, bounded output, and failure detail.
 */
export function executeReceiptBackedStateCommand(
  sandboxName: string,
  owner: ReceiptBackedStateOwner,
  agent: AgentDefinition | null,
  declaration: HarnessStateCommandDeclaration,
  dependencyOverrides: Partial<StateLifecycleExecutorDependencies> = {},
): ReceiptBackedStateCommandResult {
  const dependencies = {
    ...DEFAULT_STATE_LIFECYCLE_EXECUTOR_DEPENDENCIES,
    ...dependencyOverrides,
  };
  const receipt = owner.harnessPackage;
  const managedImage = agent?.managedImage;
  if (
    !receipt ||
    !agent ||
    agent.name !== receipt.id ||
    (owner.agent !== null && owner.agent !== undefined && owner.agent !== receipt.id) ||
    !managedImage
  ) {
    return Object.freeze({
      kind: "unsupported",
      reason: "the exact package state command authority is unavailable",
    });
  }

  try {
    return dependencies.withExecutionLease(
      sandboxName,
      "receipt-backed package state command",
      () => {
        const target = dependencies.resolveTarget(sandboxName);
        const result = dependencies.executeCommand(sandboxName, declaration.command, {
          sanitizeEnvironment: true,
          executionUser: {
            uid: managedImage.runtime_identity.uid,
            gid: managedImage.runtime_identity.gid,
          },
          expectedResourceHandle: target.resourceHandle,
          timeout: declaration.timeout_seconds * 1000,
          maxOutputBytes: STATE_LIFECYCLE_MAX_OUTPUT_BYTES,
        });
        return result.status === 0 && result.signal === null && !result.error
          ? Object.freeze({ kind: "completed" as const })
          : Object.freeze({ kind: "failed" as const, detail: boundedFailureDetail(result) });
      },
    );
  } catch (error) {
    return Object.freeze({
      kind: "failed",
      detail: redact(error instanceof Error ? error.message : String(error)).slice(0, 800),
    });
  }
}

/** Select a snapshot hook only from its receipt-pinned package declaration. */
export function packageRequestsSnapshotRestoreAction(
  declaration: HarnessStateLifecycleDeclaration,
  action: HarnessSnapshotRestoreAction,
): boolean {
  return declaration.snapshot_restore.includes(action);
}
