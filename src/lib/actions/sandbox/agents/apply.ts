// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";

import { loadAgentsManifest } from "../../../onboard/agents-manifest";
import { isOpenclawAgent } from "../../../onboard/openclaw-otel-policy-presets";
import {
  buildAgentsApplyDiffGrammar,
  buildOpenclawAgentAddArgsGrammar,
  buildOpenclawAgentDeleteArgsGrammar,
  buildOpenclawAgentListArgsGrammar,
  computeAgentsApplyDiffGrammar,
  findManifestToolsByAgentIdGrammar,
  type OpenClawAgentEntry,
  parseOpenClawAgentsListGrammar,
  validateAgentsManifestForApplyGrammar,
} from "../../../openclaw/cli-grammar";
import * as registry from "../../../state/registry";
import { buildOpenshellExecArgs } from "../exec";

// Lazy-require `ensureLiveSandboxOrExit` because its import chain pulls in
// `runner`/`./platform`, which the Vitest TS loader cannot resolve at module
// load. Matches the pattern in `auto-pair-approval.ts`.
type EnsureLive = (
  sandboxName: string,
  options?: { allowNonReadyPhase?: boolean },
) => Promise<unknown>;
function lazyEnsureLive(): EnsureLive {
  return (require("../gateway-state") as typeof import("../gateway-state"))
    .ensureLiveSandboxOrExit as EnsureLive;
}

export interface AgentsApplyDiff {
  toAdd: Array<{ id: string; workspace?: string; agentDir?: string }>;
  toDelete: string[];
  rebuildOnlyFields: string[];
}

export function validateAgentsManifestForApply(manifestAgents: unknown[]): void {
  validateAgentsManifestForApplyGrammar(manifestAgents);
}

export function computeAgentsApplyDiff(
  currentList: OpenClawAgentEntry[],
  manifestAgents: unknown[],
): { toAdd: AgentsApplyDiff["toAdd"]; toDelete: string[] } {
  return computeAgentsApplyDiffGrammar(currentList, manifestAgents);
}

export function buildAgentsApplyDiff(
  currentList: OpenClawAgentEntry[],
  manifest: { agents: unknown[]; defaults?: unknown; main?: unknown },
): AgentsApplyDiff {
  return buildAgentsApplyDiffGrammar(currentList, manifest);
}

export interface RunAgentsApplyOptions {
  sandboxName: string;
  manifestPath: string;
  yes?: boolean;
  nonInteractive?: boolean;
}

export interface RunAgentsApplyDeps {
  ensureLive?: EnsureLive;
  getSandboxAgent?: (sandboxName: string) => string | null;
  listAgents?: (sandboxName: string) => OpenClawAgentEntry[];
  addAgent?: (sandboxName: string, id: string, workspace: string | undefined) => void;
  deleteAgent?: (sandboxName: string, id: string) => void;
  log?: (message: string) => void;
  exit?: (code: number) => never;
}

function defaultGetSandboxAgent(sandboxName: string): string | null {
  const entry = registry.getSandbox(sandboxName);
  return entry?.agent ?? null;
}

export function parseOpenClawAgentsList(output: string): OpenClawAgentEntry[] {
  return parseOpenClawAgentsListGrammar(output);
}

function defaultListAgents(sandboxName: string): OpenClawAgentEntry[] {
  const { getOpenshellBinary } =
    require("../../../adapters/openshell/runtime") as typeof import("../../../adapters/openshell/runtime");
  const result = spawnSync(
    getOpenshellBinary(),
    buildOpenshellExecArgs(sandboxName, buildOpenclawAgentListArgsGrammar()),
    { stdio: ["ignore", "pipe", "pipe"], encoding: "utf-8" },
  );
  if (result.status !== 0) {
    const stderr = String(result.stderr || "").trim();
    throw new Error(
      `openclaw agents list --json failed (exit ${result.status ?? "?"})${stderr ? `: ${stderr}` : ""}`,
    );
  }
  return parseOpenClawAgentsList(String(result.stdout || "[]"));
}

export function buildOpenclawAgentAddArgs(id: string, workspace?: string | null): string[] {
  return buildOpenclawAgentAddArgsGrammar(id, workspace);
}

export function buildOpenclawAgentDeleteArgs(id: string): string[] {
  return buildOpenclawAgentDeleteArgsGrammar(id);
}

function defaultAddAgent(sandboxName: string, id: string, workspace: string | undefined): void {
  const { getOpenshellBinary } =
    require("../../../adapters/openshell/runtime") as typeof import("../../../adapters/openshell/runtime");
  const result = spawnSync(
    getOpenshellBinary(),
    buildOpenshellExecArgs(sandboxName, buildOpenclawAgentAddArgs(id, workspace)),
    { stdio: "inherit" },
  );
  if (result.status !== 0) {
    throw new Error(`openclaw agents add ${id} failed (exit ${result.status ?? "?"})`);
  }
}

function defaultDeleteAgent(sandboxName: string, id: string): void {
  const { getOpenshellBinary } =
    require("../../../adapters/openshell/runtime") as typeof import("../../../adapters/openshell/runtime");
  const result = spawnSync(
    getOpenshellBinary(),
    buildOpenshellExecArgs(sandboxName, buildOpenclawAgentDeleteArgs(id)),
    { stdio: "inherit" },
  );
  if (result.status !== 0) {
    throw new Error(`openclaw agents delete ${id} failed (exit ${result.status ?? "?"})`);
  }
}

export async function runAgentsApply(
  options: RunAgentsApplyOptions,
  deps: RunAgentsApplyDeps = {},
): Promise<void> {
  const log = deps.log ?? ((message: string) => console.log(message));
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const ensureLive = deps.ensureLive ?? lazyEnsureLive();
  const getSandboxAgent = deps.getSandboxAgent ?? defaultGetSandboxAgent;
  const listAgents = deps.listAgents ?? defaultListAgents;
  const addAgent = deps.addAgent ?? defaultAddAgent;
  const deleteAgent = deps.deleteAgent ?? defaultDeleteAgent;

  await ensureLive(options.sandboxName, { allowNonReadyPhase: false });

  const sandboxAgent = getSandboxAgent(options.sandboxName);
  if (!isOpenclawAgent(sandboxAgent)) {
    log(
      `  agents apply is OpenClaw-specific; sandbox "${options.sandboxName}" runs ${sandboxAgent}. Manage agents through the in-sandbox CLI for that runtime.`,
    );
    exit(1);
  }

  const manifest = loadAgentsManifest(options.manifestPath);
  try {
    validateAgentsManifestForApply(manifest.agents);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log(`  Manifest rejected before mutation: ${reason}`);
    exit(1);
  }
  const currentList = listAgents(options.sandboxName);
  const diff = buildAgentsApplyDiff(currentList, manifest);

  log(`  Sandbox: ${options.sandboxName}`);
  log(`  Manifest: ${options.manifestPath}`);
  log(
    `  Plan: ${diff.toAdd.length} agent(s) to add, ${diff.toDelete.length} to delete, ${currentList.length} currently present.`,
  );
  for (const entry of diff.toAdd) {
    log(`    + ${entry.id}`);
  }
  for (const id of diff.toDelete) {
    log(`    - ${id}`);
  }
  if (diff.rebuildOnlyFields.length > 0) {
    log("");
    log("  ⚠  The following manifest fields require a sandbox rebuild and are not applied here:");
    for (const field of diff.rebuildOnlyFields) {
      log(`     - ${field}`);
    }
    log("  Run `nemoclaw onboard --agents <file> --recreate-sandbox` to bake those fields.");
  }
  if (diff.toAdd.length === 0 && diff.toDelete.length === 0) {
    log("  No roster changes to apply.");
    return;
  }
  if (!options.yes && options.nonInteractive) {
    log("  Pass --yes to apply roster changes in non-interactive mode.");
    exit(1);
  }
  if (!options.yes && !options.nonInteractive) {
    log("  Pass --yes to confirm the roster changes above.");
    exit(2);
  }

  const toolsAgentIds = findManifestToolsByAgentIdGrammar(manifest.agents);
  for (const id of diff.toDelete) {
    log(`  Deleting agent: ${id}`);
    deleteAgent(options.sandboxName, id);
  }
  for (const entry of diff.toAdd) {
    if (toolsAgentIds.has(entry.id)) {
      log(
        `  ⚠  Manifest declares tools for "${entry.id}"; the live add cannot bake a tool policy. Rerun \`nemoclaw onboard --agents <file> --recreate-sandbox\` to apply it.`,
      );
    }
    log(`  Adding agent: ${entry.id}`);
    addAgent(options.sandboxName, entry.id, entry.workspace);
  }
  log("  Apply complete.");
}
