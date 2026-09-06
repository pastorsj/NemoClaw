#!/usr/bin/env -S node --experimental-strip-types --no-warnings
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import type { HarnessPackageEnvelope } from "./src/index.ts";
import {
  HarnessPackageConformanceError,
  type HarnessPackageConformanceReport,
  type HarnessPackagePublishedFile,
  validateHarnessPackage,
} from "./validate-package.mts";

const ARTIFACT_METADATA_FILE = "nemoclaw-package.json";
const MAX_FILE_BYTES = 256 * 1024 * 1024;

export type HarnessPackageBuildDiagnosticCode =
  | "output-exists"
  | "output-owner"
  | "output-path"
  | "source-changed"
  | "write-failed";

export interface HarnessPackageBuildDiagnostic {
  readonly code: HarnessPackageBuildDiagnosticCode;
  readonly path: string;
  readonly message: string;
}

export interface MaterializedHarnessPackage {
  readonly harnessId: string;
  readonly displayName: string;
  readonly packageVersion: string;
  readonly minimumNemoClawVersion: string;
  readonly maximumNemoClawVersionExclusive: string;
  readonly manifestPath: "manifest.yaml";
  readonly fileCount: number;
  readonly readOnly: true;
}

export class HarnessPackageBuildError extends Error {
  readonly diagnostic: HarnessPackageBuildDiagnostic;

  constructor(diagnostic: HarnessPackageBuildDiagnostic) {
    super(
      `Harness package build failed:\n- [${diagnostic.code}] ${diagnostic.path}: ${diagnostic.message}`,
    );
    this.name = "HarnessPackageBuildError";
    this.diagnostic = Object.freeze({ ...diagnostic });
  }
}

interface DirectoryIdentity {
  readonly device: bigint;
  readonly inode: bigint;
  readonly owner: bigint;
  readonly group: bigint;
}

function buildError(
  code: HarnessPackageBuildDiagnosticCode,
  relativePath: string,
  message: string,
): HarnessPackageBuildError {
  return new HarnessPackageBuildError(Object.freeze({ code, path: relativePath, message }));
}

function resolveBoundedPath(value: string, label: "package" | "output"): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 4096 ||
    value.includes("\0")
  ) {
    throw buildError("output-path", `<${label}>`, "must be one bounded filesystem path");
  }
  return path.resolve(value);
}

function hasPath(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function assertSeparateOutput(packageRoot: string, outputDirectory: string): void {
  if (hasPath(packageRoot, outputDirectory) || hasPath(outputDirectory, packageRoot)) {
    throw buildError(
      "output-path",
      "<output>",
      "must not contain or be contained by the source package",
    );
  }
}

function captureOutputParent(outputDirectory: string): {
  readonly path: string;
  readonly identity: DirectoryIdentity;
} {
  try {
    fs.lstatSync(outputDirectory);
    throw buildError("output-exists", "<output>", "must not already exist");
  } catch (error) {
    if (error instanceof HarnessPackageBuildError) throw error;
    if (!isErrno(error, "ENOENT")) {
      throw buildError("output-path", "<output>", "could not be inspected safely");
    }
  }

  const parent = path.dirname(outputDirectory);
  let stats: fs.BigIntStats;
  try {
    stats = fs.lstatSync(parent, { bigint: true });
  } catch {
    throw buildError("output-path", "<output-parent>", "must already exist");
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw buildError("output-path", "<output-parent>", "must be a regular directory");
  }
  const currentUser = typeof process.geteuid === "function" ? process.geteuid() : undefined;
  if (currentUser !== undefined && stats.uid !== BigInt(currentUser)) {
    throw buildError("output-owner", "<output-parent>", "must be owned by the current user");
  }
  return Object.freeze({
    path: parent,
    identity: Object.freeze({
      device: stats.dev,
      inode: stats.ino,
      owner: stats.uid,
      group: stats.gid,
    }),
  });
}

function isErrno(error: unknown, code: string): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === code
  );
}

function assertParentUnchanged(parent: {
  readonly path: string;
  readonly identity: DirectoryIdentity;
}): void {
  let stats: fs.BigIntStats;
  try {
    stats = fs.lstatSync(parent.path, { bigint: true });
  } catch {
    throw buildError("output-path", "<output-parent>", "changed during materialization");
  }
  if (
    stats.isSymbolicLink() ||
    !stats.isDirectory() ||
    stats.dev !== parent.identity.device ||
    stats.ino !== parent.identity.inode ||
    stats.uid !== parent.identity.owner ||
    stats.gid !== parent.identity.group
  ) {
    throw buildError("output-path", "<output-parent>", "changed during materialization");
  }
}

function assertOutputUnchanged(outputRoot: string, identity: DirectoryIdentity): void {
  let stats: fs.BigIntStats;
  try {
    stats = fs.lstatSync(outputRoot, { bigint: true });
  } catch {
    throw buildError("write-failed", "<output>", "changed during materialization");
  }
  if (
    stats.isSymbolicLink() ||
    !stats.isDirectory() ||
    stats.dev !== identity.device ||
    stats.ino !== identity.inode ||
    stats.uid !== identity.owner ||
    stats.gid !== identity.group
  ) {
    throw buildError("write-failed", "<output>", "changed during materialization");
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

function assertSourceParents(packageRoot: string, relativePath: string): void {
  let cursor = packageRoot;
  for (const segment of relativePath.split("/").slice(0, -1)) {
    cursor = path.join(cursor, segment);
    let stats: fs.Stats;
    try {
      stats = fs.lstatSync(cursor);
    } catch {
      throw buildError("source-changed", relativePath, "parent path changed after validation");
    }
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw buildError("source-changed", relativePath, "parent path changed after validation");
    }
  }
}

function readStableFile(packageRoot: string, publishedFile: HarnessPackagePublishedFile): Buffer {
  assertSourceParents(packageRoot, publishedFile.path);
  const sourcePath = path.join(packageRoot, ...publishedFile.path.split("/"));
  let before: fs.BigIntStats;
  try {
    before = fs.lstatSync(sourcePath, { bigint: true });
  } catch {
    throw buildError("source-changed", publishedFile.path, "was removed after validation");
  }
  if (before.isSymbolicLink() || !before.isFile()) {
    throw buildError("source-changed", publishedFile.path, "is no longer a regular file");
  }
  if (
    before.size !== BigInt(publishedFile.size) ||
    (Number(before.mode & 0o111n) !== 0) !== publishedFile.executable ||
    before.size > BigInt(MAX_FILE_BYTES)
  ) {
    throw buildError("source-changed", publishedFile.path, "metadata changed after validation");
  }
  if (typeof fs.constants.O_NOFOLLOW !== "number") {
    throw buildError("write-failed", "<platform>", "requires no-follow file reads");
  }
  let descriptor: number;
  try {
    descriptor = fs.openSync(sourcePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch {
    throw buildError("source-changed", publishedFile.path, "could not be opened safely");
  }
  try {
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (!sameFileSnapshot(before, opened)) {
      throw buildError("source-changed", publishedFile.path, "changed before it was read");
    }
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor, { bigint: true });
    let current: fs.BigIntStats;
    try {
      current = fs.lstatSync(sourcePath, { bigint: true });
    } catch {
      throw buildError("source-changed", publishedFile.path, "changed while it was read");
    }
    if (!sameFileSnapshot(opened, after) || !sameFileSnapshot(after, current)) {
      throw buildError("source-changed", publishedFile.path, "changed while it was read");
    }
    if (createHash("sha256").update(bytes).digest("hex") !== publishedFile.sha256) {
      throw buildError("source-changed", publishedFile.path, "bytes changed after validation");
    }
    return bytes;
  } finally {
    fs.closeSync(descriptor);
  }
}

function destinationKey(relativePath: string): string {
  return relativePath.normalize("NFKC").toLowerCase();
}

function assertDistinctDestinations(publishedFiles: readonly HarnessPackagePublishedFile[]): void {
  const keys = [
    ...publishedFiles.map((file) => destinationKey(file.path)),
    ARTIFACT_METADATA_FILE,
  ].sort((left, right) => left.localeCompare(right));
  for (const [index, key] of keys.entries()) {
    const next = keys[index + 1];
    if (next !== undefined && (key === next || next.startsWith(`${key}/`))) {
      throw buildError(
        "write-failed",
        "<artifact>",
        "published paths collide on a portable filesystem",
      );
    }
  }
}

function ensureOutputDirectory(directory: string, outputRoot: string): void {
  if (directory === outputRoot) return;
  const relative = path.relative(outputRoot, directory);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw buildError("write-failed", "<artifact>", "destination escaped the output directory");
  }
  let cursor = outputRoot;
  for (const segment of relative.split(path.sep)) {
    cursor = path.join(cursor, segment);
    try {
      fs.mkdirSync(cursor, { mode: 0o700 });
      fs.chmodSync(cursor, 0o700);
    } catch (error) {
      if (!isErrno(error, "EEXIST")) throw error;
      const stats = fs.lstatSync(cursor);
      if (stats.isSymbolicLink() || !stats.isDirectory()) throw error;
    }
  }
}

function writeArtifactFile(
  outputRoot: string,
  relativePath: string,
  bytes: Buffer | string,
  executable: boolean,
): void {
  const destination = path.join(outputRoot, ...relativePath.split("/"));
  ensureOutputDirectory(path.dirname(destination), outputRoot);
  fs.writeFileSync(destination, bytes, { flag: "wx", mode: 0o600 });
  fs.chmodSync(destination, executable ? 0o755 : 0o644);
}

function buildEnvelope(report: HarnessPackageConformanceReport): HarnessPackageEnvelope {
  return Object.freeze({
    schemaVersion: 1,
    kind: "agent-runtime",
    id: report.harnessId,
    displayName: report.displayName,
    packageVersion: report.packageVersion,
    minimumNemoClawVersion: report.minimumNemoClawVersion,
    maximumNemoClawVersionExclusive: report.maximumNemoClawVersionExclusive,
    manifest: "manifest.yaml",
  });
}

function makeTreeReadOnly(outputRoot: string): void {
  const directories = [outputRoot];
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw buildError("write-failed", "<artifact>", "output contains a symbolic link");
      }
      if (entry.isDirectory()) {
        directories.push(target);
        visit(target);
      } else if (entry.isFile()) {
        const executable = (fs.lstatSync(target).mode & 0o111) !== 0;
        fs.chmodSync(target, executable ? 0o555 : 0o444);
      } else {
        throw buildError("write-failed", "<artifact>", "output contains a special file");
      }
    }
  };
  visit(outputRoot);
  directories.reverse().forEach((directory) => fs.chmodSync(directory, 0o555));
}

function makeTreeWritable(outputRoot: string): void {
  let stats: fs.Stats;
  try {
    stats = fs.lstatSync(outputRoot);
  } catch {
    return;
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) return;
  fs.chmodSync(outputRoot, 0o700);
  for (const entry of fs.readdirSync(outputRoot, { withFileTypes: true })) {
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      makeTreeWritable(path.join(outputRoot, entry.name));
    }
  }
}

function removePartialOutput(outputRoot: string, identity: DirectoryIdentity): void {
  try {
    const stats = fs.lstatSync(outputRoot, { bigint: true });
    if (
      stats.isSymbolicLink() ||
      !stats.isDirectory() ||
      stats.dev !== identity.device ||
      stats.ino !== identity.inode ||
      stats.uid !== identity.owner ||
      stats.gid !== identity.group
    ) {
      return;
    }
    makeTreeWritable(outputRoot);
    fs.rmSync(outputRoot, { recursive: true });
  } catch {
    // Preserve the original bounded failure. A partial caller-owned tree can be removed manually.
  }
}

/** Materialize one validated npm publish set as a read-only NemoClaw package artifact. */
export function materializeHarnessPackageArtifact(
  packageRootInput: string,
  outputDirectoryInput: string,
): MaterializedHarnessPackage {
  const packageRoot = resolveBoundedPath(packageRootInput, "package");
  const outputDirectory = resolveBoundedPath(outputDirectoryInput, "output");
  assertSeparateOutput(packageRoot, outputDirectory);
  const outputParent = captureOutputParent(outputDirectory);
  const report = validateHarnessPackage(packageRoot);
  assertDistinctDestinations(report.publishedFiles);

  try {
    fs.mkdirSync(outputDirectory, { mode: 0o700 });
    fs.chmodSync(outputDirectory, 0o700);
  } catch (error) {
    if (isErrno(error, "EEXIST")) {
      throw buildError("output-exists", "<output>", "must not already exist");
    }
    throw buildError("output-path", "<output>", "could not be created as a new directory");
  }
  const created = fs.lstatSync(outputDirectory, { bigint: true });
  const outputIdentity = Object.freeze({
    device: created.dev,
    inode: created.ino,
    owner: created.uid,
    group: created.gid,
  });

  try {
    if (created.isSymbolicLink() || !created.isDirectory()) {
      throw buildError("write-failed", "<output>", "did not remain a regular directory");
    }
    const currentUser = typeof process.geteuid === "function" ? process.geteuid() : undefined;
    if (currentUser !== undefined && created.uid !== BigInt(currentUser)) {
      throw buildError("output-owner", "<output>", "must be owned by the current user");
    }
    assertParentUnchanged(outputParent);
    for (const publishedFile of report.publishedFiles) {
      const bytes = readStableFile(packageRoot, publishedFile);
      writeArtifactFile(outputDirectory, publishedFile.path, bytes, publishedFile.executable);
    }
    writeArtifactFile(
      outputDirectory,
      ARTIFACT_METADATA_FILE,
      `${JSON.stringify(buildEnvelope(report), null, 2)}\n`,
      false,
    );
    assertOutputUnchanged(outputDirectory, outputIdentity);
    assertParentUnchanged(outputParent);
    makeTreeReadOnly(outputDirectory);
    assertOutputUnchanged(outputDirectory, outputIdentity);
    return Object.freeze({
      harnessId: report.harnessId,
      displayName: report.displayName,
      packageVersion: report.packageVersion,
      minimumNemoClawVersion: report.minimumNemoClawVersion,
      maximumNemoClawVersionExclusive: report.maximumNemoClawVersionExclusive,
      manifestPath: "manifest.yaml",
      fileCount: report.publishedFiles.length + 1,
      readOnly: true,
    });
  } catch (error) {
    removePartialOutput(outputDirectory, outputIdentity);
    if (
      error instanceof HarnessPackageBuildError ||
      error instanceof HarnessPackageConformanceError
    ) {
      throw error;
    }
    throw buildError("write-failed", "<artifact>", "could not materialize the validated package");
  }
}

function isMainModule(): boolean {
  const invokedPath = process.argv[1];
  if (!invokedPath) return false;
  try {
    return fs.realpathSync(invokedPath) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

function main(): void {
  const arguments_ = process.argv.slice(2);
  const json = arguments_.includes("--json");
  const positional = arguments_.filter((argument) => argument !== "--json");
  if (
    positional.length !== 2 ||
    arguments_.filter((argument) => argument === "--json").length > 1 ||
    arguments_.some((argument) => argument.startsWith("-") && argument !== "--json")
  ) {
    process.stderr.write(
      "Usage: nemoclaw-build-package [--json] <package-root> <output-directory>\n",
    );
    process.exitCode = 2;
    return;
  }
  try {
    const result = materializeHarnessPackageArtifact(positional[0], positional[1]);
    process.stdout.write(
      json
        ? `${JSON.stringify(result)}\n`
        : `Built harness package ${JSON.stringify(result.harnessId)} (${String(result.fileCount)} files).\n`,
    );
  } catch (error) {
    const message =
      error instanceof HarnessPackageBuildError || error instanceof HarnessPackageConformanceError
        ? error.message
        : "Harness package build failed unexpectedly.";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}

if (isMainModule()) main();
