// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import * as agentRuntime from "../../../agent/runtime";
import { inspectPortableAgentReceiptDisposition } from "../../../onboard/experimental/portable-agent-lifecycle";
import { withMcpLifecycleLock } from "../../../state/mcp-lifecycle-lock";
import * as registry from "../../../state/registry";
import { connectSandbox } from "../connect";
import {
  prepareHermesCronRestoreRecovery,
  prepareScheduledWorkRestoreRecovery,
  recoverHermesCronRestore,
  recoverScheduledWorkRestore,
} from "../rebuild-hermes-post-restore";

const RECOVERY_LOCK_TIMEOUT_MS = 30_000;

/** Re-establish any receipt-declared scheduled-work gate around runtime repair. */
export async function recoverSandboxStateAfterRestore(sandboxName: string): Promise<void> {
  await withMcpLifecycleLock(
    sandboxName,
    async () => {
      const portable = inspectPortableAgentReceiptDisposition(sandboxName);
      if (portable.kind === "hermes") {
        await connectSandbox(sandboxName, {
          probeOnly: true,
          requireLaunchReadinessPublication: false,
        });
        return;
      }
      const agent = agentRuntime.getSessionAgent(sandboxName);
      const sandbox = registry.getSandbox(sandboxName);
      const packageScheduledWork =
        sandbox?.harnessPackage &&
        agent?.name === sandbox.harnessPackage.id &&
        (sandbox.agent == null || sandbox.agent === sandbox.harnessPackage.id)
          ? agent.stateLifecycle.rebuild.scheduled_work
          : null;
      const scheduledWork =
        packageScheduledWork?.support === "managed" ? packageScheduledWork : null;
      const legacyHermes = !sandbox?.harnessPackage && agent?.name === "hermes";
      if (scheduledWork) {
        prepareScheduledWorkRestoreRecovery(sandboxName, scheduledWork);
      } else if (legacyHermes) {
        prepareHermesCronRestoreRecovery(sandboxName);
      }
      await connectSandbox(sandboxName, {
        probeOnly: true,
        requireLaunchReadinessPublication: false,
      });
      if (!scheduledWork && !legacyHermes) return;

      const outcome = scheduledWork
        ? recoverScheduledWorkRestore(sandboxName, scheduledWork)
        : recoverHermesCronRestore(sandboxName);
      switch (outcome) {
        case "dispatch-reactivated":
          console.log(
            scheduledWork
              ? "  Scheduled-work dispatch resumed after restored jobs and scripts were validated."
              : "  Hermes cron dispatch resumed after restored jobs and scripts were validated.",
          );
          return;
        case "operator-drain-preserved":
          console.log(
            scheduledWork
              ? "  Scheduled-work restore gate cleared; the independent operator drain remains active."
              : "  Hermes cron restore gate cleared; the independent operator drain remains active.",
          );
          return;
        case "not-required":
        case "unsupported":
          return;
      }
    },
    { timeoutMs: RECOVERY_LOCK_TIMEOUT_MS },
  );
}

/** Historical export retained for callers compiled before generic package state recovery. */
export async function recoverSandboxWithHermesCronRestore(sandboxName: string): Promise<void> {
  return recoverSandboxStateAfterRestore(sandboxName);
}
