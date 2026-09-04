// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { CLI_NAME } from "../../cli/branding";
import { D, G, R, YW } from "../../cli/terminal-style";
import type { SandboxMessagingPlan } from "../../messaging";
import type { ResolvedSandboxAgent } from "../../onboard/sandbox-agent";
import * as sandboxVersion from "../../sandbox/version";
import {
  inspectMutableHermesConfigPerms,
  repairMutableConfigPerms,
} from "../../sandbox/mutable-config-perms";
import * as registry from "../../state/registry";
import { ensureMessagingHostForwardAfterRebuild } from "./messaging-host-forward-lifecycle";
import { executeSandboxExecCommand } from "./process-recovery";
import { verifyCurrentAgentAuthority } from "./rebuild/authority";
import type { RebuildBackupManifest } from "./rebuild-backup-phase";
import {
  refreshMutableOpenClawConfigHashAfterPostRestoreWrites,
  verifyFinalMutableOpenClawConfigHash,
} from "./rebuild-config-hash";
import type { RebuildBail, RebuildLog } from "./rebuild-credential-preflight";
import type { RebuildSandboxEntry } from "./rebuild-flow-helpers";
import {
  completeHermesCronRestoreAfterGatewayReplacement,
  type HermesCronRestoreIdentity,
  isHermesCronRestoreDrainMarkerRollbackFailure,
  printHermesGatewayRestoreRecovery,
  restartHermesGatewayAfterStateRestore,
  verifyHermesGatewayAfterStateRestore,
  verifyHermesGatewayAfterStateRestoreForCronGate,
} from "./rebuild-hermes-post-restore";
import {
  type McpRebuildPreparation,
  postRestoreCompleted,
  printMcpRestoreRecovery,
  restoreMcpAfterRebuild,
} from "./rebuild-mcp-phase";
import {
  finalizePendingMessagingRemovalsAfterRestore,
  reapplyMessagingManifestAfterOpenClawDoctor,
} from "./rebuild-messaging-phase";
import { reconcileStalePinnedSessionModelsAfterRebuild } from "./reconcile-session-models";
import { establishRestoredSandboxGatewayPairing } from "./restore-gateway-pairing";

export {
  type HermesCronRestoreIdentity,
  HermesCronRestoreIncompleteError,
  recoverHermesCronRestore,
  runHermesCronRestoreTransaction,
} from "./rebuild-hermes-post-restore";

/** Probe the recreated runtime instead of accepting its requested version metadata. */
function probeRebuiltAgentVersion(
  sandboxName: string,
): ReturnType<typeof sandboxVersion.checkAgentVersion> {
  return sandboxVersion.checkAgentVersion(sandboxName, { forceProbe: true });
}

const OPENCLAW_DOCTOR_TIMEOUT_MS = 5 * 60_000;

function buildSelectedRuntimeOptions(runtimeSelection: McpRebuildPreparation["runtimeSelection"]): {
  runtimeSelection?: McpRebuildPreparation["runtimeSelection"];
} {
  return runtimeSelection ? { runtimeSelection } : {};
}

export function printHermesCronRestoreRecoveryCommand(
  sandboxName: string,
  writeLine: (message: string) => void = console.error,
): void {
  writeLine(
    `  Correct the reported restore problem, then run \`${CLI_NAME} ${sandboxName} recover\`.`,
  );
}

function bailAfterHermesCronRestoreFailure(
  sandboxName: string,
  backupManifest: RebuildBackupManifest,
  detail: string,
  bailMessage: string,
  bail: RebuildBail,
  beforeCronRecovery?: () => void,
): never {
  console.error(detail);
  if (backupManifest) {
    console.error(`  Backup is preserved at: ${backupManifest.backupPath}`);
  }
  beforeCronRecovery?.();
  printHermesCronRestoreRecoveryCommand(sandboxName);
  return bail(bailMessage);
}

export interface RebuildPostRestorePhaseInput {
  sandboxName: string;
  sandboxEntry: RebuildSandboxEntry;
  agentAuthority: ResolvedSandboxAgent;
  messagingPlan: SandboxMessagingPlan | null;
  backupManifest: RebuildBackupManifest;
  mcpEntries: McpRebuildPreparation["entries"];
  mcpRuntimeSelection?: McpRebuildPreparation["runtimeSelection"];
  restoreSucceeded: boolean;
  hermesCronRestoreIdentity?: HermesCronRestoreIdentity;
  preparedBackupRecovery: boolean;
  versionCheck: ReturnType<typeof sandboxVersion.checkAgentVersion>;
  log: RebuildLog;
  bail: RebuildBail;
}

export interface RebuildPostRestoreVerification {
  readonly mutableConfigPermissionsVerified: boolean;
}

function printHermesApiTokenChangeNotice(sandboxName: string, targetAgentName: string): void {
  if (targetAgentName !== "hermes") {
    return;
  }
  console.log(`    ${YW}\u26a0${R} Hermes API bearer token changed during rebuild.`);
  console.log(
    `    Retrieve the new token with \`${CLI_NAME} ${sandboxName} gateway-token --quiet\`.`,
  );
}

async function restoreOpenClawGatewayPairing(
  sandboxName: string,
  requireCurrentAgentAuthority: (stage: string) => RebuildSandboxEntry | null,
  log: RebuildLog,
  bail: RebuildBail,
): Promise<boolean> {
  if (!requireCurrentAgentAuthority("before restored OpenClaw gateway pairing")) return false;
  log("Establishing restored OpenClaw gateway pairing");
  try {
    await establishRestoredSandboxGatewayPairing(sandboxName);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unexpected-failure";
    log(`Restored OpenClaw gateway pairing failed: ${detail}`);
    bail("OpenClaw gateway pairing could not be restored after rebuild.");
    return false;
  }
  if (!requireCurrentAgentAuthority("after restored OpenClaw gateway pairing")) return false;
  return true;
}

/**
 * Repair agent state, restore MCP/forwarding, reconcile the registry, and report
 * the final transaction result. Boundary coverage: rebuild-flow.test.ts and
 * rebuild-config-hash.test.ts cover the complete/incomplete post-restore paths;
 * rebuild-post-restore-phase.test.ts covers forwarding recovery reports.
 */
export async function runRebuildPostRestorePhase(
  input: RebuildPostRestorePhaseInput,
): Promise<RebuildPostRestoreVerification | undefined> {
  const {
    sandboxName,
    agentAuthority,
    messagingPlan,
    backupManifest,
    mcpEntries,
    mcpRuntimeSelection,
    restoreSucceeded,
    hermesCronRestoreIdentity,
    preparedBackupRecovery,
    versionCheck,
    log,
    bail,
  } = input;
  let hermesCronRestoreCompleted = false;

  const rejectAgentAuthority = (stage: string, issue: string): null => {
    log(`Post-restore agent authority rejected ${stage}: ${issue}`);
    console.error(
      `  ${YW}\u26a0${R} Recreated sandbox agent identity could not be verified against the rebuild target.`,
    );
    if (hermesCronRestoreIdentity && !hermesCronRestoreCompleted) {
      bailAfterHermesCronRestoreFailure(
        sandboxName,
        backupManifest,
        "  Hermes cron dispatch remains drained because the replacement identity is unverified.",
        "Recreated sandbox agent identity did not match the authoritative rebuild target.",
        bail,
      );
      return null;
    }
    bail("Recreated sandbox agent identity did not match the authoritative rebuild target.");
    return null;
  };

  const requireCurrentAgentAuthority = (stage: string): RebuildSandboxEntry | null => {
    let recreatedEntry: RebuildSandboxEntry | null;
    try {
      recreatedEntry = registry.getSandbox(sandboxName);
    } catch {
      return rejectAgentAuthority(stage, "the recreated registry row could not be read");
    }
    const issue = verifyCurrentAgentAuthority(sandboxName, agentAuthority, recreatedEntry);
    return issue ? rejectAgentAuthority(stage, issue) : recreatedEntry;
  };

  let verifiedRecreatedEntry = requireCurrentAgentAuthority("before harness-owned repair");
  if (!verifiedRecreatedEntry) return;
  const targetAgentName = agentAuthority.effectiveAgentId;
  const agentDef = agentAuthority.definition;
  const selectedRuntimeOptions = buildSelectedRuntimeOptions(mcpRuntimeSelection);
  const selectedAgentRuntimeOptions = {
    agentDefinition: agentDef,
    ...selectedRuntimeOptions,
  };
  const rebuiltAgentName = agentDef.displayName;
  let mutablePermsRepairUnverified = false;
  let mutableConfigPermissionsVerified = false;
  let mutableConfigHashRefreshUnverified = false;
  let finalMutableConfigHashUnverified = false;
  let messagingHostForwardUnverified = false;
  let effectiveMessagingPlan = messagingPlan;

  if (targetAgentName === "openclaw") {
    log("Running openclaw doctor --fix inside sandbox for post-upgrade structure repair");
    const doctorResult = executeSandboxExecCommand(
      sandboxName,
      "openclaw doctor --fix",
      OPENCLAW_DOCTOR_TIMEOUT_MS,
      {
        allowLocalDockerFallback: false,
        ...selectedRuntimeOptions,
      },
    );
    log(`doctor --fix: exit=${doctorResult?.status ?? "unverified"}`);
    if (doctorResult === null) {
      console.log(`  ${D}Post-upgrade structure repair completion was not verified${R}`);
      bail("OpenClaw post-upgrade structure repair completion was not verified after rebuild.");
      return;
    }
    if (doctorResult.status !== 0) {
      console.log(
        `  ${D}Post-upgrade structure repair failed (doctor returned ${doctorResult.status})${R}`,
      );
      bail("OpenClaw post-upgrade structure repair failed during rebuild.");
      return;
    }
    console.log(`  ${G}\u2713${R} Post-upgrade structure check passed`);

    verifiedRecreatedEntry = requireCurrentAgentAuthority("after OpenClaw doctor");
    if (!verifiedRecreatedEntry) return;

    // #7102: clear stale per-session pinned models left over from an
    // `inference set` before this rebuild, while the gateway is still down.
    reconcileStalePinnedSessionModelsAfterRebuild(sandboxName, log, mcpRuntimeSelection);

    verifiedRecreatedEntry = requireCurrentAgentAuthority(
      "after OpenClaw session-model reconciliation",
    );
    if (!verifiedRecreatedEntry) return;

    try {
      await reapplyMessagingManifestAfterOpenClawDoctor(
        sandboxName,
        messagingPlan,
        log,
        mcpRuntimeSelection,
      );
    } catch (error) {
      log(
        `Messaging manifest reapply failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      console.error(`  ${YW}\u26a0${R} Messaging manifest config reapply failed after doctor.`);
      bail("OpenClaw messaging manifest config reapply failed during rebuild.");
      return;
    }

    verifiedRecreatedEntry = requireCurrentAgentAuthority("after messaging replay");
    if (!verifiedRecreatedEntry) return;

    log("Restoring mutable OpenClaw config permissions after post-restore config writes");
    let permRepair: ReturnType<typeof repairMutableConfigPerms> | null = null;
    try {
      permRepair = repairMutableConfigPerms(sandboxName);
    } catch (error) {
      mutablePermsRepairUnverified = true;
      console.error(
        `  ${YW}\u26a0${R} Mutable config permission repair errored: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (permRepair === null) {
      // The thrown error was reported above.
    } else if (!permRepair.applied) {
      log(`Mutable config permission repair skipped: ${permRepair.reason}`);
    } else if (permRepair.verified) {
      mutableConfigPermissionsVerified = true;
      console.log(`  ${G}\u2713${R} Mutable config permissions restored`);
    } else {
      mutablePermsRepairUnverified = true;
      console.error(
        `  ${YW}\u26a0${R} Mutable config permission repair incomplete: ${permRepair.errors.join("; ")}`,
      );
    }
  }

  try {
    const finalizedMessagingPlan = finalizePendingMessagingRemovalsAfterRestore(
      effectiveMessagingPlan,
      log,
      mcpRuntimeSelection,
    );
    if (finalizedMessagingPlan !== effectiveMessagingPlan && finalizedMessagingPlan) {
      verifiedRecreatedEntry = requireCurrentAgentAuthority(
        "before pending messaging removal publication",
      );
      if (!verifiedRecreatedEntry) return;
      const updated = registry.updateSandboxIfCurrent(verifiedRecreatedEntry, {
        messaging: { schemaVersion: 1, plan: finalizedMessagingPlan },
      });
      if (!updated) {
        bail("Could not retire pending messaging removals after rebuild.");
        return;
      }
      verifiedRecreatedEntry = updated;
      effectiveMessagingPlan = finalizedMessagingPlan;
    }
  } catch (error) {
    bail(
      `Could not finalize pending messaging removals after rebuild: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return;
  }

  // Restart before restoring MCP. The Hermes MCP transaction performs an
  // acknowledged reload of its own; restarting afterwards would replace the
  // only runtime whose managed MCP configuration was proven to have loaded.
  verifiedRecreatedEntry = requireCurrentAgentAuthority("before Hermes gateway restart");
  if (!verifiedRecreatedEntry) return;
  const hermesGatewayRestartState = restartHermesGatewayAfterStateRestore(
    sandboxName,
    targetAgentName,
    selectedAgentRuntimeOptions,
  );
  verifiedRecreatedEntry = requireCurrentAgentAuthority("before managed MCP restoration");
  if (!verifiedRecreatedEntry) return;
  const mcpBridgeRestoreUnverified = !(await restoreMcpAfterRebuild(
    sandboxName,
    mcpEntries,
    agentDef,
    mcpRuntimeSelection,
  ));
  verifiedRecreatedEntry = requireCurrentAgentAuthority("after managed MCP restoration");
  if (!verifiedRecreatedEntry) return;
  if (targetAgentName === "openclaw" && mcpBridgeRestoreUnverified) {
    mutableConfigHashRefreshUnverified = true;
  } else if (targetAgentName === "openclaw") {
    log("Refreshing mutable OpenClaw config hash after MCP restoration");
    if (
      !refreshMutableOpenClawConfigHashAfterPostRestoreWrites(sandboxName, log, mcpRuntimeSelection)
    ) {
      mutableConfigHashRefreshUnverified = true;
    } else {
      verifiedRecreatedEntry = requireCurrentAgentAuthority(
        "after mutable OpenClaw config hash refresh",
      );
      if (!verifiedRecreatedEntry) return;
      if (!verifyFinalMutableOpenClawConfigHash(sandboxName, log, mcpRuntimeSelection)) {
        finalMutableConfigHashUnverified = true;
      }
    }
  }
  if (targetAgentName === "openclaw") {
    const gatewayRestored = await restoreOpenClawGatewayPairing(
      sandboxName,
      requireCurrentAgentAuthority,
      log,
      bail,
    );
    if (!gatewayRestored) return;
  }
  const hermesGatewayVerification = hermesCronRestoreIdentity
    ? verifyHermesGatewayAfterStateRestoreForCronGate(
        sandboxName,
        targetAgentName,
        hermesGatewayRestartState,
        hermesCronRestoreIdentity,
        selectedAgentRuntimeOptions,
      )
    : {
        state: verifyHermesGatewayAfterStateRestore(
          sandboxName,
          targetAgentName,
          hermesGatewayRestartState,
          selectedAgentRuntimeOptions,
        ),
        replacementIdentity: undefined,
      };
  const hermesGatewayRestoreState = hermesGatewayVerification.state;
  const hermesGatewayRestoreUnverified = hermesGatewayRestoreState === "unverified";
  let verifiedAgentVersion: string | null = null;
  if (versionCheck.expectedVersion) {
    // The replacement runtime is the only authority for the completed rebuild
    // version. Clear create-time bookkeeping before the forced live probe so a
    // failed probe cannot leave the requested version recorded as observed.
    registry.updateSandbox(sandboxName, { agentVersion: null });
    const rebuiltVersion = probeRebuiltAgentVersion(sandboxName);
    if (
      rebuiltVersion.verificationFailed ||
      rebuiltVersion.sandboxVersion !== versionCheck.expectedVersion
    ) {
      // checkAgentVersion caches a successful probe. Do not retain metadata
      // from a replacement that this rebuild rejects.
      registry.updateSandbox(sandboxName, { agentVersion: null });
      const observed = rebuiltVersion.sandboxVersion ?? "unverified";
      const detail = `  Replacement agent version did not match the rebuild target (expected ${versionCheck.expectedVersion}, observed ${observed}).`;
      if (hermesCronRestoreIdentity) {
        return bailAfterHermesCronRestoreFailure(
          sandboxName,
          backupManifest,
          `${detail} Hermes cron dispatch remains drained.`,
          "Replacement agent version did not match the authoritative rebuild target.",
          bail,
          mcpBridgeRestoreUnverified ? () => printMcpRestoreRecovery(sandboxName, true) : undefined,
        );
      }
      console.error(detail);
      bail("Replacement agent version did not match the authoritative rebuild target.");
      return;
    }
    verifiedAgentVersion = rebuiltVersion.sandboxVersion;
  }
  if (
    targetAgentName === "hermes" &&
    (hermesGatewayRestoreState === "healthy" || hermesGatewayRestoreState === "recovered")
  ) {
    const mutableConfigVerification = inspectMutableHermesConfigPerms(sandboxName);
    mutableConfigPermissionsVerified = mutableConfigVerification.verified;
    if (mutableConfigPermissionsVerified) {
      log("Verified the rebuilt Hermes mutable config posture");
    } else {
      log(
        `Hermes mutable config posture was not verified: ${mutableConfigVerification.errors.join("; ")}`,
      );
    }
  }
  if (hermesCronRestoreIdentity) {
    const replacementIdentity = hermesGatewayVerification.replacementIdentity;
    if (
      hermesGatewayRestoreUnverified ||
      hermesGatewayRestoreState === "not-applicable" ||
      !replacementIdentity
    ) {
      return bailAfterHermesCronRestoreFailure(
        sandboxName,
        backupManifest,
        "  Hermes cron dispatch remains drained because the replacement gateway was not verified.",
        "Hermes cron restore validation failed; dispatch was not re-enabled.",
        bail,
        mcpBridgeRestoreUnverified ? () => printMcpRestoreRecovery(sandboxName, true) : undefined,
      );
    }
    if (mcpBridgeRestoreUnverified) {
      return bailAfterHermesCronRestoreFailure(
        sandboxName,
        backupManifest,
        "  Hermes cron dispatch remains drained because managed MCP restoration was not verified.",
        "Hermes MCP restoration failed; cron dispatch was not re-enabled.",
        bail,
        () => printMcpRestoreRecovery(sandboxName, true),
      );
    }
    verifiedRecreatedEntry = requireCurrentAgentAuthority("before Hermes cron restore completion");
    if (!verifiedRecreatedEntry) return;
    let completedIdentity: HermesCronRestoreIdentity;
    try {
      completedIdentity = completeHermesCronRestoreAfterGatewayReplacement(
        sandboxName,
        hermesCronRestoreIdentity,
        replacementIdentity,
      );
      hermesCronRestoreCompleted = true;
    } catch (error) {
      const errorDetail = error instanceof Error ? error.message : String(error);
      if (isHermesCronRestoreDrainMarkerRollbackFailure(error)) {
        return bailAfterHermesCronRestoreFailure(
          sandboxName,
          backupManifest,
          `  Hermes cron restore release rollback failed: ${errorDetail}. Dispatch state is unverified, but root-owned recovery state was preserved; run recovery immediately so it can reacquire the gate and validate restored cron state.`,
          "Hermes cron restore release state requires immediate recovery.",
          bail,
        );
      }
      return bailAfterHermesCronRestoreFailure(
        sandboxName,
        backupManifest,
        `  Hermes cron restore could not validate the replacement gateway and reactivate dispatch: ${errorDetail}`,
        "Hermes cron restore validation failed; dispatch was not re-enabled.",
        bail,
      );
    }
    log(
      `Hermes cron restore gate released: pid=${String(completedIdentity.pid)}, startTime=${String(completedIdentity.start_time)}`,
    );
  }
  if (hermesGatewayRestoreState === "healthy") {
    console.log(`  ${G}\u2713${R} Hermes gateway restarted and verified after state restore`);
  } else if (hermesGatewayRestoreState === "recovered") {
    console.log(`  ${G}\u2713${R} Hermes gateway recovered after state restore`);
  }
  verifiedRecreatedEntry = requireCurrentAgentAuthority("before final registry publication");
  if (!verifiedRecreatedEntry) return;
  let publishedRegistryEntry: RebuildSandboxEntry | false;
  try {
    publishedRegistryEntry = registry.updateSandboxIfCurrent(verifiedRecreatedEntry, {
      agentVersion: verifiedAgentVersion,
    });
  } catch {
    publishedRegistryEntry = false;
  }
  if (!publishedRegistryEntry) {
    rejectAgentAuthority(
      "during final registry publication",
      "the verified recreated registry row changed before its conditional update",
    );
    return;
  }
  log(`Registry updated: agentVersion=${String(verifiedAgentVersion)}`);

  verifiedRecreatedEntry = requireCurrentAgentAuthority("after final registry publication");
  if (!verifiedRecreatedEntry) return;
  if (
    !ensureMessagingHostForwardAfterRebuild(
      sandboxName,
      effectiveMessagingPlan,
      mcpRuntimeSelection,
    )
  ) {
    messagingHostForwardUnverified = true;
  }
  if (
    targetAgentName === "openclaw" &&
    !mcpBridgeRestoreUnverified &&
    !mutableConfigHashRefreshUnverified &&
    !finalMutableConfigHashUnverified
  ) {
    verifiedRecreatedEntry = requireCurrentAgentAuthority(
      "before final OpenClaw config hash verification",
    );
    if (!verifiedRecreatedEntry) return;
    if (!verifyFinalMutableOpenClawConfigHash(sandboxName, log, mcpRuntimeSelection)) {
      finalMutableConfigHashUnverified = true;
    }
  }

  verifiedRecreatedEntry = requireCurrentAgentAuthority("before final rebuild reporting");
  if (!verifiedRecreatedEntry) return;

  console.log("");
  const genericPostRestoreComplete = postRestoreCompleted({
    hermesGatewayRestoreUnverified,
    messagingHostForwardUnverified,
    mcpBridgeRestoreUnverified,
    mutableConfigHashRefreshUnverified:
      mutableConfigHashRefreshUnverified || finalMutableConfigHashUnverified,
    mutablePermsRepairUnverified,
    restoreSucceeded,
  });
  if (agentDef.runtime?.kind === "terminal" && genericPostRestoreComplete) {
    // Terminal-agent config is materialized by the exact replacement image,
    // outside the restored user-state contract. Exact recreated identity plus
    // successful restore and generic post-restore checks therefore prove that
    // an older locked config posture did not cross the rebuild boundary.
    mutableConfigPermissionsVerified = true;
    log(`Verified the rebuilt ${targetAgentName} terminal-agent mutable posture`);
  }
  const postRestoreComplete = genericPostRestoreComplete && mutableConfigPermissionsVerified;
  if (postRestoreComplete) {
    console.log(`  ${G}✓${R} Sandbox '${sandboxName}' rebuild completed`);
    if (versionCheck.expectedVersion) {
      console.log(`    Now running: ${rebuiltAgentName} v${versionCheck.expectedVersion}`);
    }
  } else {
    console.log(
      `  ${YW}\u26a0${R} Sandbox '${sandboxName}' rebuilt but some post-restore steps were incomplete`,
    );
    if (!restoreSucceeded && backupManifest) {
      console.log(
        `    State restore was incomplete \u2014 backup available at: ${backupManifest.backupPath}`,
      );
    }
    if (mutablePermsRepairUnverified) {
      console.log(
        `    Mutable config permissions were not verified \u2014 run \`${CLI_NAME} ${sandboxName} doctor --fix\` to restore the OpenClaw config permission contract`,
      );
    }
    if (mutableConfigHashRefreshUnverified) {
      console.log(
        `    Mutable OpenClaw config hash was not refreshed \u2014 restart the sandbox or re-run \`${CLI_NAME} ${sandboxName} rebuild\` before relying on config integrity checks`,
      );
    }
    if (finalMutableConfigHashUnverified && !mutableConfigHashRefreshUnverified) {
      console.log(
        `    Final OpenClaw configuration hash verification failed after post-restore finalization \u2014 restart the sandbox or re-run \`${CLI_NAME} ${sandboxName} rebuild\` before relying on config integrity checks`,
      );
    }
    if (messagingHostForwardUnverified) {
      console.log(
        `    Messaging webhook forward was not verified \u2014 run \`${CLI_NAME} ${sandboxName} connect\` after resolving the port conflict`,
      );
    }
    printHermesGatewayRestoreRecovery(sandboxName, hermesGatewayRestoreState);
    printMcpRestoreRecovery(sandboxName, mcpBridgeRestoreUnverified);
  }
  if (!restoreSucceeded) {
    console.error(
      `  State recovery remains incomplete. Correct the restore error, then run \`${CLI_NAME} ${sandboxName} rebuild\` again.`,
    );
    bail(`State restore remained incomplete after rebuilding '${sandboxName}'.`);
    return;
  }
  if (
    targetAgentName === "openclaw" &&
    !mcpBridgeRestoreUnverified &&
    (mutableConfigHashRefreshUnverified || finalMutableConfigHashUnverified)
  ) {
    bail("OpenClaw config integrity verification failed after rebuild.");
    return;
  }
  if (
    targetAgentName === "hermes" &&
    (hermesGatewayRestoreUnverified || mcpBridgeRestoreUnverified)
  ) {
    bail(`Hermes post-restore verification failed for '${sandboxName}'.`);
    return;
  }
  if (preparedBackupRecovery && !postRestoreComplete) {
    bail(
      `Prepared backup recovery for '${sandboxName}' completed with unverified post-restore state.`,
    );
    return;
  }
  printHermesApiTokenChangeNotice(sandboxName, targetAgentName);
  return { mutableConfigPermissionsVerified };
}
