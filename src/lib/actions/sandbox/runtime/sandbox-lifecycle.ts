// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import * as processRecovery from "../process-recovery";

/**
 * Keep callers on one harness-neutral boundary for sandbox process recovery.
 * The underlying module owns the implementation; lifecycle workflows depend on
 * this smaller surface so they do not each become recovery-system importers.
 */
export function executeGatewaySupervisorAction(
  ...args: Parameters<typeof processRecovery.executeGatewaySupervisorAction>
) {
  return processRecovery.executeGatewaySupervisorAction(...args);
}

export function waitForRecoveredSandboxGateway(
  ...args: Parameters<typeof processRecovery.waitForRecoveredSandboxGateway>
) {
  return processRecovery.waitForRecoveredSandboxGateway(...args);
}

export function restartSandboxGateway(
  ...args: Parameters<typeof processRecovery.restartSandboxGateway>
) {
  return processRecovery.restartSandboxGateway(...args);
}
