// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { loadAgent } from "../../agent/defs";
import type { AgentDefinition } from "../../agent-runtime/manifest-types";
import { supportsSandboxStartupControl } from "../../agent-runtime/sandbox-create";
import { managedSandboxFeatureIssue } from "../managed-sandbox-feature";
import { DCODE_OBSERVABILITY_FEATURE } from "../observability-policy-presets";

export interface ObservabilityRequestAgentDependencies {
  readonly env: NodeJS.ProcessEnv;
  readonly loadAgent?: (name: string, env?: NodeJS.ProcessEnv) => AgentDefinition;
}

/** Validate the early CLI request against package data, with legacy DCode as the only fallback. */
export function observabilityRequestAgentError(
  requested: boolean | undefined,
  agent: string | null,
  deps: ObservabilityRequestAgentDependencies,
): string | null {
  if (!agent || requested !== true) return null;
  try {
    if (
      supportsSandboxStartupControl((deps.loadAgent ?? loadAgent)(agent, deps.env), "observability")
    ) {
      return null;
    }
  } catch {
    // An unavailable package definition can only enter the explicit legacy check below.
  }
  return managedSandboxFeatureIssue(DCODE_OBSERVABILITY_FEATURE, { agent, requested }) ===
    "unsupported-request"
    ? "  --observability requires a harness package that declares the observability startup control."
    : null;
}
