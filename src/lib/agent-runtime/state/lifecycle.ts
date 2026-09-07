// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

import type {
  HarnessBackupQuiescenceDeclaration,
  HarnessConfigIntegrityDeclaration,
  HarnessManagedExtensionsDeclaration,
  HarnessPostRestoreDeclaration,
  HarnessRebuildStateDeclaration,
  HarnessScheduledWorkDeclaration,
  HarnessSnapshotRestoreAction,
  HarnessStateCommandDeclaration,
  HarnessStateLifecycleDeclaration,
} from "@nvidia/nemoclaw-harness-contract";
import { isImmutableSandboxCommandPath } from "@nvidia/nemoclaw-harness-contract/manifest-validator";

import { readObject } from "../manifest-readers";
import type { ManifestRecord } from "../manifest-types";

const SNAPSHOT_RESTORE_ACTIONS = new Set<HarnessSnapshotRestoreAction>([
  "repair-mutable-config",
  "restart-runtime",
]);
const PRESERVED_ENV_PATTERN = /^[A-Z0-9_*]+$/u;
const CREDENTIAL_ENV_TERMS = new Set(["AUTH", "CREDENTIAL", "KEY", "PASSWORD", "SECRET", "TOKEN"]);

function isCanonicalHomeRenderTarget(value: string): boolean {
  if (!value.startsWith("~/") || value.includes("\\")) return false;
  const segments = value.slice(2).split("/");
  return (
    segments.length > 0 &&
    segments.every(
      (segment) =>
        segment.length > 0 &&
        segment !== "." &&
        segment !== ".." &&
        /^[A-Za-z0-9._-]+$/u.test(segment),
    )
  );
}
function requireExactFields(
  record: ManifestRecord,
  fields: ReadonlySet<string>,
  label: string,
): void {
  const actual = Object.keys(record);
  if (actual.length !== fields.size || actual.some((field) => !fields.has(field))) {
    throw new Error(
      `Agent manifest field '${label}' must contain exactly ${[...fields].join(", ")}`,
    );
  }
}

function requireKnownFields(
  record: ManifestRecord,
  allowed: ReadonlySet<string>,
  required: ReadonlySet<string>,
  label: string,
): void {
  const actual = Object.keys(record);
  if (
    actual.some((field) => !allowed.has(field)) ||
    [...required].some((field) => !Object.hasOwn(record, field))
  ) {
    throw new Error(
      `Agent manifest field '${label}' must contain ${[...required].join(", ")} and only known fields`,
    );
  }
}

function readBackupQuiescence(lifecycle: ManifestRecord): HarnessBackupQuiescenceDeclaration {
  const value = readObject(lifecycle, "backup_quiescence");
  if (!value) {
    throw new Error("Agent manifest field 'state_lifecycle.backup_quiescence' must be an object");
  }
  if (value.kind === "not-required") {
    requireExactFields(value, new Set(["kind"]), "state_lifecycle.backup_quiescence");
    return Object.freeze({ kind: "not-required" });
  }
  requireExactFields(
    value,
    new Set(["kind", "command", "timeout_seconds"]),
    "state_lifecycle.backup_quiescence",
  );
  if (value.kind !== "command") {
    throw new Error(
      "Agent manifest field 'state_lifecycle.backup_quiescence.kind' must be not-required or command",
    );
  }
  const command = value.command;
  if (
    !Array.isArray(command) ||
    command.length === 0 ||
    command.length > 16 ||
    command.some(
      (argument) =>
        typeof argument !== "string" ||
        argument.length === 0 ||
        argument.length > 1024 ||
        /[\0\r\n]/u.test(argument),
    )
  ) {
    throw new Error(
      "Agent manifest field 'state_lifecycle.backup_quiescence.command' must be a non-empty bounded argument array",
    );
  }
  const executable = command[0] as string;
  if (!isImmutableSandboxCommandPath(executable)) {
    throw new Error(
      "Agent manifest field 'state_lifecycle.backup_quiescence.command[0]' must be an immutable image-owned executable path",
    );
  }
  const timeoutSeconds = value.timeout_seconds;
  if (
    typeof timeoutSeconds !== "number" ||
    !Number.isInteger(timeoutSeconds) ||
    timeoutSeconds < 1 ||
    timeoutSeconds > 120
  ) {
    throw new Error(
      "Agent manifest field 'state_lifecycle.backup_quiescence.timeout_seconds' must be an integer from 1 through 120",
    );
  }
  return Object.freeze({
    kind: "command",
    command: Object.freeze([...(command as string[])]),
    timeout_seconds: timeoutSeconds,
  });
}

function readActions<Action extends string>(
  lifecycle: ManifestRecord,
  key: "snapshot_restore",
  allowed: ReadonlySet<Action>,
): readonly Action[] {
  const value = lifecycle[key];
  if (
    !Array.isArray(value) ||
    value.length > allowed.size ||
    value.some((entry) => typeof entry !== "string" || !allowed.has(entry as Action)) ||
    new Set(value).size !== value.length
  ) {
    throw new Error(
      `Agent manifest field 'state_lifecycle.${key}' must be a unique list of supported state lifecycle actions`,
    );
  }
  return Object.freeze([...(value as Action[])]);
}

function readStateCommand(value: unknown, field: string): HarnessStateCommandDeclaration {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    value instanceof Date
  ) {
    throw new Error(`Agent manifest field '${field}' must be an object`);
  }
  const declaration = value as ManifestRecord;
  requireExactFields(declaration, new Set(["command", "timeout_seconds"]), field);
  const command = declaration.command;
  if (
    !Array.isArray(command) ||
    command.length === 0 ||
    command.length > 32 ||
    command.some(
      (argument) =>
        typeof argument !== "string" ||
        argument.length === 0 ||
        argument.length > 4096 ||
        /[\0\r\n]/u.test(argument),
    )
  ) {
    throw new Error(
      `Agent manifest field '${field}.command' must be a non-empty bounded argument array`,
    );
  }
  const executable = command[0] as string;
  if (!path.posix.isAbsolute(executable) || path.posix.normalize(executable) !== executable) {
    throw new Error(`Agent manifest field '${field}.command[0]' must be a canonical absolute path`);
  }
  const timeoutSeconds = declaration.timeout_seconds;
  if (
    typeof timeoutSeconds !== "number" ||
    !Number.isInteger(timeoutSeconds) ||
    timeoutSeconds < 1 ||
    timeoutSeconds > 300
  ) {
    throw new Error(
      `Agent manifest field '${field}.timeout_seconds' must be an integer from 1 through 300`,
    );
  }
  return Object.freeze({
    command: Object.freeze([...(command as string[])]),
    timeout_seconds: timeoutSeconds,
  });
}

function readConfigIntegrity(postRestore: ManifestRecord): HarnessConfigIntegrityDeclaration {
  const field = "state_lifecycle.rebuild.post_restore.config_integrity";
  const declaration = readObject(postRestore, "config_integrity");
  if (!declaration) throw new Error(`Agent manifest field '${field}' must be an object`);
  if (declaration.kind === "not-required") {
    requireExactFields(declaration, new Set(["kind"]), field);
    return Object.freeze({ kind: "not-required" });
  }
  requireExactFields(declaration, new Set(["kind", "refresh", "verify"]), field);
  if (declaration.kind !== "commands") {
    throw new Error(`Agent manifest field '${field}.kind' must be not-required or commands`);
  }
  return Object.freeze({
    kind: "commands",
    refresh: readStateCommand(declaration.refresh, `${field}.refresh`),
    verify: readStateCommand(declaration.verify, `${field}.verify`),
  });
}

function isDirectStateDirectory(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 256 &&
    /^[A-Za-z0-9._-]+$/u.test(value)
  );
}

function readManagedExtensions(rebuild: ManifestRecord): HarnessManagedExtensionsDeclaration {
  const field = "state_lifecycle.rebuild.managed_extensions";
  const declaration = readObject(rebuild, "managed_extensions");
  if (!declaration) throw new Error(`Agent manifest field '${field}' must be an object`);
  if (declaration.support === "disabled") {
    requireExactFields(declaration, new Set(["support", "reason"]), field);
    if (typeof declaration.reason !== "string" || !declaration.reason.trim()) {
      throw new Error(`Agent manifest field '${field}.reason' must be a non-empty string`);
    }
    return Object.freeze({ support: "disabled", reason: declaration.reason });
  }
  requireExactFields(
    declaration,
    new Set([
      "support",
      "controller",
      "state_directory",
      "preserved_directories",
      "allowed_symlinks",
    ]),
    field,
  );
  const stateDirectory = declaration.state_directory;
  const preservedDirectories = declaration.preserved_directories;
  const rawRules = declaration.allowed_symlinks;
  if (
    declaration.support !== "managed" ||
    !isDirectStateDirectory(stateDirectory) ||
    !Array.isArray(preservedDirectories) ||
    preservedDirectories.length > 64 ||
    !preservedDirectories.every(isDirectStateDirectory) ||
    new Set(preservedDirectories).size !== preservedDirectories.length ||
    !Array.isArray(rawRules) ||
    rawRules.length > 16
  ) {
    throw new Error(`Agent manifest field '${field}' has an invalid managed declaration`);
  }
  const seenPatterns = new Set<string>();
  const allowedSymlinks = rawRules.map((value, index) => {
    const ruleField = `${field}.allowed_symlinks[${String(index)}]`;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`Agent manifest field '${ruleField}' must be an object`);
    }
    const rule = value as ManifestRecord;
    const sourcePattern = rule.source_pattern;
    const patternSegments = typeof sourcePattern === "string" ? sourcePattern.split("/") : [];
    const validPattern =
      typeof sourcePattern === "string" &&
      sourcePattern.length > 0 &&
      sourcePattern.length <= 512 &&
      sourcePattern.startsWith(`${stateDirectory}/`) &&
      !sourcePattern.includes("\\") &&
      patternSegments.every(
        (segment) =>
          segment.length > 0 &&
          segment !== "." &&
          segment !== ".." &&
          (segment === "*" || /^[A-Za-z0-9._-]+$/u.test(segment)),
      ) &&
      !seenPatterns.has(sourcePattern);
    if (!validPattern) {
      throw new Error(`Agent manifest field '${ruleField}.source_pattern' is invalid`);
    }
    seenPatterns.add(sourcePattern);
    if (rule.kind === "exact-target") {
      requireExactFields(rule, new Set(["kind", "source_pattern", "targets"]), ruleField);
      if (
        !Array.isArray(rule.targets) ||
        rule.targets.length === 0 ||
        rule.targets.length > 16 ||
        !rule.targets.every(
          (target) =>
            typeof target === "string" &&
            target.length <= 4096 &&
            path.posix.isAbsolute(target) &&
            path.posix.normalize(target) === target &&
            !/[\0\r\n]/u.test(target),
        ) ||
        new Set(rule.targets).size !== rule.targets.length
      ) {
        throw new Error(`Agent manifest field '${ruleField}.targets' is invalid`);
      }
      return Object.freeze({
        kind: "exact-target" as const,
        source_pattern: sourcePattern,
        targets: Object.freeze([...(rule.targets as string[])]),
      });
    }
    requireExactFields(
      rule,
      new Set(["kind", "source_pattern", "root_ancestor_depth", "forbidden_prefixes"]),
      ruleField,
    );
    if (
      rule.kind !== "relative-within" ||
      !Number.isInteger(rule.root_ancestor_depth) ||
      (rule.root_ancestor_depth as number) < 0 ||
      (rule.root_ancestor_depth as number) > 8 ||
      !Array.isArray(rule.forbidden_prefixes) ||
      rule.forbidden_prefixes.length > 8 ||
      !rule.forbidden_prefixes.every(
        (prefix) =>
          typeof prefix === "string" &&
          prefix.length > 0 &&
          !path.posix.isAbsolute(prefix) &&
          path.posix.normalize(prefix) === prefix &&
          !prefix.startsWith("../") &&
          prefix !== "..",
      ) ||
      new Set(rule.forbidden_prefixes).size !== rule.forbidden_prefixes.length
    ) {
      throw new Error(`Agent manifest field '${ruleField}' is invalid`);
    }
    return Object.freeze({
      kind: "relative-within" as const,
      source_pattern: sourcePattern,
      root_ancestor_depth: rule.root_ancestor_depth as number,
      forbidden_prefixes: Object.freeze([...(rule.forbidden_prefixes as string[])]),
    });
  });
  const controller = readStateCommand(declaration.controller, `${field}.controller`);
  if (!isImmutableSandboxCommandPath(controller.command[0] as string)) {
    throw new Error(
      `Agent manifest field '${field}.controller.command[0]' must be an immutable image-owned executable path`,
    );
  }
  return Object.freeze({
    support: "managed",
    controller,
    state_directory: stateDirectory,
    preserved_directories: Object.freeze([...(preservedDirectories as string[])]),
    allowed_symlinks: Object.freeze(allowedSymlinks),
  });
}

function readScheduledWork(rebuild: ManifestRecord): HarnessScheduledWorkDeclaration {
  const field = "state_lifecycle.rebuild.scheduled_work";
  const declaration = readObject(rebuild, "scheduled_work");
  if (!declaration) throw new Error(`Agent manifest field '${field}' must be an object`);
  if (declaration.support === "disabled") {
    requireExactFields(declaration, new Set(["support", "reason"]), field);
    if (typeof declaration.reason !== "string" || !declaration.reason.trim()) {
      throw new Error(`Agent manifest field '${field}.reason' must be a non-empty string`);
    }
    return Object.freeze({ support: "disabled", reason: declaration.reason });
  }
  requireExactFields(
    declaration,
    new Set([
      "support",
      "controller",
      "jobs_path",
      "scripts_path",
      "profiles_path",
      "runtime_root",
    ]),
    field,
  );
  const relativePaths = [
    declaration.jobs_path,
    declaration.scripts_path,
    declaration.profiles_path,
  ];
  const validRelativePath = (candidate: unknown): candidate is string =>
    typeof candidate === "string" &&
    candidate.length > 0 &&
    !candidate.startsWith("/") &&
    !candidate.includes("\\") &&
    candidate
      .split("/")
      .every((segment) => segment.length > 0 && segment !== "." && segment !== "..") &&
    !/[\0\r\n]/u.test(candidate);
  const runtimeRoot = declaration.runtime_root;
  if (
    declaration.support !== "managed" ||
    !relativePaths.every(validRelativePath) ||
    typeof runtimeRoot !== "string" ||
    !runtimeRoot.startsWith("/sandbox/") ||
    path.posix.normalize(runtimeRoot) !== runtimeRoot
  ) {
    throw new Error(`Agent manifest field '${field}' has an invalid managed declaration`);
  }
  const controller = readStateCommand(declaration.controller, `${field}.controller`);
  if (!isImmutableSandboxCommandPath(controller.command[0] as string)) {
    throw new Error(
      `Agent manifest field '${field}.controller.command[0]' must be an immutable image-owned executable path`,
    );
  }
  return Object.freeze({
    support: "managed",
    controller,
    jobs_path: declaration.jobs_path as string,
    scripts_path: declaration.scripts_path as string,
    profiles_path: declaration.profiles_path as string,
    runtime_root: runtimeRoot as `/sandbox/${string}`,
  });
}

function readPostRestore(rebuild: ManifestRecord): HarnessPostRestoreDeclaration {
  const field = "state_lifecycle.rebuild.post_restore";
  const declaration = readObject(rebuild, "post_restore");
  if (!declaration) throw new Error(`Agent manifest field '${field}' must be an object`);
  if (declaration.kind === "not-required") {
    requireExactFields(declaration, new Set(["kind"]), field);
    return Object.freeze({ kind: "not-required" });
  }
  requireExactFields(
    declaration,
    new Set([
      "kind",
      "command",
      "reapply_messaging",
      "restart_runtime",
      "mutable_config",
      "config_integrity",
      "settle_device_pairing",
      "notify_gateway_token_change",
    ]),
    field,
  );
  const mutableConfig = declaration.mutable_config;
  const booleans = [
    declaration.reapply_messaging,
    declaration.restart_runtime,
    declaration.settle_device_pairing,
    declaration.notify_gateway_token_change,
  ];
  if (
    declaration.kind !== "managed" ||
    !booleans.every((value) => typeof value === "boolean") ||
    (mutableConfig !== "not-required" && mutableConfig !== "repair" && mutableConfig !== "verify")
  ) {
    throw new Error(`Agent manifest field '${field}' has an invalid managed declaration`);
  }
  return Object.freeze({
    kind: "managed",
    command:
      declaration.command === null
        ? null
        : readStateCommand(declaration.command, `${field}.command`),
    reapply_messaging: declaration.reapply_messaging as boolean,
    restart_runtime: declaration.restart_runtime as boolean,
    mutable_config: mutableConfig,
    config_integrity: readConfigIntegrity(declaration),
    settle_device_pairing: declaration.settle_device_pairing as boolean,
    notify_gateway_token_change: declaration.notify_gateway_token_change as boolean,
  });
}

function readRebuildState(lifecycle: ManifestRecord): HarnessRebuildStateDeclaration {
  const field = "state_lifecycle.rebuild";
  const rebuild = readObject(lifecycle, "rebuild");
  if (!rebuild) throw new Error(`Agent manifest field '${field}' must be an object`);
  requireKnownFields(
    rebuild,
    new Set(["managed_extensions", "post_restore", "preserved_environment", "scheduled_work"]),
    new Set(["managed_extensions", "post_restore", "scheduled_work"]),
    field,
  );
  const managedExtensions = readManagedExtensions(rebuild);
  const preservedEnvironment = (() => {
    if (rebuild.preserved_environment === undefined) return undefined;
    const declaration = readObject(rebuild, "preserved_environment");
    if (!declaration) {
      throw new Error(`Agent manifest field '${field}.preserved_environment' must be an object`);
    }
    requireExactFields(declaration, new Set(["files"]), `${field}.preserved_environment`);
    if (!Array.isArray(declaration.files) || declaration.files.length > 8) {
      throw new Error(
        `Agent manifest field '${field}.preserved_environment.files' must contain at most eight files`,
      );
    }
    const paths = new Set<string>();
    const files = declaration.files.map((value, index) => {
      const itemField = `${field}.preserved_environment.files[${String(index)}]`;
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`Agent manifest field '${itemField}' must be an object`);
      }
      const item = value as ManifestRecord;
      requireExactFields(item, new Set(["path", "patterns", "render_target"]), itemField);
      const filePath = item.path;
      const patterns = item.patterns;
      const renderTarget = item.render_target;
      if (
        typeof filePath !== "string" ||
        filePath.length === 0 ||
        path.posix.normalize(filePath) !== filePath ||
        path.posix.isAbsolute(filePath) ||
        filePath.startsWith("../") ||
        filePath === ".." ||
        paths.has(filePath)
      ) {
        throw new Error(`Agent manifest field '${itemField}.path' must be a unique relative path`);
      }
      if (typeof renderTarget !== "string" || !isCanonicalHomeRenderTarget(renderTarget)) {
        throw new Error(
          `Agent manifest field '${itemField}.render_target' must be a canonical home-relative path`,
        );
      }
      if (
        !Array.isArray(patterns) ||
        patterns.length === 0 ||
        patterns.length > 16 ||
        new Set(patterns).size !== patterns.length ||
        patterns.some((pattern) => {
          if (typeof pattern !== "string") return true;
          return (
            !PRESERVED_ENV_PATTERN.test(pattern) ||
            !pattern.includes("*") ||
            pattern.replaceAll("*", "").length === 0 ||
            pattern.split(/[*_]+/u).some((term) => CREDENTIAL_ENV_TERMS.has(term))
          );
        })
      ) {
        throw new Error(
          `Agent manifest field '${itemField}.patterns' must contain unique environment key patterns`,
        );
      }
      paths.add(filePath);
      return Object.freeze({
        path: filePath,
        patterns: Object.freeze([...(patterns as string[])]),
        render_target: renderTarget,
      });
    });
    return Object.freeze({ files: Object.freeze(files) });
  })();
  const scheduledWork = readScheduledWork(rebuild);
  const postRestore = readPostRestore(rebuild);
  if (
    scheduledWork.support === "managed" &&
    (postRestore.kind !== "managed" || !postRestore.restart_runtime)
  ) {
    throw new Error(
      `Agent manifest field '${field}.post_restore.restart_runtime' must be true when scheduled-work restore is managed`,
    );
  }
  return Object.freeze({
    managed_extensions: managedExtensions,
    ...(preservedEnvironment ? { preserved_environment: preservedEnvironment } : {}),
    scheduled_work: scheduledWork,
    post_restore: postRestore,
  });
}

/** Read and freeze the package-owned finite state lifecycle declaration. */
export function readStateLifecycle(manifest: ManifestRecord): HarnessStateLifecycleDeclaration {
  const lifecycle = readObject(manifest, "state_lifecycle");
  if (!lifecycle) {
    throw new Error("Agent manifest field 'state_lifecycle' must be an object");
  }
  requireExactFields(
    lifecycle,
    new Set(["backup_quiescence", "snapshot_restore", "rebuild"]),
    "state_lifecycle",
  );
  return Object.freeze({
    backup_quiescence: readBackupQuiescence(lifecycle),
    snapshot_restore: readActions(lifecycle, "snapshot_restore", SNAPSHOT_RESTORE_ACTIONS),
    rebuild: readRebuildState(lifecycle),
  });
}

/** Test one ordinary snapshot-restore action. */
export function hasSnapshotRestoreAction(
  declaration: HarnessStateLifecycleDeclaration,
  action: HarnessSnapshotRestoreAction,
): boolean {
  return declaration.snapshot_restore.includes(action);
}
