// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export function resolveTestPolicyAdditionsPath(agent: string): string {
  return agent === "hermes" || agent === "langchain-deepagents-code"
    ? `/repo/packages/nemoclaw-${agent}/policy-additions.yaml`
    : `/repo/agents/${agent}/policy-additions.yaml`;
}

export function resolveTestAgentBaselinePolicy(
  agent: string | null | undefined,
): { agent: string; policyPath: string; content: string } | null {
  const resolvedAgent = agent || "openclaw";
  return {
    agent: resolvedAgent,
    policyPath:
      resolvedAgent === "openclaw"
        ? "/repo/packages/nemoclaw-openclaw/policy-additions.yaml"
        : resolveTestPolicyAdditionsPath(resolvedAgent),
    content: "version: 1\nnetwork_policies: {}\n",
  };
}
