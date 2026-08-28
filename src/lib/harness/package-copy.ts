// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { openRegularFileNoFollow } from "../adapters/fs/regular-file";
import { isErrnoException } from "../core/errno";
import {
  assertEntryMode,
  assertOpenedDirectory,
  assertSnapshot,
  assertSourcePathAuthority,
  assertTreeAuthority,
  captureAncestors,
  currentEffectiveUid,
  diagnosticPath,
  getPackageTreeAuthority,
  openVerifiedDirectoryNoFollow,
  readVerifiedFile,
  refreshOpenedDirectory,
  sameDirectoryIdentity,
  sameDirectoryObject,
  sameSnapshot,
  validateHarnessPackageTree,
  type EntrySnapshot,
  type ValidatedHarnessPackageTree,
} from "./package-tree";

export interface CopyHarnessPackageTreeOptions {
  readonly stagingParent: string;
  readonly stagingPrefix?: string;
}

export interface CopiedHarnessPackageTree {
  readonly stagingRoot: string;
  readonly packageRoot: string;
  readonly contentDigest: string;
  removeStagingRoot(): void;
}

export class HarnessPackageStageCleanupError extends Error {
  override readonly name = "HarnessPackageStageCleanupError";

  constructor(
    readonly operationError: unknown,
    readonly cleanupError: unknown,
  ) {
    super("Harness package copy failed and stage cleanup is incomplete", { cause: cleanupError });
  }
}

class StagedDestinationAuthorityError extends Error {
  override readonly name = "StagedDestinationAuthorityError";

  constructor(message: string, cause: unknown) {
    super(message, { cause });
  }
}

const NONBLOCK = typeof fs.constants.O_NONBLOCK === "number" ? fs.constants.O_NONBLOCK : 0;

function openPrivateDirectory(
  absolutePath: string,
  canonicalMode: number,
  expectedBeforeOpen: fs.BigIntStats,
): { readonly descriptor: number; readonly stat: fs.BigIntStats } {
  const opened = openVerifiedDirectoryNoFollow(absolutePath, expectedBeforeOpen);
  const { descriptor } = opened;
  try {
    fs.fchmodSync(descriptor, canonicalMode);
    const stat = fs.fstatSync(descriptor, { bigint: true });
    const pathStat = fs.lstatSync(absolutePath, { bigint: true });
    if (
      !stat.isDirectory() ||
      pathStat.isSymbolicLink() ||
      !pathStat.isDirectory() ||
      !sameDirectoryObject(opened.stat, stat) ||
      !sameSnapshot(stat, pathStat) ||
      (stat.mode & 0o7777n) !== BigInt(canonicalMode)
    ) {
      throw new Error(`Harness package staging directory changed: ${diagnosticPath(absolutePath)}`);
    }
    return { descriptor, stat };
  } catch (error) {
    fs.closeSync(descriptor);
    throw error;
  }
}

function isAuthorityErrno(error: unknown): boolean {
  return (
    isErrnoException(error) &&
    (error.code === "EEXIST" ||
      error.code === "ELOOP" ||
      error.code === "ENOENT" ||
      error.code === "ENOTDIR")
  );
}

function createStagedDirectory(
  absolutePath: string,
  canonicalMode: number,
): { readonly descriptor: number; readonly stat: fs.BigIntStats } {
  try {
    fs.mkdirSync(absolutePath, { mode: canonicalMode });
  } catch (error) {
    if (isAuthorityErrno(error)) {
      throw new StagedDestinationAuthorityError(
        "Staged harness package directory authority changed before creation",
        error,
      );
    }
    throw error;
  }

  let beforeOpen: fs.BigIntStats;
  try {
    beforeOpen = fs.lstatSync(absolutePath, { bigint: true });
  } catch (error) {
    throw new StagedDestinationAuthorityError(
      "Staged harness package directory identity is unavailable after creation",
      error,
    );
  }
  try {
    return openPrivateDirectory(absolutePath, canonicalMode, beforeOpen);
  } catch (error) {
    if (
      isAuthorityErrno(error) ||
      (error instanceof Error && error.message.includes("changed before opening"))
    ) {
      throw new StagedDestinationAuthorityError(
        "Staged harness package directory changed between creation and opening",
        error,
      );
    }
    throw error;
  }
}

function assertPrivateDirectory(absolutePath: string, expected: fs.BigIntStats): void {
  const current = fs.lstatSync(absolutePath, { bigint: true });
  if (
    current.isSymbolicLink() ||
    !current.isDirectory() ||
    !sameDirectoryIdentity(expected, current)
  ) {
    throw new Error(`Harness package staging directory changed: ${diagnosticPath(absolutePath)}`);
  }
}

function assertStagedDirectory(absolutePath: string, expected: fs.BigIntStats): void {
  try {
    assertPrivateDirectory(absolutePath, expected);
  } catch (error) {
    throw new StagedDestinationAuthorityError(
      "Staged harness package directory authority changed during copy",
      error,
    );
  }
}

function refreshStagedDirectory(
  absolutePath: string,
  descriptor: number,
  expected: fs.BigIntStats,
): fs.BigIntStats {
  try {
    return refreshOpenedDirectory(absolutePath, descriptor, expected);
  } catch (error) {
    throw new StagedDestinationAuthorityError(
      "Staged harness package directory authority changed during copy",
      error,
    );
  }
}

function writePrivateFile(absolutePath: string, contents: Buffer, executableMode: number): void {
  if (typeof fs.constants.O_NOFOLLOW !== "number") {
    throw new Error("Secure harness package copying requires O_NOFOLLOW");
  }
  const mode = 0o600 | executableMode;
  const descriptor = fs.openSync(
    absolutePath,
    fs.constants.O_WRONLY |
      fs.constants.O_CREAT |
      fs.constants.O_EXCL |
      fs.constants.O_NOFOLLOW |
      NONBLOCK,
    mode,
  );
  try {
    let offset = 0;
    while (offset < contents.length) {
      const written = fs.writeSync(descriptor, contents, offset, contents.length - offset, offset);
      if (written === 0) {
        throw new Error(
          `Short write while copying harness package file: ${diagnosticPath(absolutePath)}`,
        );
      }
      offset += written;
    }
    fs.fchmodSync(descriptor, mode);
    const stat = fs.fstatSync(descriptor, { bigint: true });
    if (!stat.isFile() || stat.nlink !== 1n || stat.size !== BigInt(contents.length)) {
      throw new Error(`Harness package staging file changed: ${diagnosticPath(absolutePath)}`);
    }
  } finally {
    fs.closeSync(descriptor);
  }

  const opened = openRegularFileNoFollow(absolutePath);
  try {
    const copied = opened.readBytes(contents.length);
    if (!copied.equals(contents)) {
      throw new Error(
        `Harness package staging file differs from its source: ${diagnosticPath(absolutePath)}`,
      );
    }
  } finally {
    opened.close();
  }
}

function assertMutableDirectory(absolutePath: string, currentUid: bigint | null): fs.BigIntStats {
  const stat = fs.lstatSync(absolutePath, { bigint: true });
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(
      `Harness package staging parent must be a regular directory: ${diagnosticPath(absolutePath)}`,
    );
  }
  assertEntryMode(stat, "directory", absolutePath);
  if (currentUid !== null && stat.uid !== currentUid) {
    throw new Error(
      `Harness package staging parent must be owned by the current user: ${diagnosticPath(absolutePath)}`,
    );
  }
  return stat;
}

function removeExactStage(
  stagingRoot: string,
  stagingStat: fs.BigIntStats | null,
  stagingParent: string,
  parentStat: fs.BigIntStats,
  stageWasCreated: boolean,
  currentUid: bigint | null,
): void {
  if (!stageWasCreated) return;
  if (!stagingRoot || path.dirname(stagingRoot) !== stagingParent) {
    throw new Error("Harness package stage path is outside its validated parent");
  }
  if (stagingStat === null) {
    throw new Error("Harness package stage identity is unavailable before cleanup");
  }
  const currentParent = fs.lstatSync(stagingParent, { bigint: true });
  if (!sameDirectoryIdentity(parentStat, currentParent)) {
    throw new Error("Harness package staging parent changed before cleanup");
  }
  const currentStage = fs.lstatSync(stagingRoot, { bigint: true });
  if (currentStage.isSymbolicLink() || !currentStage.isDirectory()) {
    throw new Error("Harness package stage has an unverified type before cleanup");
  }
  if (currentUid !== null && currentStage.uid !== currentUid) {
    throw new Error("Harness package stage has an unverified owner before cleanup");
  }
  if ((currentStage.mode & 0o7777n) !== 0o700n) {
    throw new Error("Harness package stage has an unverified mode before cleanup");
  }
  if (!sameDirectoryIdentity(stagingStat, currentStage)) {
    throw new Error("Harness package stage changed before cleanup");
  }
  // Node does not expose unlinkat. This final identity check limits cleanup
  // to the unique stage path, but it cannot make recursive removal atomic.
  fs.rmSync(stagingRoot, { recursive: true, force: false });
}

export function copyVerifiedPackageTree(
  validatedTree: ValidatedHarnessPackageTree,
  options: CopyHarnessPackageTreeOptions,
): CopiedHarnessPackageTree {
  const authority = getPackageTreeAuthority(validatedTree);
  assertTreeAuthority(authority);
  const sourceEntriesByPath = new Map(
    authority.entries.map((entry): [string, EntrySnapshot] => [entry.relativePath, entry]),
  );

  const stagingParent = path.resolve(options.stagingParent);
  const currentUid = currentEffectiveUid();
  if (authority.currentUid !== currentUid) {
    throw new Error("Effective user changed after harness package validation");
  }
  const parentAncestors = captureAncestors(stagingParent, currentUid);
  const parentStat = assertMutableDirectory(stagingParent, currentUid);
  const prefix = options.stagingPrefix ?? ".nemoclaw-package-";
  if (!/^[a-zA-Z0-9._-]{1,64}$/u.test(prefix) || prefix === "." || prefix === "..") {
    throw new Error("Harness package staging prefix is invalid");
  }
  const stagingPathPrefix = path.join(stagingParent, prefix);
  if (path.dirname(stagingPathPrefix) !== stagingParent || stagingPathPrefix === stagingParent) {
    throw new Error("Harness package staging prefix escapes its validated parent");
  }

  let stagingRoot = "";
  let stagingStat: fs.BigIntStats | null = null;
  let parentAfterCreate = parentStat;
  let stageWasCreated = false;
  let parentDescriptor: number | null = null;
  let stageDescriptor: number | null = null;
  let packageDescriptor: number | null = null;
  try {
    for (const ancestor of parentAncestors) assertSnapshot(ancestor);
    assertSnapshot({ absolutePath: stagingParent, stat: parentStat });
    const openedParent = openVerifiedDirectoryNoFollow(stagingParent, parentStat);
    parentDescriptor = openedParent.descriptor;
    stagingRoot = fs.mkdtempSync(stagingPathPrefix);
    stageWasCreated = true;
    stagingStat = fs.lstatSync(stagingRoot, { bigint: true });
    if (
      stagingStat.isSymbolicLink() ||
      !stagingStat.isDirectory() ||
      (currentUid !== null && stagingStat.uid !== currentUid)
    ) {
      throw new Error(
        `Harness package stage has invalid authority: ${diagnosticPath(stagingRoot)}`,
      );
    }
    const openedStage = openPrivateDirectory(stagingRoot, 0o700, stagingStat);
    stageDescriptor = openedStage.descriptor;
    stagingStat = openedStage.stat;
    parentAfterCreate = refreshOpenedDirectory(stagingParent, parentDescriptor, parentStat);

    const packageRoot = path.join(stagingRoot, "package");
    const openedPackage = createStagedDirectory(packageRoot, 0o700);
    packageDescriptor = openedPackage.descriptor;
    const packageStat = openedPackage.stat;
    const stagedDirectories = new Map<string, fs.BigIntStats>([["", packageStat]]);

    for (const entry of authority.entries) {
      assertSourcePathAuthority(authority, entry, sourceEntriesByPath);
      assertPrivateDirectory(stagingRoot, stagingStat);
      assertStagedDirectory(packageRoot, packageStat);
      const parentRelativePath = path.posix.dirname(entry.relativePath);
      const normalizedParent = parentRelativePath === "." ? "" : parentRelativePath;
      const parentDirectoryStat = stagedDirectories.get(normalizedParent);
      if (!parentDirectoryStat) {
        throw new Error("Validated harness package directory order is invalid");
      }
      const parentDirectory = normalizedParent
        ? path.join(packageRoot, ...normalizedParent.split("/"))
        : packageRoot;
      assertStagedDirectory(parentDirectory, parentDirectoryStat);
      const destination = path.join(packageRoot, ...entry.relativePath.split("/"));
      if (entry.type === "directory") {
        const directoryMode = 0o600 | Number(entry.stat.mode & 0o111n);
        const openedDirectory = createStagedDirectory(destination, directoryMode);
        stagedDirectories.set(entry.relativePath, openedDirectory.stat);
        fs.closeSync(openedDirectory.descriptor);
        continue;
      }
      const contents = readVerifiedFile(entry, authority.limits.maxFileBytes);
      try {
        writePrivateFile(destination, contents, Number(entry.stat.mode & 0o111n));
      } catch (error) {
        if (
          isAuthorityErrno(error) ||
          (error instanceof Error &&
            (error.message.includes("staging file") || error.message.includes("changed")))
        ) {
          throw new StagedDestinationAuthorityError(
            "Staged harness package file authority changed during copy",
            error,
          );
        }
        throw error;
      }
    }

    assertTreeAuthority(authority);
    assertPrivateDirectory(stagingRoot, stagingStat);
    assertStagedDirectory(packageRoot, packageStat);
    refreshOpenedDirectory(stagingRoot, stageDescriptor, stagingStat);
    refreshStagedDirectory(packageRoot, packageDescriptor, packageStat);
    for (const ancestor of parentAncestors) assertSnapshot(ancestor);
    assertOpenedDirectory(stagingParent, parentDescriptor, parentAfterCreate);

    let copiedTree: ValidatedHarnessPackageTree;
    try {
      copiedTree = validateHarnessPackageTree(packageRoot, {
        limits: authority.limits,
        sourceTrust: "mutable",
      });
    } catch (error) {
      throw new StagedDestinationAuthorityError(
        "Staged harness package tree failed post-copy authority validation",
        error,
      );
    }
    if (copiedTree.contentDigest !== validatedTree.contentDigest) {
      throw new StagedDestinationAuthorityError(
        "Copied harness package tree digest does not match its validated source",
        new Error("staged content digest mismatch"),
      );
    }
    fs.closeSync(packageDescriptor);
    packageDescriptor = null;
    fs.closeSync(stageDescriptor);
    stageDescriptor = null;
    fs.closeSync(parentDescriptor);
    parentDescriptor = null;
    let stageRemoved = false;
    return Object.freeze({
      stagingRoot,
      packageRoot,
      contentDigest: copiedTree.contentDigest,
      removeStagingRoot: () => {
        if (stageRemoved) return;
        removeExactStage(
          stagingRoot,
          stagingStat,
          stagingParent,
          parentAfterCreate,
          stageWasCreated,
          currentUid,
        );
        stageRemoved = true;
      },
    });
  } catch (error) {
    if (packageDescriptor !== null) fs.closeSync(packageDescriptor);
    if (stageDescriptor !== null) fs.closeSync(stageDescriptor);
    if (parentDescriptor !== null) fs.closeSync(parentDescriptor);
    if (error instanceof StagedDestinationAuthorityError) {
      throw new HarnessPackageStageCleanupError(
        error,
        new Error("NemoClaw preserved a stage with unverified descendant authority"),
      );
    }
    try {
      removeExactStage(
        stagingRoot,
        stagingStat,
        stagingParent,
        parentAfterCreate,
        stageWasCreated,
        currentUid,
      );
    } catch (cleanupError) {
      throw new HarnessPackageStageCleanupError(error, cleanupError);
    }
    throw error;
  }
}
