// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { loadHarnessCommonJsModule, resolveHarnessPackage } from "../harness/commonjs-runtime";

export interface OpenClawAgentEntry {
  id: string;
  workspace?: string;
  agentDir?: string;
}

export interface OpenClawAgentsApplyDiff {
  toAdd: Array<{ id: string; workspace?: string; agentDir?: string }>;
  toDelete: string[];
  rebuildOnlyFields: string[];
}

export type OpenClawIncompleteTurnSignal = {
  markers: string[];
  timeoutPhase?: string;
};

type AgentsManifest = { agents: unknown[]; defaults?: unknown; main?: unknown };

type RuntimeModule = {
  validateAgentsManifestForApply(manifestAgents: unknown[]): void;
  computeAgentsApplyDiff(currentList: OpenClawAgentEntry[], manifestAgents: unknown[]): unknown;
  buildAgentsApplyDiff(currentList: OpenClawAgentEntry[], manifest: AgentsManifest): unknown;
  findManifestToolsByAgentId(manifestAgents: unknown[]): unknown;
  parseOpenClawAgentsList(output: string): unknown;
  buildOpenclawAgentListArgs(): unknown;
  buildOpenclawAgentAddArgs(id: string, workspace?: string | null): unknown;
  buildOpenclawAgentDeleteArgs(id: string): unknown;
  openClawAgentJsonProvenanceLines(raw: string, sanitizeDetail: (value: string) => string): unknown;
  openClawAgentIncompleteTurnSignal(raw: string): unknown;
};

const OPENCLAW_AGENT_ID = /^[a-z][a-z0-9_-]{0,31}$/u;
const MAIN_AGENT_ID = "main";
const OPENCLAW_AGENT_DATA_ROOT = "/sandbox/.openclaw";
const MAX_ROSTER_ENTRIES = 4096;
const MAX_REBUILD_ONLY_FIELDS = 4096;
const MAX_ROSTER_STRING_LENGTH = 4096;

let cachedRuntime: {
  selectionKey: string;
  packageRoot: string;
  module: RuntimeModule;
} | null = null;

function loadOpenClawCliGrammarModule(): RuntimeModule {
  const selectionKey = process.env.HOME?.trim() || "<default-home>";
  // A command captures verified helper bytes once. Harness installation takes effect in the next process.
  if (cachedRuntime?.selectionKey === selectionKey) return cachedRuntime.module;
  const harnessPackage = resolveHarnessPackage("openclaw");
  if (!harnessPackage) throw new Error("OpenClaw harness package is unavailable.");
  const loaded = loadHarnessCommonJsModule(harnessPackage, "scripts/cli-grammar.cts", 256 * 1024);
  const runtime = loaded.exports as Partial<RuntimeModule>;
  const functions = [
    runtime.validateAgentsManifestForApply,
    runtime.computeAgentsApplyDiff,
    runtime.buildAgentsApplyDiff,
    runtime.findManifestToolsByAgentId,
    runtime.parseOpenClawAgentsList,
    runtime.buildOpenclawAgentListArgs,
    runtime.buildOpenclawAgentAddArgs,
    runtime.buildOpenclawAgentDeleteArgs,
    runtime.openClawAgentJsonProvenanceLines,
    runtime.openClawAgentIncompleteTurnSignal,
  ];
  if (!functions.every((entry) => typeof entry === "function")) {
    throw new Error("OpenClaw harness CLI-grammar module has an invalid contract.");
  }
  cachedRuntime = {
    selectionKey,
    packageRoot: harnessPackage.rootDir,
    module: runtime as RuntimeModule,
  };
  return cachedRuntime.module;
}

function invalidPackageValue(label: string): never {
  throw new Error(`OpenClaw harness CLI-grammar module returned invalid ${label}.`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeRosterString(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_ROSTER_STRING_LENGTH &&
    !/[\0\r\n]/u.test(value)
  );
}

function expectedAgentPath(kind: "workspace" | "agentDir", id: string): string {
  const segment = kind === "workspace" ? `workspace-${id}` : `agents/${id}`;
  return `${OPENCLAW_AGENT_DATA_ROOT}/${segment}`;
}

function validateAgentId(value: unknown, allowMain: boolean, label: string): string {
  if (!safeRosterString(value) || !OPENCLAW_AGENT_ID.test(value)) {
    return invalidPackageValue(label);
  }
  if (!allowMain && value === MAIN_AGENT_ID) return invalidPackageValue(label);
  return value;
}

function optionalEntryPath(
  record: Record<string, unknown>,
  key: "workspace" | "agentDir",
  id: string,
  requireCanonical: boolean,
  label: string,
): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (!safeRosterString(value)) return invalidPackageValue(label);
  if (requireCanonical && value !== expectedAgentPath(key, id)) {
    return invalidPackageValue(label);
  }
  return value;
}

function validateRosterEntries(
  value: unknown,
  options: {
    allowMain: boolean;
    canonicalPaths: boolean;
    includeMissingPaths?: boolean;
    label: string;
  },
): OpenClawAgentEntry[] {
  if (!Array.isArray(value) || value.length > MAX_ROSTER_ENTRIES) {
    return invalidPackageValue(options.label);
  }
  const seen = new Set<string>();
  return value.map((entry, index) => {
    if (!isRecord(entry)) return invalidPackageValue(`${options.label}[${index}]`);
    const id = validateAgentId(entry.id, options.allowMain, `${options.label}[${index}].id`);
    if (seen.has(id)) return invalidPackageValue(`${options.label}[${index}].id`);
    seen.add(id);
    const workspace = optionalEntryPath(
      entry,
      "workspace",
      id,
      options.canonicalPaths,
      `${options.label}[${index}].workspace`,
    );
    const agentDir = optionalEntryPath(
      entry,
      "agentDir",
      id,
      options.canonicalPaths,
      `${options.label}[${index}].agentDir`,
    );
    return options.includeMissingPaths
      ? { id, workspace, agentDir }
      : {
          id,
          ...(workspace === undefined ? {} : { workspace }),
          ...(agentDir === undefined ? {} : { agentDir }),
        };
  });
}

function manifestAgentEntries(manifestAgents: unknown[]): Map<string, OpenClawAgentEntry> {
  const entries = new Map<string, OpenClawAgentEntry>();
  for (const value of manifestAgents) {
    if (!isRecord(value) || typeof value.id !== "string" || !OPENCLAW_AGENT_ID.test(value.id)) {
      continue;
    }
    entries.set(value.id, {
      id: value.id,
      ...(typeof value.workspace === "string" ? { workspace: value.workspace } : {}),
      ...(typeof value.agentDir === "string" ? { agentDir: value.agentDir } : {}),
    });
  }
  return entries;
}

function validateDeleteIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_ROSTER_ENTRIES) {
    return invalidPackageValue("roster diff toDelete");
  }
  const seen = new Set<string>();
  return value.map((entry, index) => {
    const id = validateAgentId(entry, false, `roster diff toDelete[${index}]`);
    if (seen.has(id)) return invalidPackageValue(`roster diff toDelete[${index}]`);
    seen.add(id);
    return id;
  });
}

function validateRosterDiff(
  value: unknown,
  currentList: OpenClawAgentEntry[],
  manifestAgents: unknown[],
  includeRebuildOnlyFields: boolean,
): OpenClawAgentsApplyDiff {
  if (!isRecord(value)) return invalidPackageValue("roster diff");
  const current = validateRosterEntries(currentList, {
    allowMain: true,
    canonicalPaths: false,
    label: "current roster",
  });
  const toAdd = validateRosterEntries(value.toAdd, {
    allowMain: false,
    canonicalPaths: true,
    includeMissingPaths: true,
    label: "roster diff toAdd",
  });
  const toDelete = validateDeleteIds(value.toDelete);
  const currentIds = new Set(current.map((entry) => entry.id));
  const manifestById = manifestAgentEntries(manifestAgents);
  for (const entry of toAdd) {
    const manifestEntry = manifestById.get(entry.id);
    if (
      !manifestEntry ||
      entry.workspace !== manifestEntry.workspace ||
      entry.agentDir !== manifestEntry.agentDir
    ) {
      return invalidPackageValue("roster diff toAdd");
    }
  }
  if (toDelete.some((id) => !currentIds.has(id))) {
    return invalidPackageValue("roster diff toDelete");
  }
  const addedIds = new Set(toAdd.map((entry) => entry.id));
  if (toDelete.some((id) => addedIds.has(id))) {
    return invalidPackageValue("roster diff");
  }

  let rebuildOnlyFields: string[] = [];
  if (includeRebuildOnlyFields) {
    const fields = value.rebuildOnlyFields;
    if (
      !Array.isArray(fields) ||
      fields.length > MAX_REBUILD_ONLY_FIELDS ||
      !fields.every(safeRosterString) ||
      new Set(fields).size !== fields.length
    ) {
      return invalidPackageValue("roster diff rebuildOnlyFields");
    }
    rebuildOnlyFields = [...fields];
  }
  return { toAdd, toDelete, rebuildOnlyFields };
}

function validateCoreManifestMutationFields(manifestAgents: unknown[]): void {
  const seen = new Set<string>();
  for (let index = 0; index < manifestAgents.length; index += 1) {
    const value = manifestAgents[index];
    if (!isRecord(value)) throw new Error(`agents[${index}] must be a YAML mapping (object)`);
    const id = value.id;
    if (!safeRosterString(id) || !OPENCLAW_AGENT_ID.test(id)) {
      throw new Error(`agents[${index}].id must match ${OPENCLAW_AGENT_ID}`);
    }
    if (id === MAIN_AGENT_ID) {
      throw new Error(`agents[${index}].id "${MAIN_AGENT_ID}" is reserved for the primary agent`);
    }
    if (seen.has(id)) throw new Error(`agents[${index}].id "${id}" is duplicated`);
    seen.add(id);
    for (const key of ["workspace", "agentDir"] as const) {
      if (value[key] !== expectedAgentPath(key, id)) {
        throw new Error(`agents[${index}].${key} must equal "${expectedAgentPath(key, id)}"`);
      }
    }
  }
}

function validateArgv(value: unknown, expected: readonly string[], label: string): string[] {
  if (
    !Array.isArray(value) ||
    value.length !== expected.length ||
    !value.every((entry, index) => entry === expected[index])
  ) {
    return invalidPackageValue(label);
  }
  return [...expected];
}

export function validateAgentsManifestForApplyGrammar(manifestAgents: unknown[]): void {
  validateCoreManifestMutationFields(manifestAgents);
  loadOpenClawCliGrammarModule().validateAgentsManifestForApply(manifestAgents);
}

export function computeAgentsApplyDiffGrammar(
  currentList: OpenClawAgentEntry[],
  manifestAgents: unknown[],
): Pick<OpenClawAgentsApplyDiff, "toAdd" | "toDelete"> {
  const validated = validateRosterDiff(
    loadOpenClawCliGrammarModule().computeAgentsApplyDiff(currentList, manifestAgents),
    currentList,
    manifestAgents,
    false,
  );
  return { toAdd: validated.toAdd, toDelete: validated.toDelete };
}

export function buildAgentsApplyDiffGrammar(
  currentList: OpenClawAgentEntry[],
  manifest: AgentsManifest,
): OpenClawAgentsApplyDiff {
  return validateRosterDiff(
    loadOpenClawCliGrammarModule().buildAgentsApplyDiff(currentList, manifest),
    currentList,
    manifest.agents,
    true,
  );
}

export function findManifestToolsByAgentIdGrammar(manifestAgents: unknown[]): Set<string> {
  const value = loadOpenClawCliGrammarModule().findManifestToolsByAgentId(manifestAgents);
  let entries: unknown[];
  try {
    entries = Array.from(Set.prototype.values.call(value as Set<unknown>));
  } catch {
    return invalidPackageValue("manifest tools agent IDs");
  }
  const manifestIds = new Set(manifestAgentEntries(manifestAgents).keys());
  if (
    entries.length > MAX_ROSTER_ENTRIES ||
    !entries.every((entry) => safeRosterString(entry) && manifestIds.has(entry))
  ) {
    return invalidPackageValue("manifest tools agent IDs");
  }
  return new Set(entries as string[]);
}

export function parseOpenClawAgentsListGrammar(output: string): OpenClawAgentEntry[] {
  return validateRosterEntries(loadOpenClawCliGrammarModule().parseOpenClawAgentsList(output), {
    allowMain: true,
    canonicalPaths: false,
    label: "agent roster",
  });
}

export function buildOpenclawAgentListArgsGrammar(): string[] {
  const expected = ["openclaw", "agents", "list", "--json"];
  return validateArgv(
    loadOpenClawCliGrammarModule().buildOpenclawAgentListArgs(),
    expected,
    "agent-list argv",
  );
}

export function buildOpenclawAgentAddArgsGrammar(id: string, workspace?: string | null): string[] {
  const validatedId = validateAgentId(id, false, "agent-add id");
  if (
    workspace !== null &&
    workspace !== undefined &&
    workspace !== expectedAgentPath("workspace", id)
  ) {
    return invalidPackageValue("agent-add workspace");
  }
  const expected = ["openclaw", "agents", "add", validatedId, "--non-interactive"];
  if (workspace) expected.push("--workspace", workspace);
  return validateArgv(
    loadOpenClawCliGrammarModule().buildOpenclawAgentAddArgs(id, workspace),
    expected,
    "agent-add argv",
  );
}

export function buildOpenclawAgentDeleteArgsGrammar(id: string): string[] {
  const validatedId = validateAgentId(id, false, "agent-delete id");
  const expected = ["openclaw", "agents", "delete", validatedId, "--force"];
  return validateArgv(
    loadOpenClawCliGrammarModule().buildOpenclawAgentDeleteArgs(id),
    expected,
    "agent-delete argv",
  );
}

export function openClawAgentJsonProvenanceLinesGrammar(
  raw: string,
  sanitizeDetail: (value: string) => string,
): string[] {
  return loadOpenClawCliGrammarModule().openClawAgentJsonProvenanceLines(
    raw,
    sanitizeDetail,
  ) as string[];
}

export function openClawAgentIncompleteTurnSignalGrammar(
  raw: string,
): OpenClawIncompleteTurnSignal | null {
  return loadOpenClawCliGrammarModule().openClawAgentIncompleteTurnSignal(
    raw,
  ) as OpenClawIncompleteTurnSignal | null;
}
