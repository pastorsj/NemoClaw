// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { CLI_NAME } from "../../cli/branding";
import type { OpenShellRuntimeSelection } from "../../adapters/openshell/runtime";
import type { AgentDefinition } from "../../agent/defs";
import type { HarnessScheduledWorkDeclaration } from "@nvidia/nemoclaw-harness-contract";
import { isImmutableSandboxCommandPath } from "@nvidia/nemoclaw-harness-contract/manifest-validator";
import { isDirectSandboxFallbackUnavailableError } from "../../sandbox/privileged-exec";
import type { GatewayRestartResult } from "./gateway-restart";
import {
  checkAndRecoverSandboxProcesses,
  executePrivilegedSandboxCommand,
  restartSandboxGateway,
  type SandboxCommandResult,
} from "./process-recovery";

const HERMES_CRON_CONTROL = "/usr/local/lib/nemoclaw/hermes-cron-restore-control.py";
const HERMES_PYTHON = "/opt/hermes/.venv/bin/python";
const RECEIPT_PREFIX = "NEMOCLAW_SCHEDULED_WORK_RESTORE_V1:";
const LEGACY_RECEIPT_PREFIX = "NEMOCLAW_HERMES_CRON_RESTORE_V1:";
const CONTROL_ERROR_PREFIX = "NEMOCLAW_SCHEDULED_WORK_RESTORE_ERROR_V1:";
const LEGACY_CONTROL_ERROR_PREFIX = "NEMOCLAW_HERMES_CRON_RESTORE_ERROR_V1:";
export const HERMES_CRON_RESTORE_DRAIN_MARKER_ROLLBACK_FAILED_CODE = "drain-marker-rollback-failed";
const BEGIN_TIMEOUT_MS = 70_000;
const CONTROL_TIMEOUT_MS = 25_000;
const RECOVERY_TIMEOUT_MS = BEGIN_TIMEOUT_MS + CONTROL_TIMEOUT_MS * 2 + 10_000;
const HERMES_GATEWAY_RECHECK_ATTEMPTS = 2;

type ManagedScheduledWorkDeclaration = Extract<
  HarnessScheduledWorkDeclaration,
  { readonly support: "managed" }
>;

const LEGACY_HERMES_SCHEDULED_WORK: ManagedScheduledWorkDeclaration = {
  support: "managed",
  controller: {
    command: [HERMES_PYTHON, "-I", HERMES_CRON_CONTROL],
    timeout_seconds: Math.ceil(RECOVERY_TIMEOUT_MS / 1000),
  },
  jobs_path: "cron/jobs.json",
  scripts_path: "scripts",
  profiles_path: "profiles",
  runtime_root: "/sandbox/.hermes",
};

type HermesCronRestoreAction =
  | "begin"
  | "validate"
  | "observe"
  | "complete"
  | "prepare-recover"
  | "recover";
type HermesCronRestoreReceiptAction = Exclude<HermesCronRestoreAction, "prepare-recover">;
type HermesCronRestoreDisposition =
  | "drain-acquired"
  | "restore-validated"
  | "replacement-observed"
  | "dispatch-reactivated"
  | "operator-drain-preserved"
  | "not-required";

interface HermesCronRestoreReceipt {
  version: 1;
  action: HermesCronRestoreAction;
  pid: number;
  start_time: number;
  drain_acquired: boolean;
  drain_token?: string;
  active_agents?: number;
  profiles?: number;
  active_jobs?: number;
  script_jobs?: number;
  rearmed_oneshots?: number;
  disposition: HermesCronRestoreDisposition;
  operator_drain_active: boolean;
  preserved_drain?: boolean;
}

export type ScheduledWorkRestoreIdentity = Pick<
  HermesCronRestoreReceipt,
  "pid" | "start_time" | "drain_token"
>;

/** Historical name retained for the explicit no-receipt Hermes compatibility path. */
export type HermesCronRestoreIdentity = ScheduledWorkRestoreIdentity;

export interface PendingHermesCronRestore<T> {
  result: T;
  identity: HermesCronRestoreIdentity;
}

export type HermesCronRestoreRecoveryOutcome =
  | "dispatch-reactivated"
  | "operator-drain-preserved"
  | "not-required"
  | "unsupported";

export type HermesCronRestorePreparationOutcome = "gate-prepared" | "not-required" | "unsupported";

export class ScheduledWorkRestoreIncompleteError extends Error {
  constructor() {
    super("state restore was incomplete while scheduled-work dispatch was drained");
    this.name = "ScheduledWorkRestoreIncompleteError";
  }
}

/** Historical value export retained for the no-receipt Hermes transaction. */
export const HermesCronRestoreIncompleteError = ScheduledWorkRestoreIncompleteError;

export type HermesPostRestoreGatewayState =
  | "not-applicable"
  | "healthy"
  | "recovered"
  | "unverified";

export type HermesPostRestoreGatewayRestartState =
  | "not-applicable"
  | "restarted"
  | "restart-failed";

type GatewayRecoveryObservation = {
  checked: boolean;
  wasRunning: boolean | null;
  recovered: boolean;
  forwardRecoveryFailed?: boolean;
  secretBoundaryRefused?: boolean;
};

interface HermesPostRestoreGatewayDeps {
  agentDefinition?: AgentDefinition;
  checkAndRecoverSandboxProcesses?: (
    sandboxName: string,
    options: {
      quiet: boolean;
      agentDefinition?: AgentDefinition;
      runtimeSelection?: OpenShellRuntimeSelection;
    },
  ) => GatewayRecoveryObservation;
  restartSandboxGateway?: (
    sandboxName: string,
    options: {
      quiet: boolean;
      agentDefinition?: AgentDefinition;
      runtimeSelection?: OpenShellRuntimeSelection;
    },
  ) => GatewayRestartResult;
  observeHermesCronReplacement?: (
    sandboxName: string,
    originalIdentity: HermesCronRestoreIdentity,
  ) => HermesCronRestoreIdentity;
  runtimeSelection?: OpenShellRuntimeSelection;
}

export interface HermesPostRestoreGatewayVerification {
  state: HermesPostRestoreGatewayState;
  replacementIdentity?: HermesCronRestoreIdentity;
}

/**
 * Bind the running Hermes gateway to the state this rebuild just restored.
 *
 * Recreation starts the gateway, and the restore replaces its durable state
 * afterwards. An adapter that reads that state once at startup keeps the
 * pre-restore result for the life of the process — the WhatsApp bridge reads
 * its paired session that way — so the gateway can be alive and healthy while
 * still serving the state the rebuild replaced. A liveness check cannot see
 * that difference, so restart before runtime restoration and let the final
 * check report on the process left by every intervening acknowledged reload.
 * `relaunchManagedSupervisorSession` already restarts after its own restore
 * for the same reason.
 *
 * The split restart/verify exports let rebuild insert MCP restoration between
 * those two steps. Hermes MCP restoration performs its own acknowledged
 * gateway reload, so a later unconditional restart would discard the runtime
 * identity whose MCP load just converged. A gated rebuild keeps the root-owned
 * cron drain active across restart, MCP restoration, and final verification.
 */
export function restartPackageRuntimeAfterStateRestore(
  sandboxName: string,
  restartRequired: boolean,
  deps: HermesPostRestoreGatewayDeps = {},
): HermesPostRestoreGatewayRestartState {
  if (!restartRequired) return "not-applicable";
  const restart = deps.restartSandboxGateway ?? restartSandboxGateway;
  const result = restart(sandboxName, {
    quiet: true,
    ...(deps.agentDefinition ? { agentDefinition: deps.agentDefinition } : {}),
    ...(deps.runtimeSelection ? { runtimeSelection: deps.runtimeSelection } : {}),
  });
  if (result.ok) return "restarted";
  return "restart-failed";
}

/** Explicit pre-contract name retained for old rebuild tests and callers. */
export function restartHermesGatewayAfterStateRestore(
  ...args: Parameters<typeof restartPackageRuntimeAfterStateRestore>
): ReturnType<typeof restartPackageRuntimeAfterStateRestore> {
  return restartPackageRuntimeAfterStateRestore(...args);
}

export function verifyPackageRuntimeAfterStateRestore(
  sandboxName: string,
  verificationRequired: boolean,
  restartState: HermesPostRestoreGatewayRestartState,
  deps: HermesPostRestoreGatewayDeps = {},
): HermesPostRestoreGatewayState {
  return verifyHermesGatewayAfterStateRestoreImpl(
    sandboxName,
    verificationRequired,
    restartState,
    deps,
  ).state;
}

/** Explicit pre-contract name retained for old rebuild tests and callers. */
export function verifyHermesGatewayAfterStateRestore(
  ...args: Parameters<typeof verifyPackageRuntimeAfterStateRestore>
): ReturnType<typeof verifyPackageRuntimeAfterStateRestore> {
  return verifyPackageRuntimeAfterStateRestore(...args);
}

export function verifyHermesGatewayAfterStateRestoreForCronGate(
  sandboxName: string,
  verificationRequired: boolean,
  restartState: HermesPostRestoreGatewayRestartState,
  originalIdentity: HermesCronRestoreIdentity,
  deps: HermesPostRestoreGatewayDeps = {},
): HermesPostRestoreGatewayVerification {
  return verifyHermesGatewayAfterStateRestoreImpl(
    sandboxName,
    verificationRequired,
    restartState,
    deps,
    originalIdentity,
  );
}

/** Verify a replacement runtime identity while a declared scheduled-work gate is held. */
export function verifyPackageRuntimeAfterStateRestoreForScheduledWorkGate(
  sandboxName: string,
  verificationRequired: boolean,
  restartState: HermesPostRestoreGatewayRestartState,
  declaration: ManagedScheduledWorkDeclaration,
  originalIdentity: HermesCronRestoreIdentity,
  deps: HermesPostRestoreGatewayDeps = {},
): HermesPostRestoreGatewayVerification {
  return verifyHermesGatewayAfterStateRestoreImpl(
    sandboxName,
    verificationRequired,
    restartState,
    {
      ...deps,
      observeHermesCronReplacement: (name, identity) =>
        observeScheduledWorkRuntimeReplacement(name, declaration, identity),
    },
    originalIdentity,
  );
}

function sameGatewayIdentity(
  left: HermesCronRestoreIdentity,
  right: HermesCronRestoreIdentity,
): boolean {
  return left.pid === right.pid && left.start_time === right.start_time;
}

function verifyHermesGatewayAfterStateRestoreImpl(
  sandboxName: string,
  verificationRequired: boolean,
  restartState: HermesPostRestoreGatewayRestartState,
  deps: HermesPostRestoreGatewayDeps,
  originalIdentity?: HermesCronRestoreIdentity,
): HermesPostRestoreGatewayVerification {
  if (!verificationRequired) return { state: "not-applicable" };
  const restarted = restartState === "restarted";
  const checkAndRecover = deps.checkAndRecoverSandboxProcesses ?? checkAndRecoverSandboxProcesses;
  const observeReplacement = deps.observeHermesCronReplacement ?? observeHermesCronReplacement;
  const maxAttempts = originalIdentity
    ? HERMES_GATEWAY_RECHECK_ATTEMPTS + 1
    : HERMES_GATEWAY_RECHECK_ATTEMPTS;
  let recovered = false;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let identityBeforeHealth: HermesCronRestoreIdentity | undefined;
    if (originalIdentity) {
      try {
        identityBeforeHealth = observeReplacement(sandboxName, originalIdentity);
      } catch {
        // The recovery check may still create the replacement process. A
        // later iteration must observe it both before and after health.
      }
    }
    const observation: GatewayRecoveryObservation = checkAndRecover(sandboxName, {
      quiet: true,
      ...(deps.agentDefinition ? { agentDefinition: deps.agentDefinition } : {}),
      ...(deps.runtimeSelection ? { runtimeSelection: deps.runtimeSelection } : {}),
    });
    if (observation.forwardRecoveryFailed === true || observation.secretBoundaryRefused === true) {
      return { state: "unverified" };
    }
    if (!observation.checked) continue;
    // Recovery replaces the process, so a recovered gateway reads the restored
    // state whatever the restart reported. A gateway that stayed up through a
    // failed restart is still serving what it read before the restore, which is
    // the state this step exists to replace.
    if (observation.recovered) {
      if (!originalIdentity) return { state: "recovered" };
      recovered = true;
      continue;
    }
    if ((!restarted && !recovered) || observation.wasRunning !== true) continue;
    if (!originalIdentity) return { state: recovered ? "recovered" : "healthy" };
    if (!identityBeforeHealth) continue;
    let identityAfterHealth: HermesCronRestoreIdentity;
    try {
      identityAfterHealth = observeReplacement(sandboxName, originalIdentity);
    } catch {
      return { state: "unverified" };
    }
    if (!sameGatewayIdentity(identityBeforeHealth, identityAfterHealth)) {
      return { state: "unverified" };
    }
    return {
      state: recovered ? "recovered" : "healthy",
      replacementIdentity: identityAfterHealth,
    };
  }
  return { state: "unverified" };
}

export function printHermesGatewayRestoreRecovery(
  sandboxName: string,
  state: HermesPostRestoreGatewayState,
  writeLine: (message: string) => void = console.log,
): void {
  if (state !== "unverified") return;
  writeLine(
    `    Hermes gateway health was not verified after state restore — it can still be serving the state this rebuild replaced; run \`${CLI_NAME} ${sandboxName} gateway restart\`, then \`${CLI_NAME} ${sandboxName} recover\` if that fails`,
  );
}

function hasExactReceiptFields(
  payload: Record<string, unknown>,
  fields: readonly string[],
): boolean {
  const expected = new Set(fields);
  return (
    Object.keys(payload).length === expected.size &&
    Object.keys(payload).every((key) => expected.has(key))
  );
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isReleaseDispositionValid(payload: Record<string, unknown>): boolean {
  const operatorDrainActive = payload.operator_drain_active;
  return (
    typeof operatorDrainActive === "boolean" &&
    payload.preserved_drain === operatorDrainActive &&
    payload.disposition ===
      (operatorDrainActive ? "operator-drain-preserved" : "dispatch-reactivated")
  );
}

function scheduledWorkControllerLabel(declaration: ManagedScheduledWorkDeclaration): string {
  return declaration === LEGACY_HERMES_SCHEDULED_WORK ? "Hermes cron" : "Scheduled-work controller";
}

function acceptsLegacyHermesProtocol(declaration: ManagedScheduledWorkDeclaration): boolean {
  return declaration === LEGACY_HERMES_SCHEDULED_WORK;
}

function parseCronRestoreReceipt(
  stdout: string,
  expectedAction: HermesCronRestoreReceiptAction,
  controllerLabel: string,
  acceptLegacyProtocol: boolean,
): HermesCronRestoreReceipt {
  const acceptedPrefixes = acceptLegacyProtocol
    ? [RECEIPT_PREFIX, LEGACY_RECEIPT_PREFIX]
    : [RECEIPT_PREFIX];
  const receiptLines = stdout
    .split(/\r?\n/u)
    .map((line) => ({
      line,
      prefix: acceptedPrefixes.find((prefix) => line.startsWith(prefix)),
    }))
    .filter((entry): entry is { line: string; prefix: string } => entry.prefix !== undefined);
  if (receiptLines.length !== 1) {
    throw new Error(`${controllerLabel} ${expectedAction} returned an invalid receipt`);
  }
  let payload: unknown;
  try {
    payload = JSON.parse(receiptLines[0].line.slice(receiptLines[0].prefix.length));
  } catch {
    throw new Error(`${controllerLabel} ${expectedAction} returned malformed JSON`);
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error(`${controllerLabel} ${expectedAction} receipt failed validation`);
  }
  const receipt = payload as Record<string, unknown>;
  if (
    receipt.version !== 1 ||
    receipt.action !== expectedAction ||
    !Number.isSafeInteger(receipt.pid) ||
    Number(receipt.pid) <= 0 ||
    !isNonNegativeInteger(receipt.start_time) ||
    typeof receipt.drain_acquired !== "boolean" ||
    typeof receipt.operator_drain_active !== "boolean" ||
    (receipt.drain_acquired
      ? typeof receipt.drain_token !== "string" || receipt.drain_token.length === 0
      : "drain_token" in receipt)
  ) {
    throw new Error(`${controllerLabel} ${expectedAction} receipt failed validation`);
  }

  const baseFields = [
    "version",
    "action",
    "pid",
    "start_time",
    "drain_acquired",
    "disposition",
    "operator_drain_active",
  ];
  const tokenFields = receipt.drain_acquired ? ["drain_token"] : [];
  let actionValid = false;
  switch (expectedAction) {
    case "begin":
      actionValid =
        receipt.drain_acquired === true &&
        receipt.disposition === "drain-acquired" &&
        receipt.active_agents === 0 &&
        hasExactReceiptFields(receipt, [...baseFields, ...tokenFields, "active_agents"]);
      break;
    case "validate":
      actionValid =
        receipt.drain_acquired === true &&
        receipt.disposition === "restore-validated" &&
        isNonNegativeInteger(receipt.profiles) &&
        isNonNegativeInteger(receipt.active_jobs) &&
        isNonNegativeInteger(receipt.script_jobs) &&
        hasExactReceiptFields(receipt, [
          ...baseFields,
          ...tokenFields,
          "profiles",
          "active_jobs",
          "script_jobs",
        ]);
      break;
    case "observe":
      actionValid =
        receipt.drain_acquired === true &&
        receipt.disposition === "replacement-observed" &&
        receipt.active_agents === 0 &&
        hasExactReceiptFields(receipt, [...baseFields, ...tokenFields, "active_agents"]);
      break;
    case "complete":
      actionValid =
        receipt.drain_acquired === true &&
        receipt.active_agents === 0 &&
        isNonNegativeInteger(receipt.profiles) &&
        isNonNegativeInteger(receipt.active_jobs) &&
        isNonNegativeInteger(receipt.script_jobs) &&
        isNonNegativeInteger(receipt.rearmed_oneshots) &&
        isReleaseDispositionValid(receipt) &&
        hasExactReceiptFields(receipt, [
          ...baseFields,
          ...tokenFields,
          "active_agents",
          "profiles",
          "active_jobs",
          "script_jobs",
          "rearmed_oneshots",
          "preserved_drain",
        ]);
      break;
    case "recover":
      if (receipt.drain_acquired) {
        actionValid =
          receipt.active_agents === 0 &&
          isNonNegativeInteger(receipt.profiles) &&
          isNonNegativeInteger(receipt.active_jobs) &&
          isNonNegativeInteger(receipt.script_jobs) &&
          isNonNegativeInteger(receipt.rearmed_oneshots) &&
          isReleaseDispositionValid(receipt) &&
          hasExactReceiptFields(receipt, [
            ...baseFields,
            ...tokenFields,
            "active_agents",
            "profiles",
            "active_jobs",
            "script_jobs",
            "rearmed_oneshots",
            "preserved_drain",
          ]);
      } else {
        actionValid =
          receipt.disposition === "not-required" &&
          isNonNegativeInteger(receipt.active_agents) &&
          receipt.preserved_drain === receipt.operator_drain_active &&
          hasExactReceiptFields(receipt, [...baseFields, "active_agents", "preserved_drain"]);
      }
      break;
  }
  if (!actionValid) {
    throw new Error(`${controllerLabel} ${expectedAction} receipt failed validation`);
  }
  return receipt as unknown as HermesCronRestoreReceipt;
}

function parseCronRestorePreparationReceipt(
  stdout: string,
  controllerLabel: string,
  acceptLegacyProtocol: boolean,
): HermesCronRestorePreparationOutcome {
  const acceptedPrefixes = acceptLegacyProtocol
    ? [RECEIPT_PREFIX, LEGACY_RECEIPT_PREFIX]
    : [RECEIPT_PREFIX];
  const receiptLines = stdout
    .split(/\r?\n/u)
    .map((line) => ({
      line,
      prefix: acceptedPrefixes.find((prefix) => line.startsWith(prefix)),
    }))
    .filter((entry): entry is { line: string; prefix: string } => entry.prefix !== undefined);
  if (receiptLines.length !== 1) {
    throw new Error(`${controllerLabel} prepare-recover returned an invalid receipt`);
  }
  let payload: unknown;
  try {
    payload = JSON.parse(receiptLines[0].line.slice(receiptLines[0].prefix.length));
  } catch {
    throw new Error(`${controllerLabel} prepare-recover returned malformed JSON`);
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error(`${controllerLabel} prepare-recover receipt failed validation`);
  }
  const receipt = payload as Record<string, unknown>;
  const validDisposition =
    (receipt.drain_acquired === true && receipt.disposition === "gate-prepared") ||
    (receipt.drain_acquired === false && receipt.disposition === "not-required");
  if (
    receipt.version !== 1 ||
    receipt.action !== "prepare-recover" ||
    !validDisposition ||
    !hasExactReceiptFields(receipt, ["version", "action", "drain_acquired", "disposition"])
  ) {
    throw new Error(`${controllerLabel} prepare-recover receipt failed validation`);
  }
  return receipt.disposition as "gate-prepared" | "not-required";
}

function parseCronRestoreControlError(
  stderr: string,
  acceptLegacyProtocol: boolean,
): { code: string; message: string } | null {
  const acceptedPrefixes = acceptLegacyProtocol
    ? [CONTROL_ERROR_PREFIX, LEGACY_CONTROL_ERROR_PREFIX]
    : [CONTROL_ERROR_PREFIX];
  const signalLines = stderr
    .split(/\r?\n/u)
    .map((line) => ({
      line,
      prefix: acceptedPrefixes.find((prefix) => line.startsWith(prefix)),
    }))
    .filter((entry): entry is { line: string; prefix: string } => entry.prefix !== undefined);
  if (signalLines.length !== 1) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(signalLines[0].line.slice(signalLines[0].prefix.length));
  } catch {
    return null;
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return null;
  const signal = payload as Record<string, unknown>;
  if (
    !hasExactReceiptFields(signal, ["code", "message"]) ||
    typeof signal.code !== "string" ||
    signal.code.length === 0 ||
    typeof signal.message !== "string" ||
    signal.message.length === 0
  ) {
    return null;
  }
  return { code: signal.code, message: signal.message };
}

class HermesCronRestoreControlFailure extends Error {
  readonly action: HermesCronRestoreAction;
  readonly stderr: string;
  readonly controlCode?: string;

  constructor(
    action: HermesCronRestoreAction,
    stderr: string,
    controllerLabel: string,
    acceptLegacyProtocol: boolean,
  ) {
    const controlError = parseCronRestoreControlError(stderr, acceptLegacyProtocol);
    const detail =
      controlError?.message ??
      stderr
        .trim()
        .split(/\r?\n/u)
        .filter(
          (line) =>
            !line.startsWith(CONTROL_ERROR_PREFIX) && !line.startsWith(LEGACY_CONTROL_ERROR_PREFIX),
        )
        .at(-1);
    super(`${controllerLabel} ${action} failed${detail ? `: ${detail}` : ""}`);
    this.name = "HermesCronRestoreControlFailure";
    this.action = action;
    this.stderr = stderr;
    this.controlCode = controlError?.code;
  }
}

export function isHermesCronRestoreDrainMarkerRollbackFailure(error: unknown): boolean {
  return (
    error instanceof HermesCronRestoreControlFailure &&
    error.action === "complete" &&
    error.controlCode === HERMES_CRON_RESTORE_DRAIN_MARKER_ROLLBACK_FAILED_CODE
  );
}

function executeCronRestoreControl(
  sandboxName: string,
  declaration: ManagedScheduledWorkDeclaration,
  action: HermesCronRestoreAction,
  identity?: HermesCronRestoreIdentity,
  replacementIdentity?: HermesCronRestoreIdentity,
): string {
  const controllerLabel = scheduledWorkControllerLabel(declaration);
  if (!isImmutableSandboxCommandPath(declaration.controller.command[0] as string)) {
    throw new Error(`${controllerLabel} command is not stored in the immutable image`);
  }
  const command = [...declaration.controller.command, action];
  if (identity) {
    command.push("--pid", String(identity.pid), "--start-time", String(identity.start_time));
    if (identity.drain_token) command.push(`--drain-token=${identity.drain_token}`);
  }
  if (replacementIdentity) {
    command.push(
      "--replacement-pid",
      String(replacementIdentity.pid),
      "--replacement-start-time",
      String(replacementIdentity.start_time),
    );
  }
  let result: SandboxCommandResult | null;
  try {
    const timeout =
      declaration === LEGACY_HERMES_SCHEDULED_WORK
        ? action === "begin" || action === "observe"
          ? BEGIN_TIMEOUT_MS
          : action === "recover" || action === "complete"
            ? RECOVERY_TIMEOUT_MS
            : CONTROL_TIMEOUT_MS
        : declaration.controller.timeout_seconds * 1000;
    result = executePrivilegedSandboxCommand(sandboxName, command, timeout);
  } catch (error) {
    if (isDirectSandboxFallbackUnavailableError(error)) {
      throw new Error(`${controllerLabel} ${action} privileged transport was unavailable`);
    }
    throw error;
  }
  if (!result) {
    throw new Error(`${controllerLabel} ${action} transport was unavailable`);
  }
  if (result.status !== 0) {
    throw new HermesCronRestoreControlFailure(
      action,
      result.stderr,
      controllerLabel,
      acceptsLegacyHermesProtocol(declaration),
    );
  }
  return result.stdout;
}

function runCronRestoreControl(
  sandboxName: string,
  declaration: ManagedScheduledWorkDeclaration,
  action: HermesCronRestoreReceiptAction,
  identity?: HermesCronRestoreIdentity,
  replacementIdentity?: HermesCronRestoreIdentity,
): HermesCronRestoreReceipt {
  return parseCronRestoreReceipt(
    executeCronRestoreControl(sandboxName, declaration, action, identity, replacementIdentity),
    action,
    scheduledWorkControllerLabel(declaration),
    acceptsLegacyHermesProtocol(declaration),
  );
}

export function beginHermesCronRestore(sandboxName: string): HermesCronRestoreIdentity {
  return beginScheduledWorkRestore(sandboxName, LEGACY_HERMES_SCHEDULED_WORK);
}

export function beginScheduledWorkRestore(
  sandboxName: string,
  declaration: ManagedScheduledWorkDeclaration,
): HermesCronRestoreIdentity {
  const receipt = runCronRestoreControl(sandboxName, declaration, "begin");
  return {
    pid: receipt.pid,
    start_time: receipt.start_time,
    ...(receipt.drain_token ? { drain_token: receipt.drain_token } : {}),
  };
}

export function validateHermesCronRestore(
  sandboxName: string,
  identity: HermesCronRestoreIdentity,
): void {
  return validateScheduledWorkRestore(sandboxName, LEGACY_HERMES_SCHEDULED_WORK, identity);
}

export function validateScheduledWorkRestore(
  sandboxName: string,
  declaration: ManagedScheduledWorkDeclaration,
  identity: HermesCronRestoreIdentity,
): void {
  const receipt = runCronRestoreControl(sandboxName, declaration, "validate", identity);
  if (
    receipt.pid !== identity.pid ||
    receipt.start_time !== identity.start_time ||
    receipt.drain_token !== identity.drain_token
  ) {
    throw new Error(
      `${scheduledWorkControllerLabel(declaration)} validate receipt changed runtime identity`,
    );
  }
}

export function completeHermesCronRestoreAfterGatewayReplacement(
  sandboxName: string,
  originalIdentity: HermesCronRestoreIdentity,
  verifiedReplacementIdentity: HermesCronRestoreIdentity,
): HermesCronRestoreIdentity {
  return completeScheduledWorkRestoreAfterRuntimeReplacement(
    sandboxName,
    LEGACY_HERMES_SCHEDULED_WORK,
    originalIdentity,
    verifiedReplacementIdentity,
  );
}

export function completeScheduledWorkRestoreAfterRuntimeReplacement(
  sandboxName: string,
  declaration: ManagedScheduledWorkDeclaration,
  originalIdentity: HermesCronRestoreIdentity,
  verifiedReplacementIdentity: HermesCronRestoreIdentity,
): HermesCronRestoreIdentity {
  const controllerLabel = scheduledWorkControllerLabel(declaration);
  const runtimeIdentityName =
    declaration === LEGACY_HERMES_SCHEDULED_WORK ? "gateway identity" : "runtime identity";
  if (!originalIdentity.drain_token) {
    throw new Error(`${controllerLabel} completion requires the held drain token`);
  }
  if (sameGatewayIdentity(originalIdentity, verifiedReplacementIdentity)) {
    throw new Error(`${controllerLabel} completion requires a replacement ${runtimeIdentityName}`);
  }
  if (verifiedReplacementIdentity.drain_token !== originalIdentity.drain_token) {
    throw new Error(`${controllerLabel} completion changed the held drain token`);
  }
  const receipt = runCronRestoreControl(
    sandboxName,
    declaration,
    "complete",
    originalIdentity,
    verifiedReplacementIdentity,
  );
  if (
    receipt.drain_token !== originalIdentity.drain_token ||
    !sameGatewayIdentity(receipt, verifiedReplacementIdentity)
  ) {
    throw new Error(
      `${controllerLabel} completion changed the verified replacement ${runtimeIdentityName}`,
    );
  }
  return {
    pid: receipt.pid,
    start_time: receipt.start_time,
    ...(receipt.drain_token ? { drain_token: receipt.drain_token } : {}),
  };
}

export function observeHermesCronReplacement(
  sandboxName: string,
  originalIdentity: HermesCronRestoreIdentity,
): HermesCronRestoreIdentity {
  return observeScheduledWorkRuntimeReplacement(
    sandboxName,
    LEGACY_HERMES_SCHEDULED_WORK,
    originalIdentity,
  );
}

export function observeScheduledWorkRuntimeReplacement(
  sandboxName: string,
  declaration: ManagedScheduledWorkDeclaration,
  originalIdentity: HermesCronRestoreIdentity,
): HermesCronRestoreIdentity {
  const controllerLabel = scheduledWorkControllerLabel(declaration);
  const runtimeIdentityName =
    declaration === LEGACY_HERMES_SCHEDULED_WORK ? "gateway identity" : "runtime identity";
  if (!originalIdentity.drain_token) {
    throw new Error(`${controllerLabel} replacement observation requires the held drain token`);
  }
  const receipt = runCronRestoreControl(sandboxName, declaration, "observe", originalIdentity);
  if (
    receipt.drain_token !== originalIdentity.drain_token ||
    sameGatewayIdentity(receipt, originalIdentity)
  ) {
    throw new Error(
      `${controllerLabel} observation did not bind to a replacement ${runtimeIdentityName}`,
    );
  }
  return {
    pid: receipt.pid,
    start_time: receipt.start_time,
    ...(receipt.drain_token ? { drain_token: receipt.drain_token } : {}),
  };
}

function isLegacyCronRestoreControl(
  error: unknown,
  action: "prepare-recover" | "recover",
): boolean {
  if (!(error instanceof HermesCronRestoreControlFailure)) return false;
  const invalidAction =
    action === "prepare-recover"
      ? /argument action: invalid choice: ['"]prepare-recover['"]/u
      : /argument action: invalid choice: ['"]recover['"]/u;
  return (
    /can't open file ['"]\/usr\/local\/lib\/nemoclaw\/hermes-cron-restore-control\.py['"]: \[Errno 2\] No such file or directory/u.test(
      error.stderr,
    ) || invalidAction.test(error.stderr)
  );
}

export function prepareHermesCronRestoreRecovery(
  sandboxName: string,
): HermesCronRestorePreparationOutcome {
  let stdout: string;
  try {
    stdout = executeCronRestoreControl(
      sandboxName,
      LEGACY_HERMES_SCHEDULED_WORK,
      "prepare-recover",
    );
  } catch (error) {
    if (isLegacyCronRestoreControl(error, "prepare-recover")) return "unsupported";
    throw error;
  }
  return parseCronRestorePreparationReceipt(
    stdout,
    scheduledWorkControllerLabel(LEGACY_HERMES_SCHEDULED_WORK),
    true,
  );
}

export function prepareScheduledWorkRestoreRecovery(
  sandboxName: string,
  declaration: ManagedScheduledWorkDeclaration,
): HermesCronRestorePreparationOutcome {
  return parseCronRestorePreparationReceipt(
    executeCronRestoreControl(sandboxName, declaration, "prepare-recover"),
    scheduledWorkControllerLabel(declaration),
    acceptsLegacyHermesProtocol(declaration),
  );
}

export function recoverHermesCronRestore(sandboxName: string): HermesCronRestoreRecoveryOutcome {
  let receipt: HermesCronRestoreReceipt;
  try {
    receipt = runCronRestoreControl(sandboxName, LEGACY_HERMES_SCHEDULED_WORK, "recover");
  } catch (error) {
    if (isLegacyCronRestoreControl(error, "recover")) return "unsupported";
    throw error;
  }
  if (
    receipt.disposition === "dispatch-reactivated" ||
    receipt.disposition === "operator-drain-preserved" ||
    receipt.disposition === "not-required"
  ) {
    return receipt.disposition;
  }
  throw new Error("Hermes cron recover returned an invalid disposition");
}

export function recoverScheduledWorkRestore(
  sandboxName: string,
  declaration: ManagedScheduledWorkDeclaration,
): HermesCronRestoreRecoveryOutcome {
  const receipt = runCronRestoreControl(sandboxName, declaration, "recover");
  if (
    receipt.disposition === "dispatch-reactivated" ||
    receipt.disposition === "operator-drain-preserved" ||
    receipt.disposition === "not-required"
  ) {
    return receipt.disposition;
  }
  throw new Error(
    `${scheduledWorkControllerLabel(declaration)} recover returned an invalid disposition`,
  );
}

export function runHermesCronRestoreTransaction<T extends { restoreSucceeded: boolean }>(
  sandboxName: string,
  restore: () => T,
  onGateTransition: (state: "acquired", identity: HermesCronRestoreIdentity) => void = () => {},
): PendingHermesCronRestore<T> {
  return runScheduledWorkRestoreTransaction(
    sandboxName,
    LEGACY_HERMES_SCHEDULED_WORK,
    restore,
    onGateTransition,
  );
}

export function runScheduledWorkRestoreTransaction<T extends { restoreSucceeded: boolean }>(
  sandboxName: string,
  declaration: ManagedScheduledWorkDeclaration,
  restore: () => T,
  onGateTransition: (state: "acquired", identity: HermesCronRestoreIdentity) => void = () => {},
): PendingHermesCronRestore<T> {
  const identity = beginScheduledWorkRestore(sandboxName, declaration);
  onGateTransition("acquired", identity);
  const result = restore();
  if (!result.restoreSucceeded) {
    throw new ScheduledWorkRestoreIncompleteError();
  }
  validateScheduledWorkRestore(sandboxName, declaration, identity);
  return { result, identity };
}
