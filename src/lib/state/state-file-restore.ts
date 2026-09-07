// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";

import type { StateFileRestoreOwnership } from "../agent/defs.js";
import type {
  HarnessConfigRestoreHostModule,
  HarnessConfigRestoreWritePlan,
  HarnessManagedExtension,
} from "../agent-runtime/config-module.js";
import { redactFull, shellQuote } from "../runner.js";
import { buildKeyAllowlistMergeRestoreCommand } from "./state-file-key-merge.js";

export interface StateFileRestoreSpec {
  path: string;
  strategy: "copy" | "sqlite_backup";
}

export interface PackageConfigRestoreContext {
  readonly adapter: HarnessConfigRestoreHostModule;
  /** Runtime-native channel names derived from the exact package messaging profile. */
  readonly managedChannelNames: readonly string[];
  readonly freshManagedExtensions?: readonly HarnessManagedExtension[];
  readonly previousManagedExtensions?: readonly HarnessManagedExtension[];
}

interface PackageConfigRestoreInput {
  readonly input: Buffer;
  readonly write: HarnessConfigRestoreWritePlan;
}

const SQLITE_RESTORE_PY = [
  "import sqlite3, sys",
  "src, dst = sys.argv[1], sys.argv[2]",
  "src_conn = sqlite3.connect('file:' + src + '?mode=ro', uri=True, timeout=30)",
  "dst_conn = sqlite3.connect(dst, timeout=30)",
  "try:",
  "    dst_conn.execute('PRAGMA busy_timeout=30000')",
  "    src_conn.backup(dst_conn)",
  "    ok = dst_conn.execute('PRAGMA quick_check').fetchone()[0]",
  "    if ok != 'ok':",
  "        raise SystemExit('sqlite quick_check failed: ' + str(ok))",
  "finally:",
  "    dst_conn.close()",
  "    src_conn.close()",
].join("\n");

const SQLITE_WRITE_CHECK_PY = [
  "import sqlite3, sys",
  "dst = sys.argv[1]",
  "conn = sqlite3.connect(dst, timeout=30)",
  "try:",
  "    conn.execute('PRAGMA busy_timeout=30000')",
  "    conn.execute('BEGIN IMMEDIATE')",
  "    conn.execute('ROLLBACK')",
  "finally:",
  "    conn.close()",
].join("\n");

function stateFileRemotePath(dir: string, filePath: string): string {
  return `${dir.replace(/\/+$/, "")}/${filePath}`;
}

type StateParentSafetyMode = "create" | "read";

function canonicalStateFileSegments(filePath: string): readonly string[] {
  const segments = filePath.split("/");
  if (
    filePath.length === 0 ||
    filePath.startsWith("/") ||
    filePath.includes("\\") ||
    /[\x00-\x1f\x7f]/u.test(filePath) ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error("State file paths must be canonical relative paths");
  }
  return segments;
}

/**
 * Check every package-declared parent below the trusted state root before a
 * restore reads or writes it. This rejects a persisted intermediate symlink;
 * the surrounding rebuild transaction, rather than these shell checks, owns
 * runtime quiescence. It is not a same-UID, hostile-concurrency boundary.
 */
function buildStateParentSafetyChecks(
  dir: string,
  filePath: string,
  mode: StateParentSafetyMode,
  failureLabel = "state parent",
  failureExit = 10,
  missingExit = 2,
): readonly string[] {
  const stateRoot = dir.replace(/\/+$/, "");
  if (
    !stateRoot.startsWith("/") ||
    stateRoot === "/" ||
    stateRoot.includes("\\") ||
    /[\x00-\x1f\x7f]/u.test(stateRoot)
  ) {
    throw new Error("State root must be a canonical absolute directory");
  }
  const stateRootSegments = stateRoot.split("/").slice(1);
  if (
    stateRootSegments.some(
      (segment) => segment === "" || segment === "." || segment === "..",
    )
  ) {
    throw new Error("State root must be a canonical absolute directory");
  }
  const parentSegments = canonicalStateFileSegments(filePath).slice(0, -1);
  const checks = [`state_root=${shellQuote(stateRoot)}`];
  let rootComponent = "";
  for (const segment of stateRootSegments) {
    rootComponent += `/${segment}`;
    checks.push(
      `state_root_component=${shellQuote(rootComponent)}`,
      `[ -d "$state_root_component" ] && [ ! -L "$state_root_component" ] || { echo "unsafe ${failureLabel}: $state_root_component" >&2; exit ${String(failureExit)}; }`,
    );
  }
  let candidate = stateRoot;
  for (const segment of parentSegments) {
    candidate = `${candidate}/${segment}`;
    checks.push(`state_parent=${shellQuote(candidate)}`);
    if (mode === "create") {
      checks.push(
        `if [ -e "$state_parent" ] || [ -L "$state_parent" ]; then [ -d "$state_parent" ] && [ ! -L "$state_parent" ] || { echo "unsafe ${failureLabel}: $state_parent" >&2; exit ${String(failureExit)}; }; else mkdir -- "$state_parent" || { echo "cannot create ${failureLabel}: $state_parent" >&2; exit ${String(failureExit)}; }; fi`,
      );
    } else {
      checks.push(
        `[ ! -e "$state_parent" ] && [ ! -L "$state_parent" ] && exit ${String(missingExit)}`,
        `[ -d "$state_parent" ] && [ ! -L "$state_parent" ] || { echo "unsafe ${failureLabel}: $state_parent" >&2; exit ${String(failureExit)}; }`,
      );
    }
  }
  return checks;
}

function readCurrentPackageConfig(
  sshArgs: readonly string[],
  dir: string,
  specPath: string,
  log: (message: string) => void,
  env?: NodeJS.ProcessEnv,
):
  | { readonly kind: "read"; readonly content: Buffer }
  | { readonly kind: "missing" }
  | { readonly kind: "failed" } {
  const remotePath = stateFileRemotePath(dir, specPath);
  const command = [
    `src=${shellQuote(remotePath)}`,
    ...buildStateParentSafetyChecks(dir, specPath, "read"),
    '[ ! -e "$src" ] && [ ! -L "$src" ] && exit 2',
    '[ -f "$src" ] && [ ! -L "$src" ] || { echo "unsafe state file: $src" >&2; exit 10; }',
    'cat -- "$src"',
  ].join("; ");
  const result = spawnSync("ssh", [...sshArgs, command], {
    ...(env ? { env } : {}),
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 120000,
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.status === 0 && !result.error && !result.signal) {
    return { kind: "read", content: result.stdout };
  }
  if (result.status === 2 && !result.error && !result.signal) return { kind: "missing" };
  const detail =
    (result.stderr?.toString() || "").trim() ||
    result.error?.message ||
    (result.signal ? `signal ${result.signal}` : `exit ${String(result.status)}`);
  log(`WARNING: state file current read ${specPath} failed: ${redactFull(detail).slice(0, 200)}`);
  return { kind: "failed" };
}

function buildPackageConfigRestoreInput(
  sshArgs: readonly string[],
  dir: string,
  specPath: string,
  backupContents: Buffer,
  context: PackageConfigRestoreContext,
  log: (message: string) => void,
  env?: NodeJS.ProcessEnv,
): PackageConfigRestoreInput | null {
  const current = readCurrentPackageConfig(sshArgs, dir, specPath, log, env);
  if (current.kind === "failed") return null;
  let result: ReturnType<HarnessConfigRestoreHostModule["mergeConfigState"]>;
  try {
    result = context.adapter.mergeConfigState({
      backupContent: backupContents.toString("utf8"),
      currentContent: current.kind === "read" ? current.content.toString("utf8") : null,
      managedChannelNames: [...context.managedChannelNames],
      previousManagedExtensions: context.previousManagedExtensions ?? null,
      freshManagedExtensions: context.freshManagedExtensions ?? null,
    });
  } catch {
    // Adapter execution, schema validation, and size validation all fail at
    // this boundary. Do not disclose adapter-controlled error text or advance
    // to the privileged write after any of those failures.
    log("FAILED: package configuration restore adapter failed");
    return null;
  }
  if (result.kind === "merged") {
    return { input: Buffer.from(result.content, "utf8"), write: result.write };
  }
  log(`FAILED: ${redactFull(result.reason)}`);
  return null;
}

function requireConfigHashFiles(
  specPath: string,
  configHashFiles: readonly string[],
): readonly string[] {
  if (configHashFiles.length === 0 || configHashFiles[0] !== specPath) {
    throw new Error("Config hash inputs must begin with the restored state file");
  }
  const seen = new Set<string>();
  for (const file of configHashFiles) {
    const parts = file.split("/");
    if (
      file.length === 0 ||
      file.startsWith("/") ||
      file.includes("\\") ||
      /[\x00-\x1f\x7f]/u.test(file) ||
      parts.some((part) => part === "" || part === "." || part === "..") ||
      seen.has(file)
    ) {
      throw new Error("Config hash inputs must be unique canonical relative paths");
    }
    seen.add(file);
  }
  return configHashFiles;
}

export function buildStateFileRestoreCommand(
  dir: string,
  spec: StateFileRestoreSpec,
  refreshConfigRecoveryAnchors = false,
  configHashFiles: readonly string[] = [spec.path],
): string {
  canonicalStateFileSegments(spec.path);
  const protectedFiles = refreshConfigRecoveryAnchors
    ? requireConfigHashFiles(spec.path, configHashFiles)
    : [];
  const remotePath = stateFileRemotePath(dir, spec.path);
  const quotedRemotePath = shellQuote(remotePath);
  if (spec.strategy === "sqlite_backup") {
    // The agent gateway can own the live database under a distinct uid, so
    // restoring in place can fail for the sandbox user and expose a partially
    // replaced SQLite file to the gateway (#7312). Validate the backup into a
    // staged database this user owns, then replace the target atomically;
    // replacement only needs write permission on the parent directory. The
    // stale WAL/SHM sidecars belong to the replaced database, so drop them.
    //
    // A successful swap does not prove the agent can persist to the result, so
    // open a write transaction against the replaced database before reporting
    // success. The check runs under the same umask as the restore so its own
    // sidecars stay group-writable, and both sidecar pairs are dropped: the
    // stale ones before the check reads them, the check's own after it ends.
    return [
      `dst=${quotedRemotePath}`,
      ...buildStateParentSafetyChecks(dir, spec.path, "create"),
      'parent="$(dirname "$dst")"',
      '{ [ ! -e "$dst" ] && [ ! -L "$dst" ]; } || { [ -f "$dst" ] && [ ! -L "$dst" ]; } || { echo "unsafe sqlite state target: $dst" >&2; exit 11; }',
      'wal="${dst}-wal"',
      '{ [ ! -e "$wal" ] && [ ! -L "$wal" ]; } || { [ -f "$wal" ] && [ ! -L "$wal" ]; } || { echo "unsafe sqlite WAL target: $wal" >&2; exit 12; }',
      'shm="${dst}-shm"',
      '{ [ ! -e "$shm" ] && [ ! -L "$shm" ]; } || { [ -f "$shm" ] && [ ! -L "$shm" ]; } || { echo "unsafe sqlite SHM target: $shm" >&2; exit 12; }',
      'tmp="$(mktemp /tmp/nemoclaw-sqlite-restore.XXXXXX)"',
      'staged="$(mktemp "${parent}/.nemoclaw-sqlite-staged.XXXXXX")"',
      'trap \'rm -f "$tmp" "$staged" "${staged}-wal" "${staged}-shm"\' EXIT',
      'cat > "$tmp"',
      'chmod 600 "$tmp"',
      `(umask 0007; /usr/bin/python3 -I -S -c ${shellQuote(SQLITE_RESTORE_PY)} "$tmp" "$staged")`,
      'chmod 660 "$staged"',
      'mv -f "$staged" "$dst"',
      'rm -f -- "${dst}-wal" "${dst}-shm"',
      `(umask 0007; /usr/bin/python3 -I -S -c ${shellQuote(SQLITE_WRITE_CHECK_PY)} "$dst") || { echo "restored database is not writable: $dst" >&2; exit 12; }`,
      'rm -f -- "${dst}-wal" "${dst}-shm"',
    ].join(" && ");
  }

  const steps = [
    // Steps join with ";", so only the last step sets the exit status and the
    // OpenClaw path ends with `|| true`. "&&" is not a substitute: an earlier
    // failure then falls into the next step's `|| { ...; exit N; }` guard.
    "set -e",
    `dst=${quotedRemotePath}`,
    ...buildStateParentSafetyChecks(dir, spec.path, "create"),
    'parent="$(dirname "$dst")"',
    '{ [ ! -e "$dst" ] && [ ! -L "$dst" ]; } || { [ -f "$dst" ] && [ ! -L "$dst" ]; } || { echo "unsafe state target: $dst" >&2; exit 11; }',
    'tmp="$(mktemp "${parent}/.nemoclaw-restore.XXXXXX")"',
    'trap \'rm -f "$tmp" "${anchor_tmp:-}" "${hash_tmp:-}"\' EXIT',
    'cat > "$tmp"',
    // The managed OpenClaw restart preflight accepts only the exact mutable
    // sandbox:sandbox 0660 configuration posture. Apply that mode to the
    // staged inode before the atomic swap so the gateway and its trusted
    // controller never observe the restored config with the generic 0640
    // state-file mode.
    refreshConfigRecoveryAnchors ? 'chmod 660 "$tmp"' : 'chmod 640 "$tmp"',
  ];

  if (refreshConfigRecoveryAnchors) {
    // Validate every companion integrity input before changing either the
    // recovery anchor or the live configuration. A missing or redirected
    // Fabric configuration must leave the previous protected pair intact.
    for (const [index, file] of protectedFiles.slice(1).entries()) {
      const variable = `protected_${String(index)}`;
      steps.push(
        `${variable}=${shellQuote(stateFileRemotePath(dir, file))}`,
        ...buildStateParentSafetyChecks(dir, file, "read", "protected config parent", 19, 20),
        `[ ! -L "$${variable}" ] || { echo "refusing symlinked protected config: $${variable}" >&2; exit 19; }`,
        `[ -f "$${variable}" ] || { echo "protected config is not a regular file: $${variable}" >&2; exit 20; }`,
      );
    }

    // Build the complete future integrity record before replacing any live
    // file. This makes an unsafe hash target, missing companion, or hashing
    // failure a refusal rather than a partial configuration transaction.
    steps.push(
      'hash_file="${parent}/.config-hash"',
      '[ ! -L "$hash_file" ] || { echo "refusing symlinked config hash target: $hash_file" >&2; exit 12; }',
      '[ ! -e "$hash_file" ] || [ -f "$hash_file" ] || { echo "config hash target is not a regular file: $hash_file" >&2; exit 12; }',
      'hash_tmp="$(mktemp "${parent}/.nemoclaw-config-hash.XXXXXX")" || { echo "failed to stage config hash" >&2; exit 15; }',
      'digest="$(sha256sum -- "$tmp")" || { echo "failed to hash restored config" >&2; exit 15; }',
      'digest="${digest%% *}"',
      `printf '%s  %s\\n' "$digest" ${shellQuote(protectedFiles[0])} > "$hash_tmp" || { echo "failed to stage config hash" >&2; exit 15; }`,
    );
    for (const [index, file] of protectedFiles.slice(1).entries()) {
      const variable = `protected_${String(index)}`;
      steps.push(
        `digest="$(sha256sum -- "$${variable}")" || { echo "failed to hash protected config" >&2; exit 15; }`,
        'digest="${digest%% *}"',
        `printf '%s  %s\\n' "$digest" ${shellQuote(file)} >> "$hash_tmp" || { echo "failed to stage config hash" >&2; exit 15; }`,
      );
    }
    steps.push('chmod 660 "$hash_tmp" 2>/dev/null || true');

    // Stage the OpenClaw recovery anchor before swapping the live config so
    // the integrity watcher can never observe a restored config paired with a
    // stale `.last-good` recovery target.
    steps.push(
      'last_good="${dst}.last-good"',
      '{ [ ! -e "$last_good" ] && [ ! -L "$last_good" ]; } || { [ -f "$last_good" ] && [ ! -L "$last_good" ]; } || { echo "refusing symlinked last-good target or non-regular target: $last_good" >&2; exit 13; }',
      'anchor_tmp="$(mktemp "${parent}/.nemoclaw-lastgood.XXXXXX")" || { echo "failed to stage last-good anchor" >&2; exit 14; }',
      'cat "$tmp" > "$anchor_tmp" || { echo "failed to write last-good anchor" >&2; exit 14; }',
      'chmod 660 "$anchor_tmp" 2>/dev/null || true',
      'mv -f "$anchor_tmp" "$last_good" || { echo "failed to install last-good anchor" >&2; exit 14; }',
    );
  }

  steps.push('mv -f "$tmp" "$dst"');

  if (refreshConfigRecoveryAnchors) {
    steps.push(
      'mv -f "$hash_tmp" "$hash_file" || { echo "failed to install config hash" >&2; exit 15; }',
    );
  }

  return steps.join("; ");
}

export function restoreStateFile(
  sshArgs: readonly string[],
  dir: string,
  spec: StateFileRestoreSpec,
  backupContents: Buffer,
  ownership: StateFileRestoreOwnership | undefined,
  allowCustomImageWholeStateFileRestore: boolean,
  log: (message: string) => void,
  packageConfigRestore?: PackageConfigRestoreContext,
  env?: NodeJS.ProcessEnv,
): boolean {
  log(`Restoring state file ${spec.path} (${spec.strategy})`);

  let command: string;
  let input: Buffer | null;
  if (ownership?.merge === "package-config") {
    if (!packageConfigRestore) {
      log("FAILED: package configuration restore adapter is unavailable");
      return false;
    }
    const prepared = buildPackageConfigRestoreInput(
      sshArgs,
      dir,
      spec.path,
      backupContents,
      packageConfigRestore,
      log,
      env,
    );
    if (!prepared) return false;
    command = buildStateFileRestoreCommand(
      dir,
      spec,
      prepared.write.kind === "config-anchors",
      prepared.write.kind === "config-anchors" ? prepared.write.hashFiles : [spec.path],
    );
    input = prepared.input;
  } else if (ownership?.merge === "key-allowlist") {
    command = allowCustomImageWholeStateFileRestore
      ? buildStateFileRestoreCommand(dir, spec, false)
      : buildKeyAllowlistMergeRestoreCommand(dir, spec, ownership);
    input = backupContents;
  } else {
    command = buildStateFileRestoreCommand(dir, spec, false);
    input = backupContents;
  }
  if (input === null) return false;

  const result = spawnSync("ssh", [...sshArgs, command], {
    ...(env ? { env } : {}),
    input,
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 120000,
  });

  if (result.status === 0 && !result.error && !result.signal) return true;

  const detail =
    (result.stderr?.toString() || "").trim() ||
    result.error?.message ||
    (result.signal ? `signal ${result.signal}` : `exit ${String(result.status)}`);
  log(`FAILED: state file restore ${spec.path}: ${detail.substring(0, 200)}`);
  return false;
}
