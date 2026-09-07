// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import * as sandboxAgent from "../../onboard/sandbox-agent";
import * as mutableConfigPerms from "../../sandbox/mutable-config-perms";
import * as onboardSession from "../../state/onboard-session";
import * as registry from "../../state/registry";
import * as sandboxVersion from "../../sandbox/version";
import * as messagingHostForward from "./messaging-host-forward-lifecycle";
import * as processRecovery from "./process-recovery";
import * as rebuildConfigHash from "./rebuild-config-hash";
import { makeRebuildAgentAuthority } from "./rebuild-flow-test-fixtures";
import * as rebuildHermesPostRestore from "./rebuild-hermes-post-restore";
import * as rebuildMcp from "./rebuild-mcp-phase";
import * as rebuildMessaging from "./rebuild-messaging-phase";
import * as stateLifecycle from "./state-lifecycle";
import { runRebuildPostRestorePhase } from "./rebuild-post-restore-phase";
import * as sessionModels from "./reconcile-session-models";
import * as restoredGatewayPairing from "./restore-gateway-pairing";
import {
  createPostRestoreAgentAuthority,
  createPostRestoreInput,
  createPostRestoreOnboardSession,
  createPostRestoreRegistryEntry,
  type RebuildPostRestoreAgent,
} from "../../../../test/helpers/rebuild-post-restore-fixture";
import { installRebuildPostRestoreTestHooks } from "./rebuild-support";

describe("rebuild post-restore phase", () => {
  let agentName: RebuildPostRestoreAgent;
  let agentExpectedVersion: string | undefined;
  let order: string[];

  function currentAgentAuthority() {
    return createPostRestoreAgentAuthority(agentName, agentExpectedVersion);
  }

  function currentRegistryEntry() {
    return createPostRestoreRegistryEntry(currentAgentAuthority());
  }

  function currentOnboardSession() {
    return createPostRestoreOnboardSession(currentAgentAuthority());
  }

  installRebuildPostRestoreTestHooks({
    currentAgentAuthority,
    currentOnboardSession,
    currentRegistryEntry,
    recordOrder: (event) => order.push(event),
    reset: () => {
      agentName = "openclaw";
      agentExpectedVersion = undefined;
      order = [];
    },
  });

  function input() {
    return createPostRestoreInput(currentAgentAuthority());
  }

  it("runs an unknown receipt-backed package only through its typed state declaration", async () => {
    const futureReceipt = {
      kind: "agent-runtime" as const,
      id: "future-harness",
      packageVersion: "9.8.7",
      contentDigest: "b".repeat(64),
    };
    const futureAuthority = {
      recordedAgent: futureReceipt.id,
      effectiveAgentId: futureReceipt.id,
      harnessPackage: futureReceipt,
      harnessPackageMigration: null,
      definition: {
        ...currentAgentAuthority().definition,
        name: futureReceipt.id,
        displayName: "Future Harness",
        managedImage: {
          runtime_identity: { uid: 1234, gid: 1235, workdir: "/sandbox" },
        },
        stateLifecycle: {
          backup_quiescence: { kind: "not-required" },
          snapshot_restore: [],
          rebuild: {
            managed_extensions: {
              support: "disabled",
              reason: "Test package has no managed extensions.",
            },
            scheduled_work: { support: "disabled", reason: "No scheduled work." },
            post_restore: {
              kind: "managed",
              command: {
                command: ["/opt/future/bin/restore-state", "--after-rebuild"],
                timeout_seconds: 31,
              },
              reapply_messaging: false,
              restart_runtime: false,
              mutable_config: "not-required",
              config_integrity: { kind: "not-required" },
              settle_device_pairing: false,
              notify_gateway_token_change: false,
            },
          },
        },
      },
    } as never;
    vi.mocked(registry.getSandbox).mockReturnValue({
      name: "alpha",
      agent: futureReceipt.id,
      harnessPackage: futureReceipt,
      harnessPackageMigration: null,
    } as never);
    vi.mocked(onboardSession.loadSession).mockReturnValue({
      sandboxName: "alpha",
      agent: futureReceipt.id,
      harnessPackage: futureReceipt,
      harnessPackageMigration: null,
    } as never);
    vi.mocked(sandboxAgent.resolveSandboxAgent).mockReturnValue(futureAuthority);
    const stateCommand = vi
      .spyOn(stateLifecycle, "executeReceiptBackedStateCommand")
      .mockReturnValue({ kind: "completed" });
    const args = { ...input(), agentAuthority: futureAuthority };

    const result = await runRebuildPostRestorePhase(args);

    expect(result).toEqual({ mutableConfigPermissionsVerified: true });
    expect(stateCommand).toHaveBeenCalledWith(
      "alpha",
      expect.objectContaining({ harnessPackage: futureReceipt }),
      expect.objectContaining({ name: "future-harness" }),
      {
        command: ["/opt/future/bin/restore-state", "--after-rebuild"],
        timeout_seconds: 31,
      },
    );
    expect(processRecovery.executeSandboxExecCommand).not.toHaveBeenCalled();
    expect(rebuildHermesPostRestore.restartHermesGatewayAfterStateRestore).not.toHaveBeenCalled();
    expect(restoredGatewayPairing.establishRestoredSandboxGatewayPairing).not.toHaveBeenCalled();
  });

  it("rejects a pre-contract action list when package receipt authority is present", async () => {
    const invalidReceiptAuthority = makeRebuildAgentAuthority("hermes");
    vi.mocked(registry.getSandbox).mockReturnValue({
      name: "alpha",
      agent: invalidReceiptAuthority.recordedAgent,
      harnessPackage: invalidReceiptAuthority.harnessPackage,
      harnessPackageMigration: null,
    } as never);
    vi.mocked(onboardSession.loadSession).mockReturnValue({
      sandboxName: "alpha",
      agent: invalidReceiptAuthority.recordedAgent,
      harnessPackage: invalidReceiptAuthority.harnessPackage,
      harnessPackageMigration: null,
    } as never);
    vi.mocked(sandboxAgent.resolveSandboxAgent).mockReturnValue(invalidReceiptAuthority);
    const args = { ...input(), agentAuthority: invalidReceiptAuthority };

    await runRebuildPostRestorePhase(args);

    expect(args.bail).toHaveBeenCalledWith(
      "Receipt-backed package state lifecycle authority is invalid.",
    );
    expect(processRecovery.executeSandboxExecCommand).not.toHaveBeenCalled();
    expect(rebuildHermesPostRestore.restartHermesGatewayAfterStateRestore).not.toHaveBeenCalled();
    expect(restoredGatewayPairing.establishRestoredSandboxGatewayPairing).not.toHaveBeenCalled();
  });

  it("reconciles sessions after doctor, then seals config after MCP restoration (#7102, #9946)", async () => {
    await runRebuildPostRestorePhase(input());

    expect(order).toEqual([
      "doctor",
      "reconcile",
      "messaging",
      "mcp",
      "config-hash",
      "config-hash-final",
      "restored-pairing",
      "host-forward",
      "config-hash-final",
    ]);
    expect(processRecovery.executeSandboxExecCommand).toHaveBeenCalledExactlyOnceWith(
      "alpha",
      "openclaw doctor --fix",
      300_000,
      { allowLocalDockerFallback: false },
    );
    expect(
      restoredGatewayPairing.establishRestoredSandboxGatewayPairing,
    ).toHaveBeenCalledExactlyOnceWith("alpha");
  });

  it("stops publication when restored OpenClaw gateway pairing fails", async () => {
    vi.mocked(restoredGatewayPairing.establishRestoredSandboxGatewayPairing).mockRejectedValue(
      new Error(
        "could not establish gateway pairing for 'alpha': authenticated gateway verification run failed",
      ),
    );
    const args = input();

    await runRebuildPostRestorePhase(args);

    expect(registry.updateSandboxIfCurrent).not.toHaveBeenCalled();
    expect(messagingHostForward.ensureMessagingHostForwardAfterRebuild).not.toHaveBeenCalled();
    expect(args.log).toHaveBeenCalledWith(
      "Restored OpenClaw gateway pairing failed: could not establish gateway pairing for 'alpha': authenticated gateway verification run failed",
    );
    expect(args.bail).toHaveBeenCalledWith(
      "OpenClaw gateway pairing could not be restored after rebuild.",
    );
  });

  it("stops publication when agent authority changes during restored gateway pairing", async () => {
    const args = input();
    let currentSession: NonNullable<ReturnType<typeof onboardSession.loadSession>> =
      currentOnboardSession();
    vi.mocked(onboardSession.loadSession).mockImplementation(() => currentSession);
    vi.mocked(restoredGatewayPairing.establishRestoredSandboxGatewayPairing).mockImplementation(
      async () => {
        currentSession = {
          ...currentSession,
          harnessPackage: {
            ...args.agentAuthority.harnessPackage!,
            contentDigest: "b".repeat(64),
          },
        } as never;
      },
    );

    await runRebuildPostRestorePhase(args);

    expect(registry.updateSandboxIfCurrent).not.toHaveBeenCalled();
    expect(args.bail).toHaveBeenCalledWith(
      "Recreated sandbox agent identity did not match the authoritative rebuild target.",
    );
  });

  it("binds Hermes restart, verification, and MCP restore to rebuild authority", async () => {
    agentName = "hermes";
    const args = input();

    await runRebuildPostRestorePhase(args);

    const agentDefinition = args.agentAuthority.definition;
    expect(rebuildHermesPostRestore.restartHermesGatewayAfterStateRestore).toHaveBeenCalledWith(
      "alpha",
      true,
      { agentDefinition },
    );
    expect(rebuildMcp.restoreMcpAfterRebuild).toHaveBeenCalledWith(
      "alpha",
      [],
      agentDefinition,
      undefined,
    );
    expect(rebuildHermesPostRestore.verifyHermesGatewayAfterStateRestore).toHaveBeenCalledWith(
      "alpha",
      true,
      "restarted",
      { agentDefinition },
    );
    expect(restoredGatewayPairing.establishRestoredSandboxGatewayPairing).not.toHaveBeenCalled();
  });

  it("does not apply the managed gateway pairing gate to a terminal agent runtime", async () => {
    agentName = "pi";

    await runRebuildPostRestorePhase(input());

    expect(restoredGatewayPairing.establishRestoredSandboxGatewayPairing).not.toHaveBeenCalled();
  });

  it("stops every harness-owned repair when the recreated Session authority drifts", async () => {
    const args = input();
    vi.mocked(onboardSession.loadSession).mockReturnValue({
      sandboxName: "alpha",
      agent: args.agentAuthority.recordedAgent,
      harnessPackage: {
        ...args.agentAuthority.harnessPackage!,
        contentDigest: "b".repeat(64),
      },
      harnessPackageMigration: args.agentAuthority.harnessPackageMigration,
    } as never);

    await runRebuildPostRestorePhase(args);

    expect(sandboxAgent.resolveSandboxAgent).not.toHaveBeenCalled();
    expect(processRecovery.executeSandboxExecCommand).not.toHaveBeenCalled();
    expect(sessionModels.reconcileStalePinnedSessionModelsAfterRebuild).not.toHaveBeenCalled();
    expect(rebuildMessaging.reapplyMessagingManifestAfterOpenClawDoctor).not.toHaveBeenCalled();
    expect(mutableConfigPerms.repairMutableConfigPerms).not.toHaveBeenCalled();
    expect(
      rebuildConfigHash.refreshMutableOpenClawConfigHashAfterPostRestoreWrites,
    ).not.toHaveBeenCalled();
    expect(rebuildHermesPostRestore.restartHermesGatewayAfterStateRestore).not.toHaveBeenCalled();
    expect(rebuildMcp.restoreMcpAfterRebuild).not.toHaveBeenCalled();
    expect(registry.updateSandboxIfCurrent).not.toHaveBeenCalled();
    expect(messagingHostForward.ensureMessagingHostForwardAfterRebuild).not.toHaveBeenCalled();
    expect(args.bail).toHaveBeenCalledWith(
      "Recreated sandbox agent identity did not match the authoritative rebuild target.",
    );
  });

  it("stops later mutations when Session authority drifts during OpenClaw doctor", async () => {
    const args = input();
    let currentSession: NonNullable<ReturnType<typeof onboardSession.loadSession>> =
      currentOnboardSession();
    vi.mocked(onboardSession.loadSession).mockImplementation(() => currentSession);
    vi.mocked(processRecovery.executeSandboxExecCommand).mockImplementation(() => {
      currentSession = {
        ...currentSession,
        harnessPackage: {
          ...args.agentAuthority.harnessPackage!,
          contentDigest: "b".repeat(64),
        },
      } as never;
      return { status: 0, stdout: "", stderr: "" };
    });

    await runRebuildPostRestorePhase(args);

    expect(sessionModels.reconcileStalePinnedSessionModelsAfterRebuild).not.toHaveBeenCalled();
    expect(rebuildMessaging.reapplyMessagingManifestAfterOpenClawDoctor).not.toHaveBeenCalled();
    expect(mutableConfigPerms.repairMutableConfigPerms).not.toHaveBeenCalled();
    expect(rebuildHermesPostRestore.restartHermesGatewayAfterStateRestore).not.toHaveBeenCalled();
    expect(rebuildMcp.restoreMcpAfterRebuild).not.toHaveBeenCalled();
    expect(registry.updateSandboxIfCurrent).not.toHaveBeenCalled();
    expect(args.bail).toHaveBeenCalledWith(
      "Recreated sandbox agent identity did not match the authoritative rebuild target.",
    );
  });

  it("stops messaging replay when Session authority drifts during session-model reconciliation", async () => {
    const args = input();
    let currentSession: NonNullable<ReturnType<typeof onboardSession.loadSession>> =
      currentOnboardSession();
    vi.mocked(onboardSession.loadSession).mockImplementation(() => currentSession);
    vi.mocked(sessionModels.reconcileStalePinnedSessionModelsAfterRebuild).mockImplementation(
      () => {
        currentSession = {
          ...currentSession,
          harnessPackage: {
            ...args.agentAuthority.harnessPackage!,
            contentDigest: "b".repeat(64),
          },
        } as never;
      },
    );

    await runRebuildPostRestorePhase(args);

    expect(rebuildMessaging.reapplyMessagingManifestAfterOpenClawDoctor).not.toHaveBeenCalled();
    expect(mutableConfigPerms.repairMutableConfigPerms).not.toHaveBeenCalled();
    expect(rebuildHermesPostRestore.restartHermesGatewayAfterStateRestore).not.toHaveBeenCalled();
    expect(rebuildMcp.restoreMcpAfterRebuild).not.toHaveBeenCalled();
    expect(registry.updateSandboxIfCurrent).not.toHaveBeenCalled();
    expect(args.bail).toHaveBeenCalledWith(
      "Recreated sandbox agent identity did not match the authoritative rebuild target.",
    );
  });

  it("preserves Hermes cron recovery when recreated package receipt verification fails", async () => {
    agentName = "hermes";
    vi.mocked(sandboxAgent.resolveSandboxAgent).mockImplementation(() => {
      throw new Error("package object no longer matches its receipt");
    });
    const args = {
      ...input(),
      backupManifest: { backupPath: "/tmp/alpha-backup" } as never,
      hermesCronRestoreIdentity: {
        pid: 41,
        start_time: 902,
        drain_token: "restore-token",
      },
    };

    await runRebuildPostRestorePhase(args);

    expect(rebuildHermesPostRestore.restartHermesGatewayAfterStateRestore).not.toHaveBeenCalled();
    expect(rebuildMcp.restoreMcpAfterRebuild).not.toHaveBeenCalled();
    expect(registry.updateSandboxIfCurrent).not.toHaveBeenCalled();
    expect(args.bail).toHaveBeenCalledWith(
      "Recreated sandbox agent identity did not match the authoritative rebuild target.",
    );
    const output = vi.mocked(console.error).mock.calls.flat().join("\n");
    expect(output).toContain("Hermes cron dispatch remains drained");
    expect(output).toContain("Backup is preserved at: /tmp/alpha-backup");
    expect(output).toContain("nemoclaw alpha recover");
  });

  it("rejects malformed present package authority instead of treating it as candidate absence", async () => {
    agentName = "pi";
    const malformedCandidateSession = onboardSession.normalizeSession({
      ...onboardSession.createSession({ agent: "pi", sandboxName: "alpha" }),
      harnessPackage: { id: "pi" },
      harnessPackageMigration: null,
    } as never);
    expect(malformedCandidateSession).not.toBeNull();
    expect(onboardSession.hasInvalidSessionHarnessPackage(malformedCandidateSession)).toBe(true);
    vi.mocked(onboardSession.loadSession).mockReturnValue(malformedCandidateSession);
    const args = input();

    await runRebuildPostRestorePhase(args);

    expect(sandboxAgent.resolveSandboxAgent).not.toHaveBeenCalled();
    expect(rebuildHermesPostRestore.restartHermesGatewayAfterStateRestore).not.toHaveBeenCalled();
    expect(rebuildMcp.restoreMcpAfterRebuild).not.toHaveBeenCalled();
    expect(registry.updateSandboxIfCurrent).not.toHaveBeenCalled();
    expect(args.bail).toHaveBeenCalledWith(
      "Recreated sandbox agent identity did not match the authoritative rebuild target.",
    );
  });

  it("stops later mutations when Session authority drifts during awaited messaging replay", async () => {
    const args = input();
    let currentSession: NonNullable<ReturnType<typeof onboardSession.loadSession>> =
      currentOnboardSession();
    vi.mocked(onboardSession.loadSession).mockImplementation(() => currentSession);
    vi.mocked(rebuildMessaging.reapplyMessagingManifestAfterOpenClawDoctor).mockImplementation(
      async () => {
        currentSession = {
          ...currentSession,
          harnessPackage: {
            ...args.agentAuthority.harnessPackage!,
            contentDigest: "b".repeat(64),
          },
        } as never;
      },
    );

    await runRebuildPostRestorePhase(args);

    expect(mutableConfigPerms.repairMutableConfigPerms).not.toHaveBeenCalled();
    expect(rebuildHermesPostRestore.restartHermesGatewayAfterStateRestore).not.toHaveBeenCalled();
    expect(rebuildMcp.restoreMcpAfterRebuild).not.toHaveBeenCalled();
    expect(registry.updateSandboxIfCurrent).not.toHaveBeenCalled();
    expect(messagingHostForward.ensureMessagingHostForwardAfterRebuild).not.toHaveBeenCalled();
    expect(args.bail).toHaveBeenCalledWith(
      "Recreated sandbox agent identity did not match the authoritative rebuild target.",
    );
  });

  it("stops gateway restart when Session authority drifts during permission repair", async () => {
    const args = input();
    let currentSession: NonNullable<ReturnType<typeof onboardSession.loadSession>> =
      currentOnboardSession();
    vi.mocked(onboardSession.loadSession).mockImplementation(() => currentSession);
    vi.mocked(mutableConfigPerms.repairMutableConfigPerms).mockImplementation(() => {
      currentSession = {
        ...currentSession,
        harnessPackage: {
          ...args.agentAuthority.harnessPackage!,
          contentDigest: "b".repeat(64),
        },
      } as never;
      return {
        applied: false,
        reason: "not needed",
        skipReason: "not-needed",
      } as never;
    });

    await runRebuildPostRestorePhase(args);

    expect(mutableConfigPerms.repairMutableConfigPerms).toHaveBeenCalledOnce();
    expect(rebuildHermesPostRestore.restartHermesGatewayAfterStateRestore).not.toHaveBeenCalled();
    expect(rebuildMcp.restoreMcpAfterRebuild).not.toHaveBeenCalled();
    expect(registry.updateSandboxIfCurrent).not.toHaveBeenCalled();
    expect(args.bail).toHaveBeenCalledWith(
      "Recreated sandbox agent identity did not match the authoritative rebuild target.",
    );
  });

  it("keeps Hermes cron recovery ahead of finalization when authority drifts during MCP restore", async () => {
    agentName = "hermes";
    const args = {
      ...input(),
      backupManifest: { backupPath: "/tmp/alpha-backup" } as never,
      hermesCronRestoreIdentity: {
        pid: 41,
        start_time: 902,
        drain_token: "restore-token",
      },
    };
    let currentEntry: NonNullable<ReturnType<typeof registry.getSandbox>> = currentRegistryEntry();
    vi.mocked(registry.getSandbox).mockImplementation(() => currentEntry);
    vi.mocked(rebuildMcp.restoreMcpAfterRebuild).mockImplementation(async () => {
      currentEntry = {
        ...currentEntry,
        harnessPackage: {
          ...args.agentAuthority.harnessPackage!,
          contentDigest: "b".repeat(64),
        },
      } as never;
      return true;
    });

    await runRebuildPostRestorePhase(args);

    expect(
      rebuildHermesPostRestore.verifyHermesGatewayAfterStateRestoreForCronGate,
    ).not.toHaveBeenCalled();
    expect(
      rebuildHermesPostRestore.completeHermesCronRestoreAfterGatewayReplacement,
    ).not.toHaveBeenCalled();
    expect(registry.updateSandboxIfCurrent).not.toHaveBeenCalled();
    const output = vi.mocked(console.error).mock.calls.flat().join("\n");
    expect(output).toContain("Hermes cron dispatch remains drained");
    expect(output).toContain("Backup is preserved at: /tmp/alpha-backup");
    expect(output).toContain("nemoclaw alpha recover");
  });

  it("stops hash verification when Session authority drifts during config hash refresh", async () => {
    const args = input();
    let currentSession: NonNullable<ReturnType<typeof onboardSession.loadSession>> =
      currentOnboardSession();
    vi.mocked(onboardSession.loadSession).mockImplementation(() => currentSession);
    vi.mocked(
      rebuildConfigHash.refreshMutableOpenClawConfigHashAfterPostRestoreWrites,
    ).mockImplementation(() => {
      currentSession = {
        ...currentSession,
        harnessPackage: {
          ...args.agentAuthority.harnessPackage!,
          contentDigest: "b".repeat(64),
        },
      } as never;
      return true;
    });

    await runRebuildPostRestorePhase(args);

    expect(rebuildConfigHash.verifyFinalMutableOpenClawConfigHash).not.toHaveBeenCalled();
    expect(registry.updateSandboxIfCurrent).not.toHaveBeenCalled();
    expect(messagingHostForward.ensureMessagingHostForwardAfterRebuild).not.toHaveBeenCalled();
    expect(args.bail).toHaveBeenCalledWith(
      "Recreated sandbox agent identity did not match the authoritative rebuild target.",
    );
  });

  it("stops MCP restoration when registry authority drifts during Hermes restart", async () => {
    agentName = "hermes";
    const args = input();
    let currentEntry: NonNullable<ReturnType<typeof registry.getSandbox>> = currentRegistryEntry();
    vi.mocked(registry.getSandbox).mockImplementation(() => currentEntry);
    vi.mocked(rebuildHermesPostRestore.restartHermesGatewayAfterStateRestore).mockImplementation(
      () => {
        currentEntry = {
          ...currentEntry,
          harnessPackage: {
            ...args.agentAuthority.harnessPackage!,
            contentDigest: "b".repeat(64),
          },
        } as never;
        return "restarted";
      },
    );

    await runRebuildPostRestorePhase(args);

    expect(rebuildMcp.restoreMcpAfterRebuild).not.toHaveBeenCalled();
    expect(rebuildHermesPostRestore.verifyHermesGatewayAfterStateRestore).not.toHaveBeenCalled();
    expect(registry.updateSandboxIfCurrent).not.toHaveBeenCalled();
    expect(args.bail).toHaveBeenCalledWith(
      "Recreated sandbox agent identity did not match the authoritative rebuild target.",
    );
  });

  it("keeps Hermes cron drained when Session authority drifts before gate release", async () => {
    agentName = "hermes";
    const args = {
      ...input(),
      backupManifest: { backupPath: "/tmp/alpha-backup" } as never,
      hermesCronRestoreIdentity: {
        pid: 41,
        start_time: 902,
        drain_token: "restore-token",
      },
    };
    let currentSession: NonNullable<ReturnType<typeof onboardSession.loadSession>> =
      currentOnboardSession();
    vi.mocked(onboardSession.loadSession).mockImplementation(() => currentSession);
    vi.mocked(
      rebuildHermesPostRestore.verifyHermesGatewayAfterStateRestoreForCronGate,
    ).mockImplementation(() => {
      currentSession = {
        ...currentSession,
        harnessPackage: {
          ...args.agentAuthority.harnessPackage!,
          contentDigest: "b".repeat(64),
        },
      } as never;
      return {
        state: "healthy",
        replacementIdentity: { pid: 77, start_time: 903, drain_token: "restore-token" },
      };
    });

    await runRebuildPostRestorePhase(args);

    expect(
      rebuildHermesPostRestore.completeHermesCronRestoreAfterGatewayReplacement,
    ).not.toHaveBeenCalled();
    expect(registry.updateSandboxIfCurrent).not.toHaveBeenCalled();
    expect(args.bail).toHaveBeenCalledWith(
      "Recreated sandbox agent identity did not match the authoritative rebuild target.",
    );
    const output = vi.mocked(console.error).mock.calls.flat().join("\n");
    expect(output).toContain("Hermes cron dispatch remains drained");
    expect(output).toContain("Backup is preserved at: /tmp/alpha-backup");
    expect(output).toContain("nemoclaw alpha recover");
  });

  it("reuses the MCP rebuild target for every post-restore sandbox command (#10514)", async () => {
    vi.stubEnv("OPENSHELL_GATEWAY", "hostile-gateway");
    vi.stubEnv("OPENSHELL_WORKSPACE", "hostile-workspace");
    vi.stubEnv("OPENSHELL_LOCAL_TLS_DIR", "/hostile/tls");
    vi.stubEnv("OPENSHELL_GATEWAY_ENDPOINT", "https://hostile.invalid");
    const runtimeSelection = {
      gatewayName: "recorded-gateway",
      workspace: "default",
      localTlsDir: "/authority/tls",
    };
    const args = { ...input(), mcpRuntimeSelection: runtimeSelection };

    await runRebuildPostRestorePhase(args);

    expect(processRecovery.executeSandboxExecCommand).toHaveBeenCalledWith(
      "alpha",
      "openclaw doctor --fix",
      300_000,
      { allowLocalDockerFallback: false, runtimeSelection },
    );
    expect(rebuildMessaging.reapplyMessagingManifestAfterOpenClawDoctor).toHaveBeenCalledWith(
      "alpha",
      null,
      args.log,
      runtimeSelection,
    );
    expect(sessionModels.reconcileStalePinnedSessionModelsAfterRebuild).toHaveBeenCalledWith(
      "alpha",
      args.log,
      runtimeSelection,
    );
    expect(
      rebuildConfigHash.refreshMutableOpenClawConfigHashAfterPostRestoreWrites,
    ).toHaveBeenCalledExactlyOnceWith("alpha", args.log, runtimeSelection);
    expect(vi.mocked(rebuildConfigHash.verifyFinalMutableOpenClawConfigHash).mock.calls).toEqual([
      ["alpha", args.log, runtimeSelection],
      ["alpha", args.log, runtimeSelection],
    ]);
    expect(process.env.OPENSHELL_GATEWAY).toBe("hostile-gateway");
  });

  it("refuses frozen Hermes supervisor authority when the recreated gateway binding changed", async () => {
    agentName = "hermes";
    vi.mocked(registry.getSandbox).mockReturnValue({
      agent: "hermes",
      gatewayName: "nemoclaw-19081",
      gatewayPort: 19081,
    } as never);
    const args = {
      ...input(),
      mcpRuntimeSelection: {
        gatewayName: "nemoclaw-19080",
        workspace: "default",
      },
    };

    await runRebuildPostRestorePhase(args);

    expect(args.bail).toHaveBeenCalledWith(
      "Recreated sandbox agent identity did not match the authoritative rebuild target.",
    );
    expect(rebuildHermesPostRestore.restartHermesGatewayAfterStateRestore).not.toHaveBeenCalled();
  });

  it("does not record a final hash without trusted doctor completion (#9946)", async () => {
    vi.mocked(processRecovery.executeSandboxExecCommand).mockReturnValue(null);
    const args = input();

    await runRebuildPostRestorePhase(args);

    expect(
      rebuildConfigHash.refreshMutableOpenClawConfigHashAfterPostRestoreWrites,
    ).not.toHaveBeenCalled();
    expect(rebuildConfigHash.verifyFinalMutableOpenClawConfigHash).not.toHaveBeenCalled();
    expect(rebuildMcp.restoreMcpAfterRebuild).not.toHaveBeenCalled();
    expect(messagingHostForward.ensureMessagingHostForwardAfterRebuild).not.toHaveBeenCalled();
    expect(args.bail).toHaveBeenCalledWith(
      "OpenClaw post-upgrade structure repair completion was not verified after rebuild.",
    );
    const output = vi.mocked(console.log).mock.calls.flat().join("\n");
    expect(output).toContain("Post-upgrade structure repair completion was not verified");
    expect(output).not.toContain("rebuilt successfully");
  });

  it("does not seal OpenClaw config after unverified MCP restoration (#9946)", async () => {
    vi.mocked(rebuildMcp.restoreMcpAfterRebuild).mockResolvedValue(false);
    const args = input();

    await runRebuildPostRestorePhase(args);

    expect(
      rebuildConfigHash.refreshMutableOpenClawConfigHashAfterPostRestoreWrites,
    ).not.toHaveBeenCalled();
    expect(rebuildConfigHash.verifyFinalMutableOpenClawConfigHash).not.toHaveBeenCalled();
    expect(args.bail).not.toHaveBeenCalled();
    const output = vi.mocked(console.log).mock.calls.flat().join("\n");
    expect(output).toContain("Mutable OpenClaw config hash was not refreshed");
    expect(output).toContain("MCP bridge definitions were preserved but not fully refreshed");
    expect(output).not.toContain("rebuilt successfully");
  });

  it("stops before later writes when doctor exits nonzero (#9946)", async () => {
    vi.mocked(processRecovery.executeSandboxExecCommand).mockReturnValue({
      status: 255,
      stdout: "",
      stderr: "",
    });
    const args = input();

    await runRebuildPostRestorePhase(args);

    expect(sessionModels.reconcileStalePinnedSessionModelsAfterRebuild).not.toHaveBeenCalled();
    expect(rebuildMessaging.reapplyMessagingManifestAfterOpenClawDoctor).not.toHaveBeenCalled();
    expect(mutableConfigPerms.repairMutableConfigPerms).not.toHaveBeenCalled();
    expect(rebuildHermesPostRestore.restartHermesGatewayAfterStateRestore).not.toHaveBeenCalled();
    expect(rebuildHermesPostRestore.verifyHermesGatewayAfterStateRestore).not.toHaveBeenCalled();
    expect(rebuildMcp.restoreMcpAfterRebuild).not.toHaveBeenCalled();
    expect(
      rebuildConfigHash.refreshMutableOpenClawConfigHashAfterPostRestoreWrites,
    ).not.toHaveBeenCalled();
    expect(rebuildConfigHash.verifyFinalMutableOpenClawConfigHash).not.toHaveBeenCalled();
    expect(messagingHostForward.ensureMessagingHostForwardAfterRebuild).not.toHaveBeenCalled();
    expect(args.bail).toHaveBeenCalledWith(
      "OpenClaw post-upgrade structure repair failed during rebuild.",
    );
    const output = vi.mocked(console.log).mock.calls.flat().join("\n");
    expect(output).toContain("Post-upgrade structure repair failed (doctor returned 255)");
    expect(output).not.toContain("rebuilt successfully");
  });

  it("stops rebuild when OpenClaw messaging config reapply fails", async () => {
    vi.mocked(rebuildMessaging.reapplyMessagingManifestAfterOpenClawDoctor).mockRejectedValue(
      new Error("config write failed"),
    );
    const args = input();

    await runRebuildPostRestorePhase(args);

    expect(mutableConfigPerms.repairMutableConfigPerms).not.toHaveBeenCalled();
    expect(rebuildMcp.restoreMcpAfterRebuild).not.toHaveBeenCalled();
    expect(messagingHostForward.ensureMessagingHostForwardAfterRebuild).not.toHaveBeenCalled();
    expect(args.bail).toHaveBeenCalledWith(
      "OpenClaw messaging manifest config reapply failed during rebuild.",
    );
    expect(args.log).toHaveBeenCalledWith("Messaging manifest reapply failed: config write failed");
    const output = vi.mocked(console.error).mock.calls.flat().join("\n");
    expect(output).toContain("Messaging manifest config reapply failed after doctor");
  });

  it("captures a completed doctor mutation and rejects a later config change (#9946)", async () => {
    let configHashValid = true;
    vi.mocked(processRecovery.executeSandboxExecCommand).mockImplementation(() => {
      configHashValid = false;
      return { status: 0, stdout: "sensitive doctor output", stderr: "" };
    });
    vi.mocked(
      rebuildConfigHash.refreshMutableOpenClawConfigHashAfterPostRestoreWrites,
    ).mockImplementation(() => {
      configHashValid = true;
      return true;
    });
    vi.mocked(messagingHostForward.ensureMessagingHostForwardAfterRebuild).mockImplementation(
      () => {
        configHashValid = false;
        return true;
      },
    );
    vi.mocked(rebuildConfigHash.verifyFinalMutableOpenClawConfigHash).mockImplementation(
      () => configHashValid,
    );
    const args = input();

    await runRebuildPostRestorePhase(args);

    expect(
      rebuildConfigHash.refreshMutableOpenClawConfigHashAfterPostRestoreWrites,
    ).toHaveBeenCalledOnce();
    expect(rebuildConfigHash.verifyFinalMutableOpenClawConfigHash).toHaveBeenCalledTimes(2);
    expect(args.bail).toHaveBeenCalledWith(
      "OpenClaw config integrity verification failed after rebuild.",
    );
    const output = vi.mocked(console.log).mock.calls.flat().join("\n");
    const diagnosticLog = vi.mocked(args.log).mock.calls.flat().join("\n");
    expect(output).toContain(
      "Final OpenClaw configuration hash verification failed after post-restore finalization",
    );
    expect(output).not.toContain("Mutable OpenClaw config hash was not refreshed");
    expect(output).not.toContain("rebuilt successfully");
    expect(diagnosticLog).not.toContain("sensitive doctor output");
  });

  it("does not run OpenClaw session reconciliation for another agent (#7102)", async () => {
    agentName = "hermes";
    const args = input();

    const verification = await runRebuildPostRestorePhase(args);

    expect(args.bail).not.toHaveBeenCalled();
    expect(sessionModels.reconcileStalePinnedSessionModelsAfterRebuild).not.toHaveBeenCalled();
    expect(processRecovery.executeSandboxExecCommand).not.toHaveBeenCalled();
    expect(mutableConfigPerms.inspectMutableHermesConfigPerms).toHaveBeenCalledWith("alpha");
    expect(verification).toEqual({ mutableConfigPermissionsVerified: true });
  });

  it("rejects a replacement whose live version does not match the rebuild target", async () => {
    agentName = "hermes";
    agentExpectedVersion = "0.20.6";
    vi.mocked(sandboxVersion.checkAgentVersion).mockReturnValue({
      sandboxVersion: "0.19.0",
      expectedVersion: "0.20.6",
      isStale: true,
      verificationFailed: false,
      detectionMethod: "ssh-exec",
    });
    const args = {
      ...input(),
      versionCheck: { expectedVersion: "0.20.6" } as never,
      hermesCronRestoreIdentity: {
        pid: 41,
        start_time: 902,
        drain_token: "restore-token",
      },
    };

    await runRebuildPostRestorePhase(args);

    expect(sandboxVersion.checkAgentVersion).toHaveBeenCalledWith("alpha", { forceProbe: true });
    expect(registry.updateSandbox).toHaveBeenNthCalledWith(1, "alpha", {
      agentVersion: null,
    });
    expect(registry.updateSandbox).toHaveBeenNthCalledWith(2, "alpha", {
      agentVersion: null,
    });
    expect(registry.updateSandbox).not.toHaveBeenCalledWith(
      "alpha",
      expect.objectContaining({ agentVersion: expect.stringMatching(/.+/) }),
    );
    expect(args.bail).toHaveBeenCalledWith(
      "Replacement agent version did not match the authoritative rebuild target.",
    );
    expect(
      rebuildHermesPostRestore.completeHermesCronRestoreAfterGatewayReplacement,
    ).not.toHaveBeenCalled();
    expect(messagingHostForward.ensureMessagingHostForwardAfterRebuild).not.toHaveBeenCalled();
    expect(vi.mocked(console.error).mock.calls.flat().join("\n")).toContain(
      "Hermes cron dispatch remains drained",
    );
    expect(vi.mocked(console.log).mock.calls.flat().join("\n")).not.toContain(
      "rebuilt successfully",
    );
  });

  it("records the live replacement version only after an exact forced probe", async () => {
    agentName = "hermes";
    agentExpectedVersion = "0.20.6";
    vi.mocked(sandboxVersion.checkAgentVersion).mockReturnValue({
      sandboxVersion: "0.20.6",
      expectedVersion: "0.20.6",
      isStale: false,
      verificationFailed: false,
      detectionMethod: "ssh-exec",
    });
    const args = {
      ...input(),
      versionCheck: { expectedVersion: "0.20.6" } as never,
    };

    await runRebuildPostRestorePhase(args);

    expect(sandboxVersion.checkAgentVersion).toHaveBeenCalledWith("alpha", { forceProbe: true });
    expect(registry.updateSandbox).toHaveBeenCalledWith("alpha", { agentVersion: null });
    expect(registry.updateSandboxIfCurrent).toHaveBeenCalledWith(
      expect.objectContaining({ name: "alpha" }),
      { agentVersion: "0.20.6" },
    );
    expect(args.bail).not.toHaveBeenCalled();
    expect(vi.mocked(console.log).mock.calls.flat().join("\n")).toContain(
      "Sandbox 'alpha' rebuild completed",
    );
  });

  it("keeps cron dispatch blocked through replacement health verification (#8472)", async () => {
    agentName = "hermes";
    const events: string[] = [];
    let dispatchHeld = true;
    const attemptDispatch = () => events.push(dispatchHeld ? "dispatch-blocked" : "dispatch-ran");
    vi.mocked(rebuildHermesPostRestore.restartHermesGatewayAfterStateRestore).mockImplementation(
      () => {
        events.push("restart");
        attemptDispatch();
        return "restarted";
      },
    );
    vi.mocked(rebuildMcp.restoreMcpAfterRebuild).mockImplementation(async () => {
      events.push("mcp");
      attemptDispatch();
      return true;
    });
    vi.mocked(
      rebuildHermesPostRestore.verifyHermesGatewayAfterStateRestoreForCronGate,
    ).mockImplementation(() => {
      events.push("health-verified");
      attemptDispatch();
      return {
        state: "healthy",
        replacementIdentity: { pid: 77, start_time: 903, drain_token: "restore-token" },
      };
    });
    vi.mocked(
      rebuildHermesPostRestore.completeHermesCronRestoreAfterGatewayReplacement,
    ).mockImplementation(() => {
      events.push("release");
      dispatchHeld = false;
      return { pid: 77, start_time: 903, drain_token: "restore-token" };
    });
    vi.mocked(messagingHostForward.ensureMessagingHostForwardAfterRebuild).mockImplementation(
      () => {
        attemptDispatch();
        return true;
      },
    );
    const args = {
      ...input(),
      hermesCronRestoreIdentity: {
        pid: 41,
        start_time: 902,
        drain_token: "restore-token",
      },
    };

    await runRebuildPostRestorePhase(args);

    expect(events).toEqual([
      "restart",
      "dispatch-blocked",
      "mcp",
      "dispatch-blocked",
      "health-verified",
      "dispatch-blocked",
      "release",
      "dispatch-ran",
    ]);
    expect(rebuildHermesPostRestore.restartHermesGatewayAfterStateRestore).toHaveBeenCalledOnce();
    expect(args.log).toHaveBeenCalledWith(
      "Hermes cron restore gate released: pid=77, startTime=903",
    );
    expect(
      rebuildHermesPostRestore.completeHermesCronRestoreAfterGatewayReplacement,
    ).toHaveBeenCalledWith(
      "alpha",
      { pid: 41, start_time: 902, drain_token: "restore-token" },
      { pid: 77, start_time: 903, drain_token: "restore-token" },
    );
    expect(args.bail).not.toHaveBeenCalled();
  });

  it("leaves the cron gate active when replacement verification fails (#8472)", async () => {
    agentName = "hermes";
    vi.mocked(
      rebuildHermesPostRestore.verifyHermesGatewayAfterStateRestoreForCronGate,
    ).mockReturnValue({ state: "unverified" });
    const args = {
      ...input(),
      hermesCronRestoreIdentity: {
        pid: 41,
        start_time: 902,
        drain_token: "restore-token",
      },
    };

    await runRebuildPostRestorePhase(args);

    expect(
      rebuildHermesPostRestore.completeHermesCronRestoreAfterGatewayReplacement,
    ).not.toHaveBeenCalled();
    expect(args.bail).toHaveBeenCalledWith(
      "Hermes cron restore validation failed; dispatch was not re-enabled.",
    );
    expect(messagingHostForward.ensureMessagingHostForwardAfterRebuild).not.toHaveBeenCalled();
    expect(vi.mocked(console.error).mock.calls.flat().join("\n")).toContain(
      "Hermes cron dispatch remains drained",
    );
  });

  it("keeps restart failure ahead of MCP repair and final verification (#8472)", async () => {
    agentName = "hermes";
    const events: string[] = [];
    vi.mocked(rebuildHermesPostRestore.restartHermesGatewayAfterStateRestore).mockImplementation(
      () => {
        events.push("restart-failed");
        return "restart-failed";
      },
    );
    vi.mocked(rebuildMcp.restoreMcpAfterRebuild).mockImplementation(async () => {
      events.push("mcp");
      return true;
    });
    vi.mocked(
      rebuildHermesPostRestore.verifyHermesGatewayAfterStateRestoreForCronGate,
    ).mockImplementation((_sandboxName, _agentName, restartState) => {
      events.push(`verify:${restartState}`);
      return { state: "unverified" };
    });
    const args = {
      ...input(),
      hermesCronRestoreIdentity: {
        pid: 41,
        start_time: 902,
        drain_token: "restore-token",
      },
    };

    await runRebuildPostRestorePhase(args);

    expect(events).toEqual(["restart-failed", "mcp", "verify:restart-failed"]);
    expect(
      rebuildHermesPostRestore.completeHermesCronRestoreAfterGatewayReplacement,
    ).not.toHaveBeenCalled();
    expect(args.bail).toHaveBeenCalledWith(
      "Hermes cron restore validation failed; dispatch was not re-enabled.",
    );
  });

  it("leaves the cron gate active when replacement completion fails (#8472)", async () => {
    agentName = "hermes";
    vi.mocked(
      rebuildHermesPostRestore.completeHermesCronRestoreAfterGatewayReplacement,
    ).mockImplementation(() => {
      throw new Error("replacement cron tree is invalid");
    });
    const args = {
      ...input(),
      backupManifest: { backupPath: "/tmp/alpha-backup" } as never,
      hermesCronRestoreIdentity: {
        pid: 41,
        start_time: 902,
        drain_token: "restore-token",
      },
    };

    await runRebuildPostRestorePhase(args);

    expect(args.bail).toHaveBeenCalledWith(
      "Hermes cron restore validation failed; dispatch was not re-enabled.",
    );
    expect(messagingHostForward.ensureMessagingHostForwardAfterRebuild).not.toHaveBeenCalled();
    const output = vi.mocked(console.error).mock.calls.flat().join("\n");
    expect(output).toContain("replacement cron tree is invalid");
    expect(output).toContain("Backup is preserved at: /tmp/alpha-backup");
    expect(output).toContain("nemoclaw alpha recover");
  });

  it("reports preserved recovery authority when release marker rollback fails (#8472)", async () => {
    agentName = "hermes";
    const rollbackFailure = new Error(
      "Hermes cron complete failed: Hermes cron restore drain release failed and its marker could not be restored",
    );
    vi.mocked(
      rebuildHermesPostRestore.completeHermesCronRestoreAfterGatewayReplacement,
    ).mockImplementation(() => {
      throw rollbackFailure;
    });
    vi.mocked(
      rebuildHermesPostRestore.isHermesCronRestoreDrainMarkerRollbackFailure,
    ).mockImplementation((error) => error === rollbackFailure);
    const args = {
      ...input(),
      hermesCronRestoreIdentity: {
        pid: 41,
        start_time: 902,
        drain_token: "restore-token",
      },
    };

    await runRebuildPostRestorePhase(args);

    expect(args.bail).toHaveBeenCalledWith(
      "Hermes cron restore release state requires immediate recovery.",
    );
    const output = vi.mocked(console.error).mock.calls.flat().join("\n");
    expect(output).toContain("drain release failed and its marker could not be restored");
    expect(output).toContain("root-owned recovery state was preserved");
    expect(output).toContain("reacquire the gate and validate restored cron state");
    expect(output).toContain("nemoclaw alpha recover");
    expect(output).not.toContain("dispatch was not re-enabled");
    expect(
      rebuildHermesPostRestore.isHermesCronRestoreDrainMarkerRollbackFailure,
    ).toHaveBeenCalledWith(rollbackFailure);
  });

  it("keeps the gate active and repairs MCP before cron recovery (#8472)", async () => {
    agentName = "hermes";
    vi.mocked(rebuildMcp.restoreMcpAfterRebuild).mockResolvedValue(false);
    const args = {
      ...input(),
      hermesCronRestoreIdentity: {
        pid: 41,
        start_time: 902,
        drain_token: "restore-token",
      },
    };

    await runRebuildPostRestorePhase(args);

    expect(
      rebuildHermesPostRestore.completeHermesCronRestoreAfterGatewayReplacement,
    ).not.toHaveBeenCalled();
    expect(args.bail).toHaveBeenCalledWith(
      "Hermes MCP restoration failed; cron dispatch was not re-enabled.",
    );
    const mcpCall = vi
      .mocked(console.log)
      .mock.calls.findIndex((call) => String(call[0]).includes("nemoclaw alpha mcp restart"));
    const recoverCall = vi
      .mocked(console.error)
      .mock.calls.findIndex((call) => String(call[0]).includes("nemoclaw alpha recover"));
    expect(mcpCall).toBeGreaterThanOrEqual(0);
    expect(recoverCall).toBeGreaterThanOrEqual(0);
    expect(vi.mocked(console.log).mock.invocationCallOrder[mcpCall]).toBeLessThan(
      vi.mocked(console.error).mock.invocationCallOrder[recoverCall] ?? 0,
    );
  });

  it("repairs MCP before cron recovery when gateway verification also fails (#8472)", async () => {
    agentName = "hermes";
    vi.mocked(rebuildMcp.restoreMcpAfterRebuild).mockResolvedValue(false);
    vi.mocked(
      rebuildHermesPostRestore.verifyHermesGatewayAfterStateRestoreForCronGate,
    ).mockReturnValue({ state: "unverified" });
    const args = {
      ...input(),
      hermesCronRestoreIdentity: {
        pid: 41,
        start_time: 902,
        drain_token: "restore-token",
      },
    };

    await runRebuildPostRestorePhase(args);

    expect(
      rebuildHermesPostRestore.completeHermesCronRestoreAfterGatewayReplacement,
    ).not.toHaveBeenCalled();
    const mcpCall = vi
      .mocked(console.log)
      .mock.calls.findIndex((call) => String(call[0]).includes("nemoclaw alpha mcp restart"));
    const recoverCall = vi
      .mocked(console.error)
      .mock.calls.findIndex((call) => String(call[0]).includes("nemoclaw alpha recover"));
    expect(mcpCall).toBeGreaterThanOrEqual(0);
    expect(recoverCall).toBeGreaterThanOrEqual(0);
    expect(vi.mocked(console.log).mock.invocationCallOrder[mcpCall]).toBeLessThan(
      vi.mocked(console.error).mock.invocationCallOrder[recoverCall] ?? 0,
    );
  });

  it("points Hermes rebuilds to the replacement API token retrieval command (#7175)", async () => {
    agentName = "hermes";

    await runRebuildPostRestorePhase(input());

    const outputLines = vi.mocked(console.log).mock.calls.flat().map(String);
    const output = outputLines.join("\n");
    expect(output).toContain("Hermes API bearer token changed during rebuild");
    expect(output).toContain("nemoclaw alpha gateway-token --quiet");
    expect(
      outputLines.findIndex((line) => line.includes("API bearer token changed")),
    ).toBeGreaterThan(outputLines.findIndex((line) => line.includes("rebuilt successfully")));
  });

  it("does not print the Hermes API token notice for OpenClaw rebuilds (#7175)", async () => {
    await runRebuildPostRestorePhase(input());

    const output = vi.mocked(console.log).mock.calls.flat().join("\n");
    expect(output).not.toContain("Hermes API bearer token");
    expect(output).not.toContain("gateway-token --quiet");
  });

  it("does not print the Hermes API token notice when post-restore verification is incomplete (#7175)", async () => {
    agentName = "hermes";
    vi.mocked(rebuildHermesPostRestore.verifyHermesGatewayAfterStateRestore).mockReturnValue(
      "unverified",
    );
    const args = input();

    await runRebuildPostRestorePhase(args);

    const output = vi.mocked(console.log).mock.calls.flat().join("\n");
    expect(output).not.toContain("Hermes API bearer token changed during rebuild");
    expect(output).not.toContain("gateway-token --quiet");
    expect(args.bail).toHaveBeenCalledWith("Hermes post-restore verification failed for 'alpha'.");
  });

  it("still prints the Hermes API token notice when a non-fatal post-restore step is unverified (#7175)", async () => {
    agentName = "hermes";
    vi.mocked(messagingHostForward.ensureMessagingHostForwardAfterRebuild).mockReturnValue(false);
    const args = input();

    await runRebuildPostRestorePhase(args);

    const output = vi.mocked(console.log).mock.calls.flat().join("\n");
    expect(args.bail).not.toHaveBeenCalled();
    expect(output).toContain("rebuilt but some post-restore steps were incomplete");
    expect(output).toContain("Hermes API bearer token changed during rebuild");
    expect(output).toContain("nemoclaw alpha gateway-token --quiet");
  });

  it("does not print the Hermes API token notice when prepared backup recovery is incomplete (#7175)", async () => {
    agentName = "hermes";
    vi.mocked(messagingHostForward.ensureMessagingHostForwardAfterRebuild).mockReturnValue(false);
    const args = input();
    args.preparedBackupRecovery = true;

    await runRebuildPostRestorePhase(args);

    const output = vi.mocked(console.log).mock.calls.flat().join("\n");
    expect(output).not.toContain("Hermes API bearer token changed during rebuild");
    expect(output).not.toContain("gateway-token --quiet");
    expect(args.bail).toHaveBeenCalledWith(
      "Prepared backup recovery for 'alpha' completed with unverified post-restore state.",
    );
  });

  it("prints the Hermes API token notice after gateway recovery (#7175)", async () => {
    agentName = "hermes";
    vi.mocked(rebuildHermesPostRestore.verifyHermesGatewayAfterStateRestore).mockReturnValue(
      "recovered",
    );
    const args = input();

    await runRebuildPostRestorePhase(args);

    const output = vi.mocked(console.log).mock.calls.flat().join("\n");
    expect(args.bail).not.toHaveBeenCalled();
    expect(output).toContain("Hermes gateway recovered after state restore");
    expect(output).toContain("Hermes API bearer token changed during rebuild");
  });

  it("reconciles the registry before verifying host forwarding (#8283)", async () => {
    const observed: string[] = [];
    vi.mocked(registry.updateSandboxIfCurrent).mockImplementation((expected, updates) => {
      observed.push("registry");
      return { ...expected, ...updates } as never;
    });
    vi.mocked(messagingHostForward.ensureMessagingHostForwardAfterRebuild).mockImplementation(
      () => {
        observed.push("forward");
        return true;
      },
    );
    const args = input();

    await runRebuildPostRestorePhase(args);

    expect(observed).toEqual(["registry", "forward"]);
    expect(args.bail).not.toHaveBeenCalled();
  });

  it("stops finalization when the verified registry row loses the conditional update race", async () => {
    vi.mocked(registry.updateSandboxIfCurrent).mockReturnValue(false);
    const args = input();

    await runRebuildPostRestorePhase(args);

    expect(registry.updateSandboxIfCurrent).toHaveBeenCalledOnce();
    expect(messagingHostForward.ensureMessagingHostForwardAfterRebuild).not.toHaveBeenCalled();
    expect(args.bail).toHaveBeenCalledWith(
      "Recreated sandbox agent identity did not match the authoritative rebuild target.",
    );
  });

  it("stops finalization when Session authority drifts during registry publication", async () => {
    const args = input();
    let currentSession: NonNullable<ReturnType<typeof onboardSession.loadSession>> =
      currentOnboardSession();
    vi.mocked(onboardSession.loadSession).mockImplementation(() => currentSession);
    vi.mocked(registry.updateSandboxIfCurrent).mockImplementation((expected, updates) => {
      currentSession = {
        ...currentSession,
        harnessPackage: {
          ...args.agentAuthority.harnessPackage!,
          contentDigest: "b".repeat(64),
        },
      } as never;
      return { ...expected, ...updates } as never;
    });

    await runRebuildPostRestorePhase(args);

    expect(registry.updateSandboxIfCurrent).toHaveBeenCalledOnce();
    expect(messagingHostForward.ensureMessagingHostForwardAfterRebuild).not.toHaveBeenCalled();
    expect(args.bail).toHaveBeenCalledWith(
      "Recreated sandbox agent identity did not match the authoritative rebuild target.",
    );
    expect(vi.mocked(console.log).mock.calls.flat().join("\n")).not.toContain(
      "rebuilt successfully",
    );
  });

  it("does not report success when Session authority drifts during final host forwarding", async () => {
    const args = input();
    let currentSession: NonNullable<ReturnType<typeof onboardSession.loadSession>> =
      currentOnboardSession();
    vi.mocked(onboardSession.loadSession).mockImplementation(() => currentSession);
    vi.mocked(messagingHostForward.ensureMessagingHostForwardAfterRebuild).mockImplementation(
      () => {
        currentSession = {
          ...currentSession,
          harnessPackage: {
            ...args.agentAuthority.harnessPackage!,
            contentDigest: "b".repeat(64),
          },
        } as never;
        return true;
      },
    );

    await runRebuildPostRestorePhase(args);

    expect(messagingHostForward.ensureMessagingHostForwardAfterRebuild).toHaveBeenCalledOnce();
    expect(rebuildConfigHash.verifyFinalMutableOpenClawConfigHash).toHaveBeenCalledOnce();
    expect(args.bail).toHaveBeenCalledWith(
      "Recreated sandbox agent identity did not match the authoritative rebuild target.",
    );
    expect(vi.mocked(console.log).mock.calls.flat().join("\n")).not.toContain(
      "rebuilt successfully",
    );
  });

  it("names the connect recovery command when host forwarding is unverified (#8283)", async () => {
    vi.mocked(messagingHostForward.ensureMessagingHostForwardAfterRebuild).mockReturnValue(false);
    const args = input();

    await runRebuildPostRestorePhase(args);

    const output = vi.mocked(console.log).mock.calls.flat().join("\n");
    expect(output).toContain("Messaging webhook forward was not verified");
    expect(output).toContain("nemoclaw alpha connect");
    expect(args.bail).not.toHaveBeenCalled();
  });

  it("prints every incomplete OpenClaw recovery report in a fixed order (#8283)", async () => {
    vi.mocked(
      rebuildConfigHash.refreshMutableOpenClawConfigHashAfterPostRestoreWrites,
    ).mockReturnValue(false);
    vi.mocked(mutableConfigPerms.repairMutableConfigPerms).mockReturnValue({
      applied: true,
      verified: false,
      errors: ["config is unreadable"],
    });
    vi.mocked(messagingHostForward.ensureMessagingHostForwardAfterRebuild).mockReturnValue(false);
    vi.mocked(rebuildMcp.restoreMcpAfterRebuild).mockResolvedValue(false);
    const args = {
      ...input(),
      backupManifest: { backupPath: "/tmp/alpha-backup" } as never,
      restoreSucceeded: false,
      failedPresets: ["messaging-telegram"],
      failedPresetRemovals: ["messaging-discord"],
      policyPresetReconciliationVerified: false,
    };

    await runRebuildPostRestorePhase(args);

    const output = vi.mocked(console.log).mock.calls.flat().map(String).join("\n");
    // Every incomplete-recovery report this path can emit for an OpenClaw
    // rebuild. The Hermes gateway report is unreachable here because
    // verifyHermesGatewayAfterStateRestore returns "not-applicable" for
    // OpenClaw; baseline exclusions are covered by the #7194 test above.
    const ordered = [
      "State restore was incomplete",
      "Mutable config permissions were not verified",
      "Mutable OpenClaw config hash was not refreshed",
      "Messaging webhook forward was not verified",
      "MCP bridge definitions were preserved but not fully refreshed",
    ];
    const offsets = ordered.map((fragment) => output.indexOf(fragment));
    expect(offsets.every((offset) => offset >= 0)).toBe(true);
    expect(offsets).toEqual([...offsets].sort((left, right) => left - right));
    expect(args.bail).toHaveBeenCalledWith(
      "State restore remained incomplete after rebuilding 'alpha'.",
    );
    expect(vi.mocked(console.error).mock.calls.flat().join("\n")).toContain(
      "nemoclaw alpha rebuild",
    );
  });
});
