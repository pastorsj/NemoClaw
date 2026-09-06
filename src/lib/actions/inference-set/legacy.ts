// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { CLI_NAME } from "../../cli/branding";
import type {
  HarnessInferenceApi,
  HarnessInferenceConfigPostCommit,
} from "../../agent-runtime/config-module";
import type { ConfigObject } from "../../security/credential-filter";
import type { OperationalAuditEntry } from "../../state/audit/operational";
import { type InferenceApi, readOpenClawPrimaryRouteApi } from "../inference-route-api";
import { InferenceSetError } from "../inference-set-error";
import {
  runPortableOpenClawPairingApproval,
  runPortableOpenClawPairingRequestProducer,
  type PortableOpenClawPairingApprovalReceipt,
} from "../sandbox/auto-pair-approval";
import {
  observeOpenClawPairingSettlement,
  type OpenClawPairingSettlementObservation,
} from "../sandbox/launch-readiness/openclaw-pairing-qualification";

export type LegacyInferenceAgentKind = "dashboard-config" | "gateway-config";

export function requireLegacyInferenceAgent(agentName: string): LegacyInferenceAgentKind {
  if (agentName === "hermes") return "dashboard-config";
  if (agentName === "openclaw") return "gateway-config";
  throw new InferenceSetError(
    `The legacy runtime for '${agentName}' does not provide a supported runtime inference mapping.`,
    2,
  );
}

export function assertLegacyRequestedInferenceApi(options: {
  agentName: string;
  provider: string;
  explicitInferenceApi: string | null;
}): void {
  if (
    requireLegacyInferenceAgent(options.agentName) === "dashboard-config" &&
    options.provider === "compatible-anthropic-endpoint" &&
    options.explicitInferenceApi !== null &&
    options.explicitInferenceApi !== "openai-completions"
  ) {
    throw new InferenceSetError(
      "Hermes custom Anthropic endpoints require the managed openai-completions frontend. " +
        "Set --inference-api openai-completions or omit --inference-api so NemoClaw selects it.",
      2,
    );
  }
}

export function legacyInferencePostCommit(
  agentName: string,
  previousOpenClawApi: HarnessInferenceApi | null,
): HarnessInferenceConfigPostCommit {
  return requireLegacyInferenceAgent(agentName) === "dashboard-config"
    ? {
        configSync: "required",
        gatewayRestart: { kind: "not-required" },
        sandboxReconcile: { kind: "not-required" },
      }
    : {
        configSync: "best-effort",
        gatewayRestart: { kind: "when-api-changes", previousApi: previousOpenClawApi },
        sandboxReconcile: { kind: "not-required" },
      };
}

export function readPreviousLegacyInferenceApi(
  agentName: string,
  config: ConfigObject,
): InferenceApi | null {
  return requireLegacyInferenceAgent(agentName) === "gateway-config"
    ? readOpenClawPrimaryRouteApi(config)
    : null;
}

export type LegacyOpenClawPairingTarget = {
  readonly sandboxName: string;
  readonly gatewayName: string;
  readonly openclawVersion: string;
  readonly stateDirectory: string;
};

export type LegacyOpenClawPairingFailureLayer =
  | "initial-state-unavailable"
  | "final-state-unavailable"
  | "final-state-unsettled"
  | "pairing-operation-failed"
  | `approval-${Exclude<PortableOpenClawPairingApprovalReceipt, "approved">}`;

export type LegacyOpenClawPairingResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly failureLayer: LegacyOpenClawPairingFailureLayer };

export type LegacyOpenClawPairingDeps = {
  observePairing: (target: LegacyOpenClawPairingTarget) => OpenClawPairingSettlementObservation;
  publishScopeRequest: (target: LegacyOpenClawPairingTarget) => void;
  approveScopeRequest: (
    target: LegacyOpenClawPairingTarget,
    deviceIdentitySha256: string,
  ) => PortableOpenClawPairingApprovalReceipt;
};

const defaultOpenClawPairingDeps: LegacyOpenClawPairingDeps = {
  observePairing: (target) =>
    observeOpenClawPairingSettlement(
      target.sandboxName,
      target.gatewayName,
      target.openclawVersion,
      target.stateDirectory,
    ),
  publishScopeRequest: (target) =>
    runPortableOpenClawPairingRequestProducer(target.sandboxName, target.gatewayName),
  approveScopeRequest: (target, deviceIdentitySha256) =>
    runPortableOpenClawPairingApproval(
      target.sandboxName,
      target.gatewayName,
      deviceIdentitySha256,
    ),
};

/** Preserve the no-receipt OpenClaw scope-upgrade flow during package migration. */
export function settleLegacyOpenClawPairing(
  target: LegacyOpenClawPairingTarget,
  deps: LegacyOpenClawPairingDeps = defaultOpenClawPairingDeps,
): LegacyOpenClawPairingResult {
  let initial: OpenClawPairingSettlementObservation;
  try {
    initial = deps.observePairing(target);
  } catch {
    return { ok: false, failureLayer: "initial-state-unavailable" };
  }
  if (initial.state === "settled") return { ok: true };

  let approval: PortableOpenClawPairingApprovalReceipt;
  try {
    deps.publishScopeRequest(target);
    approval = deps.approveScopeRequest(target, initial.deviceIdentitySha256);
  } catch {
    return { ok: false, failureLayer: "pairing-operation-failed" };
  }

  let final: OpenClawPairingSettlementObservation;
  try {
    final = deps.observePairing(target);
  } catch {
    return { ok: false, failureLayer: "final-state-unavailable" };
  }
  if (final.state === "settled") return { ok: true };
  return {
    ok: false,
    failureLayer: approval === "approved" ? "final-state-unsettled" : `approval-${approval}`,
  };
}

export interface LegacyInferenceCompletion {
  readonly target: LegacyOpenClawPairingTarget | null;
  readonly gatewayRestartRequired: boolean;
  readonly result: {
    readonly sandboxName: string;
    readonly provider: string;
    readonly model: string;
    readonly primaryModelRef: string;
  };
}

export interface LegacyInferenceCompletionDeps {
  readonly appendAuditEntry: (entry: OperationalAuditEntry) => void;
  readonly log: (message: string) => void;
  readonly settleLegacyPairing: (
    target: LegacyOpenClawPairingTarget,
  ) => LegacyOpenClawPairingResult;
}

function appendLegacyAudit(
  deps: Pick<LegacyInferenceCompletionDeps, "appendAuditEntry" | "log">,
  entry: OperationalAuditEntry,
): void {
  try {
    deps.appendAuditEntry(entry);
  } catch {
    deps.log(
      `  Warning: could not record the post-commit inference audit entry for '${entry.sandbox}'.`,
    );
  }
}

export function completeLegacyInferencePostCommit(
  completion: LegacyInferenceCompletion,
  deps: LegacyInferenceCompletionDeps,
): void {
  if (!completion.target) return;
  let pairing: LegacyOpenClawPairingResult;
  try {
    pairing = deps.settleLegacyPairing(completion.target);
  } catch {
    pairing = { ok: false, failureLayer: "pairing-operation-failed" };
  }
  const { result } = completion;
  if (!pairing.ok) {
    appendLegacyAudit(deps, {
      action: "inference_set",
      sandbox: result.sandboxName,
      timestamp: new Date().toISOString(),
      reason: `inference set openclaw:${result.provider}:${result.model} (config committed; ${
        completion.gatewayRestartRequired ? "gateway restart completed; " : ""
      }pairing convergence failed: ${pairing.failureLayer})`,
    });
    throw new InferenceSetError(
      `Inference route and config were updated for '${result.sandboxName}', but OpenClaw gateway pairing did not converge (${pairing.failureLayer}). ` +
        `The committed route was not rolled back. Run '${CLI_NAME} ${result.sandboxName} doctor --fix', then retry the agent turn.`,
    );
  }
  appendLegacyAudit(deps, {
    action: "inference_set",
    sandbox: result.sandboxName,
    timestamp: new Date().toISOString(),
    reason: `inference set openclaw:${result.provider}:${result.model} (${
      completion.gatewayRestartRequired ? "gateway restart and " : ""
    }pairing convergence completed)`,
  });
  deps.log(`  Inference route synced for '${result.sandboxName}': ${result.primaryModelRef}`);
}
