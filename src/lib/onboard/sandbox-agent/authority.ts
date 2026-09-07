// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { requireCandidateQualificationEnabled } from "../../agent/candidate";
import {
  createImmutableAgentDefinition,
  loadAgent,
  loadAgentFresh,
  type AgentDefinition,
} from "../../agent/defs";
import { buildAgentDefinition } from "../../agent-runtime/manifest-loader";
import {
  inspectHarnessPackageState,
  type HarnessPackageIdentity,
  type HarnessPackageMigration,
} from "../../agent-runtime/package/identity";
import {
  resolvePinnedHarnessPackage,
  type HarnessPackageStoreOptions,
} from "../../agent-runtime/package/store";
import type { SandboxEntry } from "../../state/registry/types";
import { normalizeSandboxAgentName } from "./naming";

const SANDBOX_AGENT_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;

/** Load the legacy no-receipt default retained by onboarding compatibility paths. */
export function loadLegacyDefaultAgent(): AgentDefinition {
  return loadAgent("openclaw");
}

export interface ResolvedSandboxAgent {
  readonly recordedAgent: string | null;
  readonly effectiveAgentId: string;
  readonly definition: AgentDefinition;
  readonly harnessPackage: HarnessPackageIdentity | null;
  readonly harnessPackageMigration: HarnessPackageMigration | null;
}

export interface ResolveSandboxAgentOptions extends HarnessPackageStoreOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly requireLifecycleEligibility?: boolean;
}

function sandboxAgentAuthorityError(message: string): Error {
  return new Error(`Sandbox agent authority is invalid: ${message}`);
}

function requireRecordedSandboxAgent(agent: unknown): string | null {
  if (agent === null || agent === undefined) return null;
  if (typeof agent !== "string" || !SANDBOX_AGENT_ID_PATTERN.test(agent)) {
    throw sandboxAgentAuthorityError(
      "the recorded agent must be null or a canonical lowercase hyphen-separated identifier",
    );
  }
  return agent;
}

/** Resolve one sandbox from its durable, exact agent authority without reading mutable registry state. */
export function resolveSandboxAgent(
  entry: Pick<SandboxEntry, "agent" | "harnessPackage" | "harnessPackageMigration">,
  options: ResolveSandboxAgentOptions = {},
): ResolvedSandboxAgent {
  const recordedAgent = requireRecordedSandboxAgent(entry.agent);
  const effectiveAgentId = normalizeSandboxAgentName(recordedAgent);
  const packageState = inspectHarnessPackageState(
    entry.harnessPackage,
    entry.harnessPackageMigration,
  );
  if (options.requireLifecycleEligibility === true && packageState.status !== "valid") {
    // Receipt-backed packages bring their own exact, validated lifecycle
    // authority. Candidate qualification remains a product gate only for the
    // legacy package-free path.
    requireCandidateQualificationEnabled(effectiveAgentId, options.env ?? process.env);
  }

  if (effectiveAgentId === "nemocua") {
    if (packageState.status !== "absent") {
      throw sandboxAgentAuthorityError(
        `qualified agent '${effectiveAgentId}' must not carry harness package authority`,
      );
    }
    return Object.freeze({
      recordedAgent,
      effectiveAgentId,
      definition: loadAgentFresh(effectiveAgentId, options.env ?? process.env),
      harnessPackage: null,
      harnessPackageMigration: null,
    });
  }

  if (packageState.status === "absent") {
    throw sandboxAgentAuthorityError(
      `agent '${effectiveAgentId}' requires legacy package migration before use`,
    );
  }
  if (packageState.status === "invalid") {
    throw sandboxAgentAuthorityError("the recorded harness package identity is malformed");
  }
  if (packageState.harnessPackage.id !== effectiveAgentId) {
    throw sandboxAgentAuthorityError(
      `recorded agent '${effectiveAgentId}' does not match harness package '${packageState.harnessPackage.id}'`,
    );
  }

  const installed = resolvePinnedHarnessPackage(packageState.harnessPackage, {
    ...(options.storeRoot === undefined ? {} : { storeRoot: options.storeRoot }),
  });
  const definition = createImmutableAgentDefinition(
    buildAgentDefinition({
      manifest: installed.packageManifest.manifest,
      manifestPath: installed.packageManifest.manifestPath,
      packageRoot: installed.packageRoot,
    }),
  );
  if (definition.name !== effectiveAgentId || definition.packageRoot !== installed.packageRoot) {
    throw sandboxAgentAuthorityError("the installed definition does not match its package receipt");
  }

  return Object.freeze({
    recordedAgent,
    effectiveAgentId,
    definition,
    harnessPackage: packageState.harnessPackage,
    harnessPackageMigration: packageState.harnessPackageMigration,
  });
}

/** Resolve the durable owner that may authorize one legacy backup manifest. */
export function resolveLegacyBackupRecoveryOwner(
  entry: Pick<SandboxEntry, "agent" | "harnessPackage" | "harnessPackageMigration">,
  options: ResolveSandboxAgentOptions = {},
): string | null {
  const authority = resolveSandboxAgent(entry, options);
  if (authority.harnessPackage === null) return authority.recordedAgent;
  if (
    authority.harnessPackageMigration === null ||
    authority.harnessPackageMigration.legacyAgent !== authority.recordedAgent
  ) {
    throw sandboxAgentAuthorityError(
      "legacy backup owner is missing exact legacy-current-bundle migration provenance",
    );
  }
  return authority.recordedAgent;
}
