// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, vi } from "vitest";

import * as sandboxAgent from "../../src/lib/onboard/sandbox-agent";
import * as mutableConfigPerms from "../../src/lib/sandbox/mutable-config-perms";
import * as onboardSession from "../../src/lib/state/onboard-session";
import * as registry from "../../src/lib/state/registry";
import * as sandboxVersion from "../../src/lib/sandbox/version";
import * as messagingHostForward from "../../src/lib/actions/sandbox/messaging-host-forward-lifecycle";
import * as processRecovery from "../../src/lib/actions/sandbox/process-recovery";
import * as rebuildConfigHash from "../../src/lib/actions/sandbox/rebuild-config-hash";
import * as rebuildHermesPostRestore from "../../src/lib/actions/sandbox/rebuild-hermes-post-restore";
import * as rebuildMcp from "../../src/lib/actions/sandbox/rebuild-mcp-phase";
import * as rebuildMessaging from "../../src/lib/actions/sandbox/rebuild-messaging-phase";
import * as sessionModels from "../../src/lib/actions/sandbox/reconcile-session-models";
import * as restoredGatewayPairing from "../../src/lib/actions/sandbox/restore-gateway-pairing";

interface RebuildPostRestoreTestContext {
  readonly currentAgentAuthority: () => ReturnType<typeof sandboxAgent.resolveSandboxAgent>;
  readonly currentOnboardSession: () => ReturnType<typeof onboardSession.loadSession>;
  readonly currentRegistryEntry: () => ReturnType<typeof registry.getSandbox>;
  readonly recordOrder: (event: string) => void;
  readonly reset: () => void;
}

/** Install the common successful rebuild boundary used by focused post-restore scenarios. */
export function installRebuildPostRestoreTestHooks(context: RebuildPostRestoreTestContext): void {
  beforeEach(() => {
    context.reset();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(sandboxAgent, "resolveSandboxAgent").mockImplementation(() =>
      context.currentAgentAuthority(),
    );
    vi.spyOn(processRecovery, "executeSandboxExecCommand").mockImplementation(() => {
      context.recordOrder("doctor");
      return { status: 0, stdout: "", stderr: "" };
    });
    vi.spyOn(restoredGatewayPairing, "establishRestoredSandboxGatewayPairing").mockImplementation(
      async () => context.recordOrder("restored-pairing"),
    );
    vi.spyOn(sessionModels, "reconcileStalePinnedSessionModelsAfterRebuild").mockImplementation(
      () => context.recordOrder("reconcile"),
    );
    vi.spyOn(rebuildMessaging, "reapplyMessagingManifestAfterOpenClawDoctor").mockImplementation(
      async () => context.recordOrder("messaging"),
    );
    vi.spyOn(
      rebuildConfigHash,
      "refreshMutableOpenClawConfigHashAfterPostRestoreWrites",
    ).mockImplementation(() => {
      context.recordOrder("config-hash");
      return true;
    });
    vi.spyOn(rebuildConfigHash, "verifyFinalMutableOpenClawConfigHash").mockImplementation(() => {
      context.recordOrder("config-hash-final");
      return true;
    });
    vi.spyOn(mutableConfigPerms, "repairMutableConfigPerms").mockReturnValue({
      applied: true,
      verified: true,
      errors: [],
    });
    vi.spyOn(mutableConfigPerms, "inspectMutableHermesConfigPerms").mockReturnValue({
      verified: true,
      errors: [],
    });
    vi.spyOn(rebuildMcp, "restoreMcpAfterRebuild").mockImplementation(async () => {
      context.recordOrder("mcp");
      return true;
    });
    vi.spyOn(rebuildHermesPostRestore, "restartHermesGatewayAfterStateRestore").mockImplementation(
      (_sandboxName, restartRequired) => (restartRequired ? "restarted" : "not-applicable"),
    );
    vi.spyOn(rebuildHermesPostRestore, "verifyHermesGatewayAfterStateRestore").mockImplementation(
      (_sandboxName, restartRequired) => (restartRequired ? "healthy" : "not-applicable"),
    );
    vi.spyOn(
      rebuildHermesPostRestore,
      "verifyHermesGatewayAfterStateRestoreForCronGate",
    ).mockReturnValue({
      state: "healthy",
      replacementIdentity: { pid: 77, start_time: 903, drain_token: "restore-token" },
    });
    vi.spyOn(
      rebuildHermesPostRestore,
      "completeHermesCronRestoreAfterGatewayReplacement",
    ).mockReturnValue({ pid: 77, start_time: 903, drain_token: "restore-token" });
    vi.spyOn(
      rebuildHermesPostRestore,
      "isHermesCronRestoreDrainMarkerRollbackFailure",
    ).mockReturnValue(false);
    vi.spyOn(registry, "getSandbox").mockImplementation(() => context.currentRegistryEntry());
    vi.spyOn(onboardSession, "loadSession").mockImplementation(() =>
      context.currentOnboardSession(),
    );
    vi.spyOn(registry, "updateSandboxIfCurrent").mockImplementation(
      (expected, updates) => ({ ...expected, ...updates }) as never,
    );
    vi.spyOn(registry, "updateSandbox").mockReturnValue(true);
    vi.spyOn(sandboxVersion, "checkAgentVersion").mockReturnValue({
      sandboxVersion: null,
      expectedVersion: null,
      isStale: false,
      verificationFailed: true,
      detectionMethod: "unavailable",
      unavailableReason: "no-expected-version",
    });
    vi.spyOn(messagingHostForward, "ensureMessagingHostForwardAfterRebuild").mockImplementation(
      () => {
        context.recordOrder("host-forward");
        return true;
      },
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });
}
