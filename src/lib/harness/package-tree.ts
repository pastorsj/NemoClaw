// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { TextDecoder } from "node:util";

import { openRegularFileNoFollow } from "../adapters/fs/regular-file";
import { isInsideIgnoredCustomBuildContextPath } from "../onboard/custom-build-context";

export interface HarnessPackageTreeLimits {
  readonly maxEntries: number;
  readonly maxDepth: number;
  readonly maxPathBytes: number;
  readonly maxFileBytes: number;
  readonly maxTotalBytes: number;
}

export const DEFAULT_HARNESS_PACKAGE_TREE_LIMITS: HarnessPackageTreeLimits = Object.freeze({
  maxEntries: 4_096,
  maxDepth: 32,
  maxPathBytes: 1_024,
  maxFileBytes: 64 * 1_024 * 1_024,
  maxTotalBytes: 256 * 1_024 * 1_024,
});

export type HarnessPackageSourceTrust = "mutable" | "reviewed";

export interface ValidateHarnessPackageTreeOptions {
  readonly sourceTrust?: HarnessPackageSourceTrust;
  readonly limits?: Partial<HarnessPackageTreeLimits>;
}

export interface HarnessPackageTreeEntry {
  readonly relativePath: string;
  readonly type: "directory" | "file";
  readonly executableMode: number;
  readonly size: number;
}

type EntryType = HarnessPackageTreeEntry["type"];
export type EntrySnapshot = {
  readonly absolutePath: string;
  readonly relativePath: string;
  readonly type: EntryType;
  readonly stat: fs.BigIntStats;
};

export type AncestorSnapshot = {
  readonly absolutePath: string;
  readonly stat: fs.BigIntStats;
};

export type TreeAuthority = {
  readonly root: EntrySnapshot;
  readonly entries: readonly EntrySnapshot[];
  readonly ancestors: readonly AncestorSnapshot[];
  readonly sourceTrust: HarnessPackageSourceTrust;
  readonly currentUid: bigint | null;
  readonly limits: HarnessPackageTreeLimits;
};

const VALIDATED_TREE = Symbol("validated-harness-package-tree");

export interface ValidatedHarnessPackageTree {
  readonly rootDir: string;
  readonly contentDigest: string;
  readonly entries: readonly HarnessPackageTreeEntry[];
  readonly entryCount: number;
  readonly totalBytes: number;
  readonly [VALIDATED_TREE]: TreeAuthority;
}

export function getPackageTreeAuthority(validatedTree: ValidatedHarnessPackageTree): TreeAuthority {
  const authority = validatedTree[VALIDATED_TREE];
  if (!authority) throw new Error("Harness package tree was not validated by NemoClaw");
  return authority;
}

const AUTHORING_ROOT_NAMES = new Set([
  ".DS_Store",
  ".git",
  "__pycache__",
  "node_modules",
  "package-lock.json",
  "tests",
  "tsconfig.test.json",
  "vitest.config.ts",
  "vitest.nemoclaw.ts",
]);
const AUTHORING_PLUGIN_NAMES = new Set([
  "plugin/tsconfig.test.json",
  "plugin/vitest.config.ts",
  "plugin/vitest.project.ts",
]);
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/u;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const NONBLOCK = typeof fs.constants.O_NONBLOCK === "number" ? fs.constants.O_NONBLOCK : 0;
const DIRECTORY_READ_BUFFER_SIZE = 8;

export function diagnosticPath(_candidate: string): string {
  return "<package path>";
}

function resolveLimits(
  overrides: Partial<HarnessPackageTreeLimits> | undefined,
): HarnessPackageTreeLimits {
  const limits = { ...DEFAULT_HARNESS_PACKAGE_TREE_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError(`Harness package tree limit '${name}' must be a non-negative integer`);
    }
  }
  return Object.freeze(limits);
}

export function currentEffectiveUid(): bigint | null {
  return typeof process.geteuid === "function" ? BigInt(process.geteuid()) : null;
}

function entryType(stat: fs.BigIntStats, absolutePath: string): EntryType {
  if (stat.isSymbolicLink()) {
    throw new Error(
      `Harness package trees must not contain symbolic links: ${diagnosticPath(absolutePath)}`,
    );
  }
  if (stat.isDirectory()) return "directory";
  if (stat.isFile()) return "file";

  let label = "unknown entries";
  if (stat.isSocket()) label = "sockets";
  else if (stat.isFIFO()) label = "FIFOs";
  else if (stat.isBlockDevice() || stat.isCharacterDevice()) label = "device files";
  throw new Error(
    `Harness package trees must not contain ${label}: ${diagnosticPath(absolutePath)}`,
  );
}

export function assertEntryMode(stat: fs.BigIntStats, type: EntryType, absolutePath: string): void {
  if ((stat.mode & 0o7000n) !== 0n) {
    throw new Error(
      `Harness package entries must not use special mode bits: ${diagnosticPath(absolutePath)}`,
    );
  }
  if ((stat.mode & 0o022n) !== 0n) {
    throw new Error(
      `Harness package entries must not be group or world writable: ${diagnosticPath(absolutePath)}`,
    );
  }
  if (type === "directory" && (stat.mode & 0o500n) !== 0o500n) {
    throw new Error(
      `Harness package directories must be owner-readable and owner-searchable: ${diagnosticPath(absolutePath)}`,
    );
  }
  if (type === "file" && (stat.mode & 0o400n) === 0n) {
    throw new Error(
      `Harness package files must be owner-readable: ${diagnosticPath(absolutePath)}`,
    );
  }
}

function assertEntryOwner(
  stat: fs.BigIntStats,
  absolutePath: string,
  sourceTrust: HarnessPackageSourceTrust,
  currentUid: bigint | null,
): void {
  if (currentUid === null) return;
  const reviewedRootOwner = sourceTrust === "reviewed" && currentUid !== 0n && stat.uid === 0n;
  if (stat.uid !== currentUid && !reviewedRootOwner) {
    throw new Error(
      `Harness package entry has an untrusted owner: ${diagnosticPath(absolutePath)}`,
    );
  }
}

function assertAncestorOwner(
  stat: fs.BigIntStats,
  absolutePath: string,
  currentUid: bigint | null,
): void {
  if (currentUid !== null && stat.uid !== currentUid && stat.uid !== 0n) {
    throw new Error(
      `Harness package ancestor has an untrusted owner: ${diagnosticPath(absolutePath)}`,
    );
  }
}

export function captureAncestors(
  rootDir: string,
  currentUid: bigint | null,
): readonly AncestorSnapshot[] {
  const snapshots: AncestorSnapshot[] = [];
  let candidate = path.dirname(rootDir);
  while (true) {
    const stat = fs.lstatSync(candidate, { bigint: true });
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(
        `Harness package ancestor must be a regular directory: ${diagnosticPath(candidate)}`,
      );
    }
    assertEntryMode(stat, "directory", candidate);
    assertAncestorOwner(stat, candidate, currentUid);
    snapshots.push(Object.freeze({ absolutePath: candidate, stat }));
    const parent = path.dirname(candidate);
    if (parent === candidate) break;
    candidate = parent;
  }
  return Object.freeze(snapshots);
}

function decodeEntryName(rawName: Buffer): string {
  let name: string;
  try {
    name = UTF8_DECODER.decode(rawName);
  } catch {
    throw new Error("Harness package paths must use valid UTF-8");
  }
  if (
    name.length === 0 ||
    name === "." ||
    name === ".." ||
    name.includes("/") ||
    name.includes("\\") ||
    CONTROL_CHARACTER.test(name) ||
    path.posix.isAbsolute(name) ||
    path.win32.isAbsolute(name)
  ) {
    throw new Error("Harness package paths must contain canonical relative components");
  }
  if (name.normalize("NFC") !== name) {
    throw new Error("Harness package paths must use NFC Unicode normalization");
  }
  return name;
}

function duplicatePathKey(relativePath: string): string {
  // NFKC plus upper/lower conversion catches case aliases that common target
  // filesystems treat as one path. NFC remains the accepted stored form.
  return relativePath.normalize("NFKC").toUpperCase().toLowerCase().normalize("NFC");
}

function isAuthoringPath(relativePath: string): boolean {
  const first = relativePath.split("/", 1)[0];
  return (
    AUTHORING_ROOT_NAMES.has(first) ||
    AUTHORING_ROOT_NAMES.has(relativePath) ||
    AUTHORING_PLUGIN_NAMES.has(relativePath) ||
    /^plugin\/test_[^/]+\.py$/u.test(relativePath) ||
    /^plugin\/src\/.+\.test\.ts$/u.test(relativePath)
  );
}

function assertAllowedRelativePath(relativePath: string, limits: HarnessPackageTreeLimits): void {
  if (Buffer.byteLength(relativePath, "utf8") > limits.maxPathBytes) {
    throw new Error(`Harness package path exceeds the ${limits.maxPathBytes}-byte limit`);
  }
  if (isAuthoringPath(relativePath)) {
    throw new Error(`Harness package contains authoring content: ${diagnosticPath(relativePath)}`);
  }
  if (isInsideIgnoredCustomBuildContextPath(relativePath)) {
    throw new Error(
      `Harness package contains a denied credential path: ${diagnosticPath(relativePath)}`,
    );
  }
}

function assertRegularFileLimits(
  stat: fs.BigIntStats,
  absolutePath: string,
  limits: HarnessPackageTreeLimits,
): number {
  if (stat.nlink !== 1n) {
    throw new Error(
      `Harness package trees must not contain hard-linked files: ${diagnosticPath(absolutePath)}`,
    );
  }
  if (stat.size > BigInt(limits.maxFileBytes)) {
    throw new Error(
      `Harness package file exceeds the ${limits.maxFileBytes}-byte limit: ${diagnosticPath(absolutePath)}`,
    );
  }
  if (stat.size > 0n && stat.blocks * 512n < stat.size) {
    throw new Error(
      `Harness package trees must not contain sparse files: ${diagnosticPath(absolutePath)}`,
    );
  }
  return Number(stat.size);
}

export function sameSnapshot(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.size === right.size &&
    left.blocks === right.blocks &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

export function sameDirectoryIdentity(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return (
    left.isDirectory() &&
    right.isDirectory() &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.uid === right.uid &&
    left.gid === right.gid
  );
}

export function sameDirectoryObject(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return (
    left.isDirectory() &&
    right.isDirectory() &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.uid === right.uid &&
    left.gid === right.gid
  );
}

export function openVerifiedDirectoryNoFollow(
  absolutePath: string,
  expected: fs.BigIntStats,
): { readonly descriptor: number; readonly stat: fs.BigIntStats } {
  if (typeof fs.constants.O_NOFOLLOW !== "number" || typeof fs.constants.O_DIRECTORY !== "number") {
    throw new Error("Secure harness package traversal requires O_NOFOLLOW and O_DIRECTORY");
  }
  const descriptor = fs.openSync(
    absolutePath,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_DIRECTORY | NONBLOCK,
  );
  try {
    const descriptorStat = fs.fstatSync(descriptor, { bigint: true });
    const pathStat = fs.lstatSync(absolutePath, { bigint: true });
    if (
      pathStat.isSymbolicLink() ||
      !descriptorStat.isDirectory() ||
      !pathStat.isDirectory() ||
      !sameSnapshot(expected, descriptorStat) ||
      !sameSnapshot(descriptorStat, pathStat)
    ) {
      throw new Error(
        `Harness package directory changed before opening: ${diagnosticPath(absolutePath)}`,
      );
    }
    return { descriptor, stat: descriptorStat };
  } catch (error) {
    fs.closeSync(descriptor);
    throw error;
  }
}

export function assertOpenedDirectory(
  absolutePath: string,
  descriptor: number,
  expected: fs.BigIntStats,
): void {
  const descriptorStat = fs.fstatSync(descriptor, { bigint: true });
  const pathStat = fs.lstatSync(absolutePath, { bigint: true });
  if (
    pathStat.isSymbolicLink() ||
    !descriptorStat.isDirectory() ||
    !pathStat.isDirectory() ||
    !sameSnapshot(expected, descriptorStat) ||
    !sameSnapshot(descriptorStat, pathStat)
  ) {
    throw new Error(
      `Harness package directory changed while it was open: ${diagnosticPath(absolutePath)}`,
    );
  }
}

export function refreshOpenedDirectory(
  absolutePath: string,
  descriptor: number,
  previous: fs.BigIntStats,
): fs.BigIntStats {
  const descriptorStat = fs.fstatSync(descriptor, { bigint: true });
  const pathStat = fs.lstatSync(absolutePath, { bigint: true });
  if (
    pathStat.isSymbolicLink() ||
    !descriptorStat.isDirectory() ||
    !pathStat.isDirectory() ||
    !sameDirectoryIdentity(previous, descriptorStat) ||
    !sameSnapshot(descriptorStat, pathStat)
  ) {
    throw new Error(
      `Harness package directory changed during an expected mutation: ${diagnosticPath(absolutePath)}`,
    );
  }
  return descriptorStat;
}

export function assertSnapshot(snapshot: EntrySnapshot | AncestorSnapshot): void {
  const current = fs.lstatSync(snapshot.absolutePath, { bigint: true });
  const unchanged =
    "type" in snapshot
      ? sameSnapshot(snapshot.stat, current)
      : sameDirectoryIdentity(snapshot.stat, current);
  if (!unchanged) {
    throw new Error(
      `Harness package path changed during validation: ${diagnosticPath(snapshot.absolutePath)}`,
    );
  }
  if ("type" in snapshot && entryType(current, snapshot.absolutePath) !== snapshot.type) {
    throw new Error(
      `Harness package path changed type during validation: ${diagnosticPath(snapshot.absolutePath)}`,
    );
  }
}

export function assertTreeAuthority(authority: TreeAuthority): void {
  for (const ancestor of authority.ancestors) assertSnapshot(ancestor);
  assertSnapshot(authority.root);
  for (const entry of authority.entries) assertSnapshot(entry);
}

export function assertSourcePathAuthority(
  authority: TreeAuthority,
  entry: EntrySnapshot,
  entriesByPath: ReadonlyMap<string, EntrySnapshot>,
): void {
  // Node does not expose openat. Recheck each no-follow path component before
  // and after copy operations instead of claiming a kernel-atomic path walk.
  for (const ancestor of authority.ancestors) assertSnapshot(ancestor);
  assertSnapshot(authority.root);
  const components = entry.relativePath.split("/");
  for (let end = 1; end <= components.length; end += 1) {
    const relativePath = components.slice(0, end).join("/");
    const snapshot = entriesByPath.get(relativePath);
    if (!snapshot) throw new Error("Validated harness package authority is incomplete");
    assertSnapshot(snapshot);
  }
}

export function readVerifiedFile(entry: EntrySnapshot, maxFileBytes: number): Buffer {
  assertSnapshot(entry);
  const opened = openRegularFileNoFollow(entry.absolutePath);
  try {
    const bytes = opened.readBytes(maxFileBytes);
    if (bytes.length !== Number(entry.stat.size)) {
      throw new Error(
        `Harness package file changed while it was read: ${diagnosticPath(entry.absolutePath)}`,
      );
    }
    assertSnapshot(entry);
    return bytes;
  } finally {
    opened.close();
  }
}

function updateFrame(hash: crypto.Hash, value: Buffer): void {
  const length = Buffer.allocUnsafe(8);
  length.writeBigUInt64BE(BigInt(value.length));
  hash.update(length);
  hash.update(value);
}

function digestTree(entries: readonly EntrySnapshot[], maxFileBytes: number): string {
  const hash = crypto.createHash("sha256");
  hash.update("nemoclaw-harness-package-tree-v1\0", "utf8");
  for (const entry of entries) {
    const executableMode = Buffer.from([Number(entry.stat.mode & 0o111n)]);
    const bytes = entry.type === "file" ? readVerifiedFile(entry, maxFileBytes) : Buffer.alloc(0);
    updateFrame(hash, Buffer.from(entry.relativePath, "utf8"));
    updateFrame(hash, Buffer.from(entry.type, "utf8"));
    updateFrame(hash, executableMode);
    const byteLength = Buffer.allocUnsafe(8);
    byteLength.writeBigUInt64BE(BigInt(bytes.length));
    hash.update(byteLength);
    hash.update(bytes);
  }
  return hash.digest("hex");
}

export function validateHarnessPackageTree(
  sourceRoot: string,
  options: ValidateHarnessPackageTreeOptions = {},
): ValidatedHarnessPackageTree {
  const rootDir = path.resolve(sourceRoot);
  const limits = resolveLimits(options.limits);
  const sourceTrust = options.sourceTrust ?? "mutable";
  const currentUid = currentEffectiveUid();
  const ancestors = captureAncestors(rootDir, currentUid);
  const rootStat = fs.lstatSync(rootDir, { bigint: true });
  const rootType = entryType(rootStat, rootDir);
  if (rootType !== "directory") {
    throw new Error(`Harness package root must be a regular directory: ${diagnosticPath(rootDir)}`);
  }
  assertEntryMode(rootStat, rootType, rootDir);
  assertEntryOwner(rootStat, rootDir, sourceTrust, currentUid);

  const root: EntrySnapshot = Object.freeze({
    absolutePath: rootDir,
    relativePath: "",
    type: "directory",
    stat: rootStat,
  });
  const entries: EntrySnapshot[] = [];
  const duplicatePaths = new Set<string>();
  let totalBytes = 0;

  const walk = (directory: EntrySnapshot, depth: number): void => {
    const openedDirectory = openVerifiedDirectoryNoFollow(directory.absolutePath, directory.stat);
    let directoryStream: fs.Dir | null = null;
    let operationFailed = false;
    try {
      directoryStream = fs.opendirSync(Buffer.from(directory.absolutePath), {
        bufferSize: DIRECTORY_READ_BUFFER_SIZE,
        encoding: "buffer" as BufferEncoding,
      });
      while (true) {
        const child = directoryStream.readSync() as fs.Dirent<Buffer> | null;
        if (child === null) break;
        if (!Buffer.isBuffer(child.name)) {
          throw new Error("Harness package directory stream did not return byte paths");
        }
        const name = decodeEntryName(child.name);
        const relativePath = directory.relativePath ? `${directory.relativePath}/${name}` : name;
        const childDepth = depth + 1;
        if (childDepth > limits.maxDepth) {
          throw new Error(`Harness package exceeds the maximum depth of ${limits.maxDepth}`);
        }
        assertAllowedRelativePath(relativePath, limits);
        const duplicateKey = duplicatePathKey(relativePath);
        if (duplicatePaths.has(duplicateKey)) {
          throw new Error(
            `Harness package contains a normalized or case-folded duplicate path: ${diagnosticPath(relativePath)}`,
          );
        }
        duplicatePaths.add(duplicateKey);
        if (entries.length >= limits.maxEntries) {
          throw new Error(
            `Harness package exceeds the maximum entry count of ${limits.maxEntries}`,
          );
        }

        const absolutePath = path.join(directory.absolutePath, name);
        const stat = fs.lstatSync(absolutePath, { bigint: true });
        const type = entryType(stat, absolutePath);
        assertEntryMode(stat, type, absolutePath);
        assertEntryOwner(stat, absolutePath, sourceTrust, currentUid);
        if (type === "file") {
          totalBytes += assertRegularFileLimits(stat, absolutePath, limits);
          if (totalBytes > limits.maxTotalBytes) {
            throw new Error(`Harness package exceeds the ${limits.maxTotalBytes}-byte total limit`);
          }
        }
        const snapshot: EntrySnapshot = Object.freeze({ absolutePath, relativePath, type, stat });
        entries.push(snapshot);
        if (type === "directory") walk(snapshot, childDepth);
        assertSnapshot(snapshot);
      }
    } catch (error) {
      operationFailed = true;
      throw error;
    } finally {
      let closeError: unknown = null;
      try {
        directoryStream?.closeSync();
      } catch (error) {
        if (!operationFailed) closeError = error;
      }
      try {
        if (!operationFailed && closeError === null) {
          assertOpenedDirectory(directory.absolutePath, openedDirectory.descriptor, directory.stat);
        }
      } finally {
        fs.closeSync(openedDirectory.descriptor);
      }
      if (closeError !== null) throw closeError;
    }
  };

  walk(root, 0);
  entries.sort((left, right) =>
    Buffer.compare(Buffer.from(left.relativePath, "utf8"), Buffer.from(right.relativePath, "utf8")),
  );
  const contentDigest = digestTree(entries, limits.maxFileBytes);
  const authority: TreeAuthority = Object.freeze({
    root,
    entries: Object.freeze(entries),
    ancestors,
    sourceTrust,
    currentUid,
    limits,
  });
  assertTreeAuthority(authority);
  const publicEntries = Object.freeze(
    entries.map((entry) =>
      Object.freeze({
        relativePath: entry.relativePath,
        type: entry.type,
        executableMode: Number(entry.stat.mode & 0o111n),
        size: Number(entry.stat.size),
      }),
    ),
  );
  return Object.freeze({
    rootDir,
    contentDigest,
    entries: publicEntries,
    entryCount: entries.length,
    totalBytes,
    [VALIDATED_TREE]: authority,
  });
}
