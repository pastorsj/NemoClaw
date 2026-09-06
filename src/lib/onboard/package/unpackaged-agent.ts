// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { normalizeAgentSelector } from "../../agent/aliases";
import { loadAgent } from "../../agent/defs";
import type { AgentDefinition } from "../../agent-runtime/manifest-types";

/** Resolve the remaining qualified repository agent that has no package receipt yet. */
export function resolveUnpackagedOnboardAgent(
  selector: string,
  env: NodeJS.ProcessEnv = process.env,
): AgentDefinition | null {
  const agentId = normalizeAgentSelector(selector);
  if (agentId !== "nemocua") return null;
  return loadAgent(agentId, env);
}
