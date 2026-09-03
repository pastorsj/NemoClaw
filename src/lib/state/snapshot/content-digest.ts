// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readlinkSync,
  readSync,
  type Dirent,
} from "node:fs";
import path from "node:path";

const REBUILD_MANIFEST_FILE = "rebuild-manifest.json";
export const REBUILD_RECOVERY_MARKER_FILE = ".nemoclaw-rebuild-recovery.json";
const REBUILD_POLICY_HANDOFF_FILE_PATTERN = /^rebuild-policy-handoff\.[0-9a-f]{64}\.yaml$/u;
const REBUILD_POLICY_HANDOFF_FILE_EXAMPLE = `rebuild-policy-handoff.${"0".repeat(64)}.yaml`;

type SnapshotFileStat = NonNullable<ReturnType<typeof lstatSync>>;

function sameSnapshotFileStat(left: SnapshotFileStat, right: SnapshotFileStat): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function snapshotPermissionMode(stat: SnapshotFileStat): number {
  return Number(stat.mode) & 0o777;
}

function snapshotRestorableMtimeSeconds(stat: SnapshotFileStat): number {
  // The portable tar boundary restores whole-second timestamps. Bind the
  // digest to that value instead of host-specific sub-second precision.
  return Math.trunc(Number(stat.mtimeMs) / 1000);
}

function snapshotDirectoryOpenFlags(): number {
  if (typeof constants.O_NOFOLLOW !== "number" || typeof constants.O_DIRECTORY !== "number") {
    throw new Error("snapshot hashing requires O_NOFOLLOW and O_DIRECTORY support");
  }
  return constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY;
}

/** Hash one stable snapshot tree, including entry type, path, mode, and file bytes. */
export function hashSnapshotTree(
  backupPath: string,
  options: {
    readonly excludedRootEntries?: readonly string[];
    readonly excludeRootEntry?: (entry: Dirent) => boolean;
  } = {},
): string {
  if (typeof constants.O_NOFOLLOW !== "number") {
    throw new Error("snapshot hashing requires O_NOFOLLOW support");
  }
  const excludedRootEntries = new Set(options.excludedRootEntries ?? []);
  const openFlags =
    constants.O_RDONLY |
    constants.O_NOFOLLOW |
    (typeof constants.O_NONBLOCK === "number" ? constants.O_NONBLOCK : 0);
  const hash = createHash("sha256");
  const visit = (directory: string, relativeDirectory: string): void => {
    const directoryDescriptor = openSync(directory, snapshotDirectoryOpenFlags());
    try {
      const openedDirectory = fstatSync(directoryDescriptor);
      const namedDirectory = lstatSync(directory);
      if (
        !openedDirectory.isDirectory() ||
        namedDirectory.isSymbolicLink() ||
        !sameSnapshotFileStat(openedDirectory, namedDirectory)
      ) {
        throw new Error(
          `snapshot directory '${relativeDirectory || "."}' changed while it was opened`,
        );
      }
      if (relativeDirectory !== "") {
        hash.update(
          JSON.stringify([
            "directory",
            relativeDirectory,
            snapshotPermissionMode(openedDirectory),
            snapshotRestorableMtimeSeconds(openedDirectory),
          ]),
          "utf8",
        );
      }
      const entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
        left.name === right.name ? 0 : left.name < right.name ? -1 : 1,
      );
      for (const entry of entries) {
        if (
          relativeDirectory === "" &&
          (excludedRootEntries.has(entry.name) || options.excludeRootEntry?.(entry) === true)
        ) {
          continue;
        }
        const fullPath = path.join(directory, entry.name);
        const relativePath = path.posix.join(
          relativeDirectory.split(path.sep).join(path.posix.sep),
          entry.name,
        );
        if (entry.isDirectory()) {
          visit(fullPath, relativePath);
          continue;
        }
        if (entry.isSymbolicLink()) {
          const namedBefore = lstatSync(fullPath);
          const target = readlinkSync(fullPath);
          const namedAfter = lstatSync(fullPath);
          if (
            !namedBefore.isSymbolicLink() ||
            !sameSnapshotFileStat(namedBefore, namedAfter) ||
            readlinkSync(fullPath) !== target
          ) {
            throw new Error(`snapshot symlink '${relativePath}' changed while it was read`);
          }
          hash.update(
            JSON.stringify([
              "symlink",
              relativePath,
              target,
              snapshotRestorableMtimeSeconds(namedBefore),
            ]),
            "utf8",
          );
          continue;
        }
        if (!entry.isFile()) {
          throw new Error(`snapshot contains unsupported entry '${relativePath}'`);
        }
        const descriptor = openSync(fullPath, openFlags);
        try {
          const opened = fstatSync(descriptor);
          const namedBefore = lstatSync(fullPath);
          if (
            !opened.isFile() ||
            namedBefore.isSymbolicLink() ||
            !sameSnapshotFileStat(opened, namedBefore)
          ) {
            throw new Error(`snapshot entry '${relativePath}' changed while it was opened`);
          }
          hash.update(
            JSON.stringify([
              "file",
              relativePath,
              opened.size,
              snapshotPermissionMode(opened),
              snapshotRestorableMtimeSeconds(opened),
            ]),
            "utf8",
          );
          const buffer = Buffer.allocUnsafe(64 * 1024);
          for (;;) {
            const bytesRead = readSync(descriptor, buffer, 0, buffer.byteLength, null);
            if (bytesRead === 0) break;
            hash.update(buffer.subarray(0, bytesRead));
          }
          const after = fstatSync(descriptor);
          const namedAfter = lstatSync(fullPath);
          if (!sameSnapshotFileStat(opened, after) || !sameSnapshotFileStat(opened, namedAfter)) {
            throw new Error(`snapshot entry '${relativePath}' changed while it was read`);
          }
        } finally {
          closeSync(descriptor);
        }
      }
      const afterDirectory = fstatSync(directoryDescriptor);
      const namedAfterDirectory = lstatSync(directory);
      if (
        !sameSnapshotFileStat(openedDirectory, afterDirectory) ||
        !sameSnapshotFileStat(openedDirectory, namedAfterDirectory)
      ) {
        throw new Error(
          `snapshot directory '${relativeDirectory || "."}' changed while it was read`,
        );
      }
    } finally {
      closeSync(directoryDescriptor);
    }
  };
  visit(backupPath, "");
  return hash.digest("hex");
}

/** Identify root paths reserved for snapshot publication and rebuild recovery control records. */
export function isSnapshotControlPath(relativePath: string): boolean {
  const root = relativePath.replace(/\\/gu, "/").split("/", 1)[0].toLowerCase();
  return (
    root === REBUILD_MANIFEST_FILE ||
    root === REBUILD_RECOVERY_MARKER_FILE ||
    REBUILD_POLICY_HANDOFF_FILE_PATTERN.test(root)
  );
}

/** Report whether dynamic state-directory discovery could claim a reserved control record. */
export function snapshotControlPathMatchesPrefix(prefix: string): boolean {
  const normalizedPrefix = prefix.toLowerCase();
  return [
    REBUILD_MANIFEST_FILE,
    REBUILD_RECOVERY_MARKER_FILE,
    REBUILD_POLICY_HANDOFF_FILE_EXAMPLE,
  ].some((fileName) => fileName.startsWith(normalizedPrefix));
}

/** Hash only restorable backup content; publication and recovery metadata are validated separately. */
export function hashSnapshotBackupContent(backupPath: string): string {
  return hashSnapshotTree(backupPath, {
    excludeRootEntry: (entry) => entry.isFile() && isSnapshotControlPath(entry.name),
  });
}
