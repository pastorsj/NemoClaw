// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

import type { AgentDefinition } from "../agent/defs";
import type { DockerUlimit } from "./docker-gpu-patch-types";
import { isPortableExperimentalProfile } from "./experimental/portable-profile";

const DCODE_AGENT_NAME = "langchain-deepagents-code";

// DCode's managed entrypoint fails closed unless both limits are exact. Set
// them on the Docker container so the OpenShell supervisor and every child
// inherit the contract, including after container and gateway restarts.
export const DCODE_DOCKER_ULIMITS: readonly DockerUlimit[] = [
  { name: "nproc", soft: 512, hard: 512 },
  { name: "nofile", soft: 65_536, hard: 65_536 },
];

/** Recognize a definition produced from an authored or installed package manifest. */
export function isPackageOwnedAgentDefinition(
  agent: AgentDefinition | null | undefined,
): agent is AgentDefinition {
  if (!agent || typeof agent.manifestPath !== "string" || typeof agent.packageRoot !== "string") {
    return false;
  }
  const manifestPath = path.relative(agent.packageRoot, agent.manifestPath);
  return (
    manifestPath === "manifest.yaml" ||
    manifestPath === path.join("packages", `nemoclaw-${agent.name}`, "manifest.yaml")
  );
}

export function resolveDockerStartupCommandPatch(
  agent: AgentDefinition | null | undefined,
  dockerDriverGateway: boolean | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): {
  persistStartupCommand: boolean;
  requiredUlimits: readonly DockerUlimit[] | null;
} {
  if (dockerDriverGateway !== true) {
    return { persistStartupCommand: false, requiredUlimits: null };
  }
  const agentName = agent?.name ?? "openclaw";
  const requiredUlimits = agentName === DCODE_AGENT_NAME ? DCODE_DOCKER_ULIMITS : null;
  // The restart-safe recreation discovers the sandbox with docker-driver
  // labels (openshell.ai/managed-by), but the portable profile registers the
  // gateway with the podman driver, whose containers never carry that label —
  // the recreation can only fail after Ready (#9462). Portable+OpenClaw
  // persistence is owned by the portable lifecycle instead (#9176).
  if (isPortableExperimentalProfile(env)) {
    return { persistStartupCommand: false, requiredUlimits };
  }
  return {
    persistStartupCommand:
      isPackageOwnedAgentDefinition(agent) ||
      agentName === "openclaw" ||
      agentName === "hermes" ||
      agentName === DCODE_AGENT_NAME,
    requiredUlimits,
  };
}
