// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  inspectHarnessPackageState,
  type HarnessPackageIdentity,
  type HarnessPackageMigration,
} from "../../harness/package-identity";
import {
  checkpointGatewayAuthority,
  gatewayOwnerFromCheckpoint,
} from "../../onboard/gateway-authority-checkpoint";
import { describeGatewayOwnerForError, sameGatewayOwner } from "../../onboard/gateway-ownership";
import {
  GatewayAuthorityError,
  gatewayAuthorityFailureLines,
  isManagedPackagedServiceMigration,
  resolveGatewayRebuildAuthority,
} from "../../onboard/gateway-teardown-authority";
import {
  observeSandboxOnGateway,
  type SandboxRecreateObserver,
  type SandboxRecreateTarget,
} from "../../onboard/sandbox-recreate-probe";
import {
  advanceSandboxRecreateTransaction,
  beginSandboxRecreateTransaction,
  clearCompletedSandboxRecreateTransaction,
  fingerprintSandboxRecreateValue,
  planSandboxRecreateRecovery,
  type SandboxRecreateSourcePresence,
  sandboxRecreatePhaseReached,
} from "../../onboard/sandbox-recreate-transaction";
import { decisionSelected } from "../../state/onboard-checkpoint-decision";
import {
  bindCheckpointHarnessPackageAuthority,
  deriveCheckpointFromSession,
} from "../../state/onboard-checkpoint-migrate";
import type {
  CheckpointGatewayAuthority,
  CheckpointSandboxRecreatePhase,
} from "../../state/onboard-checkpoint-types";
import * as onboardSession from "../../state/onboard-session";
import * as registry from "../../state/registry";
import {
  rebuildPackageAuthorityMatches,
  type RebuildPackageAuthority,
} from "./rebuild/authority";
import type { RebuildRecreateOnboardOpts } from "./rebuild-gpu-opt-out";

export type { RebuildPackageAuthority } from "./rebuild/authority";

export type RebuildRecreateJournalTarget = SandboxRecreateTarget;

export type RebuildSandboxObserver = SandboxRecreateObserver;

export type RebuildRecreateSourcePresence = SandboxRecreateSourcePresence;

type RebuildFingerprintOptions = Pick<
  RebuildRecreateOnboardOpts,
  | "harnessPackage"
  | "agent"
  | "endpointSource"
  | "recreateProvider"
  | "recreateModel"
  | "recreatePreferredInferenceApi"
  | "fromDockerfile"
  | "sandboxGpu"
  | "sandboxGpuDevice"
  | "controlUiPort"
  | "hostMounts"
  | "targetGatewayName"
  | "targetGatewayPort"
  | "toolDisclosure"
  | "dcodeAutoApprovalMode"
  | "observabilityEnabled"
  | "policyTier"
>;

function readRebuildPackageAuthority(
  entry: {
    readonly harnessPackage?: HarnessPackageIdentity | null;
    readonly harnessPackageMigration?: HarnessPackageMigration | null;
  },
): RebuildPackageAuthority {
  const state = inspectHarnessPackageState(entry.harnessPackage, entry.harnessPackageMigration);
  if (state.status === "invalid") {
    throw new Error("the source registry harness package authority is malformed");
  }
  return state.status === "valid"
    ? Object.freeze({
        harnessPackage: state.harnessPackage,
        harnessPackageMigration: state.harnessPackageMigration,
      })
    : Object.freeze({ harnessPackage: null, harnessPackageMigration: null });
}

function assertCurrentRebuildSessionPackageAuthority(expected: RebuildPackageAuthority): void {
  const current = onboardSession.loadSession();
  if (!current) {
    throw new Error("The rebuild Session disappeared while its replacement journal was active.");
  }
  const actual = readRebuildPackageAuthority(current);
  if (!rebuildPackageAuthorityMatches(actual, expected)) {
    throw new Error("The rebuild Session harness package authority changed.");
  }
}

/** Re-read the source owner before a rebuild crosses an independently resumable mutation. */
export function assertCurrentRebuildPackageAuthority(
  sandboxName: string,
  expected: RebuildPackageAuthority,
): registry.SandboxEntry {
  const current = registry.getSandbox(sandboxName);
  if (!current) {
    throw new Error(`Cannot rebuild '${sandboxName}': the source registry row disappeared.`);
  }
  const actual = readRebuildPackageAuthority(current);
  if (!rebuildPackageAuthorityMatches(actual, expected)) {
    throw new Error(`Cannot rebuild '${sandboxName}': source harness package authority changed.`);
  }
  return current;
}

export interface RebuildRecreateJournal {
  readonly id: string;
  readonly acceptedTarget: boolean;
  readonly sourceConfirmedAbsent: boolean;
  readonly gatewayAuthority: CheckpointGatewayAuthority;
  readonly targetGeneration: string;
  readonly targetIntentFingerprint: string;
  readonly harnessPackage: HarnessPackageIdentity | null;
  markDeleting(): void;
  observeSourceForDelete(): RebuildRecreateSourcePresence;
  confirmDeleted(): void;
  completeAcceptedTarget(): void;
}

export function fingerprintRebuildRecreateTargetIntent(
  options: RebuildFingerprintOptions,
): string {
  const hostMounts = (options.hostMounts ?? []).map(
    ({ source, target, readOnly, sourceIdentity }) => ({
      source,
      target,
      readOnly,
      sourceIdentity: sourceIdentity
        ? { device: sourceIdentity.device, inode: sourceIdentity.inode }
        : null,
    }),
  );
  return fingerprintSandboxRecreateValue({
    version: 2,
    harnessPackage: options.harnessPackage,
    agent: options.agent ?? null,
    endpointSource: options.endpointSource ?? null,
    provider: options.recreateProvider,
    model: options.recreateModel,
    preferredInferenceApi: options.recreatePreferredInferenceApi,
    fromDockerfile: options.fromDockerfile,
    sandboxGpu: options.sandboxGpu,
    sandboxGpuDevice: options.sandboxGpuDevice,
    controlUiPort: options.controlUiPort,
    // Mount-free and mounted targets share the package-bound version-2 schema.
    // A previous journal did not bind package or mount source authority and
    // remains intentionally incompatible with this stronger fingerprint.
    ...(hostMounts.length > 0 ? { hostMounts } : {}),
    gatewayName: options.targetGatewayName,
    gatewayPort: options.targetGatewayPort,
    toolDisclosure: options.toolDisclosure,
    dcodeAutoApprovalMode: options.dcodeAutoApprovalMode,
    observabilityEnabled: options.observabilityEnabled,
    policyTier: options.policyTier,
  });
}

/** Exact pre-package rebuild fingerprint used only to resume an active v1 journal. */
export function fingerprintLegacyRebuildRecreateTargetIntent(
  options: RebuildFingerprintOptions,
): string {
  const hostMounts = (options.hostMounts ?? []).map(
    ({ source, target, readOnly, sourceIdentity }) => ({
      source,
      target,
      readOnly,
      sourceIdentity: sourceIdentity
        ? { device: sourceIdentity.device, inode: sourceIdentity.inode }
        : null,
    }),
  );
  return fingerprintSandboxRecreateValue({
    version: 1,
    agent: options.agent ?? null,
    endpointSource: options.endpointSource ?? null,
    provider: options.recreateProvider,
    model: options.recreateModel,
    preferredInferenceApi: options.recreatePreferredInferenceApi,
    fromDockerfile: options.fromDockerfile,
    sandboxGpu: options.sandboxGpu,
    sandboxGpuDevice: options.sandboxGpuDevice,
    controlUiPort: options.controlUiPort,
    ...(hostMounts.length > 0 ? { hostMounts } : {}),
    gatewayName: options.targetGatewayName,
    gatewayPort: options.targetGatewayPort,
    toolDisclosure: options.toolDisclosure,
    dcodeAutoApprovalMode: options.dcodeAutoApprovalMode,
    observabilityEnabled: options.observabilityEnabled,
    policyTier: options.policyTier,
  });
}

export const observeRebuildSandbox = observeSandboxOnGateway;

export interface OpenRebuildRecreateJournalInput {
  readonly target: RebuildRecreateJournalTarget;
  readonly expectedGatewayAuthority: CheckpointGatewayAuthority;
  readonly agentName: string;
  readonly targetIntentFingerprint: string;
  /** Exact v1 value admitted only while migrating an already-active journal. */
  readonly legacyTargetIntentFingerprint?: string;
  readonly packageAuthority: RebuildPackageAuthority;
  readonly log: (message: string) => void;
  readonly observe?: RebuildSandboxObserver;
  /**
   * Invoked with ready-to-print lines when gateway authority cannot be
   * revalidated, so the command layer can fail cleanly (#8103).
   */
  readonly onAuthorityRefusal?: (lines: readonly string[]) => void;
}

export function openRebuildRecreateJournal(
  input: OpenRebuildRecreateJournalInput,
): RebuildRecreateJournal {
  const { target, agentName, targetIntentFingerprint, log } = input;
  const observe = input.observe ?? observeRebuildSandbox;
  const sourceEntry = assertCurrentRebuildPackageAuthority(
    target.sandboxName,
    input.packageAuthority,
  );
  if ((sourceEntry.agent ?? "openclaw") !== agentName) {
    throw new Error(
      `Cannot rebuild '${target.sandboxName}': source registry agent authority changed.`,
    );
  }
  // Authority revalidation runs before the destroy phase. Handing the refusal
  // to the caller lets rebuild report the migration and its remedy instead of
  // crashing with a Node stack trace (#8103). The dedicated rebuild resolver
  // permits its narrowly defined managed-service migration.
  let authority: ReturnType<typeof resolveGatewayRebuildAuthority>;
  try {
    authority = resolveGatewayRebuildAuthority({
      gatewayName: target.gatewayName,
      gatewayPort: target.gatewayPort,
    });
    const expectedAuthority = gatewayOwnerFromCheckpoint(input.expectedGatewayAuthority);
    if (
      !sameGatewayOwner(expectedAuthority, authority) &&
      !isManagedPackagedServiceMigration(expectedAuthority, authority)
    ) {
      throw new GatewayAuthorityError(
        "Gateway lifecycle authority changed after authoritative rebuild preflight " +
          `(${describeGatewayOwnerForError(expectedAuthority)} -> ${describeGatewayOwnerForError(authority)}). ` +
          "Retry the rebuild; the current run will not delete the source sandbox.",
      );
    }
  } catch (error) {
    if (!(error instanceof GatewayAuthorityError)) throw error;
    input.onAuthorityRefusal?.(gatewayAuthorityFailureLines(error, "sandbox rebuild"));
    throw error;
  }
  const gatewayAuthority = checkpointGatewayAuthority(authority);
  const observation = observe(target);
  const openingSession = onboardSession.loadSession();
  const openingCheckpoint = openingSession?.checkpoint ?? null;
  const openingTransaction = openingCheckpoint?.sandboxRecreate ?? null;
  const resumedTargetIntentFingerprint =
    openingTransaction?.version === 1 &&
    openingTransaction.targetIntentFingerprint === input.legacyTargetIntentFingerprint
      ? openingTransaction.targetIntentFingerprint
      : targetIntentFingerprint;
  const boundOpeningCheckpoint = openingCheckpoint?.sandboxRecreate
    ? bindCheckpointHarnessPackageAuthority(
        openingCheckpoint,
        input.packageAuthority.harnessPackage,
      )
    : null;
  const active = boundOpeningCheckpoint?.sandboxRecreate ?? null;
  const recovery = active
    ? planSandboxRecreateRecovery(active, observation, sourceEntry)
    : { action: "continue_delete" as const };
  if (recovery.action === "reject") {
    throw new Error(
      `Cannot resume sandbox '${target.sandboxName}' replacement: ${recovery.reason}.`,
    );
  }
  // A registered, ready same-name sandbox carrying the journaled target
  // generation and identity is the replacement this rebuild already proved.
  // The caller must retire the transaction instead of deleting it again.
  const acceptedTarget = recovery.action === "accept_target";

  const bindingSourceEntry = assertCurrentRebuildPackageAuthority(
    target.sandboxName,
    input.packageAuthority,
  );

  const session = onboardSession.updateSession((current) => {
    const hasActiveTransaction = Boolean(current.checkpoint?.sandboxRecreate);
    current.agent = bindingSourceEntry.agent ?? null;
    current.harnessPackage = input.packageAuthority.harnessPackage
      ? structuredClone(input.packageAuthority.harnessPackage)
      : null;
    current.harnessPackageMigration = input.packageAuthority.harnessPackageMigration
      ? structuredClone(input.packageAuthority.harnessPackageMigration)
      : null;
    const checkpoint = hasActiveTransaction
      ? bindCheckpointHarnessPackageAuthority(
          current.checkpoint,
          input.packageAuthority.harnessPackage,
        )
      : deriveCheckpointFromSession(current);
    if (!checkpoint) {
      throw new Error(
        `Sandbox '${target.sandboxName}' replacement checkpoint could not be package-bound.`,
      );
    }
    current.checkpoint = {
      ...checkpoint,
      machineState: current.machine.state,
      updatedAt: new Date().toISOString(),
      sandboxIdentity: decisionSelected({ name: target.sandboxName, agent: agentName }),
      gatewayAuthority: decisionSelected(gatewayAuthority),
    };
    beginSandboxRecreateTransaction(current, {
      sandboxName: target.sandboxName,
      gatewayName: target.gatewayName,
      gatewayPort: target.gatewayPort,
      sourceEntry: bindingSourceEntry,
      observation,
      targetIntentFingerprint: resumedTargetIntentFingerprint,
    });
    return current;
  });

  const transaction = session.checkpoint?.sandboxRecreate;
  if (!transaction || transaction.version !== 2) {
    throw new Error(
      `Sandbox '${target.sandboxName}' replacement journal could not be recorded before deletion.`,
    );
  }
  log(
    `Journaled replacement ${transaction.id} for '${target.sandboxName}' on ${target.gatewayName}:${String(target.gatewayPort)} at phase '${transaction.phase}'`,
  );

  let phase: CheckpointSandboxRecreatePhase = transaction.phase;
  const advance = (next: CheckpointSandboxRecreatePhase): void => {
    onboardSession.updateSession((current) => {
      phase = advanceSandboxRecreateTransaction(current, transaction.id, next).phase;
      return current;
    });
  };

  return {
    id: transaction.id,
    acceptedTarget,
    sourceConfirmedAbsent: recovery.action === "continue_create",
    gatewayAuthority,
    targetGeneration: transaction.targetGeneration,
    targetIntentFingerprint: transaction.targetIntentFingerprint,
    harnessPackage: transaction.harnessPackage,
    markDeleting: () => {
      if (sandboxRecreatePhaseReached(phase, "deleted")) return;
      assertCurrentRebuildPackageAuthority(target.sandboxName, input.packageAuthority);
      advance("deleting");
    },
    observeSourceForDelete: () => {
      assertCurrentRebuildPackageAuthority(target.sandboxName, input.packageAuthority);
      const current = observe(target);
      if (current.state === "missing") return "missing";
      if (
        !transaction.sourceLiveIdentityFingerprint ||
        current.liveIdentityFingerprint !== transaction.sourceLiveIdentityFingerprint
      ) {
        throw new Error(
          `Cannot delete sandbox '${target.sandboxName}': the live same-name sandbox is not the journaled source.`,
        );
      }
      return "source";
    },
    confirmDeleted: () => {
      if (observe(target).state !== "missing") {
        throw new Error(
          `Cannot continue sandbox '${target.sandboxName}' replacement: OpenShell still reports the journaled source after delete.`,
        );
      }
      // The source row may already be absent here. The durable owner is now
      // the Session/checkpoint chain, including migration provenance.
      assertCurrentRebuildSessionPackageAuthority(input.packageAuthority);
      advance("deleted");
    },
    completeAcceptedTarget: () => {
      if (!acceptedTarget) {
        throw new Error(
          `Sandbox '${target.sandboxName}' replacement journal cannot be retired before its replacement is proven.`,
        );
      }
      assertCurrentRebuildPackageAuthority(target.sandboxName, input.packageAuthority);
      for (const next of ["registry_committing", "completed"] as const) {
        if (!sandboxRecreatePhaseReached(phase, next)) advance(next);
      }
      onboardSession.updateSession((current) => {
        clearCompletedSandboxRecreateTransaction(current, transaction.id);
        return current;
      });
    },
  };
}
