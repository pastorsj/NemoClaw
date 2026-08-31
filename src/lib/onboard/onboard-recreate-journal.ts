// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isDeepStrictEqual } from "node:util";

import { decisionSelected } from "../state/onboard-checkpoint-decision";
import {
  harnessPackageIdentitiesEqual,
  type HarnessPackageIdentity,
} from "../agent-runtime/package/identity";
import { deriveCheckpointFromSession } from "../state/onboard-checkpoint-migrate";
import * as onboardSession from "../state/onboard-session";
import * as registry from "../state/registry";
import { checkpointGatewayAuthority } from "./gateway-authority-checkpoint";
import { resolveGatewayTeardownAuthority } from "./gateway-teardown-authority";
import {
  observeSandboxOnGateway,
  type SandboxRecreateObserver,
  type SandboxRecreateTarget,
} from "./sandbox-recreate-probe";
import {
  abandonSandboxRecreateTransaction,
  advanceSandboxRecreateTransaction,
  beginSandboxRecreateTransaction,
  clearCompletedSandboxRecreateTransaction,
  createSandboxRecreateRuntime,
  fingerprintSandboxRegistryEntry,
  fingerprintSandboxRecreateValue,
  planSandboxRecreateRecovery,
  type SandboxRecreateRuntime,
  sandboxRecreatePhaseReached,
} from "./sandbox-recreate-transaction";

export interface OnboardRecreateTargetIntent {
  readonly harnessPackage: HarnessPackageIdentity | null;
  readonly agent: string | null;
  readonly fromDockerfile: string | null;
  readonly provider: string | null;
  readonly model: string | null;
  readonly preferredInferenceApi: string | null;
  readonly sandboxGpuConfig: unknown;
  readonly gatewayName: string;
  readonly gatewayPort: number;
  readonly toolDisclosure: string;
  readonly dcodeAutoApprovalMode: string | null;
  readonly observabilityEnabled: boolean;
  readonly policyTier: string | null;
}

export function fingerprintOnboardRecreateTargetIntent(
  intent: OnboardRecreateTargetIntent,
): string {
  return fingerprintSandboxRecreateValue({ version: 2, ...intent });
}

function fingerprintLegacyOnboardRecreateTargetIntent(intent: OnboardRecreateTargetIntent): string {
  const { harnessPackage: _harnessPackage, ...legacyIntent } = intent;
  return fingerprintSandboxRecreateValue({ version: 1, ...legacyIntent });
}

export interface ManagedMcpRecreateRefusal {
  readonly sandboxName: string;
  readonly cliName: string;
  readonly toolDisclosure: string;
  readonly rebuildFlag: string;
  readonly observabilityFlag: string | null;
}

export function managedMcpRecreateRefusalHints(input: ManagedMcpRecreateRefusal): string[] {
  const observability = input.observabilityFlag ? ` ${input.observabilityFlag}` : "";
  return [
    `  Sandbox '${input.sandboxName}' has managed MCP servers. Refusing the generic onboard recreation path.`,
    `  Run \`${input.cliName} ${input.sandboxName} rebuild --yes --tool-disclosure ${input.toolDisclosure}${observability}${input.rebuildFlag}\` so MCP providers and adapter state are preserved transactionally.`,
  ];
}

export interface OpenOnboardRecreateJournalInput {
  readonly target: SandboxRecreateTarget;
  readonly agentName: string;
  readonly intent: OnboardRecreateTargetIntent;
  readonly note: (message: string) => void;
  readonly observe?: SandboxRecreateObserver;
}

export type OwnedSandboxRecreateRuntime = SandboxRecreateRuntime & {
  complete(): void;
  abandon(): void;
};

function requireCurrentRegistryPackageOwner(
  session: onboardSession.Session,
  target: SandboxRecreateTarget,
  agentName: string,
  operation: string,
): registry.SandboxEntry {
  const entry = registry.getSandbox(target.sandboxName);
  if (!entry) {
    throw new Error(`Cannot ${operation}: sandbox '${target.sandboxName}' registry owner is absent`);
  }
  if (
    (entry.agent ?? "openclaw") !== agentName ||
    !isDeepStrictEqual(session.harnessPackage, entry.harnessPackage ?? null) ||
    !isDeepStrictEqual(session.harnessPackageMigration, entry.harnessPackageMigration ?? null)
  ) {
    throw new Error(`Cannot ${operation}: sandbox registry package authority changed`);
  }
  return entry;
}

export function openOnboardRecreateJournal(
  input: OpenOnboardRecreateJournalInput,
): OwnedSandboxRecreateRuntime {
  const { target, agentName, note } = input;
  const openingSession = onboardSession.loadSession();
  if (!openingSession) {
    throw new Error(`Cannot start sandbox '${target.sandboxName}' recreate without its Session.`);
  }
  const sessionPackageMatches =
    openingSession.harnessPackage === null
      ? input.intent.harnessPackage === null
      : input.intent.harnessPackage !== null &&
        harnessPackageIdentitiesEqual(openingSession.harnessPackage, input.intent.harnessPackage);
  if (!sessionPackageMatches) {
    throw new Error("Cannot start sandbox recreate: target package authority changed");
  }
  const requestedTargetIntentFingerprint = fingerprintOnboardRecreateTargetIntent(input.intent);
  const observe = input.observe ?? observeSandboxOnGateway;
  const authority = resolveGatewayTeardownAuthority({
    gatewayName: target.gatewayName,
    gatewayPort: target.gatewayPort,
  });
  const sourceEntry = requireCurrentRegistryPackageOwner(
    openingSession,
    target,
    agentName,
    "start sandbox recreate without its source registry row",
  );
  const observation = observe(target);
  const active = openingSession.checkpoint?.sandboxRecreate ?? null;
  const legacyTargetIntentFingerprint = fingerprintLegacyOnboardRecreateTargetIntent(input.intent);
  const targetIntentFingerprint =
    active?.targetIntentFingerprint === legacyTargetIntentFingerprint
      ? active.targetIntentFingerprint
      : requestedTargetIntentFingerprint;
  if (active) {
    const recovery = planSandboxRecreateRecovery(active, observation, sourceEntry);
    if (recovery.action === "reject") {
      throw new Error(
        `Cannot resume sandbox '${target.sandboxName}' replacement: ${recovery.reason}.`,
      );
    }
  }

  const session = onboardSession.updateSession((current) => {
    if (
      current.sessionId !== openingSession.sessionId ||
      !isDeepStrictEqual(current.harnessPackage, openingSession.harnessPackage) ||
      !isDeepStrictEqual(current.harnessPackageMigration, openingSession.harnessPackageMigration)
    ) {
      throw new Error("Cannot start sandbox recreate: owning Session authority changed");
    }
    if (!isDeepStrictEqual(current.checkpoint, openingSession.checkpoint)) {
      throw new Error("Cannot start sandbox recreate: owning Session checkpoint changed");
    }
    const mutationSourceEntry = requireCurrentRegistryPackageOwner(
      current,
      target,
      agentName,
      "open sandbox recreate journal",
    );
    if (!isDeepStrictEqual(mutationSourceEntry, sourceEntry)) {
      throw new Error("Cannot start sandbox recreate: source registry owner changed");
    }
    const checkpoint = current.checkpoint ?? deriveCheckpointFromSession(current);
    current.checkpoint = {
      ...checkpoint,
      machineState: current.machine.state,
      updatedAt: new Date().toISOString(),
      sandboxIdentity: decisionSelected({ name: target.sandboxName, agent: agentName }),
      gatewayAuthority: decisionSelected(checkpointGatewayAuthority(authority)),
    };
    beginSandboxRecreateTransaction(current, {
      sandboxName: target.sandboxName,
      gatewayName: target.gatewayName,
      gatewayPort: target.gatewayPort,
      sourceEntry: mutationSourceEntry,
      observation,
      targetIntentFingerprint,
    });
    return current;
  });

  const transaction = session.checkpoint?.sandboxRecreate;
  if (!transaction) {
    throw new Error(
      `Sandbox '${target.sandboxName}' replacement journal could not be recorded before deletion.`,
    );
  }
  note(
    `  Journaled replacement ${transaction.id} for '${target.sandboxName}' on ${target.gatewayName}:${String(target.gatewayPort)} at phase '${transaction.phase}'.`,
  );

  const runtime = createSandboxRecreateRuntime(
    {
      loadSession: onboardSession.loadSession,
      updateSession: onboardSession.updateSession,
      compareAndSwapSession: onboardSession.compareAndSwapSession,
    },
    {
      version: 2,
      id: transaction.id,
      targetGeneration: transaction.targetGeneration,
      targetIntentFingerprint: transaction.targetIntentFingerprint,
      harnessPackage: transaction.version === 2 ? transaction.harnessPackage : null,
    },
    target.sandboxName,
    target.gatewayName,
    sourceEntry,
    (sandboxName, gatewayName) => observe({ ...target, sandboxName, gatewayName }),
    note,
    registry.getSandbox,
  );

  return {
    ...runtime,
    get registrationFields() {
      return runtime.registrationFields;
    },
    abandon: () => {
      onboardSession.updateSession((current) => {
        const currentTransaction = current.checkpoint?.sandboxRecreate;
        if (!currentTransaction || currentTransaction.id !== transaction.id) {
          throw new Error("Cannot abandon sandbox recreate: transaction ownership changed");
        }
        const currentSource = requireCurrentRegistryPackageOwner(
          current,
          target,
          agentName,
          "abandon sandbox recreate",
        );
        if (
          fingerprintSandboxRegistryEntry(currentSource) !==
          currentTransaction.sourceRegistryFingerprint
        ) {
          throw new Error("Cannot abandon sandbox recreate: source registry owner changed");
        }
        abandonSandboxRecreateTransaction(current, transaction.id);
        return current;
      });
    },
    // This journal has no outer owner, so it retires its own transaction once
    // the replacement registry row commits.
    complete: () => {
      onboardSession.updateSession((current) => {
        const currentTransaction = current.checkpoint?.sandboxRecreate;
        if (
          !currentTransaction ||
          currentTransaction.version !== 2 ||
          currentTransaction.id !== transaction.id
        ) {
          throw new Error("Cannot complete sandbox recreate: transaction ownership changed");
        }
        const replacement = requireCurrentRegistryPackageOwner(
          current,
          target,
          agentName,
          "complete sandbox recreate",
        );
        if (!isDeepStrictEqual(currentTransaction.harnessPackage, replacement.harnessPackage ?? null)) {
          throw new Error("Cannot complete sandbox recreate: replacement registry owner changed");
        }
        for (const next of ["registry_committing", "completed"] as const) {
          const phase = current.checkpoint?.sandboxRecreate?.phase;
          if (phase && sandboxRecreatePhaseReached(phase, next)) continue;
          advanceSandboxRecreateTransaction(current, transaction.id, next);
        }
        clearCompletedSandboxRecreateTransaction(current, transaction.id);
        return current;
      });
    },
  };
}
