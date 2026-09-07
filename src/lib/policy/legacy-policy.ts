// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { HERMES_TOOL_GATEWAY_PRESET_NAMES } from "../onboard/hermes-managed-tools";
import { DCODE_ONLY_POLICY_PRESETS } from "../onboard/observability-policy-presets";
import { OPENCLAW_ONLY_POLICY_PRESETS } from "../onboard/openclaw-otel-policy-presets";

const LEGACY_BASELINE_EXCLUSION_IMPACTS: Readonly<
  Record<string, Readonly<Record<string, string>>>
> = {
  openclaw: {
    nvidia: "Direct NVIDIA API inference may stop working.",
    openclaw_gateway_dialback:
      "OpenClaw sessions_spawn and multi-agent delegation may stop working.",
    clawhub: "ClawHub authentication and skill or plugin discovery may stop working.",
    openclaw_api: "OpenClaw authentication and plugin discovery may stop working.",
    openclaw_docs: "In-sandbox access to OpenClaw documentation may stop working.",
    npm_registry: "OpenClaw plugin installation from npm may stop working.",
  },
  hermes: {
    nvidia: "Direct NVIDIA API inference may stop working.",
    nous_research: "Hermes public metadata lookup and agent updates may stop working.",
    pypi: "Hermes skill or plugin dependency installation through pip may stop working.",
  },
  "langchain-deepagents-code": {
    github: "Git operations and GitHub API or source access may stop working.",
    pypi: "Python package installation through pip may stop working.",
  },
};

/** Pre-package exclusion disclosure retained only for sandboxes without receipts. */
export function getLegacyBaselineExclusionFeatureImpact(
  agent: string | null | undefined,
  key: string,
): string | null {
  return agent ? (LEGACY_BASELINE_EXCLUSION_IMPACTS[agent]?.[key] ?? null) : null;
}

/** Pre-package preset ownership retained only for sandboxes without receipts. */
export function isLegacyAgentOwnedPreset(
  agent: string | null | undefined,
  presetName: string,
): boolean {
  if (agent === "openclaw") return OPENCLAW_ONLY_POLICY_PRESETS.has(presetName);
  if (agent === "hermes") return HERMES_TOOL_GATEWAY_PRESET_NAMES.has(presetName);
  return false;
}

/** Identify central preset copies retained solely for receiptless harness compatibility. */
export function isLegacyHarnessPolicyPreset(presetName: string): boolean {
  return (
    OPENCLAW_ONLY_POLICY_PRESETS.has(presetName) ||
    HERMES_TOOL_GATEWAY_PRESET_NAMES.has(presetName) ||
    DCODE_ONLY_POLICY_PRESETS.has(presetName)
  );
}
