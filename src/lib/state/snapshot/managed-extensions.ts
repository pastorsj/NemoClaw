// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";
import { spawnSync } from "node:child_process";

import type {
  HarnessManagedExtension,
  HarnessManagedExtensionsDeclaration,
  HarnessStateSymlinkRule,
} from "@nvidia/nemoclaw-harness-contract";
import { isImmutableSandboxCommandPath } from "@nvidia/nemoclaw-harness-contract/manifest-validator";

import { createTempSshConfig } from "../../sandbox/temp-ssh-config.js";
import { isObjectRecord } from "../../shared/object-record.js";
import { shellQuote } from "../../shared/shell-quote.js";

const MAX_MANAGED_EXTENSIONS = 128;
const MAX_CONFIG_PATHS = 8;
const MAX_CONTROLLER_OUTPUT_BYTES = 1024 * 1024;
const SAFE_DIRECTORY = /^[A-Za-z0-9][A-Za-z0-9._+~-]{0,127}$/u;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;
const FORBIDDEN_IDS = new Set(["__proto__", "constructor", "prototype"]);

export type ManagedExtensionInspectionResult =
  | { readonly ok: true; readonly extensions: readonly HarnessManagedExtension[] }
  | { readonly ok: false; readonly error: string };

export type ManagedExtensionRestorePlan =
  | {
      readonly ok: true;
      readonly freshDirectories: readonly string[];
      readonly previousDirectories: readonly string[];
      readonly preservedDirectories: readonly string[];
      readonly archiveExcludedDirectories: readonly string[];
      readonly requiredFreshDirectories: readonly string[];
    }
  | { readonly ok: false; readonly error: string };

export interface ManagedExtensionDiscoveryDependencies {
  readonly env?: NodeJS.ProcessEnv;
  getSshConfig(sandboxName: string): string | null;
  sshArgs(configFile: string, sandboxName: string): string[];
}

function isCanonicalAbsolutePath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 1 &&
    value.length <= 4096 &&
    !CONTROL_CHARACTERS.test(value) &&
    path.posix.isAbsolute(value) &&
    path.posix.normalize(value) === value
  );
}

function isSafeExtensionId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 256 &&
    !CONTROL_CHARACTERS.test(value) &&
    !FORBIDDEN_IDS.has(value)
  );
}

/** Validate and clone sandbox-controlled output from the package controller. */
export function parseManagedExtensionInspection(
  value: unknown,
  declaration: Extract<HarnessManagedExtensionsDeclaration, { readonly support: "managed" }>,
): ManagedExtensionInspectionResult {
  if (
    !isObjectRecord(value) ||
    Object.keys(value).length !== 2 ||
    !Object.hasOwn(value, "schemaVersion") ||
    !Object.hasOwn(value, "extensions") ||
    value.schemaVersion !== 1 ||
    !Array.isArray(value.extensions)
  ) {
    return { ok: false, error: "managed-extension inspection response is invalid" };
  }
  if (value.extensions.length > MAX_MANAGED_EXTENSIONS) {
    return { ok: false, error: "managed-extension inspection returned too many entries" };
  }
  const ids = new Set<string>();
  const directories = new Set<string>();
  const configPaths = new Set<string>();
  const extensions: HarnessManagedExtension[] = [];
  for (const candidate of value.extensions) {
    if (!isObjectRecord(candidate)) {
      return { ok: false, error: "managed-extension inspection entry is invalid" };
    }
    const keys = Object.keys(candidate);
    if (
      keys.length !== 3 ||
      !keys.includes("id") ||
      !keys.includes("directory") ||
      !keys.includes("configPaths") ||
      !isSafeExtensionId(candidate.id) ||
      ids.has(candidate.id) ||
      (candidate.directory !== null &&
        (typeof candidate.directory !== "string" ||
          !SAFE_DIRECTORY.test(candidate.directory) ||
          directories.has(candidate.directory))) ||
      !Array.isArray(candidate.configPaths) ||
      candidate.configPaths.length > MAX_CONFIG_PATHS ||
      new Set(candidate.configPaths).size !== candidate.configPaths.length ||
      !candidate.configPaths.every(isCanonicalAbsolutePath) ||
      candidate.configPaths.some((configPath) => configPaths.has(configPath))
    ) {
      return { ok: false, error: "managed-extension inspection entry failed validation" };
    }
    ids.add(candidate.id);
    if (typeof candidate.directory === "string") directories.add(candidate.directory);
    for (const configPath of candidate.configPaths as string[]) configPaths.add(configPath);
    extensions.push(
      Object.freeze({
        id: candidate.id,
        directory: candidate.directory as string | null,
        configPaths: Object.freeze([...(candidate.configPaths as string[])]),
      }),
    );
  }
  return {
    ok: true,
    extensions: Object.freeze(extensions.sort((left, right) => left.id.localeCompare(right.id))),
  };
}

/** Run the one finite package operation that reports image-owned extensions. */
export function discoverManagedImageExtensions(
  sandboxName: string,
  declaration: Extract<HarnessManagedExtensionsDeclaration, { readonly support: "managed" }>,
  dependencies: ManagedExtensionDiscoveryDependencies,
): ManagedExtensionInspectionResult {
  if (!isImmutableSandboxCommandPath(declaration.controller.command[0] as string)) {
    return {
      ok: false,
      error: "managed-extension controller command is not stored in the immutable image",
    };
  }
  const sshConfig = dependencies.getSshConfig(sandboxName);
  if (!sshConfig) {
    return { ok: false, error: "could not get SSH config for managed-extension inspection" };
  }
  const tempSshConfig = createTempSshConfig(sshConfig, "nemoclaw-extension-inspection-");
  try {
    const command = [...declaration.controller.command, "inspect-managed-extensions"]
      .map(shellQuote)
      .join(" ");
    const result = spawnSync(
      "ssh",
      [...dependencies.sshArgs(tempSshConfig.file, sandboxName), command],
      {
        ...(dependencies.env ? { env: dependencies.env } : {}),
        stdio: ["ignore", "pipe", "pipe"],
        timeout: declaration.controller.timeout_seconds * 1000,
        maxBuffer: MAX_CONTROLLER_OUTPUT_BYTES,
      },
    );
    if (result.stdout && Buffer.byteLength(result.stdout) > MAX_CONTROLLER_OUTPUT_BYTES) {
      return { ok: false, error: "managed-extension inspection response is too large" };
    }
    if (result.status !== 0 || result.error || result.signal || !result.stdout) {
      return { ok: false, error: "managed-extension inspection command failed" };
    }
    try {
      return parseManagedExtensionInspection(
        JSON.parse(result.stdout.toString("utf8")),
        declaration,
      );
    } catch {
      return { ok: false, error: "managed-extension inspection response is not valid JSON" };
    }
  } finally {
    tempSshConfig.cleanup();
  }
}

/** Clone and validate a durable extension baseline using the receipt declaration. */
export function parseManagedImageExtensions(
  value: unknown,
  declaration: Extract<HarnessManagedExtensionsDeclaration, { readonly support: "managed" }>,
): ManagedExtensionInspectionResult {
  return parseManagedExtensionInspection({ schemaVersion: 1, extensions: value }, declaration);
}

/** Build the generic directory ownership transition for a recreated image. */
export function planManagedExtensionRestore(options: {
  readonly declaration: Extract<
    HarnessManagedExtensionsDeclaration,
    { readonly support: "managed" }
  >;
  readonly restoredStateDirectories: readonly string[];
  readonly freshExtensions: readonly HarnessManagedExtension[];
  readonly previousExtensions?: readonly HarnessManagedExtension[];
}): ManagedExtensionRestorePlan {
  if (!options.restoredStateDirectories.includes(options.declaration.state_directory)) {
    return {
      ok: true,
      freshDirectories: [],
      previousDirectories: [],
      preservedDirectories: [],
      archiveExcludedDirectories: [],
      requiredFreshDirectories: [],
    };
  }
  const fresh = parseManagedImageExtensions(options.freshExtensions, options.declaration);
  if (!fresh.ok) return fresh;
  const previous = parseManagedImageExtensions(
    options.previousExtensions ?? [],
    options.declaration,
  );
  if (!previous.ok) return previous;
  const freshDirectories = fresh.extensions.flatMap((entry) =>
    entry.directory === null ? [] : [entry.directory],
  );
  const previousDirectories =
    options.previousExtensions === undefined
      ? []
      : previous.extensions.flatMap((entry) => (entry.directory === null ? [] : [entry.directory]));
  const preservedDirectories = [
    ...new Set([...options.declaration.preserved_directories, ...freshDirectories]),
  ].sort();
  return {
    ok: true,
    freshDirectories,
    previousDirectories,
    preservedDirectories,
    archiveExcludedDirectories: [
      ...new Set([...preservedDirectories, ...previousDirectories]),
    ].sort(),
    requiredFreshDirectories: freshDirectories,
  };
}

function matchesSourcePattern(sourcePattern: string, relativePath: string): boolean {
  const patternSegments = sourcePattern.split("/");
  const pathSegments = relativePath.split(path.sep).join("/").split("/");
  return (
    patternSegments.length === pathSegments.length &&
    patternSegments.every((segment, index) => segment === "*" || segment === pathSegments[index])
  );
}

function matchesRelativeWithinRule(
  rule: Extract<HarnessStateSymlinkRule, { readonly kind: "relative-within" }>,
  relativePath: string,
  linkTarget: string,
): boolean {
  if (
    linkTarget.length === 0 ||
    linkTarget.length > 4096 ||
    path.posix.isAbsolute(linkTarget) ||
    CONTROL_CHARACTERS.test(linkTarget) ||
    linkTarget.includes("%")
  ) {
    return false;
  }
  const sourceParent = path.posix.dirname(relativePath.split(path.sep).join("/"));
  let root = sourceParent;
  for (let index = 0; index < rule.root_ancestor_depth; index += 1) root = path.posix.dirname(root);
  const resolvedTarget = path.posix.normalize(path.posix.join(sourceParent, linkTarget));
  const relativeTarget = path.posix.relative(root, resolvedTarget);
  return (
    relativeTarget.length > 0 &&
    relativeTarget !== ".." &&
    !relativeTarget.startsWith("../") &&
    !path.posix.isAbsolute(relativeTarget) &&
    !rule.forbidden_prefixes.some(
      (prefix) => relativeTarget === prefix || relativeTarget.startsWith(`${prefix}/`),
    )
  );
}

/** Authorize only symlinks described by the receipt-pinned package declaration. */
export function isAllowedManagedStateSymlink(
  declaration: Extract<HarnessManagedExtensionsDeclaration, { readonly support: "managed" }>,
  relativePath: string,
  linkTarget: string,
): boolean {
  return declaration.allowed_symlinks.some((rule) => {
    if (!matchesSourcePattern(rule.source_pattern, relativePath)) return false;
    return rule.kind === "exact-target"
      ? rule.targets.includes(linkTarget)
      : matchesRelativeWithinRule(rule, relativePath, linkTarget);
  });
}

export function buildManagedExtensionRestoreTarArgs(
  backupPath: string,
  localDirectories: readonly string[],
  stateDirectory: string,
  excludedDirectories: readonly string[],
): string[] {
  const args = ["-cf", "-", "-C", backupPath];
  for (const directory of excludedDirectories) {
    args.push("--exclude", `${stateDirectory}/${directory}`);
  }
  args.push("--", ...localDirectories);
  return args;
}

function buildManagedDirectoryCleanupCommand(
  root: string,
  stateDirectory: string,
  preservedDirectories: readonly string[],
  requiredDirectories: ReadonlySet<string>,
): string {
  const managedRoot = `${root}/${stateDirectory}`;
  const validations = preservedDirectories.map((directory) => {
    const managedPath = `${managedRoot}/${directory}`;
    const presence = requiredDirectories.has(directory)
      ? '[ ! -d "$p" ] || [ -L "$p" ]'
      : '{ [ -e "$p" ] || [ -L "$p" ]; } && { [ ! -d "$p" ] || [ -L "$p" ]; }';
    return `p=${shellQuote(managedPath)}; if ${presence}; then echo "refusing missing or unsafe image-managed directory: $p" >&2; exit 20; fi`;
  });
  const namePredicates = preservedDirectories
    .map((directory) => `! -name ${shellQuote(directory)}`)
    .join(" ");
  return [
    `mkdir -p -- ${shellQuote(managedRoot)}`,
    ...(validations.length > 0 ? [`{ ${validations.join("; ")}; }`] : []),
    `find ${shellQuote(managedRoot)} -mindepth 1 -maxdepth 1 ${namePredicates} -exec rm -rf -- {} +`,
  ].join(" && ");
}

function buildStaleDirectoryCleanupCommand(root: string, directory: string): string {
  return (
    `d=${shellQuote(`${root}/${directory}`)}; ` +
    'if [ -d "$d" ] && [ ! -L "$d" ]; then find "$d" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +; fi'
  );
}

/** Build cleanup without embedding any harness-specific path or directory. */
export function buildManagedExtensionCleanupCommand(options: {
  readonly root: string;
  readonly localDirectories: readonly string[];
  readonly staleDirectories?: readonly string[];
  readonly declaration: Extract<
    HarnessManagedExtensionsDeclaration,
    { readonly support: "managed" }
  >;
  readonly preservedDirectories: readonly string[];
  readonly requiredDirectories: ReadonlySet<string>;
}): string {
  const commands: string[] = [];
  for (const directory of options.localDirectories) {
    if (directory === options.declaration.state_directory) continue;
    commands.push(`rm -rf -- ${shellQuote(`${options.root}/${directory}`)}`);
  }
  commands.push(
    buildManagedDirectoryCleanupCommand(
      options.root,
      options.declaration.state_directory,
      options.preservedDirectories,
      options.requiredDirectories,
    ),
  );
  const localSet = new Set(options.localDirectories);
  for (const directory of options.staleDirectories ?? []) {
    if (localSet.has(directory) || directory === options.declaration.state_directory) continue;
    commands.push(buildStaleDirectoryCleanupCommand(options.root, directory));
  }
  return commands.length > 0 ? commands.join(" && ") : ":";
}
