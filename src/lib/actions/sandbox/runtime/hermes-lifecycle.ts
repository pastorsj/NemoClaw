// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { MessagingSetupApplier } from "../../../messaging/applier/setup-applier";
import type { MessagingOpenShellRunner } from "../../../messaging/applier/types";
import type { SandboxMessagingPlan } from "../../../messaging/manifest";
import * as gatewayRestart from "../gateway-restart";
import * as sandboxLifecycle from "./sandbox-lifecycle";

export function createHermesCredentialEnvReconciliationRuntime(
  runOpenshell: MessagingOpenShellRunner,
  revalidateSandboxIdentity: (operation: string) => void,
) {
  return {
    reconcileCredentialEnv: (plan: SandboxMessagingPlan, revalidate: (operation: string) => void) =>
      MessagingSetupApplier.reconcileCredentialEnvAtOpenShell(plan, {
        runOpenshell: (args, options) => {
          revalidate(`mutating Hermes credential environment for sandbox '${plan.sandboxName}'`);
          const result = runOpenshell(args, options);
          revalidate(`confirming Hermes credential environment for sandbox '${plan.sandboxName}'`);
          return result;
        },
      }),
    restartGateway: (sandboxName: string, revalidate: (operation: string) => void) => {
      revalidate(`restarting Hermes gateway for sandbox '${sandboxName}'`);
      const result = sandboxLifecycle.executeGatewaySupervisorAction(
        sandboxName,
        "restart",
        210000,
      );
      revalidate(`confirming Hermes gateway restart for sandbox '${sandboxName}'`);
      return result;
    },
    parseRestartCompletion: gatewayRestart.parseManagedGatewayControlCompletion,
    waitForGateway: (sandboxName: string, revalidate: (operation: string) => void) => {
      revalidate(`checking Hermes gateway health for sandbox '${sandboxName}'`);
      const healthy = sandboxLifecycle.waitForRecoveredSandboxGateway(sandboxName, {
        quiet: true,
        initialManagedHealthPassed: true,
        requireManagedProbe: true,
      });
      revalidate(`confirming Hermes gateway health for sandbox '${sandboxName}'`);
      return healthy;
    },
    revalidateSandboxIdentity,
  };
}
