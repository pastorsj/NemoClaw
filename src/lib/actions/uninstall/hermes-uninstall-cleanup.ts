// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ManagedAgentStateVolumeContext } from "../../onboard/managed-workload/agent-state-volume";
import {
  managedAgentStateVolumeContext,
  prepareManagedAgentStateVolumeCleanups,
  removeManagedAgentStateVolumesForUninstall,
  type ManagedAgentStateVolumeRuntime,
} from "./receipt-cleanup";

export { requiresManagedHermesStateVolume } from "../../onboard/managed-workload/hermes-state-volume";
/** @deprecated Use ManagedAgentStateVolumeContext. */
export type ManagedHermesStateVolumeContext = ManagedAgentStateVolumeContext;
/** @deprecated Use ManagedAgentStateVolumeRuntime. */
export type ManagedHermesStateVolumeRuntime = ManagedAgentStateVolumeRuntime;

/** @deprecated Receipt-aware uninstall uses managedAgentStateVolumeContext. */
export const managedHermesStateVolumeContext = managedAgentStateVolumeContext;

export function removeManagedHermesStateVolumes(
  contexts: readonly ManagedAgentStateVolumeContext[],
  runtime: ManagedAgentStateVolumeRuntime,
): boolean {
  return removeManagedAgentStateVolumesForUninstall(
    prepareManagedAgentStateVolumeCleanups(contexts, runtime),
    runtime,
  );
}
