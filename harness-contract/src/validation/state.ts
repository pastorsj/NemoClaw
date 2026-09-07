// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  CONTROL_CHARACTER_PATTERN,
  fail,
  isCanonicalAbsolutePath,
  isImmutableSandboxCommandPath,
  type ManifestRecord,
  requireExactFields,
  requireKnownFields,
  requireRecord,
  requireString,
} from "./shared.js";

const SNAPSHOT_RESTORE_ACTIONS = new Set(["repair-mutable-config", "restart-runtime"]);
const CREDENTIAL_ENV_TERMS = new Set(["AUTH", "CREDENTIAL", "KEY", "PASSWORD", "SECRET", "TOKEN"]);

const SNAPSHOT_HANDOFF_PATTERN = /^rebuild-policy-handoff\.[0-9a-f]{64}\.yaml$/u;

function isSnapshotControlPath(value: string): boolean {
  const root = value.split("/", 1)[0]?.toLowerCase() ?? "";
  return (
    root === "rebuild-manifest.json" ||
    root === ".nemoclaw-rebuild-recovery.json" ||
    SNAPSHOT_HANDOFF_PATTERN.test(root)
  );
}

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

function snapshotControlPathMatchesPrefix(prefix: string): boolean {
  const normalized = prefix.toLowerCase();
  return [
    "rebuild-manifest.json",
    ".nemoclaw-rebuild-recovery.json",
    `rebuild-policy-handoff.${"0".repeat(64)}.yaml`,
  ].some((fileName) => fileName.startsWith(normalized));
}

function validateRelativeStatePath(value: unknown, field: string): string {
  const candidate = requireString(value, field);
  const segments = candidate.split("/");
  if (candidate.length === 0) fail(field, "must not be empty");
  if (CONTROL_CHARACTER_PATTERN.test(candidate)) fail(field, "must not contain control characters");
  if (candidate.startsWith("/")) fail(field, "must be a relative path, not absolute");
  if (candidate.includes("\\")) fail(field, "must use canonical forward slashes");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    fail(field, "must be a canonical relative path without empty, '.', or '..' components");
  }
  if (segments.some((segment) => segment.includes("*"))) {
    fail(field, "must not contain wildcards");
  }
  if (isSnapshotControlPath(candidate)) fail(field, "uses a path reserved for snapshot metadata");
  return candidate;
}

function validateStateDirectories(manifest: ManifestRecord): void {
  if (manifest.runtime_auth_state_dirs !== undefined) {
    fail("runtime_auth_state_dirs", "was replaced by state_dirs entries with backup: false");
  }
  if (manifest.state_dirs === undefined) return;
  if (!Array.isArray(manifest.state_dirs)) fail("state_dirs", "must be an array");

  const paths = new Set<string>();
  const prefixes = new Set<string>();
  manifest.state_dirs.forEach((entry, index) => {
    const field = `state_dirs[${String(index)}]`;
    if (typeof entry === "string") {
      const statePath = validateRelativeStatePath(entry, field);
      if (paths.has(statePath)) fail("state_dirs", `repeats path:${statePath}`);
      paths.add(statePath);
      return;
    }

    const declaration = requireRecord(entry, field);
    requireKnownFields(declaration, new Set(["path", "prefix", "backup"]), new Set(), field);
    const hasPath = Object.hasOwn(declaration, "path");
    const hasPrefix = Object.hasOwn(declaration, "prefix");
    if (hasPath === hasPrefix) fail(field, "must declare exactly one of path or prefix");
    if (declaration.backup !== undefined && typeof declaration.backup !== "boolean") {
      fail(`${field}.backup`, "must be a boolean");
    }
    if (hasPath) {
      const statePath = validateRelativeStatePath(declaration.path, `${field}.path`);
      if (paths.has(statePath)) fail("state_dirs", `repeats path:${statePath}`);
      paths.add(statePath);
      return;
    }

    const prefix = requireString(declaration.prefix, `${field}.prefix`);
    if (!/^[A-Za-z0-9._-]+$/u.test(prefix)) {
      fail(`${field}.prefix`, "must contain only letters, digits, '.', '_', or '-'");
    }
    if (snapshotControlPathMatchesPrefix(prefix)) {
      fail(`${field}.prefix`, "can match a path reserved for snapshot metadata");
    }
    if (prefixes.has(prefix)) fail("state_dirs", `repeats prefix:${prefix}`);
    prefixes.add(prefix);
  });

  for (const prefix of prefixes) {
    const sibling = prefix.slice(0, -1);
    if (!prefix.endsWith("-") || sibling.includes("/") || !paths.has(sibling)) {
      fail("state_dirs", `prefix '${prefix}' must extend a declared top-level path with '-'`);
    }
    const overlap = [...paths].find((statePath) => statePath.split("/", 1)[0]?.startsWith(prefix));
    if (overlap) fail("state_dirs", `prefix '${prefix}' overlaps exact path '${overlap}'`);
  }
}

function validateDottedKey(value: unknown, field: string): string {
  const key = requireString(value, field);
  if (CONTROL_CHARACTER_PATTERN.test(key)) fail(field, "must not contain control characters");
  if (key.split(".").some((segment) => segment.length === 0)) {
    fail(field, "must not contain empty path segments");
  }
  return key;
}

function dottedKeysOverlap(left: string, right: string): boolean {
  const leftParts = left.split(".");
  const rightParts = right.split(".");
  const commonLength = Math.min(leftParts.length, rightParts.length);
  return leftParts.slice(0, commonLength).every((part, index) => part === rightParts[index]);
}

function validateNonOverlappingKeys(keys: readonly string[], field: string): void {
  for (let left = 0; left < keys.length; left += 1) {
    for (let right = left + 1; right < keys.length; right += 1) {
      if (dottedKeysOverlap(keys[left] ?? "", keys[right] ?? "")) {
        fail(
          field,
          `entries ${String(left)} and ${String(right)} must not duplicate or contain one another`,
        );
      }
    }
  }
}

function validateStateUserKey(value: unknown, field: string): string {
  const declaration = requireRecord(value, field);
  requireKnownFields(
    declaration,
    new Set(["key", "type", "values", "min", "max", "max_length"]),
    new Set(["key", "type"]),
    field,
  );
  const key = validateDottedKey(declaration.key, `${field}.key`);
  const type = declaration.type;
  if (!new Set(["boolean", "string", "integer", "number", "enum"]).has(type as string)) {
    fail(`${field}.type`, "must be boolean, string, integer, number, or enum");
  }
  if (type === "enum") {
    if (
      !Array.isArray(declaration.values) ||
      declaration.values.length === 0 ||
      declaration.values.some(
        (entry) =>
          typeof entry !== "string" && typeof entry !== "number" && typeof entry !== "boolean",
      )
    ) {
      fail(`${field}.values`, "must be a non-empty array of scalars for enum type");
    }
  } else if (declaration.values !== undefined) {
    fail(`${field}.values`, "is only allowed for enum type");
  }
  if (type === "integer" || type === "number") {
    for (const bound of ["min", "max"] as const) {
      if (declaration[bound] === undefined) continue;
      if (typeof declaration[bound] !== "number" || !Number.isFinite(declaration[bound])) {
        fail(`${field}.${bound}`, "must be a finite number");
      }
      if (type === "integer" && !Number.isInteger(declaration[bound])) {
        fail(`${field}.${bound}`, "must be an integer");
      }
    }
    if (
      typeof declaration.min === "number" &&
      typeof declaration.max === "number" &&
      declaration.min > declaration.max
    ) {
      fail(`${field}.min`, "must not exceed max");
    }
  } else if (declaration.min !== undefined || declaration.max !== undefined) {
    fail(`${field}.min`, "and max are only allowed for integer or number types");
  }
  if (type === "string") {
    if (
      declaration.max_length !== undefined &&
      (!Number.isInteger(declaration.max_length) || (declaration.max_length as number) < 0)
    ) {
      fail(`${field}.max_length`, "must be a non-negative integer");
    }
  } else if (declaration.max_length !== undefined) {
    fail(`${field}.max_length`, "is only allowed for string type");
  }
  return key;
}

function validateFreshHeaders(value: unknown, field: string): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length === 0) fail(field, "must be a non-empty array");
  value.forEach((entry, index) => {
    const itemField = `${field}[${String(index)}]`;
    if (typeof entry === "string") {
      if (entry.length === 0) fail(itemField, "must not be empty");
      return;
    }
    const declaration = requireRecord(entry, itemField);
    requireKnownFields(declaration, new Set(["match", "value"]), new Set(["value"]), itemField);
    if (
      declaration.match !== undefined &&
      declaration.match !== "exact" &&
      declaration.match !== "prefix"
    ) {
      fail(`${itemField}.match`, "must be exact or prefix");
    }
    if (typeof declaration.value !== "string" || declaration.value.length === 0) {
      fail(`${itemField}.value`, "must be a non-empty string");
    }
  });
}

function validateStateRestore(value: unknown, field: string, strategy: string): void {
  const restore = requireRecord(value, field);
  requireKnownFields(
    restore,
    new Set(["merge", "user_keys", "require_fresh_tables", "require_fresh_headers"]),
    new Set(["merge"]),
    field,
  );
  if (strategy !== "copy") fail(field, "requires strategy 'copy'");
  if (restore.merge !== "key-allowlist" && restore.merge !== "package-config") {
    fail(`${field}.merge`, "must be key-allowlist or package-config");
  }
  if (restore.merge === "package-config") {
    for (const key of ["user_keys", "require_fresh_tables", "require_fresh_headers"] as const) {
      if (restore[key] !== undefined) {
        fail(`${field}.${key}`, "is not allowed for merge package-config");
      }
    }
    return;
  }
  if (!Array.isArray(restore.user_keys) || restore.user_keys.length === 0) {
    fail(`${field}.user_keys`, "must be a non-empty array");
  }
  const userKeys = restore.user_keys.map((entry, index) =>
    validateStateUserKey(entry, `${field}.user_keys[${String(index)}]`),
  );
  validateNonOverlappingKeys(userKeys, `${field}.user_keys`);

  let freshTables: string[] = [];
  if (restore.require_fresh_tables !== undefined) {
    if (!Array.isArray(restore.require_fresh_tables) || restore.require_fresh_tables.length === 0) {
      fail(`${field}.require_fresh_tables`, "must be a non-empty array");
    }
    freshTables = restore.require_fresh_tables.map((entry, index) =>
      validateDottedKey(entry, `${field}.require_fresh_tables[${String(index)}]`),
    );
    validateNonOverlappingKeys(freshTables, `${field}.require_fresh_tables`);
    userKeys.forEach((userKey, userIndex) => {
      freshTables.forEach((freshTable, freshIndex) => {
        if (dottedKeysOverlap(userKey, freshTable)) {
          fail(
            `${field}.user_keys[${String(userIndex)}].key`,
            `must not overlap ${field}.require_fresh_tables[${String(freshIndex)}]`,
          );
        }
      });
    });
  }
  validateFreshHeaders(restore.require_fresh_headers, `${field}.require_fresh_headers`);
}

function validateStateFiles(manifest: ManifestRecord): void {
  if (manifest.state_files !== undefined) {
    if (!Array.isArray(manifest.state_files)) fail("state_files", "must be an array");
    manifest.state_files.forEach((entry, index) => {
      const field = `state_files[${String(index)}]`;
      if (typeof entry === "string") {
        validateRelativeStatePath(entry, field);
        return;
      }
      const declaration = requireRecord(entry, field);
      requireKnownFields(
        declaration,
        new Set(["path", "strategy", "backup", "restore"]),
        new Set(["path"]),
        field,
      );
      validateRelativeStatePath(declaration.path, `${field}.path`);
      const strategy = declaration.strategy ?? "copy";
      if (strategy !== "copy" && strategy !== "sqlite_backup") {
        fail(`${field}.strategy`, "must be copy or sqlite_backup");
      }
      if (declaration.backup !== undefined) {
        const backup = requireRecord(declaration.backup, `${field}.backup`);
        requireExactFields(backup, new Set(["fallback"]), `${field}.backup`);
        if (strategy !== "copy") fail(`${field}.backup`, "requires strategy 'copy'");
        if (backup.fallback !== "privileged-copy") {
          fail(`${field}.backup.fallback`, "must be privileged-copy");
        }
      }
      if (declaration.restore !== undefined) {
        validateStateRestore(declaration.restore, `${field}.restore`, strategy);
      }
    });
  }

  if (manifest.user_managed_files !== undefined) {
    if (!Array.isArray(manifest.user_managed_files)) {
      fail("user_managed_files", "must be an array");
    }
    manifest.user_managed_files.forEach((entry, index) => {
      const field = `user_managed_files[${String(index)}]`;
      const candidate = requireString(entry, field);
      if (candidate.length === 0) fail(field, "must not be empty");
      if (CONTROL_CHARACTER_PATTERN.test(candidate)) {
        fail(field, "must not contain control characters");
      }
      if (candidate.startsWith("/")) fail(field, "must be a relative path, not absolute");
      if (candidate.split("/").includes("..")) fail(field, "must not contain '..' path components");
    });
  }
}

function validateStateActionList(
  value: unknown,
  field: string,
  allowed: ReadonlySet<string>,
): void {
  if (
    !Array.isArray(value) ||
    value.length > allowed.size ||
    value.some((entry) => typeof entry !== "string" || !allowed.has(entry)) ||
    new Set(value).size !== value.length
  ) {
    fail(field, "must be a unique list of supported state lifecycle actions");
  }
}

function validateBackupQuiescence(value: unknown): void {
  const field = "state_lifecycle.backup_quiescence";
  const declaration = requireRecord(value, field);
  if (declaration.kind === "not-required") {
    requireExactFields(declaration, new Set(["kind"]), field);
    return;
  }
  if (declaration.kind !== "command") {
    fail(`${field}.kind`, "must be not-required or command");
  }
  requireExactFields(declaration, new Set(["kind", "command", "timeout_seconds"]), field);
  if (
    !Array.isArray(declaration.command) ||
    declaration.command.length === 0 ||
    declaration.command.length > 16 ||
    declaration.command.some(
      (argument) =>
        typeof argument !== "string" ||
        argument.length === 0 ||
        argument.length > 1024 ||
        /[\u0000\r\n]/u.test(argument),
    )
  ) {
    fail(`${field}.command`, "must be a non-empty bounded argument array");
  }
  const executable = declaration.command[0] as string;
  if (!isImmutableSandboxCommandPath(executable)) {
    fail(`${field}.command[0]`, "must be an immutable image-owned executable path");
  }
  if (
    !Number.isInteger(declaration.timeout_seconds) ||
    (declaration.timeout_seconds as number) < 1 ||
    (declaration.timeout_seconds as number) > 120
  ) {
    fail(`${field}.timeout_seconds`, "must be an integer from 1 through 120");
  }
}

function validateStateCommand(value: unknown, field: string): void {
  const declaration = requireRecord(value, field);
  requireExactFields(declaration, new Set(["command", "timeout_seconds"]), field);
  if (
    !Array.isArray(declaration.command) ||
    declaration.command.length === 0 ||
    declaration.command.length > 32 ||
    declaration.command.some(
      (argument) =>
        typeof argument !== "string" ||
        argument.length === 0 ||
        argument.length > 4096 ||
        CONTROL_CHARACTER_PATTERN.test(argument),
    )
  ) {
    fail(`${field}.command`, "must be a non-empty bounded argument array");
  }
  if (!isCanonicalAbsolutePath(declaration.command[0] as string)) {
    fail(`${field}.command[0]`, "must be a canonical absolute path");
  }
  if (
    !Number.isInteger(declaration.timeout_seconds) ||
    (declaration.timeout_seconds as number) < 1 ||
    (declaration.timeout_seconds as number) > 300
  ) {
    fail(`${field}.timeout_seconds`, "must be an integer from 1 through 300");
  }
}

function validateImmutableStateCommand(value: unknown, field: string): void {
  validateStateCommand(value, field);
  const command = (value as ManifestRecord).command as readonly string[];
  if (!isImmutableSandboxCommandPath(command[0] as string)) {
    fail(`${field}.command[0]`, "must be an immutable image-owned executable path");
  }
}

function validateDirectStateDirectory(value: unknown, field: string): string {
  const candidate = validateRelativeStatePath(value, field);
  if (candidate.includes("/") || !/^[A-Za-z0-9._-]+$/u.test(candidate)) {
    fail(field, "must be one canonical state-directory name");
  }
  return candidate;
}

function validateSymlinkSourcePattern(value: unknown, field: string): string {
  const candidate = requireString(value, field);
  if (
    candidate.length === 0 ||
    candidate.length > 512 ||
    candidate.startsWith("/") ||
    candidate.includes("\\") ||
    CONTROL_CHARACTER_PATTERN.test(candidate)
  ) {
    fail(field, "must be a bounded canonical relative pattern");
  }
  const segments = candidate.split("/");
  if (
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === "." ||
        segment === ".." ||
        (segment !== "*" && !/^[A-Za-z0-9._-]+$/u.test(segment)),
    )
  ) {
    fail(field, "may use '*' only as a complete path segment");
  }
  return candidate;
}

function validateManagedExtensions(value: unknown, manifest: ManifestRecord): void {
  const field = "state_lifecycle.rebuild.managed_extensions";
  const declaration = requireRecord(value, field);
  if (declaration.support === "disabled") {
    requireExactFields(declaration, new Set(["support", "reason"]), field);
    if (!requireString(declaration.reason, `${field}.reason`).trim()) {
      fail(`${field}.reason`, "must not be empty");
    }
    return;
  }
  if (declaration.support !== "managed") {
    fail(`${field}.support`, "must be managed or disabled");
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
  validateImmutableStateCommand(declaration.controller, `${field}.controller`);
  const stateDirectory = validateDirectStateDirectory(
    declaration.state_directory,
    `${field}.state_directory`,
  );
  const declaredStateDirectories = Array.isArray(manifest.state_dirs)
    ? manifest.state_dirs.flatMap((entry) => {
        if (typeof entry === "string") return [entry];
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
        const path = (entry as ManifestRecord).path;
        return typeof path === "string" ? [path] : [];
      })
    : [];
  if (!declaredStateDirectories.includes(stateDirectory)) {
    fail(`${field}.state_directory`, "must name a declared state_dirs path");
  }
  if (
    !Array.isArray(declaration.preserved_directories) ||
    declaration.preserved_directories.length > 64 ||
    new Set(declaration.preserved_directories).size !== declaration.preserved_directories.length
  ) {
    fail(`${field}.preserved_directories`, "must contain at most 64 unique directory names");
  }
  declaration.preserved_directories.forEach((entry, index) => {
    validateDirectStateDirectory(entry, `${field}.preserved_directories[${String(index)}]`);
  });
  if (!Array.isArray(declaration.allowed_symlinks) || declaration.allowed_symlinks.length > 16) {
    fail(`${field}.allowed_symlinks`, "must contain at most 16 rules");
  }
  const patterns = new Set<string>();
  declaration.allowed_symlinks.forEach((entry, index) => {
    const ruleField = `${field}.allowed_symlinks[${String(index)}]`;
    const rule = requireRecord(entry, ruleField);
    const sourcePattern = validateSymlinkSourcePattern(
      rule.source_pattern,
      `${ruleField}.source_pattern`,
    );
    if (!sourcePattern.startsWith(`${stateDirectory}/`)) {
      fail(`${ruleField}.source_pattern`, "must remain inside the managed state directory");
    }
    if (patterns.has(sourcePattern)) fail(`${ruleField}.source_pattern`, "must be unique");
    patterns.add(sourcePattern);
    if (rule.kind === "exact-target") {
      requireExactFields(rule, new Set(["kind", "source_pattern", "targets"]), ruleField);
      if (
        !Array.isArray(rule.targets) ||
        rule.targets.length === 0 ||
        rule.targets.length > 16 ||
        new Set(rule.targets).size !== rule.targets.length ||
        rule.targets.some(
          (target) =>
            typeof target !== "string" ||
            target.length > 4096 ||
            CONTROL_CHARACTER_PATTERN.test(target) ||
            !isCanonicalAbsolutePath(target),
        )
      ) {
        fail(`${ruleField}.targets`, "must contain unique canonical absolute paths");
      }
      return;
    }
    if (rule.kind !== "relative-within") {
      fail(`${ruleField}.kind`, "must be exact-target or relative-within");
    }
    requireExactFields(
      rule,
      new Set(["kind", "source_pattern", "root_ancestor_depth", "forbidden_prefixes"]),
      ruleField,
    );
    if (
      !Number.isInteger(rule.root_ancestor_depth) ||
      (rule.root_ancestor_depth as number) < 0 ||
      (rule.root_ancestor_depth as number) > 8
    ) {
      fail(`${ruleField}.root_ancestor_depth`, "must be an integer from 0 through 8");
    }
    if (
      !Array.isArray(rule.forbidden_prefixes) ||
      rule.forbidden_prefixes.length > 8 ||
      new Set(rule.forbidden_prefixes).size !== rule.forbidden_prefixes.length
    ) {
      fail(`${ruleField}.forbidden_prefixes`, "must contain at most eight unique paths");
    }
    rule.forbidden_prefixes.forEach((prefix, prefixIndex) => {
      validateRelativeStatePath(prefix, `${ruleField}.forbidden_prefixes[${String(prefixIndex)}]`);
    });
  });
  if (manifest.managed_image === undefined) {
    fail(field, "requires managed_image runtime identity authority");
  }
}

function validateScheduledWork(value: unknown): void {
  const field = "state_lifecycle.rebuild.scheduled_work";
  const declaration = requireRecord(value, field);
  if (declaration.support === "disabled") {
    requireExactFields(declaration, new Set(["support", "reason"]), field);
    if (!requireString(declaration.reason, `${field}.reason`).trim()) {
      fail(`${field}.reason`, "must not be empty");
    }
    return;
  }
  if (declaration.support !== "managed") {
    fail(`${field}.support`, "must be managed or disabled");
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
  validateImmutableStateCommand(declaration.controller, `${field}.controller`);
  validateRelativeStatePath(declaration.jobs_path, `${field}.jobs_path`);
  validateRelativeStatePath(declaration.scripts_path, `${field}.scripts_path`);
  validateRelativeStatePath(declaration.profiles_path, `${field}.profiles_path`);
  const runtimeRoot = requireString(declaration.runtime_root, `${field}.runtime_root`);
  if (!isCanonicalAbsolutePath(runtimeRoot) || !runtimeRoot.startsWith("/sandbox/")) {
    fail(`${field}.runtime_root`, "must be a canonical path below /sandbox");
  }
}

function validateConfigIntegrity(value: unknown): void {
  const field = "state_lifecycle.rebuild.post_restore.config_integrity";
  const declaration = requireRecord(value, field);
  if (declaration.kind === "not-required") {
    requireExactFields(declaration, new Set(["kind"]), field);
    return;
  }
  if (declaration.kind !== "commands") fail(`${field}.kind`, "must be not-required or commands");
  requireExactFields(declaration, new Set(["kind", "refresh", "verify"]), field);
  validateStateCommand(declaration.refresh, `${field}.refresh`);
  validateStateCommand(declaration.verify, `${field}.verify`);
}

function validatePostRestore(value: unknown): void {
  const field = "state_lifecycle.rebuild.post_restore";
  const declaration = requireRecord(value, field);
  if (declaration.kind === "not-required") {
    requireExactFields(declaration, new Set(["kind"]), field);
    return;
  }
  if (declaration.kind !== "managed") fail(`${field}.kind`, "must be managed or not-required");
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
  if (declaration.command !== null) validateStateCommand(declaration.command, `${field}.command`);
  for (const name of [
    "reapply_messaging",
    "restart_runtime",
    "settle_device_pairing",
    "notify_gateway_token_change",
  ] as const) {
    if (typeof declaration[name] !== "boolean") fail(`${field}.${name}`, "must be a boolean");
  }
  if (
    declaration.mutable_config !== "not-required" &&
    declaration.mutable_config !== "repair" &&
    declaration.mutable_config !== "verify"
  ) {
    fail(`${field}.mutable_config`, "must be not-required, repair, or verify");
  }
  validateConfigIntegrity(declaration.config_integrity);
}

function validateRebuildState(value: unknown, manifest: ManifestRecord): void {
  const field = "state_lifecycle.rebuild";
  const declaration = requireRecord(value, field);
  requireKnownFields(
    declaration,
    new Set(["managed_extensions", "post_restore", "preserved_environment", "scheduled_work"]),
    new Set(["managed_extensions", "post_restore", "scheduled_work"]),
    field,
  );
  validateManagedExtensions(declaration.managed_extensions, manifest);
  if (declaration.preserved_environment !== undefined) {
    const preserved = requireRecord(
      declaration.preserved_environment,
      `${field}.preserved_environment`,
    );
    requireExactFields(preserved, new Set(["files"]), `${field}.preserved_environment`);
    if (!Array.isArray(preserved.files) || preserved.files.length > 8) {
      fail(`${field}.preserved_environment.files`, "must contain at most eight files");
    }
    const paths = new Set<string>();
    preserved.files.forEach((value, index) => {
      const itemField = `${field}.preserved_environment.files[${String(index)}]`;
      const item = requireRecord(value, itemField);
      requireExactFields(item, new Set(["path", "patterns", "render_target"]), itemField);
      const relativePath = validateRelativeStatePath(item.path, `${itemField}.path`);
      if (paths.has(relativePath)) fail(`${itemField}.path`, "must be unique");
      paths.add(relativePath);
      const renderTarget = requireString(item.render_target, `${itemField}.render_target`);
      if (!isCanonicalHomeRenderTarget(renderTarget)) {
        fail(`${itemField}.render_target`, "must be a canonical home-relative render target");
      }
      if (
        !Array.isArray(item.patterns) ||
        item.patterns.length === 0 ||
        item.patterns.length > 16 ||
        new Set(item.patterns).size !== item.patterns.length ||
        item.patterns.some((pattern) => {
          if (typeof pattern !== "string") return true;
          return (
            !/^[A-Z0-9_*]+$/u.test(pattern) ||
            !pattern.includes("*") ||
            pattern.replaceAll("*", "").length === 0 ||
            pattern.split(/[*_]+/u).some((term) => CREDENTIAL_ENV_TERMS.has(term))
          );
        })
      ) {
        fail(`${itemField}.patterns`, "must contain unique bounded environment key patterns");
      }
    });
  }
  validateScheduledWork(declaration.scheduled_work);
  validatePostRestore(declaration.post_restore);
  const scheduledWork = declaration.scheduled_work as ManifestRecord;
  const postRestore = declaration.post_restore as ManifestRecord;
  if (
    scheduledWork.support === "managed" &&
    (postRestore.kind !== "managed" || postRestore.restart_runtime !== true)
  ) {
    fail(
      `${field}.post_restore.restart_runtime`,
      "must be true when scheduled-work restore is managed",
    );
  }
  const hasStateCommand =
    scheduledWork.support === "managed" ||
    (postRestore.kind === "managed" &&
      (postRestore.command !== null ||
        (postRestore.config_integrity as ManifestRecord | undefined)?.kind === "commands"));
  if (hasStateCommand && manifest.managed_image === undefined) {
    fail(field, "fixed state commands require managed_image runtime identity authority");
  }
  if (postRestore.kind === "managed" && postRestore.settle_device_pairing === true) {
    const runtime = requireRecord(manifest.runtime, "runtime");
    if (runtime.device_pairing_settlement === undefined) {
      fail(
        `${field}.post_restore.settle_device_pairing`,
        "requires runtime.device_pairing_settlement",
      );
    }
  }
}

function validateStateLifecycle(manifest: ManifestRecord): void {
  if (manifest.state_lifecycle === undefined) {
    fail("state_lifecycle", "is required for a harness package");
  }
  const lifecycle = requireRecord(manifest.state_lifecycle, "state_lifecycle");
  requireExactFields(
    lifecycle,
    new Set(["backup_quiescence", "snapshot_restore", "rebuild"]),
    "state_lifecycle",
  );
  validateBackupQuiescence(lifecycle.backup_quiescence);
  validateStateActionList(
    lifecycle.snapshot_restore,
    "state_lifecycle.snapshot_restore",
    SNAPSHOT_RESTORE_ACTIONS,
  );
  if (
    Array.isArray(lifecycle.snapshot_restore) &&
    lifecycle.snapshot_restore.includes("restart-runtime")
  ) {
    const runtime = requireRecord(manifest.runtime, "runtime");
    if (runtime.kind !== "gateway") {
      fail("state_lifecycle.snapshot_restore", "restart-runtime requires runtime.kind gateway");
    }
    const processLifecycle = requireRecord(runtime.process_lifecycle, "runtime.process_lifecycle");
    if (processLifecycle.support !== "managed") {
      fail(
        "state_lifecycle.snapshot_restore",
        "restart-runtime requires managed runtime.process_lifecycle",
      );
    }
  }
  validateRebuildState(lifecycle.rebuild, manifest);
}

/** Validate state backup, restore, and user-owned path declarations. */
export function validateHarnessState(manifest: ManifestRecord): void {
  validateStateDirectories(manifest);
  validateStateFiles(manifest);
  validateStateLifecycle(manifest);
}
