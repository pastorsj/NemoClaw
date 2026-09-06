// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { CLI_NAME } from "../../cli/branding";
import type { HarnessScheduledWorkDeclaration } from "@nvidia/nemoclaw-harness-contract";
import { D, G, R, YW } from "../../cli/terminal-style";
import type { SandboxMessagingPlan } from "../../messaging";
import type { ResolvedSandboxAgent } from "../../onboard/sandbox-agent";
import * as sandboxVersion from "../../sandbox/version";
import {
  inspectMutableConfigPerms,
  inspectMutableHermesConfigPerms,
  repairMutableConfigPerms,
} from "../../sandbox/mutable-config-perms";
import {
  packageDevicePairingIncompleteMessage,
  settlePackageDevicePairing,
} from "../../onboard/sandbox-create/device-pairing";
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
  completeScheduledWorkRestoreAfterRuntimeReplacement,
  type HermesCronRestoreIdentity,
  type ScheduledWorkRestoreIdentity,
  isHermesCronRestoreDrainMarkerRollbackFailure,
  printHermesGatewayRestoreRecovery,
  restartHermesGatewayAfterStateRestore,
  restartPackageRuntimeAfterStateRestore,
  verifyHermesGatewayAfterStateRestore,
  verifyHermesGatewayAfterStateRestoreForCronGate,
  verifyPackageRuntimeAfterStateRestore,
  verifyPackageRuntimeAfterStateRestoreForScheduledWorkGate,
} from "./rebuild-hermes-post-restore";
import {
  type McpRebuildPreparation,
  postRestoreCompleted,
  printMcpRestoreRecovery,
  restoreMcpAfterRebuild,
} from "./rebuild-mcp-phase";
import {
  finalizePendingMessagingRemovalsAfterRestore,
  reapplyMessagingManifestAfterPackageRepair,
  reapplyMessagingManifestAfterOpenClawDoctor,
} from "./rebuild-messaging-phase";
import { reconcileStalePinnedSessionModelsAfterRebuild } from "./reconcile-session-models";
import { establishRestoredSandboxGatewayPairing } from "./restore-gateway-pairing";
import { legacyRebuildRequestsStateAction } from "./rebuild/legacy-state";
import { executeReceiptBackedStateCommand } from "./state-lifecycle";

export {
  type HermesCronRestoreIdentity,
  type ScheduledWorkRestoreIdentity,
  HermesCronRestoreIncompleteError,
  ScheduledWorkRestoreIncompleteError,
  recoverScheduledWorkRestore,
  recoverHermesCronRestore,
  runScheduledWorkRestoreTransaction,
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
  scheduledWorkRestoreIdentity?: ScheduledWorkRestoreIdentity;
  /** Explicit no-receipt compatibility input; receipt-backed packages use the generic field. */
  hermesCronRestoreIdentity?: HermesCronRestoreIdentity;
  scheduledWorkDeclaration?: Extract<
    HarnessScheduledWorkDeclaration,
    { readonly support: "managed" }
  > | null;
  preparedBackupRecovery: boolean;
  versionCheck: ReturnType<typeof sandboxVersion.checkAgentVersion>;
  log: RebuildLog;
  bail: RebuildBail;
}

export interface RebuildPostRestoreVerification {
  readonly mutableConfigPermissionsVerified: boolean;
}

function printApiTokenChangeNotice(sandboxName: string, required: boolean): void {
  if (!required) return;
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

interface OpenClawPostRestoreRepair {
  readonly registryEntry: RebuildSandboxEntry;
  readonly mutableConfigPermissionsVerified: boolean;
  readonly mutablePermsRepairUnverified: boolean;
}

async function repairOpenClawStateAfterRestore(input: {
  readonly sandboxName: string;
  readonly messagingPlan: SandboxMessagingPlan | null;
  readonly runtimeSelection: McpRebuildPreparation["runtimeSelection"];
  readonly requireCurrentAgentAuthority: (stage: string) => RebuildSandboxEntry | null;
  readonly log: RebuildLog;
  readonly bail: RebuildBail;
}): Promise<OpenClawPostRestoreRepair | null> {
  const { sandboxName, messagingPlan, runtimeSelection, requireCurrentAgentAuthority, log, bail } =
    input;
  const runtimeOptions = buildSelectedRuntimeOptions(runtimeSelection);

  log("Running openclaw doctor --fix inside sandbox for post-upgrade structure repair");
  const doctorResult = executeSandboxExecCommand(
    sandboxName,
    "openclaw doctor --fix",
    OPENCLAW_DOCTOR_TIMEOUT_MS,
    {
      allowLocalDockerFallback: false,
      ...runtimeOptions,
    },
  );
  log(`doctor --fix: exit=${doctorResult?.status ?? "unverified"}`);
  if (doctorResult === null) {
    console.log(`  ${D}Post-upgrade structure repair completion was not verified${R}`);
    bail("OpenClaw post-upgrade structure repair completion was not verified after rebuild.");
    return null;
  }
  if (doctorResult.status !== 0) {
    console.log(
      `  ${D}Post-upgrade structure repair failed (doctor returned ${doctorResult.status})${R}`,
    );
    bail("OpenClaw post-upgrade structure repair failed during rebuild.");
    return null;
  }
  console.log(`  ${G}\u2713${R} Post-upgrade structure check passed`);

  let registryEntry = requireCurrentAgentAuthority("after OpenClaw doctor");
  if (!registryEntry) return null;

  // #7102: clear stale per-session pinned models while the gateway is down.
  reconcileStalePinnedSessionModelsAfterRebuild(sandboxName, log, runtimeSelection);
  registryEntry = requireCurrentAgentAuthority("after OpenClaw session-model reconciliation");
  if (!registryEntry) return null;

  try {
    await reapplyMessagingManifestAfterOpenClawDoctor(
      sandboxName,
      messagingPlan,
      log,
      runtimeSelection,
    );
  } catch (error) {
    log(
      `Messaging manifest reapply failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    console.error(`  ${YW}\u26a0${R} Messaging manifest config reapply failed after doctor.`);
    bail("OpenClaw messaging manifest config reapply failed during rebuild.");
    return null;
  }

  registryEntry = requireCurrentAgentAuthority("after messaging replay");
  if (!registryEntry) return null;

  log("Restoring mutable OpenClaw config permissions after post-restore config writes");
  let mutablePermsRepairUnverified = false;
  let mutableConfigPermissionsVerified = false;
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

  return { registryEntry, mutableConfigPermissionsVerified, mutablePermsRepairUnverified };
}

async function runReceiptBackedPackagePostRestore(input: {
  readonly phase: RebuildPostRestorePhaseInput;
  readonly requireCurrentAgentAuthority: (stage: string) => RebuildSandboxEntry | null;
}): Promise<RebuildPostRestoreVerification | undefined> {
  const { phase, requireCurrentAgentAuthority } = input;
  const {
    sandboxName,
    agentAuthority,
    messagingPlan,
    backupManifest,
    mcpEntries,
    mcpRuntimeSelection,
    restoreSucceeded,
    scheduledWorkRestoreIdentity,
    scheduledWorkDeclaration,
    preparedBackupRecovery,
    versionCheck,
    log,
    bail,
  } = phase;
  const receipt = agentAuthority.harnessPackage;
  if (!receipt) return bail("Receipt-backed post-restore authority is unavailable.");
  const agentDefinition = agentAuthority.definition;
  const postRestore = agentDefinition.stateLifecycle.rebuild.post_restore;
  const runtimeOptions = buildSelectedRuntimeOptions(mcpRuntimeSelection);
  const runtimeLifecycleOptions = { agentDefinition, ...runtimeOptions };
  let current = requireCurrentAgentAuthority("before package post-restore work");
  if (!current) return;
  let effectiveMessagingPlan = messagingPlan;
  let mutableConfigPermissionsVerified = postRestore.kind === "not-required";
  let postRestoreIncomplete = false;

  const failPackageStateCommand = (purpose: string, detail: string): undefined => {
    console.error(`  ${YW}\u26a0${R} ${agentDefinition.displayName} ${purpose} failed: ${detail}`);
    bail(`${agentDefinition.displayName} ${purpose} failed during rebuild.`);
    return undefined;
  };

  if (postRestore.kind === "managed") {
    if (postRestore.command) {
      const commandResult = executeReceiptBackedStateCommand(
        sandboxName,
        current,
        agentDefinition,
        postRestore.command,
      );
      if (commandResult.kind !== "completed") {
        return failPackageStateCommand(
          "post-restore command",
          commandResult.kind === "failed" ? commandResult.detail : commandResult.reason,
        );
      }
      current = requireCurrentAgentAuthority("after package post-restore command");
      if (!current) return;
      log(`Completed ${agentDefinition.displayName} package post-restore command`);
    }

    if (postRestore.reapply_messaging) {
      try {
        await reapplyMessagingManifestAfterPackageRepair(
          sandboxName,
          effectiveMessagingPlan,
          log,
          mcpRuntimeSelection,
        );
      } catch (error) {
        return failPackageStateCommand(
          "messaging manifest reapply",
          error instanceof Error ? error.message : String(error),
        );
      }
      current = requireCurrentAgentAuthority("after package messaging replay");
      if (!current) return;
    }

    if (postRestore.mutable_config === "repair") {
      const repair = repairMutableConfigPerms(sandboxName);
      mutableConfigPermissionsVerified = repair.applied && repair.verified;
      if (!mutableConfigPermissionsVerified) {
        const detail = repair.applied ? repair.errors.join("; ") : repair.reason;
        return failPackageStateCommand("mutable config repair", detail);
      }
      current = requireCurrentAgentAuthority("after package mutable config repair");
      if (!current) return;
    }
  }

  try {
    const finalized = finalizePendingMessagingRemovalsAfterRestore(
      effectiveMessagingPlan,
      log,
      mcpRuntimeSelection,
    );
    if (finalized !== effectiveMessagingPlan && finalized) {
      current = requireCurrentAgentAuthority("before pending messaging removal publication");
      if (!current) return;
      const updated = registry.updateSandboxIfCurrent(current, {
        messaging: { schemaVersion: 1, plan: finalized },
      });
      if (!updated) return bail("Could not retire pending messaging removals after rebuild.");
      current = updated;
      effectiveMessagingPlan = finalized;
    }
  } catch (error) {
    return bail(
      `Could not finalize pending messaging removals after rebuild: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  const restartRequired = postRestore.kind === "managed" && postRestore.restart_runtime;
  current = requireCurrentAgentAuthority("before package runtime restart");
  if (!current) return;
  const restartState = restartPackageRuntimeAfterStateRestore(
    sandboxName,
    restartRequired,
    runtimeLifecycleOptions,
  );

  current = requireCurrentAgentAuthority("before managed MCP restoration");
  if (!current) return;
  const mcpBridgeRestoreUnverified = !(await restoreMcpAfterRebuild(
    sandboxName,
    mcpEntries,
    agentDefinition,
    mcpRuntimeSelection,
  ));
  current = requireCurrentAgentAuthority("after managed MCP restoration");
  if (!current) return;

  let integrityUnverified = false;
  const integrity = postRestore.kind === "managed" ? postRestore.config_integrity : null;
  if (integrity?.kind === "commands") {
    if (mcpBridgeRestoreUnverified) {
      integrityUnverified = true;
    } else {
      for (const [purpose, command] of [
        ["config integrity refresh", integrity.refresh],
        ["config integrity verification", integrity.verify],
      ] as const) {
        const result = executeReceiptBackedStateCommand(
          sandboxName,
          current,
          agentDefinition,
          command,
        );
        if (result.kind !== "completed") {
          integrityUnverified = true;
          log(`${purpose} failed: ${result.kind === "failed" ? result.detail : result.reason}`);
          break;
        }
        current = requireCurrentAgentAuthority(`after package ${purpose}`);
        if (!current) return;
      }
    }
  }

  if (postRestore.kind === "managed" && postRestore.settle_device_pairing) {
    const declaration = agentDefinition.runtime?.device_pairing_settlement;
    const runtimeIdentity = agentDefinition.managedImage?.runtime_identity;
    if (!declaration || !runtimeIdentity) {
      return bail(
        `${agentDefinition.displayName} requested device-pairing settlement without a package command and runtime identity.`,
      );
    }
    const settlement = await settlePackageDevicePairing(
      sandboxName,
      receipt.id,
      declaration,
      runtimeIdentity,
    );
    if (settlement.kind !== "settled") {
      return bail(
        packageDevicePairingIncompleteMessage(
          agentDefinition.displayName,
          sandboxName,
          settlement.reason,
        ),
      );
    }
    current = requireCurrentAgentAuthority("after package device-pairing settlement");
    if (!current) return;
  }

  if (scheduledWorkRestoreIdentity && !scheduledWorkDeclaration) {
    return bail("A scheduled-work restore gate has no receipt-backed package declaration.");
  }
  const runtimeVerification =
    scheduledWorkRestoreIdentity && scheduledWorkDeclaration
      ? verifyPackageRuntimeAfterStateRestoreForScheduledWorkGate(
          sandboxName,
          restartRequired,
          restartState,
          scheduledWorkDeclaration,
          scheduledWorkRestoreIdentity,
          runtimeLifecycleOptions,
        )
      : {
          state: verifyPackageRuntimeAfterStateRestore(
            sandboxName,
            restartRequired,
            restartState,
            runtimeLifecycleOptions,
          ),
          replacementIdentity: undefined,
        };
  const runtimeRestoreUnverified = runtimeVerification.state === "unverified";

  if (postRestore.kind === "managed" && postRestore.mutable_config === "verify") {
    const inspection = inspectMutableConfigPerms(sandboxName);
    mutableConfigPermissionsVerified = inspection.applies && inspection.ok;
    if (!mutableConfigPermissionsVerified) {
      log(
        `Package mutable config verification failed: ${
          inspection.applies ? inspection.issues.join("; ") : inspection.reason
        }`,
      );
      postRestoreIncomplete = true;
    }
  } else if (postRestore.kind === "managed" && postRestore.mutable_config === "not-required") {
    mutableConfigPermissionsVerified = true;
  }

  let verifiedAgentVersion: string | null = null;
  if (versionCheck.expectedVersion) {
    registry.updateSandbox(sandboxName, { agentVersion: null });
    const rebuiltVersion = probeRebuiltAgentVersion(sandboxName);
    if (
      rebuiltVersion.verificationFailed ||
      rebuiltVersion.sandboxVersion !== versionCheck.expectedVersion
    ) {
      registry.updateSandbox(sandboxName, { agentVersion: null });
      return bail("Replacement agent version did not match the authoritative rebuild target.");
    }
    verifiedAgentVersion = rebuiltVersion.sandboxVersion;
  }

  if (scheduledWorkRestoreIdentity && scheduledWorkDeclaration) {
    const replacementIdentity = runtimeVerification.replacementIdentity;
    if (runtimeRestoreUnverified || mcpBridgeRestoreUnverified || !replacementIdentity) {
      console.error(
        "  Scheduled-work dispatch remains drained because replacement runtime state was not verified.",
      );
      return bail("Scheduled-work restore validation failed; dispatch was not re-enabled.");
    }
    try {
      completeScheduledWorkRestoreAfterRuntimeReplacement(
        sandboxName,
        scheduledWorkDeclaration,
        scheduledWorkRestoreIdentity,
        replacementIdentity,
      );
    } catch (error) {
      console.error(
        `  Scheduled-work dispatch remains drained: ${error instanceof Error ? error.message : String(error)}`,
      );
      return bail("Scheduled-work restore validation failed; dispatch was not re-enabled.");
    }
    current = requireCurrentAgentAuthority("after scheduled-work restore completion");
    if (!current) return;
  }

  current = requireCurrentAgentAuthority("before final registry publication");
  if (!current) return;
  const published = registry.updateSandboxIfCurrent(current, {
    agentVersion: verifiedAgentVersion,
  });
  if (!published) return bail("The recreated registry row changed before final publication.");
  current = requireCurrentAgentAuthority("after final registry publication");
  if (!current) return;

  const messagingHostForwardUnverified = !ensureMessagingHostForwardAfterRebuild(
    sandboxName,
    effectiveMessagingPlan,
    mcpRuntimeSelection,
  );
  if (integrity?.kind === "commands" && !integrityUnverified) {
    const finalIntegrity = executeReceiptBackedStateCommand(
      sandboxName,
      current,
      agentDefinition,
      integrity.verify,
    );
    integrityUnverified = finalIntegrity.kind !== "completed";
  }
  if (!requireCurrentAgentAuthority("before final package rebuild reporting")) return;

  const complete =
    restoreSucceeded &&
    !mcpBridgeRestoreUnverified &&
    !runtimeRestoreUnverified &&
    !messagingHostForwardUnverified &&
    !integrityUnverified &&
    !postRestoreIncomplete &&
    mutableConfigPermissionsVerified;
  console.log("");
  if (!complete) {
    if (backupManifest) console.error(`  Backup is preserved at: ${backupManifest.backupPath}`);
    if (preparedBackupRecovery) {
      return bail(
        `Prepared backup recovery for '${sandboxName}' completed with unverified post-restore state.`,
      );
    }
    return bail(
      `${agentDefinition.displayName} post-restore verification failed for '${sandboxName}'.`,
    );
  }

  console.log(`  ${G}✓${R} Sandbox '${sandboxName}' rebuild completed`);
  if (versionCheck.expectedVersion) {
    console.log(`    Now running: ${agentDefinition.displayName} v${versionCheck.expectedVersion}`);
  }
  if (postRestore.kind === "managed" && postRestore.notify_gateway_token_change) {
    console.log(
      `    ${YW}\u26a0${R} ${agentDefinition.displayName} API bearer token changed during rebuild.`,
    );
    console.log(
      `    Retrieve the new token with \`${CLI_NAME} ${sandboxName} gateway-token --quiet\`.`,
    );
  }
  return { mutableConfigPermissionsVerified };
}

function finishRebuildPostRestore(input: {
  readonly sandboxName: string;
  readonly targetAgentName: string;
  readonly stateLifecycle: ResolvedSandboxAgent["definition"]["stateLifecycle"];
  readonly rebuiltAgentName: string;
  readonly expectedVersion: string | null;
  readonly terminalAgent: boolean;
  readonly restoreSucceeded: boolean;
  readonly preparedBackupRecovery: boolean;
  readonly backupManifest: RebuildBackupManifest;
  readonly hermesGatewayRestoreState: ReturnType<typeof verifyHermesGatewayAfterStateRestore>;
  readonly hermesGatewayRestoreUnverified: boolean;
  readonly messagingHostForwardUnverified: boolean;
  readonly mcpBridgeRestoreUnverified: boolean;
  readonly mutableConfigHashRefreshUnverified: boolean;
  readonly finalMutableConfigHashUnverified: boolean;
  readonly mutablePermsRepairUnverified: boolean;
  readonly mutableConfigPermissionsVerified: boolean;
  readonly log: RebuildLog;
  readonly bail: RebuildBail;
}): RebuildPostRestoreVerification {
  const {
    sandboxName,
    targetAgentName,
    stateLifecycle,
    rebuiltAgentName,
    expectedVersion,
    terminalAgent,
    restoreSucceeded,
    preparedBackupRecovery,
    backupManifest,
    hermesGatewayRestoreState,
    hermesGatewayRestoreUnverified,
    messagingHostForwardUnverified,
    mcpBridgeRestoreUnverified,
    mutableConfigHashRefreshUnverified,
    finalMutableConfigHashUnverified,
    mutablePermsRepairUnverified,
    log,
    bail,
  } = input;
  let { mutableConfigPermissionsVerified } = input;

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
  if (terminalAgent && genericPostRestoreComplete) {
    // The replacement image materializes terminal-agent configuration outside restored user state.
    mutableConfigPermissionsVerified = true;
    log(`Verified the rebuilt ${targetAgentName} terminal-agent mutable posture`);
  }
  const postRestoreComplete = genericPostRestoreComplete && mutableConfigPermissionsVerified;
  if (postRestoreComplete) {
    console.log(`  ${G}✓${R} Sandbox '${sandboxName}' rebuild completed`);
    if (expectedVersion) console.log(`    Now running: ${rebuiltAgentName} v${expectedVersion}`);
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
    return bail(`State restore remained incomplete after rebuilding '${sandboxName}'.`);
  }
  if (
    legacyRebuildRequestsStateAction(stateLifecycle.rebuild, "verify-config-integrity") &&
    !mcpBridgeRestoreUnverified &&
    (mutableConfigHashRefreshUnverified || finalMutableConfigHashUnverified)
  ) {
    return bail("OpenClaw config integrity verification failed after rebuild.");
  }
  if (
    legacyRebuildRequestsStateAction(stateLifecycle.rebuild, "restart-runtime-after-restore") &&
    (hermesGatewayRestoreUnverified || mcpBridgeRestoreUnverified)
  ) {
    return bail(`Hermes post-restore verification failed for '${sandboxName}'.`);
  }
  if (preparedBackupRecovery && !postRestoreComplete) {
    return bail(
      `Prepared backup recovery for '${sandboxName}' completed with unverified post-restore state.`,
    );
  }
  printApiTokenChangeNotice(
    sandboxName,
    legacyRebuildRequestsStateAction(stateLifecycle.rebuild, "notify-api-token-change"),
  );
  return { mutableConfigPermissionsVerified };
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
  const stateLifecycle = agentDef.stateLifecycle;
  if (agentAuthority.harnessPackage) {
    if (Array.isArray(stateLifecycle.rebuild)) {
      return bail("Receipt-backed package state lifecycle authority is invalid.");
    }
    return runReceiptBackedPackagePostRestore({
      phase: input,
      requireCurrentAgentAuthority,
    });
  }
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

  if (legacyRebuildRequestsStateAction(stateLifecycle.rebuild, "repair-upgraded-state")) {
    const repair = await repairOpenClawStateAfterRestore({
      sandboxName,
      messagingPlan,
      runtimeSelection: mcpRuntimeSelection,
      requireCurrentAgentAuthority,
      log,
      bail,
    });
    if (!repair) return;
    verifiedRecreatedEntry = repair.registryEntry;
    mutableConfigPermissionsVerified = repair.mutableConfigPermissionsVerified;
    mutablePermsRepairUnverified = repair.mutablePermsRepairUnverified;
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
    legacyRebuildRequestsStateAction(stateLifecycle.rebuild, "restart-runtime-after-restore"),
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
  if (
    legacyRebuildRequestsStateAction(stateLifecycle.rebuild, "verify-config-integrity") &&
    mcpBridgeRestoreUnverified
  ) {
    mutableConfigHashRefreshUnverified = true;
  } else if (legacyRebuildRequestsStateAction(stateLifecycle.rebuild, "verify-config-integrity")) {
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
  if (legacyRebuildRequestsStateAction(stateLifecycle.rebuild, "restore-device-pairing")) {
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
        legacyRebuildRequestsStateAction(stateLifecycle.rebuild, "restart-runtime-after-restore"),
        hermesGatewayRestartState,
        hermesCronRestoreIdentity,
        selectedAgentRuntimeOptions,
      )
    : {
        state: verifyHermesGatewayAfterStateRestore(
          sandboxName,
          legacyRebuildRequestsStateAction(stateLifecycle.rebuild, "restart-runtime-after-restore"),
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
    legacyRebuildRequestsStateAction(stateLifecycle.rebuild, "verify-mutable-config") &&
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
    legacyRebuildRequestsStateAction(stateLifecycle.rebuild, "verify-config-integrity") &&
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

  return finishRebuildPostRestore({
    sandboxName,
    targetAgentName,
    stateLifecycle,
    rebuiltAgentName,
    expectedVersion: versionCheck.expectedVersion,
    terminalAgent: agentDef.runtime?.kind === "terminal",
    restoreSucceeded,
    preparedBackupRecovery,
    backupManifest,
    hermesGatewayRestoreState,
    hermesGatewayRestoreUnverified,
    messagingHostForwardUnverified,
    mcpBridgeRestoreUnverified,
    mutableConfigHashRefreshUnverified,
    finalMutableConfigHashUnverified,
    mutablePermsRepairUnverified,
    mutableConfigPermissionsVerified,
    log,
    bail,
  });
}
