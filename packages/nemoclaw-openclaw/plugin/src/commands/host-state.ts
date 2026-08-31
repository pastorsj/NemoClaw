// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import JSON5 from "json5";

import { isObjectRecord, type UnknownRecord } from "../shared/object-record.js";

const SANDBOX_MIGRATION_DIR = "/sandbox/.nemoclaw/migration";

export type MigrationRootKind = "workspace" | "agentDir" | "skillsExtraDir";

export interface MigrationRootBinding {
  configPath: string;
}

export interface MigrationExternalRoot {
  id: string;
  kind: MigrationRootKind;
  label: string;
  sourcePath: string;
  snapshotRelativePath: string;
  sandboxPath: string;
  symlinkPaths: string[];
  bindings: MigrationRootBinding[];
}

export interface HostOpenClawState {
  exists: boolean;
  homeDir: string | null;
  stateDir: string | null;
  configDir: string | null;
  configPath: string | null;
  workspaceDir: string | null;
  extensionsDir: string | null;
  skillsDir: string | null;
  hooksDir: string | null;
  externalRoots: MigrationExternalRoot[];
  warnings: string[];
  errors: string[];
  hasExternalConfig: boolean;
}

interface CandidateRoot {
  id: string;
  kind: MigrationRootKind;
  label: string;
  sourcePath: string;
  sandboxPath: string;
  bindings: MigrationRootBinding[];
  required: boolean;
}

type OpenClawConfigDocument = UnknownRecord;

function readString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function readTrimmedString(value: unknown): string | null {
  const trimmed = readString(value)?.trim();
  return trimmed ? trimmed : null;
}

function readRecord(value: unknown): UnknownRecord | null {
  return isObjectRecord(value) ? value : null;
}

function readRecordKey(
  record: UnknownRecord | null | undefined,
  key: string,
): UnknownRecord | null {
  return readRecord(record?.[key]);
}

function readArrayKey(record: UnknownRecord | null | undefined, key: string): unknown[] | null {
  const value = record?.[key];
  return Array.isArray(value) ? value : null;
}

function parseConfigDocument(value: unknown, context: string): OpenClawConfigDocument {
  if (!isObjectRecord(value)) {
    throw new Error(`${context} is not a JSON object.`);
  }
  return value;
}

export function resolveHostHome(env: NodeJS.ProcessEnv = process.env): string {
  const fallbackHome = env.HOME?.trim() || env.USERPROFILE?.trim() || os.homedir();
  const explicitHome = env.OPENCLAW_HOME?.trim();
  if (explicitHome) {
    if (explicitHome === "~") {
      return fallbackHome;
    }
    if (explicitHome.startsWith("~/") || explicitHome.startsWith("~\\")) {
      return path.join(fallbackHome, explicitHome.slice(2));
    }
    return path.resolve(explicitHome);
  }
  return fallbackHome;
}

export function resolveUserPath(input: string, env: NodeJS.ProcessEnv = process.env): string {
  if (input === "~") {
    return resolveHostHome(env);
  }
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return path.join(resolveHostHome(env), input.slice(2));
  }
  return path.resolve(input);
}

export function normalizeHostPath(input: string): string {
  const resolved = path.resolve(input);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function isWithinRoot(candidatePath: string, rootPath: string): boolean {
  const candidate = normalizeHostPath(candidatePath);
  const root = normalizeHostPath(rootPath);
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function resolveStateDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.OPENCLAW_STATE_DIR?.trim();
  if (override) {
    return resolveUserPath(override, env);
  }
  return path.join(resolveHostHome(env), ".openclaw");
}

function resolveConfigPath(stateDir: string, env: NodeJS.ProcessEnv = process.env): string {
  const override = env.OPENCLAW_CONFIG_PATH?.trim();
  if (override) {
    return resolveUserPath(override, env);
  }
  return path.join(stateDir, "openclaw.json");
}

export function parseConfigDocumentText(raw: string, configPath: string): OpenClawConfigDocument {
  // A failed upstream truncate-then-write operation can leave this file empty.
  // Report the recovery action instead of the JSON5 parser error. (#3118)
  if (raw.trim() === "") {
    throw new Error(
      `Config at ${configPath} is empty (0 bytes or whitespace-only). ` +
        "Restart the sandbox to trigger baseline recovery, or restore the " +
        "file from a known-good copy (see #3118).",
    );
  }
  return parseConfigDocument(JSON5.parse(raw), `Config at ${configPath}`);
}

function loadConfigDocument(configPath: string): OpenClawConfigDocument | null {
  if (!existsSync(configPath)) {
    return null;
  }
  return parseConfigDocumentText(readFileSync(configPath, "utf-8"), configPath);
}

export function collectSymlinkPaths(rootPath: string): string[] {
  const symlinks: string[] = [];

  function walk(currentPath: string, relativePath: string): void {
    const stat = lstatSync(currentPath);
    if (stat.isSymbolicLink()) {
      symlinks.push(relativePath || ".");
      return;
    }
    if (!stat.isDirectory()) {
      return;
    }
    for (const entry of readdirSync(currentPath)) {
      const nextPath = path.join(currentPath, entry);
      const nextRelative = relativePath ? path.join(relativePath, entry) : entry;
      walk(nextPath, nextRelative);
    }
  }

  walk(rootPath, "");
  return symlinks.sort();
}

function slugify(input: string): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "root";
}

function registerRoot(
  rootMap: Map<string, CandidateRoot>,
  params: {
    pathValue: string;
    kind: MigrationRootKind;
    label: string;
    bindingPath: string;
    sandboxGroup: string;
    required: boolean;
  },
  env: NodeJS.ProcessEnv = process.env,
): void {
  const resolvedPath = resolveUserPath(params.pathValue, env);
  const normalized = normalizeHostPath(resolvedPath);
  const existing = rootMap.get(normalized);
  if (existing) {
    existing.bindings.push({ configPath: params.bindingPath });
    return;
  }

  const id = `${params.sandboxGroup}-${slugify(params.label)}`;
  rootMap.set(normalized, {
    id,
    kind: params.kind,
    label: params.label,
    sourcePath: resolvedPath,
    sandboxPath: path.posix.join(SANDBOX_MIGRATION_DIR, params.sandboxGroup, id),
    bindings: [{ configPath: params.bindingPath }],
    required: params.required,
  });
}

function defaultWorkspacePath(env: NodeJS.ProcessEnv = process.env): string {
  const home = resolveHostHome(env);
  const profile = env.OPENCLAW_PROFILE?.trim();
  if (profile && profile.toLowerCase() !== "default") {
    return path.join(home, ".openclaw", `workspace-${profile}`);
  }
  return path.join(home, ".openclaw", "workspace");
}

function collectExternalRoots(
  config: OpenClawConfigDocument | null,
  stateDir: string,
  env: NodeJS.ProcessEnv = process.env,
): { roots: MigrationExternalRoot[]; warnings: string[]; errors: string[] } {
  const warnings: string[] = [];
  const errors: string[] = [];
  const rootMap = new Map<string, CandidateRoot>();

  const agents = readRecordKey(config, "agents");
  const agentDefaults = readRecordKey(agents, "defaults");
  const agentList = readArrayKey(agents, "list");
  const skillLoad = readRecordKey(readRecordKey(config, "skills"), "load");

  const defaultsWorkspace = readTrimmedString(agentDefaults?.workspace);
  const defaultWorkspace = defaultsWorkspace ?? defaultWorkspacePath(env);
  registerRoot(
    rootMap,
    {
      pathValue: defaultWorkspace,
      kind: "workspace",
      label: "default-workspace",
      bindingPath: "agents.defaults.workspace",
      sandboxGroup: "workspaces",
      required: typeof defaultsWorkspace === "string" && defaultsWorkspace.trim().length > 0,
    },
    env,
  );

  if (agentList) {
    agentList.forEach((entry, index) => {
      const agent = readRecord(entry);
      if (!agent) {
        return;
      }
      const agentId = readTrimmedString(agent.id) ?? `agent-${String(index)}`;
      const workspace = readTrimmedString(agent.workspace);
      const agentDir = readTrimmedString(agent.agentDir);

      if (workspace) {
        registerRoot(
          rootMap,
          {
            pathValue: workspace,
            kind: "workspace",
            label: `${agentId}-workspace`,
            bindingPath: `agents.list[${String(index)}].workspace`,
            sandboxGroup: "workspaces",
            required: true,
          },
          env,
        );
      }

      if (agentDir) {
        registerRoot(
          rootMap,
          {
            pathValue: agentDir,
            kind: "agentDir",
            label: `${agentId}-agent-dir`,
            bindingPath: `agents.list[${String(index)}].agentDir`,
            sandboxGroup: "agent-dirs",
            required: true,
          },
          env,
        );
      }
    });
  }

  const extraDirs = readArrayKey(skillLoad, "extraDirs");
  if (extraDirs) {
    extraDirs.forEach((entry, index) => {
      const extraDir = readTrimmedString(entry);
      if (!extraDir) {
        return;
      }
      registerRoot(
        rootMap,
        {
          pathValue: extraDir,
          kind: "skillsExtraDir",
          label: `skills-extra-${String(index + 1)}`,
          bindingPath: `skills.load.extraDirs[${String(index)}]`,
          sandboxGroup: "skills",
          required: true,
        },
        env,
      );
    });
  }

  const roots = [...rootMap.values()]
    .filter((root) => !isWithinRoot(root.sourcePath, stateDir))
    .map<MigrationExternalRoot>((root) => ({
      id: root.id,
      kind: root.kind,
      label: root.label,
      sourcePath: root.sourcePath,
      snapshotRelativePath: path.join("external", root.id),
      sandboxPath: root.sandboxPath,
      symlinkPaths: [],
      bindings: root.bindings,
    }));

  const validRoots: MigrationExternalRoot[] = [];
  for (const root of roots) {
    if (!existsSync(root.sourcePath)) {
      const message = `${root.kind} path is missing: ${root.sourcePath} (${root.bindings
        .map((binding) => binding.configPath)
        .join(", ")})`;
      if (rootMap.get(normalizeHostPath(root.sourcePath))?.required) {
        errors.push(`Configured ${message}`);
      } else {
        warnings.push(`Skipping absent optional ${message}`);
      }
      continue;
    }
    try {
      const stat = lstatSync(root.sourcePath);
      if (!stat.isDirectory()) {
        errors.push(
          `${root.kind} path is not a directory: ${root.sourcePath} (${root.bindings
            .map((binding) => binding.configPath)
            .join(", ")})`,
        );
        continue;
      }
      root.symlinkPaths = collectSymlinkPaths(root.sourcePath);
      if (root.symlinkPaths.length > 0) {
        warnings.push(
          `Preserving ${String(root.symlinkPaths.length)} symlink(s) under ${root.sourcePath} during migration.`,
        );
      }
      validRoots.push(root);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`Failed to inspect ${root.sourcePath}: ${message}`);
    }
  }

  return { roots: validRoots, warnings, errors };
}

export function detectHostOpenClaw(env: NodeJS.ProcessEnv = process.env): HostOpenClawState {
  const homeDir = resolveHostHome(env);
  const stateDir = resolveStateDir(env);
  const configPath = resolveConfigPath(stateDir, env);
  const stateExists = existsSync(stateDir);
  const configExists = existsSync(configPath);

  if (!stateExists && !configExists) {
    return {
      exists: false,
      homeDir,
      stateDir: null,
      configDir: null,
      configPath: null,
      workspaceDir: null,
      extensionsDir: null,
      skillsDir: null,
      hooksDir: null,
      externalRoots: [],
      warnings: [],
      errors: [],
      hasExternalConfig: false,
    };
  }

  const errors: string[] = [];
  const warnings: string[] = [];
  let config: OpenClawConfigDocument | null = null;

  if (!stateExists) {
    errors.push(`Resolved OpenClaw state directory does not exist: ${stateDir}`);
  }

  try {
    config = loadConfigDocument(configPath);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    errors.push(`Failed to parse OpenClaw config at ${configPath}: ${message}`);
  }

  const rootInfo = collectExternalRoots(config, stateDir, env);
  warnings.push(...rootInfo.warnings);
  errors.push(...rootInfo.errors);

  const defaultsWorkspace = readTrimmedString(
    readRecordKey(readRecordKey(config, "agents"), "defaults")?.workspace,
  );
  const workspaceDir = defaultsWorkspace
    ? resolveUserPath(defaultsWorkspace, env)
    : defaultWorkspacePath(env);

  const extensionsDir = existsSync(path.join(stateDir, "extensions"))
    ? path.join(stateDir, "extensions")
    : null;
  const skillsDir = existsSync(path.join(stateDir, "skills"))
    ? path.join(stateDir, "skills")
    : null;
  const hooksDir = existsSync(path.join(stateDir, "hooks")) ? path.join(stateDir, "hooks") : null;

  if (existsSync(workspaceDir)) {
    try {
      const symlinkPaths = collectSymlinkPaths(workspaceDir);
      if (symlinkPaths.length > 0) {
        warnings.push(
          `Primary workspace contains ${String(symlinkPaths.length)} symlink(s): ${workspaceDir}.`,
        );
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      warnings.push(`Failed to inspect workspace symlinks at ${workspaceDir}: ${message}`);
    }
  }

  return {
    exists: true,
    homeDir,
    stateDir,
    configDir: stateDir,
    configPath: configExists ? configPath : null,
    workspaceDir: existsSync(workspaceDir) ? workspaceDir : null,
    extensionsDir,
    skillsDir,
    hooksDir,
    externalRoots: rootInfo.roots,
    warnings,
    errors,
    hasExternalConfig: configExists && !isWithinRoot(configPath, stateDir),
  };
}
