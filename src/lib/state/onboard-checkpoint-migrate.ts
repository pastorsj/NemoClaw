// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

import { isObjectRecord, type JsonValue } from "../core/json-types";
import {
  harnessPackageIdentitiesEqual,
  parseHarnessPackageIdentity,
  type HarnessPackageIdentity,
} from "../harness/package-identity";
import type { WebSearchConfig } from "../inference/web-search";
import {
  getActiveChannelIdsFromPlan,
  getDisabledChannelIdsFromPlan,
} from "../messaging/plan-validation";
import { inspectCheckpoint } from "./onboard-checkpoint";
import {
  decisionFromLegacyNullable,
  decisionSelected,
  decisionUnset,
} from "./onboard-checkpoint-decision";
import {
  CHECKPOINT_SCHEMA_VERSION,
  type CheckpointDecision,
  type CheckpointLoadResult,
  type CheckpointMessagingSelection,
  type CheckpointOnboardProfile,
  type CheckpointPortableRuntimeAuthority,
  type CheckpointResourceProfile,
  type CheckpointSandboxIdentity,
  type OnboardCheckpoint,
} from "./onboard-checkpoint-types";
import {
  hasInvalidSessionHarnessPackage,
  normalizeSession,
  SESSION_FILE,
  type Session,
} from "./onboard-session";

export { SESSION_FILE as ONBOARD_CHECKPOINT_SESSION_FILE };

/** Validate and migrate one complete v4 checkpoint without inferring package authority. */
export function migrateCheckpointVersion4(raw: unknown): OnboardCheckpoint | null {
  if (!isObjectRecord(raw) || raw.schemaVersion !== 4) return null;
  const inspected = inspectCheckpoint(raw);
  return inspected.status === "loaded" ? inspected.checkpoint : null;
}

function nullableHarnessPackagesEqual(
  left: HarnessPackageIdentity | null,
  right: HarnessPackageIdentity | null,
): boolean {
  return left === null
    ? right === null
    : right !== null && harnessPackageIdentitiesEqual(left, right);
}

/**
 * Bind a legacy checkpoint to authority already established by its owning
 * Session. This is the only v1 recreate migration: it adds identity without
 * changing any journal progress, timestamp, generation, or fingerprint.
 */
export function bindCheckpointHarnessPackageAuthority(
  checkpoint: OnboardCheckpoint | null,
  desiredIdentity: HarnessPackageIdentity | null,
): OnboardCheckpoint | null {
  if (checkpoint === null) return null;
  if (
    checkpoint.harnessPackage !== null &&
    !nullableHarnessPackagesEqual(checkpoint.harnessPackage, desiredIdentity)
  ) {
    throw new Error("Checkpoint harness package authority does not match its Session");
  }

  const transaction = checkpoint.sandboxRecreate;
  if (
    transaction?.version === 2 &&
    !nullableHarnessPackagesEqual(transaction.harnessPackage, desiredIdentity)
  ) {
    throw new Error("Recreate transaction harness package authority does not match its Session");
  }
  const harnessPackage = desiredIdentity ? structuredClone(desiredIdentity) : null;
  const sandboxRecreate =
    transaction?.version === 1
      ? { ...transaction, version: 2 as const, harnessPackage }
      : transaction;
  if (
    nullableHarnessPackagesEqual(checkpoint.harnessPackage, desiredIdentity) &&
    sandboxRecreate === transaction
  ) {
    return checkpoint;
  }
  return { ...checkpoint, harnessPackage, sandboxRecreate };
}

function inspectResumeCheckpoint(raw: unknown): CheckpointLoadResult {
  if (isObjectRecord(raw) && raw.schemaVersion === 4) {
    const checkpoint = migrateCheckpointVersion4(raw);
    return checkpoint ? { status: "loaded", checkpoint } : { status: "corrupt" };
  }
  return inspectCheckpoint(raw);
}

function identityDecision(session: Session): CheckpointDecision<CheckpointSandboxIdentity> {
  const { sandboxName, agent } = session;
  if (
    session.sandboxPromptProgress.sandboxName &&
    typeof sandboxName === "string" &&
    sandboxName.length > 0 &&
    typeof agent === "string" &&
    agent.length > 0
  ) {
    return decisionSelected({ name: sandboxName, agent });
  }
  return decisionUnset();
}

function webSearchDecision(session: Session): CheckpointDecision<WebSearchConfig> {
  return decisionFromLegacyNullable(
    session.sandboxPromptProgress.webSearch,
    session.webSearchConfig,
    (config) => config,
  );
}

function messagingDecision(session: Session): CheckpointDecision<CheckpointMessagingSelection> {
  return decisionFromLegacyNullable(
    session.sandboxPromptProgress.messaging,
    session.messagingPlan,
    (plan) => ({
      selectedChannels: getActiveChannelIdsFromPlan(plan),
      disabledChannels: getDisabledChannelIdsFromPlan(plan),
    }),
  );
}

function resourceDecision(session: Session): CheckpointDecision<CheckpointResourceProfile> {
  return decisionFromLegacyNullable(
    session.sandboxPromptProgress.resourceProfile,
    session.resourceProfile,
    (profile) => ({ cpu: profile.cpu, memory: profile.memory }),
  );
}

export function deriveCheckpointFromSession(
  session: Session,
  options: {
    profile?: CheckpointOnboardProfile;
    runtimeAuthority?: CheckpointPortableRuntimeAuthority | null;
  } = {},
): OnboardCheckpoint {
  if (hasInvalidSessionHarnessPackage(session)) {
    throw new Error("Cannot derive a checkpoint from invalid harness package authority.");
  }
  const profile = options.profile ?? "default";
  const runtimeAuthority = options.runtimeAuthority ?? null;
  if ((profile === "portable") !== (runtimeAuthority !== null)) {
    throw new Error("Portable onboarding checkpoints require one selected runtime authority.");
  }
  return {
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    sessionId: session.sessionId,
    machineState: session.machine.state,
    updatedAt: session.updatedAt,
    profile: { kind: "selected", value: profile },
    runtimeAuthority: runtimeAuthority
      ? { kind: "selected", value: runtimeAuthority }
      : { kind: "unset" },
    harnessPackage:
      session.harnessPackage == null ? null : parseHarnessPackageIdentity(session.harnessPackage),
    sandboxIdentity: identityDecision(session),
    webSearch: webSearchDecision(session),
    messaging: messagingDecision(session),
    resourceProfile: resourceDecision(session),
    gatewayAuthority: decisionUnset(),
    effectGroups: {},
    bindings: {
      // Provider/inference resume owns and revalidates the primary inference
      // binding before the sandbox phase. This ledger covers only external
      // effects created inside the sandbox phase.
      credentialEnvs: [],
      registeredProviders: [],
    },
    sandboxRecreate: null,
  };
}

export function resolveCheckpointForResume(rawSession: unknown): CheckpointLoadResult {
  if (!isObjectRecord(rawSession)) return { status: "none" };
  if (hasInvalidSessionHarnessPackage(rawSession)) return { status: "corrupt" };

  const inspected = inspectResumeCheckpoint(rawSession.checkpoint);
  if (
    inspected.status === "unsupported_future" ||
    inspected.status === "corrupt" ||
    inspected.status === "legacy"
  ) {
    return inspected;
  }

  if (inspected.status === "loaded") {
    const rawMachine = isObjectRecord(rawSession.machine) ? rawSession.machine : null;
    if (
      rawSession.sessionId !== inspected.checkpoint.sessionId ||
      rawMachine?.state !== inspected.checkpoint.machineState
    ) {
      return { status: "corrupt" };
    }
  }

  const session = normalizeSession(rawSession as JsonValue);
  if (!session) return { status: "none" };

  if (inspected.status === "loaded") {
    // A checkpoint copied from another session's file would otherwise supply
    // identity, bindings, and effect receipts for the wrong onboarding run.
    if (
      inspected.checkpoint.sessionId !== session.sessionId ||
      inspected.checkpoint.machineState !== session.machine.state
    ) {
      return { status: "corrupt" };
    }
    if (
      session.harnessPackage !== null &&
      inspected.checkpoint.harnessPackage != null &&
      !harnessPackageIdentitiesEqual(session.harnessPackage, inspected.checkpoint.harnessPackage)
    ) {
      return { status: "corrupt" };
    }
    return inspected;
  }

  return { status: "legacy" };
}

export function loadResumeCheckpoint(): CheckpointLoadResult {
  if (!fs.existsSync(SESSION_FILE)) return { status: "none" };
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(SESSION_FILE, "utf-8"));
  } catch {
    return { status: "corrupt" };
  }
  return resolveCheckpointForResume(raw);
}
