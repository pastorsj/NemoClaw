// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { SkillPaths } from "./skill-install";

type LegacySkillAgent = { name: string; configPaths: { dir: string } } | null;

/**
 * Preserve skill behavior for registry rows that predate package receipts.
 * Package-backed sandboxes must use their parsed skill capability instead.
 */
export function resolveLegacySkillPaths(agent: LegacySkillAgent, skillName: string): SkillPaths {
  const stateDir = agent?.configPaths.dir ?? "/sandbox/.openclaw";
  const agentName = agent?.name ?? "openclaw";

  if (agentName === "openclaw") {
    return {
      stateDir,
      uploadDir: `${stateDir}/skills/${skillName}`,
      mirrorDir: `$HOME/.openclaw/skills/${skillName}`,
      collision: "replace",
      removal: "remove",
      activation: {
        kind: "reset-session-index",
        path: `${stateDir}/agents/main/sessions/sessions.json` as `/sandbox/${string}`,
      },
    };
  }

  if (agentName === "langchain-deepagents-code") {
    return {
      stateDir,
      uploadDir: `${stateDir}/agent/skills/${skillName}`,
      mirrorDir: null,
      collision: "refuse",
      removal: "refuse",
      activation: { kind: "new-session" },
    };
  }

  return {
    stateDir,
    uploadDir: `${stateDir}/skills/${skillName}`,
    mirrorDir: null,
    collision: "replace",
    removal: "remove",
    activation:
      agentName === "hermes" ? { kind: "new-session" } : { kind: "gateway-restart-required" },
  };
}
