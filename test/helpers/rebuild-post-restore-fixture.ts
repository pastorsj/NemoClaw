// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { vi } from "vitest";

import { makeRebuildAgentAuthority } from "../../src/lib/actions/sandbox/rebuild-flow-test-fixtures";

export type RebuildPostRestoreAgent = "openclaw" | "hermes" | "langchain-deepagents-code" | "pi";

/** Create the explicit no-receipt authority used by post-restore compatibility tests. */
export function createPostRestoreAgentAuthority(
  agentName: RebuildPostRestoreAgent,
  expectedVersion?: string,
) {
  const legacyProfile = makeRebuildAgentAuthority(agentName === "openclaw" ? null : agentName);
  const authority = makeRebuildAgentAuthority("nemocua");
  const definition = {
    ...authority.definition,
    displayName:
      agentName === "openclaw" ? "OpenClaw" : agentName === "hermes" ? "Hermes" : agentName,
    runtime: legacyProfile.definition.runtime,
    stateLifecycle: legacyProfile.definition.stateLifecycle,
  };
  return expectedVersion
    ? { ...authority, definition: { ...definition, expectedVersion } }
    : { ...authority, definition };
}

/** Project the current test authority into its registry representation. */
export function createPostRestoreRegistryEntry(
  authority: ReturnType<typeof createPostRestoreAgentAuthority>,
) {
  return {
    name: "alpha",
    agent: authority.recordedAgent,
    harnessPackage: authority.harnessPackage,
    harnessPackageMigration: authority.harnessPackageMigration,
  } as never;
}

/** Project the current test authority into its onboarding-session representation. */
export function createPostRestoreOnboardSession(
  authority: ReturnType<typeof createPostRestoreAgentAuthority>,
) {
  return {
    sandboxName: "alpha",
    agent: authority.recordedAgent,
    harnessPackage: authority.harnessPackage,
    harnessPackageMigration: authority.harnessPackageMigration,
  } as never;
}

/** Build the ordinary successful post-restore phase input. */
export function createPostRestoreInput(
  authority: ReturnType<typeof createPostRestoreAgentAuthority>,
) {
  return {
    sandboxName: "alpha",
    agentAuthority: authority,
    sandboxEntry: {} as never,
    messagingPlan: null,
    backupManifest: null,
    mcpEntries: [],
    restoreSucceeded: true,
    failedPresets: [],
    finalBuiltinPresets: [],
    failedPresetRemovals: [],
    policyPresetReconciliationVerified: true,
    preparedBackupRecovery: false,
    versionCheck: { expectedVersion: null } as never,
    log: vi.fn(),
    bail: vi.fn() as never,
  };
}
