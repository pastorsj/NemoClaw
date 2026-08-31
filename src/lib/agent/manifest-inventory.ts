// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { buildAgentDefinition } from "../agent-runtime/manifest-loader";
import { loadManifestRecord } from "../agent-runtime/manifest-readers";
import { isCuaEnabled } from "../cua/feature";
import { ROOT } from "../runner";
import type { AgentAliasTarget } from "./aliases";
import { isCandidateAgent, isCandidateAgentSelectable } from "./candidate";

export const AGENT_REPOSITORY_ROOT = ROOT;
export const AGENT_MANIFESTS_DIR = path.join(AGENT_REPOSITORY_ROOT, "agents");
export const AGENT_RUNTIME_PACKAGES_DIR = path.join(AGENT_REPOSITORY_ROOT, "packages");

export interface AgentManifestLocation {
  readonly name: string;
  readonly packageRoot: string;
  readonly manifestPath: string;
}

/** List source packages that declare the NemoClaw harness manifest entry point. */
export function listAgentRuntimePackageLocations(): readonly AgentManifestLocation[] {
  if (!fs.existsSync(AGENT_RUNTIME_PACKAGES_DIR)) return [];
  return fs
    .readdirSync(AGENT_RUNTIME_PACKAGES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("nemoclaw-"))
    .flatMap((entry): AgentManifestLocation[] => {
      const packageRoot = path.join(AGENT_RUNTIME_PACKAGES_DIR, entry.name);
      const packageJsonPath = path.join(packageRoot, "package.json");
      try {
        const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as {
          nemoclaw?: { harnessManifest?: unknown };
        };
        const manifestName = packageJson.nemoclaw?.harnessManifest;
        if (typeof manifestName !== "string" || manifestName !== "manifest.yaml") return [];
        const manifestPath = path.join(packageRoot, manifestName);
        const manifest = loadManifestRecord(manifestPath);
        const name = typeof manifest.name === "string" ? manifest.name : "";
        return name ? [{ name, packageRoot, manifestPath }] : [];
      } catch {
        return [];
      }
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function findAgentManifestLocation(name: string): AgentManifestLocation | null {
  return listAgentRuntimePackageLocations().find((location) => location.name === name) ?? null;
}

function legacyAgentManifestLocation(name: string): AgentManifestLocation {
  return {
    name,
    packageRoot: AGENT_REPOSITORY_ROOT,
    manifestPath: path.join(AGENT_MANIFESTS_DIR, name, "manifest.yaml"),
  };
}

/** Read alias metadata through the same manifest validation used by full definitions. */
export function readAgentAliasTargets(
  availableAgents: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): readonly AgentAliasTarget[] {
  return availableAgents.flatMap((name): AgentAliasTarget[] => {
    if (name === "nemocua" && !isCuaEnabled(env)) return [];
    if (isCandidateAgent(name) && !isCandidateAgentSelectable(name, env)) return [];
    try {
      const location = findAgentManifestLocation(name) ?? legacyAgentManifestLocation(name);
      const definition = buildAgentDefinition({
        manifest: loadManifestRecord(location.manifestPath),
        manifestPath: location.manifestPath,
        packageRoot: location.packageRoot,
      });
      return [
        {
          name,
          aliases: definition.agentAliases,
          aliasSummary: definition.agentAliasSummary,
        },
      ];
    } catch {
      return [];
    }
  });
}
