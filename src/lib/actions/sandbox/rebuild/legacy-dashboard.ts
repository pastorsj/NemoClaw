// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { AgentDefinition } from "../../../agent-runtime/manifest-types";
import * as sandboxConfig from "../../../sandbox/config";

/** Restore the pre-receipt Hermes dashboard layout. Package receipts use their fixed state command. */
export function reconcileLegacyDashboardProfile(
  sandboxName: string,
  agentDefinition: AgentDefinition,
): ReturnType<typeof sandboxConfig.restoreHermesDashboardConfig> {
  const target = sandboxConfig.resolveAgentConfig(sandboxName, agentDefinition);
  return sandboxConfig.restoreHermesDashboardConfig(sandboxName, target);
}
