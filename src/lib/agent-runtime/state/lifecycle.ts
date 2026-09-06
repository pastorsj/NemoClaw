// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

import type {
  HarnessBackupQuiescenceDeclaration,
  HarnessConfigIntegrityDeclaration,
  HarnessPostRestoreDeclaration,
  HarnessRebuildStateDeclaration,
  HarnessScheduledWorkDeclaration,
  HarnessSnapshotRestoreAction,
  HarnessStateCommandDeclaration,
  HarnessStateLifecycleDeclaration,
} from "@nvidia/nemoclaw-harness-contract";

import { readObject } from "../manifest-readers";
import type { ManifestRecord } from "../manifest-types";

const SNAPSHOT_RESTORE_ACTIONS = new Set<HarnessSnapshotRestoreAction>(["repair-mutable-config"]);
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
  if (!path.posix.isAbsolute(executable) || path.posix.normalize(executable) !== executable) {
    throw new Error(
      "Agent manifest field 'state_lifecycle.backup_quiescence.command[0]' must be a canonical absolute path",
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
  return Object.freeze({
    support: "managed",
    controller: readStateCommand(declaration.controller, `${field}.controller`),
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
  requireExactFields(
    rebuild,
    new Set(["image_plugin_provenance", "scheduled_work", "post_restore"]),
    field,
  );
  const imagePluginProvenance = rebuild.image_plugin_provenance;
  if (imagePluginProvenance !== "required" && imagePluginProvenance !== "not-required") {
    throw new Error(
      `Agent manifest field '${field}.image_plugin_provenance' must be required or not-required`,
    );
  }
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
    image_plugin_provenance: imagePluginProvenance,
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
