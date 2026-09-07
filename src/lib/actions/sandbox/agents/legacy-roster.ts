// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";

import { loadAgentsManifest } from "../../../onboard/agents-manifest";
import { buildOpenshellExecArgs, execSandbox } from "../exec";
import { ensureLiveSandboxOrExit } from "../gateway-state";
import { getOpenshellBinary } from "./openshell";

interface LegacyAgentEntry {
  readonly id: string;
  readonly workspace?: string;
}

export interface LegacyAgentsApplyOptions {
  readonly sandboxName: string;
  readonly manifestPath: string;
  readonly yes?: boolean;
  readonly nonInteractive?: boolean;
}

export interface LegacyAgentsApplyDependencies {
  readonly ensureLive?: typeof ensureLiveSandboxOrExit;
  readonly listAgents?: (sandboxName: string) => LegacyAgentEntry[];
  readonly addAgent?: (sandboxName: string, id: string, workspace: string | undefined) => void;
  readonly deleteAgent?: (sandboxName: string, id: string) => void;
  readonly log?: (message: string) => void;
  readonly exit?: (code: number) => never;
}

const AGENT_ID_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeLegacyAgents(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value))
    throw new Error("agents manifest 'agents' must be a list when present");
  const seen = new Set<string>();
  return value.map((candidate, index) => {
    if (!isRecord(candidate)) throw new Error(`agents[${String(index)}] must be a YAML mapping`);
    const entry = { ...candidate };
    const id = entry.id;
    if (typeof id !== "string" || !AGENT_ID_PATTERN.test(id) || id === "main") {
      throw new Error(`agents[${String(index)}].id is invalid or reserved`);
    }
    if (seen.has(id)) throw new Error(`agents[${String(index)}].id "${id}" is duplicated`);
    seen.add(id);
    const workspace = `/sandbox/.openclaw/workspace-${id}`;
    const agentDir = `/sandbox/.openclaw/agents/${id}`;
    entry.workspace ??= workspace;
    entry.agentDir ??= agentDir;
    if (entry.workspace !== workspace || entry.agentDir !== agentDir) {
      throw new Error(`agents[${String(index)}] must use OpenClaw's canonical state paths`);
    }
    return entry;
  });
}

function parseLegacyAgents(output: string): LegacyAgentEntry[] {
  const trimmed = output.trim();
  let parsed: unknown;
  let parsedSuccessfully = false;
  for (let index = 0; index < trimmed.length; index += 1) {
    if (trimmed[index] !== "[" && trimmed[index] !== "{") continue;
    try {
      parsed = JSON.parse(trimmed.slice(index) || "[]") as unknown;
      parsedSuccessfully = true;
      break;
    } catch {
      // Ignore warning prefixes from the native CLI.
    }
  }
  if (!parsedSuccessfully) parsed = JSON.parse(trimmed || "[]") as unknown;
  const entries = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed) && Array.isArray(parsed.agents)
      ? parsed.agents
      : null;
  if (!entries) throw new Error("openclaw agents list --json did not return a JSON array");
  return entries.flatMap((entry) =>
    isRecord(entry) && typeof entry.id === "string"
      ? [
          {
            id: entry.id,
            ...(typeof entry.workspace === "string" ? { workspace: entry.workspace } : {}),
          },
        ]
      : [],
  );
}

function hasLegacyContent(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (Array.isArray(value)) return value.length > 0;
  return typeof value === "object" ? Object.keys(value).length > 0 : false;
}

function legacyRebuildOnlyFields(manifest: Record<string, unknown>): string[] {
  const fields: string[] = [];
  if (hasLegacyContent(manifest.defaults)) fields.push("defaults");
  if (hasLegacyContent(manifest.main)) fields.push("main");
  const agents = Array.isArray(manifest.agents) ? manifest.agents : [];
  for (const entry of agents) {
    if (!isRecord(entry)) continue;
    const id = typeof entry.id === "string" ? entry.id : "?";
    if (entry.model !== undefined) fields.push(`agents[${id}].model`);
    if (hasLegacyContent(entry.subagents)) fields.push(`agents[${id}].subagents`);
    if (hasLegacyContent(entry.tools)) fields.push(`agents[${id}].tools`);
  }
  return fields;
}

function defaultListAgents(sandboxName: string): LegacyAgentEntry[] {
  const result = spawnSync(
    getOpenshellBinary(),
    buildOpenshellExecArgs(sandboxName, ["openclaw", "agents", "list", "--json"]),
    { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  if (result.status !== 0) {
    const stderr = String(result.stderr ?? "").trim();
    throw new Error(
      `openclaw agents list --json failed (exit ${String(result.status ?? "?")})${stderr ? `: ${stderr}` : ""}`,
    );
  }
  return parseLegacyAgents(String(result.stdout ?? "[]"));
}

function defaultAddAgent(sandboxName: string, id: string, workspace: string | undefined): void {
  const command = ["openclaw", "agents", "add", id, "--non-interactive"];
  if (workspace) command.push("--workspace", workspace);
  const result = spawnSync(getOpenshellBinary(), buildOpenshellExecArgs(sandboxName, command), {
    stdio: "inherit",
  });
  if (result.status !== 0) throw new Error(`openclaw agents add ${id} failed`);
}

function defaultDeleteAgent(sandboxName: string, id: string): void {
  const command = ["openclaw", "agents", "delete", id, "--force"];
  const result = spawnSync(getOpenshellBinary(), buildOpenshellExecArgs(sandboxName, command), {
    stdio: "inherit",
  });
  if (result.status !== 0) throw new Error(`openclaw agents delete ${id} failed`);
}

/** Keep pre-receipt OpenClaw pass-through behavior isolated from package dispatch. */
export async function runLegacyAgentsPassthrough(
  sandboxName: string,
  operation: "list" | "add" | "delete",
  arguments_: readonly string[],
): Promise<void> {
  await ensureLiveSandboxOrExit(sandboxName, { allowNonReadyPhase: true });
  await execSandbox(sandboxName, ["openclaw", "agents", operation, ...arguments_]);
}

/** Keep pre-receipt OpenClaw reconciliation available without influencing package selection. */
export async function runLegacyAgentsApply(
  options: LegacyAgentsApplyOptions,
  dependencies: LegacyAgentsApplyDependencies = {},
): Promise<void> {
  const log = dependencies.log ?? ((message: string) => console.log(message));
  const exit = dependencies.exit ?? ((code: number) => process.exit(code));
  await (dependencies.ensureLive ?? ensureLiveSandboxOrExit)(options.sandboxName, {
    allowNonReadyPhase: false,
  });

  const manifest = loadAgentsManifest(options.manifestPath);
  let desired: Array<Record<string, unknown>>;
  try {
    desired = normalizeLegacyAgents(manifest.agents ?? []);
  } catch (error) {
    log(
      `  Manifest rejected before mutation: ${error instanceof Error ? error.message : String(error)}`,
    );
    return exit(1);
  }
  const current = (dependencies.listAgents ?? defaultListAgents)(options.sandboxName);
  const currentIds = new Set(current.map((entry) => entry.id));
  const desiredIds = new Set(desired.map((entry) => String(entry.id)));
  const additions = desired.filter((entry) => !currentIds.has(String(entry.id)));
  const deletions = current.filter((entry) => entry.id !== "main" && !desiredIds.has(entry.id));
  const rebuildOnlyFields = legacyRebuildOnlyFields(manifest);

  log(`  Sandbox: ${options.sandboxName}`);
  log(`  Manifest: ${options.manifestPath}`);
  log(
    `  Plan: ${String(additions.length)} agent(s) to add, ${String(deletions.length)} to delete, ${String(current.length)} currently present.`,
  );
  additions.forEach((entry) => log(`    + ${String(entry.id)}`));
  deletions.forEach((entry) => log(`    - ${entry.id}`));
  if (rebuildOnlyFields.length > 0) {
    log("");
    log("  ⚠  The following manifest fields require a sandbox rebuild and are not applied here:");
    rebuildOnlyFields.forEach((field) => log(`     - ${field}`));
    log("  Run `nemoclaw onboard --agents <file> --recreate-sandbox` to bake those fields.");
  }
  if (additions.length === 0 && deletions.length === 0) {
    log("  No roster changes to apply.");
    return;
  }
  if (!options.yes) {
    log(
      options.nonInteractive
        ? "  Pass --yes to apply roster changes in non-interactive mode."
        : "  Pass --yes to confirm the roster changes above.",
    );
    return exit(options.nonInteractive ? 1 : 2);
  }
  for (const entry of deletions) {
    log(`  Deleting agent: ${entry.id}`);
    (dependencies.deleteAgent ?? defaultDeleteAgent)(options.sandboxName, entry.id);
  }
  for (const entry of additions) {
    const id = String(entry.id);
    if (hasLegacyContent(entry.tools)) {
      log(
        `  ⚠  Manifest declares tools for "${id}"; the live add cannot bake a tool policy. Rerun \`nemoclaw onboard --agents <file> --recreate-sandbox\` to apply it.`,
      );
    }
    log(`  Adding agent: ${id}`);
    (dependencies.addAgent ?? defaultAddAgent)(
      options.sandboxName,
      id,
      typeof entry.workspace === "string" ? entry.workspace : undefined,
    );
  }
  log("  Apply complete.");
}
