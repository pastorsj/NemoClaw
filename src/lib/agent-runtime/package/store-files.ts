// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { TextDecoder } from "node:util";

import {
  assertOpenedDirectory,
  assertSnapshot,
  assertTreeAuthority,
  getPackageTreeAuthority,
  openVerifiedDirectoryNoFollow,
  sameDirectoryObject,
  sameSnapshot,
  type ValidatedHarnessPackageTree,
} from "./tree";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const DIRECTORY_ENTRY_LIMIT = 4_096;
const DIRECTORY_READ_BUFFER_SIZE = 8;
const NONBLOCK = typeof fs.constants.O_NONBLOCK === "number" ? fs.constants.O_NONBLOCK : 0;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error;
}

function requireNoFollow(): number {
  if (typeof fs.constants.O_NOFOLLOW !== "number") {
    throw new Error("Harness package storage requires O_NOFOLLOW");
  }
  return fs.constants.O_NOFOLLOW;
}

interface DirectorySnapshot {
  readonly absolutePath: string;
  readonly privateDirectory: boolean;
  readonly stat: fs.BigIntStats;
}

export interface HarnessPackageStoreAuthority {
  readonly root: string;
  readonly uid: bigint;
  readonly directories: readonly DirectorySnapshot[];
}

export interface HarnessPackageStorePaths {
  readonly root: string;
  readonly staging: string;
  readonly objects: string;
  readonly objectShard: string;
  readonly receipts: string;
  readonly harnessReceipts: string;
  readonly receiptShard: string;
  readonly active: string;
  readonly locks: string;
  readonly lock: string;
}

export interface StagedStoreFile {
  readonly absolutePath: string;
  readonly parent: string;
  readonly stat: fs.BigIntStats;
}

export interface VerifiedStoreFile<T> {
  readonly absolutePath: string;
  readonly stat: fs.BigIntStats;
  readonly value: T;
}

function currentUid(): bigint {
  const realUid = process.getuid?.();
  const effectiveUid = process.geteuid?.();
  if (realUid === undefined || effectiveUid === undefined || realUid !== effectiveUid) {
    throw new Error("Harness package storage requires one current-user identity");
  }
  return BigInt(effectiveUid);
}

function directoryComponents(target: string): string[] {
  const resolved = path.resolve(target);
  const root = path.parse(resolved).root;
  const relative = path.relative(root, resolved);
  const components = relative ? relative.split(path.sep) : [];
  const result = [root];
  let current = root;
  for (const component of components) {
    current = path.join(current, component);
    result.push(current);
  }
  return result;
}

function sameDirectorySnapshot(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
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

function assertDirectoryPosture(
  stat: fs.BigIntStats,
  uid: bigint,
  privateDirectory: boolean,
): void {
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error("Harness package store contains a non-directory path component");
  }
  if (privateDirectory) {
    if (stat.uid !== uid || (stat.mode & 0o7777n) !== BigInt(PRIVATE_DIRECTORY_MODE)) {
      throw new Error("Harness package store directory is not current-user private");
    }
    return;
  }
  if (
    (stat.uid !== uid && stat.uid !== 0n) ||
    (stat.mode & 0o022n) !== 0n ||
    (stat.mode & 0o7000n) !== 0n
  ) {
    throw new Error("Harness package store ancestor has an unsafe owner or mode");
  }
}

function fsyncDirectoryDescriptor(descriptor: number): void {
  try {
    fs.fsyncSync(descriptor);
  } catch (error) {
    if (
      !isErrnoException(error) ||
      (error.code !== "EINVAL" && error.code !== "ENOTSUP" && error.code !== "ENOSYS")
    ) {
      throw error;
    }
  }
}

export function fsyncHarnessPackageDirectory(directory: string): void {
  const before = fs.lstatSync(directory, { bigint: true });
  const opened = openVerifiedDirectoryNoFollow(directory, before);
  try {
    fsyncDirectoryDescriptor(opened.descriptor);
    assertOpenedDirectory(directory, opened.descriptor, opened.stat);
  } finally {
    fs.closeSync(opened.descriptor);
  }
}

function createPrivateDirectory(candidate: string, uid: bigint): void {
  fs.mkdirSync(candidate, { mode: PRIVATE_DIRECTORY_MODE });
  const before = fs.lstatSync(candidate, { bigint: true });
  const opened = openVerifiedDirectoryNoFollow(candidate, before);
  try {
    fs.fchmodSync(opened.descriptor, PRIVATE_DIRECTORY_MODE);
    const after = fs.fstatSync(opened.descriptor, { bigint: true });
    const named = fs.lstatSync(candidate, { bigint: true });
    assertDirectoryPosture(after, uid, true);
    if (!sameSnapshot(after, named)) {
      throw new Error("Harness package store directory changed during creation");
    }
    fsyncDirectoryDescriptor(opened.descriptor);
  } finally {
    fs.closeSync(opened.descriptor);
  }
  fsyncHarnessPackageDirectory(path.dirname(candidate));
}

function captureDirectory(
  absolutePath: string,
  uid: bigint,
  privateDirectory: boolean,
): DirectorySnapshot {
  const stat = fs.lstatSync(absolutePath, { bigint: true });
  assertDirectoryPosture(stat, uid, privateDirectory);
  const opened = openVerifiedDirectoryNoFollow(absolutePath, stat);
  fs.closeSync(opened.descriptor);
  return Object.freeze({ absolutePath, privateDirectory, stat: opened.stat });
}

function ensureRoot(root: string, uid: bigint): readonly DirectorySnapshot[] {
  const components = directoryComponents(root);
  const snapshots: DirectorySnapshot[] = [];
  for (const candidate of components) {
    const privateDirectory = candidate === root;
    try {
      snapshots.push(captureDirectory(candidate, uid, privateDirectory));
    } catch (error) {
      if (!isErrnoException(error) || error.code !== "ENOENT" || candidate === components[0]) {
        throw error;
      }
      try {
        createPrivateDirectory(candidate, uid);
      } catch (createError) {
        if (!isErrnoException(createError) || createError.code !== "EEXIST") throw createError;
      }
      snapshots.push(captureDirectory(candidate, uid, privateDirectory));
    }
  }
  return snapshots;
}

function ensureManagedDirectory(
  candidate: string,
  uid: bigint,
  snapshots: DirectorySnapshot[],
): void {
  try {
    snapshots.push(captureDirectory(candidate, uid, true));
  } catch (error) {
    if (!isErrnoException(error) || error.code !== "ENOENT") throw error;
    try {
      createPrivateDirectory(candidate, uid);
    } catch (createError) {
      if (!isErrnoException(createError) || createError.code !== "EEXIST") throw createError;
    }
    snapshots.push(captureDirectory(candidate, uid, true));
  }
}

export function harnessPackageStorePaths(
  storeRoot: string,
  harnessId: string,
): HarnessPackageStorePaths {
  const root = path.resolve(storeRoot);
  const staging = path.join(root, "staging");
  const objects = path.join(root, "objects");
  const objectShard = path.join(objects, "sha256");
  const receipts = path.join(root, "receipts");
  const harnessReceipts = path.join(receipts, harnessId);
  const receiptShard = path.join(harnessReceipts, "sha256");
  const active = path.join(root, "active");
  const locks = path.join(root, "locks");
  return Object.freeze({
    root,
    staging,
    objects,
    objectShard,
    receipts,
    harnessReceipts,
    receiptShard,
    active,
    locks,
    lock: path.join(locks, `${harnessId}.lock`),
  });
}

export function ensureHarnessPackageStore(
  paths: HarnessPackageStorePaths,
): HarnessPackageStoreAuthority {
  const uid = currentUid();
  const snapshots = [...ensureRoot(paths.root, uid)];
  for (const directory of [
    paths.staging,
    paths.objects,
    paths.objectShard,
    paths.receipts,
    paths.harnessReceipts,
    paths.receiptShard,
    paths.active,
    paths.locks,
  ]) {
    ensureManagedDirectory(directory, uid, snapshots);
  }
  const authority = Object.freeze({
    root: paths.root,
    uid,
    directories: Object.freeze(snapshots),
  });
  assertHarnessPackageStoreAuthority(authority);
  return authority;
}

export function captureHarnessPackageStore(
  paths: HarnessPackageStorePaths,
  managedDirectories: readonly string[],
): HarnessPackageStoreAuthority {
  const uid = currentUid();
  const snapshots = directoryComponents(paths.root).map((candidate) =>
    captureDirectory(candidate, uid, candidate === paths.root),
  );
  for (const directory of managedDirectories) {
    snapshots.push(captureDirectory(directory, uid, true));
  }
  const authority = Object.freeze({
    root: paths.root,
    uid,
    directories: Object.freeze(snapshots),
  });
  assertHarnessPackageStoreAuthority(authority);
  return authority;
}

export function assertHarnessPackageStoreAuthority(authority: HarnessPackageStoreAuthority): void {
  if (currentUid() !== authority.uid) {
    throw new Error("Harness package store user identity changed during the operation");
  }
  for (const snapshot of authority.directories) {
    const current = fs.lstatSync(snapshot.absolutePath, { bigint: true });
    assertDirectoryPosture(current, authority.uid, snapshot.privateDirectory);
    if (!sameDirectorySnapshot(snapshot.stat, current)) {
      throw new Error("Harness package store directory authority changed during the operation");
    }
  }
}

function sameFileSnapshot(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return (
    left.isFile() &&
    right.isFile() &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function assertPrivateFilePosture(stat: fs.BigIntStats, uid: bigint): void {
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1n ||
    stat.uid !== uid ||
    (stat.mode & 0o7777n) !== BigInt(PRIVATE_FILE_MODE)
  ) {
    throw new Error("Harness package store record has an unsafe file authority");
  }
}

function assertPrivateFile(stat: fs.BigIntStats, uid: bigint, maxBytes: number): void {
  assertPrivateFilePosture(stat, uid);
  if (stat.size < 1n || stat.size > BigInt(maxBytes)) {
    throw new Error("Harness package store record has an unsafe file authority");
  }
}

export function assertHarnessPackageStoreFileAuthority(
  absolutePath: string,
  authority: HarnessPackageStoreAuthority,
): void {
  assertHarnessPackageStoreAuthority(authority);
  const descriptor = fs.openSync(
    absolutePath,
    fs.constants.O_RDONLY | requireNoFollow() | NONBLOCK,
  );
  try {
    const opened = fs.fstatSync(descriptor, { bigint: true });
    const named = fs.lstatSync(absolutePath, { bigint: true });
    assertPrivateFilePosture(opened, authority.uid);
    if (!sameFileSnapshot(opened, named)) {
      throw new Error("Harness package store record changed during authority validation");
    }
    assertHarnessPackageStoreAuthority(authority);
  } finally {
    fs.closeSync(descriptor);
  }
}

export function readCanonicalStoreFileRecord<T>(options: {
  readonly absolutePath: string;
  readonly authority: HarnessPackageStoreAuthority;
  readonly maxBytes: number;
  readonly parse: (source: Uint8Array) => T;
  readonly serialize: (value: T) => string;
}): VerifiedStoreFile<T> {
  assertHarnessPackageStoreAuthority(options.authority);
  const descriptor = fs.openSync(
    options.absolutePath,
    fs.constants.O_RDONLY | requireNoFollow() | NONBLOCK,
  );
  try {
    const before = fs.fstatSync(descriptor, { bigint: true });
    const namedBefore = fs.lstatSync(options.absolutePath, { bigint: true });
    assertPrivateFile(before, options.authority.uid, options.maxBytes);
    if (!sameFileSnapshot(before, namedBefore)) {
      throw new Error("Harness package store record changed before reading");
    }
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const read = fs.readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (read === 0) throw new Error("Harness package store record ended before its stated size");
      offset += read;
    }
    const after = fs.fstatSync(descriptor, { bigint: true });
    const namedAfter = fs.lstatSync(options.absolutePath, { bigint: true });
    if (!sameFileSnapshot(before, after) || !sameFileSnapshot(before, namedAfter)) {
      throw new Error("Harness package store record changed while reading");
    }
    const parsed = options.parse(bytes);
    if (!Buffer.from(options.serialize(parsed), "utf8").equals(bytes)) {
      throw new Error("Harness package store record is not canonical JSON");
    }
    assertHarnessPackageStoreAuthority(options.authority);
    return Object.freeze({
      absolutePath: options.absolutePath,
      stat: before,
      value: parsed,
    });
  } finally {
    fs.closeSync(descriptor);
  }
}

export function readCanonicalStoreFile<T>(options: {
  readonly absolutePath: string;
  readonly authority: HarnessPackageStoreAuthority;
  readonly maxBytes: number;
  readonly parse: (source: Uint8Array) => T;
  readonly serialize: (value: T) => string;
}): T {
  return readCanonicalStoreFileRecord(options).value;
}

export function assertCanonicalStoreFileUnchanged<T>(
  file: VerifiedStoreFile<T>,
  authority: HarnessPackageStoreAuthority,
): void {
  assertHarnessPackageStoreAuthority(authority);
  const descriptor = fs.openSync(
    file.absolutePath,
    fs.constants.O_RDONLY | requireNoFollow() | NONBLOCK,
  );
  try {
    const current = fs.fstatSync(descriptor, { bigint: true });
    const named = fs.lstatSync(file.absolutePath, { bigint: true });
    assertPrivateFile(current, authority.uid, Number(file.stat.size));
    if (!sameFileSnapshot(file.stat, current) || !sameFileSnapshot(file.stat, named)) {
      throw new Error("Harness package store record changed after reading");
    }
    assertHarnessPackageStoreAuthority(authority);
  } finally {
    fs.closeSync(descriptor);
  }
}

/**
 * Remove one previously verified mutable store record without following a
 * replacement path. Immutable objects and receipts use separate publication
 * helpers and must never call this function.
 */
export function removeCanonicalStoreFile<T>(
  file: VerifiedStoreFile<T>,
  authority: HarnessPackageStoreAuthority,
): void {
  assertHarnessPackageStoreAuthority(authority);
  const descriptor = fs.openSync(
    file.absolutePath,
    fs.constants.O_RDONLY | requireNoFollow() | NONBLOCK,
  );
  try {
    const opened = fs.fstatSync(descriptor, { bigint: true });
    const named = fs.lstatSync(file.absolutePath, { bigint: true });
    assertPrivateFile(opened, authority.uid, Number(file.stat.size));
    if (!sameFileSnapshot(file.stat, opened) || !sameFileSnapshot(file.stat, named)) {
      throw new Error("Harness package store record changed before removal");
    }
    assertHarnessPackageStoreAuthority(authority);
    fs.unlinkSync(file.absolutePath);
    if (fs.fstatSync(descriptor, { bigint: true }).nlink !== 0n) {
      throw new Error("Harness package store record remained linked after removal");
    }
    fsyncHarnessPackageDirectory(path.dirname(file.absolutePath));
    if (!storePathIsMissing(file.absolutePath)) {
      throw new Error("Harness package store record removal did not persist");
    }
  } finally {
    fs.closeSync(descriptor);
  }
}

function assertStagedStoreFile(file: StagedStoreFile, uid: bigint): void {
  const current = fs.lstatSync(file.absolutePath, { bigint: true });
  assertPrivateFile(current, uid, Number(file.stat.size));
  if (!sameFileSnapshot(file.stat, current)) {
    throw new Error("Harness package staged record changed before publication");
  }
}

function cleanFailedStagedStoreFile(
  absolutePath: string,
  parent: string,
  descriptor: number,
): void {
  const opened = fs.fstatSync(descriptor, { bigint: true });
  const named = fs.lstatSync(absolutePath, { bigint: true });
  if (!sameFileSnapshot(opened, named) || path.dirname(absolutePath) !== parent) {
    throw new Error("Harness package failed staged record changed before cleanup");
  }
  fs.unlinkSync(absolutePath);
  if (fs.fstatSync(descriptor, { bigint: true }).nlink !== 0n) {
    throw new Error("Harness package failed staged record remained linked after cleanup");
  }
  fsyncHarnessPackageDirectory(parent);
}

export function writeStagedStoreFile(
  stageRoot: string,
  role: string,
  contents: string,
  authority: HarnessPackageStoreAuthority,
): StagedStoreFile {
  if (!/^[a-z][a-z-]{0,63}$/u.test(role)) {
    throw new Error("Harness package staged record role is invalid");
  }
  assertHarnessPackageStoreAuthority(authority);
  const parentStat = fs.lstatSync(stageRoot, { bigint: true });
  assertDirectoryPosture(parentStat, authority.uid, true);
  const absolutePath = path.join(stageRoot, `.${role}.${String(process.pid)}.${randomUUID()}.tmp`);
  const descriptor = fs.openSync(
    absolutePath,
    fs.constants.O_WRONLY |
      fs.constants.O_CREAT |
      fs.constants.O_EXCL |
      requireNoFollow() |
      NONBLOCK,
    PRIVATE_FILE_MODE,
  );
  try {
    const bytes = Buffer.from(contents, "utf8");
    let offset = 0;
    while (offset < bytes.length) {
      const written = fs.writeSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (written === 0) throw new Error("Harness package staged record write was incomplete");
      offset += written;
    }
    fs.fchmodSync(descriptor, PRIVATE_FILE_MODE);
    fs.fsyncSync(descriptor);
    const stat = fs.fstatSync(descriptor, { bigint: true });
    const named = fs.lstatSync(absolutePath, { bigint: true });
    assertPrivateFile(stat, authority.uid, bytes.length);
    if (!sameFileSnapshot(stat, named)) {
      throw new Error("Harness package staged record changed while writing");
    }
    return Object.freeze({ absolutePath, parent: stageRoot, stat });
  } catch (operationError) {
    try {
      cleanFailedStagedStoreFile(absolutePath, stageRoot, descriptor);
    } catch (cleanupError) {
      throw new Error("Harness package staged record failure cleanup is incomplete", {
        cause: new AggregateError([operationError, cleanupError]),
      });
    }
    throw operationError;
  } finally {
    fs.closeSync(descriptor);
  }
}

export function removeStagedStoreFile(
  file: StagedStoreFile,
  authority: HarnessPackageStoreAuthority,
): void {
  assertHarnessPackageStoreAuthority(authority);
  try {
    fs.lstatSync(file.absolutePath);
  } catch (error) {
    if (!isErrnoException(error) || error.code !== "ENOENT") throw error;
    assertHarnessPackageStoreAuthority(authority);
    return;
  }
  assertStagedStoreFile(file, authority.uid);
  fs.unlinkSync(file.absolutePath);
  fsyncHarnessPackageDirectory(file.parent);
  assertHarnessPackageStoreAuthority(authority);
}

export function publishStagedStoreFile(
  file: StagedStoreFile,
  destination: string,
  authority: HarnessPackageStoreAuthority,
): void {
  assertHarnessPackageStoreAuthority(authority);
  assertStagedStoreFile(file, authority.uid);
  fs.renameSync(file.absolutePath, destination);
  fsyncHarnessPackageDirectory(file.parent);
  fsyncHarnessPackageDirectory(path.dirname(destination));
  assertHarnessPackageStoreAuthority(authority);
}

/**
 * Publish one immutable record without replacing an existing destination.
 * Node does not expose renameat2(RENAME_NOREPLACE). The per-harness process
 * lock serializes NemoClaw publishers; this final absence check prevents a
 * known destination from being replaced, and the inode check proves which
 * staged file won the remaining same-user rename interval.
 */
export function publishAbsentStagedStoreFile(
  file: StagedStoreFile,
  destination: string,
  authority: HarnessPackageStoreAuthority,
): "published" | "exists" {
  assertHarnessPackageStoreAuthority(authority);
  assertStagedStoreFile(file, authority.uid);
  try {
    fs.lstatSync(destination);
    return "exists";
  } catch (error) {
    if (!isErrnoException(error) || error.code !== "ENOENT") throw error;
  }
  fs.renameSync(file.absolutePath, destination);
  fsyncHarnessPackageDirectory(file.parent);
  fsyncHarnessPackageDirectory(path.dirname(destination));

  const published = fs.lstatSync(destination, { bigint: true });
  assertPrivateFile(published, authority.uid, Number(file.stat.size));
  if (
    published.dev !== file.stat.dev ||
    published.ino !== file.stat.ino ||
    published.size !== file.stat.size
  ) {
    throw new Error("Harness package immutable record changed after publication");
  }
  assertHarnessPackageStoreAuthority(authority);
  return "published";
}

function syncPackageFile(absolutePath: string, expected: fs.BigIntStats): void {
  assertSnapshot({ absolutePath, relativePath: "", type: "file", stat: expected });
  const descriptor = fs.openSync(
    absolutePath,
    fs.constants.O_RDONLY | requireNoFollow() | NONBLOCK,
  );
  try {
    const before = fs.fstatSync(descriptor, { bigint: true });
    if (!sameSnapshot(expected, before)) {
      throw new Error("Harness package staged file changed before durability sync");
    }
    fs.fsyncSync(descriptor);
    const after = fs.fstatSync(descriptor, { bigint: true });
    const named = fs.lstatSync(absolutePath, { bigint: true });
    if (!sameSnapshot(expected, after) || !sameSnapshot(expected, named)) {
      throw new Error("Harness package staged file changed during durability sync");
    }
  } finally {
    fs.closeSync(descriptor);
  }
}

export function syncHarnessPackageTree(tree: ValidatedHarnessPackageTree): void {
  const authority = getPackageTreeAuthority(tree);
  assertTreeAuthority(authority);
  for (const entry of authority.entries) {
    if (entry.type === "file") syncPackageFile(entry.absolutePath, entry.stat);
  }
  const directories = [
    authority.root,
    ...authority.entries.filter((entry) => entry.type === "directory"),
  ].sort(
    (left, right) => right.relativePath.split("/").length - left.relativePath.split("/").length,
  );
  for (const directory of directories) {
    const opened = openVerifiedDirectoryNoFollow(directory.absolutePath, directory.stat);
    try {
      fsyncDirectoryDescriptor(opened.descriptor);
      assertOpenedDirectory(directory.absolutePath, opened.descriptor, directory.stat);
    } finally {
      fs.closeSync(opened.descriptor);
    }
  }
  assertTreeAuthority(authority);
}

export function publishStagedPackageDirectory(
  source: string,
  destination: string,
  authority: HarnessPackageStoreAuthority,
): "published" | "exists" {
  assertHarnessPackageStoreAuthority(authority);
  const sourceStat = fs.lstatSync(source, { bigint: true });
  assertDirectoryPosture(sourceStat, authority.uid, true);
  try {
    fs.lstatSync(destination);
    return "exists";
  } catch (error) {
    if (!isErrnoException(error) || error.code !== "ENOENT") throw error;
  }
  // Node does not expose renameat2(RENAME_NOREPLACE). The per-harness process
  // lock serializes NemoClaw publishers; this final check prevents a known
  // destination from being replaced, and the inode check below proves which
  // staged object won the remaining same-user rename interval.
  fs.renameSync(source, destination);
  fsyncHarnessPackageDirectory(path.dirname(source));
  fsyncHarnessPackageDirectory(path.dirname(destination));
  const published = fs.lstatSync(destination, { bigint: true });
  if (!sameDirectoryObject(sourceStat, published)) {
    throw new Error("Harness package immutable object changed during publication");
  }
  assertHarnessPackageStoreAuthority(authority);
  return "published";
}

function decodeStoreEntryName(name: Buffer): string {
  try {
    const decoded = UTF8_DECODER.decode(name);
    if (!/^[a-zA-Z0-9._-]{1,255}$/u.test(decoded)) {
      throw new Error("Harness package store directory contains an invalid entry name");
    }
    return decoded;
  } catch (error) {
    if (error instanceof Error && error.message.includes("invalid entry name")) throw error;
    throw new Error("Harness package store directory contains a non-UTF-8 entry name");
  }
}

export function listHarnessPackageStoreDirectory(
  directory: string,
  authority: HarnessPackageStoreAuthority,
): readonly string[] {
  assertHarnessPackageStoreAuthority(authority);
  const stat = fs.lstatSync(directory, { bigint: true });
  const opened = openVerifiedDirectoryNoFollow(directory, stat);
  const stream = fs.opendirSync(Buffer.from(directory), {
    bufferSize: DIRECTORY_READ_BUFFER_SIZE,
    encoding: "buffer" as BufferEncoding,
  });
  const entries: string[] = [];
  try {
    while (true) {
      const entry = stream.readSync() as fs.Dirent<Buffer> | null;
      if (entry === null) break;
      if (entries.length >= DIRECTORY_ENTRY_LIMIT) {
        throw new Error("Harness package store directory exceeds its entry limit");
      }
      if (!Buffer.isBuffer(entry.name)) {
        throw new Error("Harness package store directory did not return byte paths");
      }
      entries.push(decodeStoreEntryName(entry.name));
    }
    assertOpenedDirectory(directory, opened.descriptor, opened.stat);
    assertHarnessPackageStoreAuthority(authority);
    return Object.freeze(entries.sort());
  } finally {
    stream.closeSync();
    fs.closeSync(opened.descriptor);
  }
}

export function storePathIsMissing(target: string): boolean {
  try {
    fs.lstatSync(target);
    return false;
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") return true;
    throw error;
  }
}
