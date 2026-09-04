// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isDeepStrictEqual } from "node:util";

import { decisionSelected } from "../state/onboard-checkpoint-decision";
import {
  harnessPackageIdentitiesEqual,
  type HarnessPackageIdentity,
} from "../agent-runtime/package/identity";
import * as onboardSession from "../state/onboard-session";
import * as registry from "../state/registry";
import { checkpointGatewayAuthority } from "./gateway-authority-checkpoint";
import { sameGatewayOwner } from "./gateway-ownership";
import { resolveGatewayTeardownAuthority } from "./gateway-teardown-authority";
import {
  observeSandboxOnGateway,
  type SandboxRecreateObserver,
  type SandboxRecreateTarget,
} from "./sandbox-recreate-probe";
import {
  abandonSandboxRecreateTransaction,
  advanceSandboxRecreateTransaction,
  clearCompletedSandboxRecreateTransaction,
  createSandboxRecreateRuntime,
  fingerprintSandboxRegistryEntry,
  fingerprintSandboxRecreateValue,
  ownSandboxRecreateTransaction,
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
    throw new Error(
      `Cannot ${operation}: sandbox '${target.sandboxName}' registry owner is absent`,
    );
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

/** Capture gateway lifecycle authority and return its delete-edge revalidator. */
export function createOnboardRecreateGatewayAuthorityRevalidator(target: SandboxRecreateTarget): {
  authority: ReturnType<typeof resolveGatewayTeardownAuthority>;
  revalidate: () => void;
} {
  const authority = resolveGatewayTeardownAuthority(target);
  return {
    authority,
    revalidate: () => {
      const currentAuthority = resolveGatewayTeardownAuthority(target);
      if (!sameGatewayOwner(authority, currentAuthority)) {
        throw new Error(
          `Cannot delete sandbox '${target.sandboxName}': its gateway lifecycle authority changed.`,
        );
      }
    },
  };
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
  const active = openingSession.checkpoint?.sandboxRecreate ?? null;
  const legacyTargetIntentFingerprint = fingerprintLegacyOnboardRecreateTargetIntent(input.intent);
  const targetIntentFingerprint =
    active?.targetIntentFingerprint === legacyTargetIntentFingerprint
      ? active.targetIntentFingerprint
      : requestedTargetIntentFingerprint;
  const observe = input.observe ?? observeSandboxOnGateway;
  const gatewayAuthority = createOnboardRecreateGatewayAuthorityRevalidator(target);
  const { authority } = gatewayAuthority;
  const owned = ownSandboxRecreateTransaction({
    sessionStore: {
      loadSession: onboardSession.loadSession,
      updateSession: onboardSession.updateSession,
      compareAndSwapSession: onboardSession.compareAndSwapSession,
    },
    sandboxName: target.sandboxName,
    gatewayName: target.gatewayName,
    gatewayPort: target.gatewayPort,
    targetIntentFingerprint,
    requireSourceEntry: true,
    readRegistryEntry: () =>
      requireCurrentRegistryPackageOwner(
        openingSession,
        target,
        agentName,
        "start sandbox recreate without its source registry row",
      ),
    observe: () => observe(target),
    decorateCheckpoint: (current, checkpoint, now) => ({
      ...checkpoint,
      machineState: current.machine.state,
      updatedAt: now,
      sandboxIdentity: decisionSelected({ name: target.sandboxName, agent: agentName }),
      gatewayAuthority: decisionSelected(checkpointGatewayAuthority(authority)),
    }),
  });
  const { transaction, registryEntry: sourceEntry } = owned;
  if (owned.replacedTransactionId) {
    note(
      `  Replaced void journal ${owned.replacedTransactionId} with ${transaction.id} for '${target.sandboxName}'; its source sandbox is registered and live.`,
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
    () => registry.getSandbox(target.sandboxName),
    gatewayAuthority.revalidate,
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
        if (
          !isDeepStrictEqual(currentTransaction.harnessPackage, replacement.harnessPackage ?? null)
        ) {
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
