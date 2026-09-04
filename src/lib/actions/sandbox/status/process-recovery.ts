// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Keep read-only process inspection, recovery, and deployment probes behind
// one edge to the lifecycle module. This preserves the source-architecture
// fan-in budget while every consumer shares the same guarded implementation.
export {
  checkAndRecoverSandboxProcesses,
  executeGatewaySupervisorAction,
  executeSandboxCommand,
  executeSandboxExecCommand,
  isSandboxGatewayRunningForStatus,
} from "../process-recovery";
