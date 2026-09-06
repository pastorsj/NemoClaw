// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { CLI_NAME } from "../cli/branding";
import type { HarnessInferenceConfigPostCommit } from "../agent-runtime/config-module";
import type { HarnessPackageIdentity } from "../agent-runtime/package/types";
import type { OperationalAuditEntry } from "../state/audit/operational";
import { InferenceSetError } from "./inference-set-error";
import type { GatewayRestartResult } from "./sandbox/gateway-restart";

export interface InferenceGatewayRestartDeps {
  appendAuditEntry: (entry: OperationalAuditEntry) => void;
  log: (message: string) => void;
  restartSandboxGateway: (sandboxName: string) => GatewayRestartResult;
  reconcilePackageSandbox: (
    sandboxName: string,
    identity: HarnessPackageIdentity,
    declaration: Extract<
      HarnessInferenceConfigPostCommit["sandboxReconcile"],
      { readonly kind: "command" }
    >,
  ) => void;
}

interface InferenceResultForGateway {
  sandboxName: string;
  provider: string;
  model: string;
  primaryModelRef: string;
  inSandboxConfigSynced: boolean;
}

export interface InferenceMutation<T extends InferenceResultForGateway> {
  result: T;
  gatewayRestartRequired: boolean;
  completionDeferred: boolean;
  sandboxReconcile:
    | { readonly state: "not-required" }
    | {
        readonly state: "required";
        readonly identity: HarnessPackageIdentity;
        readonly declaration: Extract<
          HarnessInferenceConfigPostCommit["sandboxReconcile"],
          { readonly kind: "command" }
        >;
      };
}

export function defaultInferenceGatewayRestart(sandboxName: string): GatewayRestartResult {
  const recovery: typeof import("./sandbox/process-recovery") = require("./sandbox/process-recovery");
  return recovery.restartSandboxGateway(sandboxName, { quiet: true });
}

function appendPostCommitInferenceAudit(
  deps: Pick<InferenceGatewayRestartDeps, "appendAuditEntry" | "log">,
  entry: OperationalAuditEntry,
): void {
  try {
    deps.appendAuditEntry(entry);
  } catch {
    // Config and possibly the running gateway are already committed. Audit
    // persistence is best-effort here so it cannot hide the real restart
    // outcome or the operator recovery command.
    deps.log(
      `  Warning: could not record the post-commit inference audit entry for '${entry.sandbox}'.`,
    );
  }
}

export function finalizeInferenceMutation<T extends InferenceResultForGateway>(
  options: {
    agentName: string;
    additionalPostCommitRequired?: boolean;
    configChanged: boolean;
    nextApi: string;
    packageIdentity: HarnessPackageIdentity | null;
    postCommit: HarnessInferenceConfigPostCommit;
    result: T;
  },
  deps: Pick<InferenceGatewayRestartDeps, "appendAuditEntry" | "log">,
): InferenceMutation<T> {
  const {
    additionalPostCommitRequired = false,
    agentName,
    configChanged,
    nextApi,
    packageIdentity,
    postCommit,
    result,
  } = options;
  const gatewayRestartRequired =
    postCommit.gatewayRestart.kind === "when-api-changes" &&
    configChanged &&
    result.inSandboxConfigSynced &&
    postCommit.gatewayRestart.previousApi !== null &&
    postCommit.gatewayRestart.previousApi !== nextApi;
  const sandboxReconcileRequired =
    postCommit.sandboxReconcile.kind === "command" &&
    result.inSandboxConfigSynced &&
    (postCommit.sandboxReconcile.trigger === "after-config-sync" || configChanged);
  if (sandboxReconcileRequired && !packageIdentity) {
    throw new InferenceSetError(
      `Inference config was synchronized for '${result.sandboxName}', but its package reconciliation authority is unavailable. ` +
        `Run '${CLI_NAME} ${result.sandboxName} rebuild' to restore package authority.`,
    );
  }

  const auditEntry: OperationalAuditEntry = {
    action: "inference_set",
    sandbox: result.sandboxName,
    timestamp: new Date().toISOString(),
    reason: `inference set ${agentName}:${result.provider}:${result.model}${
      !result.inSandboxConfigSynced
        ? " (in-sandbox sync incomplete)"
        : gatewayRestartRequired && sandboxReconcileRequired
          ? " (gateway restart and package reconciliation pending)"
          : gatewayRestartRequired
            ? " (gateway restart pending)"
            : sandboxReconcileRequired
              ? " (package reconciliation pending)"
              : additionalPostCommitRequired
                ? " (additional reconciliation pending)"
                : ""
    }`,
  };
  if (gatewayRestartRequired || sandboxReconcileRequired || additionalPostCommitRequired) {
    appendPostCommitInferenceAudit(deps, auditEntry);
  } else {
    deps.appendAuditEntry(auditEntry);
  }

  if (
    result.inSandboxConfigSynced &&
    !gatewayRestartRequired &&
    !sandboxReconcileRequired &&
    !additionalPostCommitRequired
  ) {
    deps.log(`  Inference route synced for '${result.sandboxName}': ${result.primaryModelRef}`);
  }

  return {
    result,
    gatewayRestartRequired,
    completionDeferred: additionalPostCommitRequired,
    sandboxReconcile:
      sandboxReconcileRequired && packageIdentity && postCommit.sandboxReconcile.kind === "command"
        ? {
            state: "required",
            identity: packageIdentity,
            declaration: postCommit.sandboxReconcile,
          }
        : { state: "not-required" },
  };
}

export function completeInferencePostCommit<T extends InferenceResultForGateway>(
  mutation: InferenceMutation<T>,
  deps: InferenceGatewayRestartDeps,
): void {
  const { result } = mutation;
  if (mutation.gatewayRestartRequired) {
    deps.log(
      `  Restarting the managed gateway in '${result.sandboxName}' to apply the new inference API family...`,
    );
    let restartFailure: string | null = null;
    try {
      const restart = deps.restartSandboxGateway(result.sandboxName);
      if (!restart.ok) restartFailure = restart.failureLayer;
    } catch {
      restartFailure = "restart exception";
    }
    if (restartFailure) {
      appendPostCommitInferenceAudit(deps, {
        action: "inference_set",
        sandbox: result.sandboxName,
        timestamp: new Date().toISOString(),
        reason: `inference set ${result.provider}:${result.model} (config committed; gateway restart failed: ${restartFailure})`,
      });
      throw new InferenceSetError(
        `Inference route and config were updated for '${result.sandboxName}', but the managed gateway restart/recovery did not complete successfully. ` +
          `The committed route was not rolled back. Retry with '${CLI_NAME} ${result.sandboxName} gateway restart'.`,
      );
    }
  }
  const reconcileMutation = mutation.sandboxReconcile;
  if (reconcileMutation.state === "required") {
    try {
      deps.reconcilePackageSandbox(
        result.sandboxName,
        reconcileMutation.identity,
        reconcileMutation.declaration,
      );
    } catch {
      appendPostCommitInferenceAudit(deps, {
        action: "inference_set",
        sandbox: result.sandboxName,
        timestamp: new Date().toISOString(),
        reason: `inference set ${result.provider}:${result.model} (config committed; ${
          mutation.gatewayRestartRequired ? "gateway restart completed; " : ""
        }package reconciliation failed)`,
      });
      throw new InferenceSetError(
        `Inference route and config were updated for '${result.sandboxName}', but installed package reconciliation did not converge. ` +
          `The committed route was not rolled back. Run '${CLI_NAME} ${result.sandboxName} rebuild' to converge it.`,
      );
    }
  }
  if (!mutation.gatewayRestartRequired && reconcileMutation.state === "not-required") return;
  if (mutation.completionDeferred) return;
  appendPostCommitInferenceAudit(deps, {
    action: "inference_set",
    sandbox: result.sandboxName,
    timestamp: new Date().toISOString(),
    reason: `inference set ${result.provider}:${result.model} (${
      mutation.gatewayRestartRequired && reconcileMutation.state === "required"
        ? "gateway restart and package reconciliation completed"
        : mutation.gatewayRestartRequired
          ? "gateway restart completed"
          : "package reconciliation completed"
    })`,
  });
  deps.log(`  Inference route synced for '${result.sandboxName}': ${result.primaryModelRef}`);
}
