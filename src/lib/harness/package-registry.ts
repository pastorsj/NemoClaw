// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { openRegularFileNoFollow } from "../adapters/fs/regular-file";
import { parseManifestRecord, readString } from "../agent/manifest-readers";
import { isInsideIgnoredCustomBuildContextPath } from "../onboard/custom-build-context";

const PACKAGE_DIRECTORY_PREFIX = "nemoclaw-";
const INSTALL_RECEIPT_FILENAME = ".nemoclaw-install.json";
const INSTALL_RECEIPT_MAX_BYTES = 4 * 1024;
const PACKAGE_JSON_MAX_BYTES = 64 * 1024;
const MANIFEST_MAX_BYTES = 256 * 1024;
const PACKAGE_FILE_MAX_BYTES = 64 * 1024 * 1024;
const PACKAGE_TREE_MAX_BYTES = 256 * 1024 * 1024;
const PACKAGE_TREE_MAX_ENTRIES = 4096;
const PACKAGE_TREE_MAX_DEPTH = 32;
const REQUIRED_HARNESS_FILES = [
  "Dockerfile",
  "Dockerfile.base",
  "start.sh",
  "policy-additions.yaml",
] as const;
const HARNESS_ID = /^[a-z][a-z0-9-]{0,62}$/u;
const SHA256_DIGEST = /^[a-f0-9]{64}$/u;
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u;
const PACKAGE_VERSION =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?(?:\+[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/u;

const ROOT = path.resolve(__dirname, "..", "..", "..");
const BUNDLED_PACKAGES_ROOT = path.join(ROOT, "packages");

export interface HarnessPackage {
  readonly id: string;
  readonly packageName: string;
  readonly version: string;
  readonly rootDir: string;
  readonly manifestPath: string;
  readonly source: "bundled" | "installed";
}

export interface HarnessPackageSnapshot {
  readonly contentDigest: string;
  readonly manifestSource: string;
}

export interface HarnessPackageTextSnapshot {
  readonly contentDigest: string;
  readonly source: string | null;
}

export interface HarnessPackageTextsSnapshot {
  readonly contentDigest: string;
  readonly sources: ReadonlyMap<string, string | null>;
}

type PackageTextDirectoryCapture = {
  readonly prefix: string;
  readonly suffix: string;
  readonly maxBytes: number;
};

export class HarnessPackageReceiptMismatchError extends Error {}

type JsonRecord = Record<string, unknown>;

interface ExistingHarnessPackage {
  readonly id: string;
  readonly rootDir: string;
  readonly harnessPackage: HarnessPackage | null;
  readonly contentDigest: string;
  readonly installedDigest: string | null;
}

interface InstallDirectoryAuthority {
  readonly path: string;
  readonly device: bigint;
  readonly inode: bigint;
}

interface InstallPathAuthority {
  readonly stateRoot: InstallDirectoryAuthority;
  readonly harnessRoot: InstallDirectoryAuthority;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function installedPackagesRoot(env: NodeJS.ProcessEnv): string {
  const home = env.HOME?.trim() || os.homedir();
  return path.join(home, ".nemoclaw", "harnesses");
}

function packageNameBase(packageName: string): string {
  return packageName.slice(packageName.lastIndexOf("/") + 1);
}

function readBoundedRegularFile(filePath: string, label: string, maxBytes: number): string {
  let opened: ReturnType<typeof openRegularFileNoFollow>;
  try {
    opened = openRegularFileNoFollow(filePath);
  } catch (error) {
    throw new Error(`${label} is unavailable: ${filePath}`, { cause: error });
  }
  try {
    let bytes: Buffer;
    try {
      bytes = opened.readBytes(maxBytes);
    } catch (error) {
      if (error instanceof RangeError) {
        throw new Error(`${label} has an invalid size: ${filePath}`, { cause: error });
      }
      throw error;
    }
    if (bytes.length < 2) {
      throw new Error(`${label} has an invalid size: ${filePath}`);
    }
    return bytes.toString("utf8");
  } finally {
    opened.close();
  }
}

function readPackageMetadata(packageJsonPath: string): JsonRecord {
  let value: unknown;
  try {
    value = JSON.parse(
      readBoundedRegularFile(packageJsonPath, "Harness package metadata", PACKAGE_JSON_MAX_BYTES),
    );
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Harness package metadata is not valid JSON: ${packageJsonPath}`, {
        cause: error,
      });
    }
    throw error;
  }
  if (!isRecord(value)) {
    throw new Error(`Harness package metadata must be a JSON object: ${packageJsonPath}`);
  }
  return value;
}

function installReceiptPath(rootDir: string): string {
  return path.join(rootDir, INSTALL_RECEIPT_FILENAME);
}

function readInstallReceipt(rootDir: string): string | null {
  const receiptPath = installReceiptPath(rootDir);
  try {
    fs.lstatSync(receiptPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }

  let value: unknown;
  try {
    value = JSON.parse(
      readBoundedRegularFile(
        receiptPath,
        "Harness installation receipt",
        INSTALL_RECEIPT_MAX_BYTES,
      ),
    );
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Harness installation receipt is not valid JSON: ${receiptPath}`, {
        cause: error,
      });
    }
    throw error;
  }
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 1 ||
    typeof value.installedDigest !== "string" ||
    !SHA256_DIGEST.test(value.installedDigest)
  ) {
    throw new Error(`Harness installation receipt is invalid: ${receiptPath}`);
  }
  return value.installedDigest;
}

function writeInstallReceipt(rootDir: string, digest: string): void {
  const receiptPath = installReceiptPath(rootDir);
  const temporaryPath = path.join(
    rootDir,
    `.nemoclaw-install-${process.pid}-${crypto.randomUUID()}.tmp`,
  );
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify({ installedDigest: digest })}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    fs.renameSync(temporaryPath, receiptPath);
  } finally {
    fs.rmSync(temporaryPath, { force: true });
  }
}

function assertPackageRoot(rootDir: string): void {
  let metadata: fs.Stats;
  try {
    metadata = fs.lstatSync(rootDir);
  } catch (error) {
    throw new Error(`Harness package directory is unavailable: ${rootDir}`, { cause: error });
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`Harness package must be a regular directory, not a symlink: ${rootDir}`);
  }
}

function assertRequiredHarnessFiles(rootDir: string): void {
  for (const fileName of REQUIRED_HARNESS_FILES) {
    const filePath = path.join(rootDir, fileName);
    let metadata: fs.Stats;
    try {
      metadata = fs.lstatSync(filePath);
    } catch (error) {
      throw new Error(`Harness package is missing required file '${fileName}': ${rootDir}`, {
        cause: error,
      });
    }
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new Error(`Harness package file '${fileName}' must be a regular file: ${filePath}`);
    }
    if (metadata.size === 0) {
      throw new Error(`Harness package file '${fileName}' must not be empty: ${filePath}`);
    }
    if (fileName === "start.sh" && (metadata.mode & 0o111) === 0) {
      throw new Error(`Harness package start.sh must be executable: ${filePath}`);
    }
  }
}

function readHarnessPackageMetadata(
  rootDir: string,
  source: HarnessPackage["source"],
): HarnessPackage {
  assertPackageRoot(rootDir);
  const directoryName = path.basename(rootDir);
  if (!directoryName.startsWith(PACKAGE_DIRECTORY_PREFIX)) {
    throw new Error(`Harness package directory must start with '${PACKAGE_DIRECTORY_PREFIX}'`);
  }

  const packageJsonPath = path.join(rootDir, "package.json");
  const metadata = readPackageMetadata(packageJsonPath);
  const packageName = metadata.name;
  const version = metadata.version;
  const nemoclaw = metadata.nemoclaw;
  if (typeof packageName !== "string" || !PACKAGE_NAME.test(packageName)) {
    throw new Error(`Harness package has an invalid package name: ${packageJsonPath}`);
  }
  if (typeof version !== "string" || !PACKAGE_VERSION.test(version)) {
    throw new Error(`Harness package has an invalid version: ${packageJsonPath}`);
  }
  if (!isRecord(nemoclaw)) {
    throw new Error(`Harness package must declare nemoclaw.harnessManifest: ${packageJsonPath}`);
  }
  const nemoclawKeys = Object.keys(nemoclaw);
  if (nemoclawKeys.length !== 1 || nemoclawKeys[0] !== "harnessManifest") {
    throw new Error(
      `Harness package nemoclaw metadata may declare only harnessManifest: ${packageJsonPath}`,
    );
  }
  const harnessManifest = nemoclaw.harnessManifest;
  if (harnessManifest !== "manifest.yaml") {
    throw new Error(
      `Harness package nemoclaw.harnessManifest must be 'manifest.yaml': ${packageJsonPath}`,
    );
  }

  const manifestPath = path.join(rootDir, ...harnessManifest.split("/"));
  const relativeManifest = path.relative(rootDir, manifestPath);
  if (
    relativeManifest === "" ||
    relativeManifest.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeManifest)
  ) {
    throw new Error(`Harness manifest escapes its package directory: ${manifestPath}`);
  }
  const manifest = parseManifestRecord(
    readBoundedRegularFile(manifestPath, "Harness manifest", MANIFEST_MAX_BYTES),
    manifestPath,
  );
  const id = readString(manifest, "name")?.trim();
  if (!id || !HARNESS_ID.test(id)) {
    throw new Error(`Harness manifest has an invalid name: ${manifestPath}`);
  }

  const expectedDirectoryName = `${PACKAGE_DIRECTORY_PREFIX}${id}`;
  if (
    directoryName !== expectedDirectoryName ||
    packageNameBase(packageName) !== expectedDirectoryName
  ) {
    throw new Error(
      `Harness package identity mismatch: directory, package name, and manifest must identify '${id}'`,
    );
  }
  return Object.freeze({
    id,
    packageName,
    version,
    rootDir,
    manifestPath,
    source,
  });
}

function readHarnessPackage(rootDir: string, source: HarnessPackage["source"]): HarnessPackage {
  const harnessPackage = readHarnessPackageMetadata(rootDir, source);
  assertRequiredHarnessFiles(rootDir);
  return harnessPackage;
}

function scanPackageRoot(packagesRoot: string, source: HarnessPackage["source"]): HarnessPackage[] {
  let rootMetadata: fs.Stats;
  try {
    rootMetadata = fs.lstatSync(packagesRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new Error(`Harness package root is unavailable: ${packagesRoot}`, { cause: error });
  }
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
    throw new Error(`Harness package root must be a regular directory: ${packagesRoot}`);
  }

  const packages: HarnessPackage[] = [];
  for (const entry of fs
    .readdirSync(packagesRoot, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.name.startsWith(PACKAGE_DIRECTORY_PREFIX)) continue;
    const rootDir = path.join(packagesRoot, entry.name);
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new Error(`Harness package must be a regular directory, not a symlink: ${rootDir}`);
    }
    const harnessPackage = readHarnessPackage(rootDir, source);
    if (source === "installed") {
      assertInstalledPackageOwnership(rootDir);
      assertInstallReceiptMatches(rootDir, packageTreeDigest(rootDir));
    }
    packages.push(harnessPackage);
  }
  return packages;
}

function ignoredTreeEntry(name: string): boolean {
  return (
    name === ".git" || name === ".DS_Store" || name === "node_modules" || name === "__pycache__"
  );
}

export function isIgnoredHarnessPackageEntry(name: string): boolean {
  return name === INSTALL_RECEIPT_FILENAME || ignoredTreeEntry(name);
}

function visitPackageTree(
  rootDir: string,
  visitor: (relativePath: string, metadata: fs.BigIntStats) => void,
): void {
  let entryCount = 0;
  let totalBytes = 0n;
  const assertUnchanged = (
    absolutePath: string,
    before: fs.BigIntStats,
    expectedType: "directory" | "file",
  ): void => {
    const after = fs.lstatSync(absolutePath, { bigint: true });
    const typeMatches = expectedType === "directory" ? after.isDirectory() : after.isFile();
    if (
      after.isSymbolicLink() ||
      !typeMatches ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.mode !== after.mode ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs
    ) {
      throw new Error(`Harness package tree changed while it was read: ${absolutePath}`);
    }
  };
  const walk = (directory: string, prefix: string, depth: number): void => {
    if (depth > PACKAGE_TREE_MAX_DEPTH) {
      throw new Error(`Harness package exceeds the maximum directory depth: ${rootDir}`);
    }
    const directoryBefore = fs.lstatSync(directory, { bigint: true });
    if (directoryBefore.isSymbolicLink() || !directoryBefore.isDirectory()) {
      throw new Error(`Harness packages may contain only regular directories: ${directory}`);
    }
    for (const entry of fs
      .readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      if (ignoredTreeEntry(entry.name)) continue;
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolutePath = path.join(directory, entry.name);
      const metadata = fs.lstatSync(absolutePath, { bigint: true });
      entryCount += 1;
      if (entryCount > PACKAGE_TREE_MAX_ENTRIES) {
        throw new Error(`Harness package exceeds the maximum entry count: ${rootDir}`);
      }
      if (metadata.isSymbolicLink()) {
        throw new Error(`Harness packages may not contain symbolic links: ${absolutePath}`);
      }
      if (!metadata.isDirectory() && !metadata.isFile()) {
        throw new Error(
          `Harness packages may contain only directories and regular files: ${absolutePath}`,
        );
      }
      if (isInsideIgnoredCustomBuildContextPath(relativePath)) {
        throw new Error(`Harness package contains a forbidden build-context path: ${absolutePath}`);
      }
      if (metadata.isFile()) {
        if (metadata.size > BigInt(PACKAGE_FILE_MAX_BYTES)) {
          throw new Error(`Harness package file exceeds the size limit: ${absolutePath}`);
        }
        totalBytes += metadata.size;
        if (totalBytes > BigInt(PACKAGE_TREE_MAX_BYTES)) {
          throw new Error(`Harness package exceeds the total size limit: ${rootDir}`);
        }
      }
      visitor(relativePath, metadata);
      if (metadata.isDirectory()) {
        walk(absolutePath, relativePath, depth + 1);
        assertUnchanged(absolutePath, metadata, "directory");
      } else {
        assertUnchanged(absolutePath, metadata, "file");
      }
    }
    assertUnchanged(directory, directoryBefore, "directory");
  };
  walk(rootDir, "", 0);
}

function assertInstalledPackageOwnership(rootDir: string): void {
  if (typeof process.geteuid !== "function") return;
  const expectedUid = BigInt(process.geteuid());
  const assertOwned = (candidate: string, metadata: fs.BigIntStats): void => {
    if (metadata.uid !== expectedUid || (metadata.mode & 0o022n) !== 0n) {
      throw new Error(
        `Installed harness paths must be owned by the current user and not group or world writable: ${candidate}`,
      );
    }
  };
  assertOwned(rootDir, fs.lstatSync(rootDir, { bigint: true }));
  visitPackageTree(rootDir, (relativePath, metadata) => {
    assertOwned(path.join(rootDir, ...relativePath.split("/")), metadata);
  });
}

function packageTreeSnapshot(
  rootDir: string,
  captureFiles: ReadonlyMap<string, number> = new Map(),
  captureDirectory: PackageTextDirectoryCapture | null = null,
): { contentDigest: string; capturedFiles: ReadonlyMap<string, Buffer> } {
  const hash = crypto.createHash("sha256");
  const capturedFiles = new Map<string, Buffer>();
  visitPackageTree(rootDir, (relativePath, metadata) => {
    if (relativePath === INSTALL_RECEIPT_FILENAME) {
      if (!metadata.isFile()) {
        throw new Error(
          `Harness installation receipt must be a regular file: ${path.join(rootDir, relativePath)}`,
        );
      }
      return;
    }
    const executable = (metadata.mode & 0o111n) === 0n ? "0" : "1";
    if (metadata.isDirectory()) {
      hash.update(`d\0${relativePath}\0${executable}\0`);
      return;
    }
    const filePath = path.join(rootDir, ...relativePath.split("/"));
    const opened = openRegularFileNoFollow(filePath);
    try {
      const fileSize = Number(metadata.size);
      hash.update(`f\0${relativePath}\0${executable}\0${String(fileSize)}\0`);
      const directChild = captureDirectory
        ? relativePath.startsWith(captureDirectory.prefix) &&
          !relativePath.slice(captureDirectory.prefix.length).includes("/") &&
          relativePath.endsWith(captureDirectory.suffix)
        : false;
      const captureMaxBytes =
        captureFiles.get(relativePath) ?? (directChild ? captureDirectory?.maxBytes : undefined);
      if (captureMaxBytes !== undefined) {
        const capturedFile = opened.readBytes(captureMaxBytes);
        capturedFiles.set(relativePath, capturedFile);
        hash.update(capturedFile);
      } else {
        opened.readChunks(PACKAGE_FILE_MAX_BYTES, (chunk) => hash.update(chunk));
      }
      hash.update("\0");
    } finally {
      opened.close();
    }
  });
  return { contentDigest: hash.digest("hex"), capturedFiles };
}

function packageTreeDigest(rootDir: string): string {
  return packageTreeSnapshot(rootDir).contentDigest;
}

export function harnessPackageContentDigest(rootDir: string): string {
  return packageTreeDigest(rootDir);
}

export function bundledHarnessPackageContentDigest(id: string): string | null {
  const harnessPackage = scanPackageRoot(BUNDLED_PACKAGES_ROOT, "bundled").find(
    (candidate) => candidate.id === id,
  );
  return harnessPackage ? packageTreeDigest(harnessPackage.rootDir) : null;
}

function assertInstallReceiptMatches(rootDir: string, contentDigest: string): string {
  const installedDigest = readInstallReceipt(rootDir);
  if (!installedDigest) {
    throw new Error(`Harness installation receipt is missing: ${installReceiptPath(rootDir)}`);
  }
  if (contentDigest !== installedDigest) {
    throw new HarnessPackageReceiptMismatchError(
      `Harness installation receipt does not match package content: ${rootDir}`,
    );
  }
  return contentDigest;
}

/** Verify a complete installed package and return the digest bound by its receipt. */
export function verifyHarnessPackageInstallReceipt(rootDir: string): string {
  readHarnessPackage(rootDir, "installed");
  assertInstalledPackageOwnership(rootDir);
  return assertInstallReceiptMatches(rootDir, packageTreeDigest(rootDir));
}

/** Capture the manifest bytes from the same bounded traversal that hashes the package. */
export function captureHarnessPackageSnapshot(
  harnessPackage: HarnessPackage,
): HarnessPackageSnapshot {
  const relativeManifest = path
    .relative(harnessPackage.rootDir, harnessPackage.manifestPath)
    .split(path.sep)
    .join("/");
  if (relativeManifest !== "manifest.yaml") {
    throw new Error(`Harness manifest must be at the package root: ${harnessPackage.manifestPath}`);
  }
  if (harnessPackage.source === "installed") {
    assertInstalledPackageOwnership(harnessPackage.rootDir);
  }
  const snapshot = packageTreeSnapshot(
    harnessPackage.rootDir,
    new Map([[relativeManifest, MANIFEST_MAX_BYTES]]),
  );
  const manifestBytes = snapshot.capturedFiles.get(relativeManifest);
  if (!manifestBytes) {
    throw new Error(`Harness manifest is unavailable: ${harnessPackage.manifestPath}`);
  }
  if (harnessPackage.source === "installed") {
    assertInstallReceiptMatches(harnessPackage.rootDir, snapshot.contentDigest);
  }
  return Object.freeze({
    contentDigest: snapshot.contentDigest,
    manifestSource: manifestBytes.toString("utf8"),
  });
}

function assertHarnessPackageRelativeTextPath(relativePath: string, maxBytes: number): void {
  if (
    !relativePath ||
    relativePath.includes("\\") ||
    relativePath.split("/").some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error(`Harness package file path must be normalized and relative: ${relativePath}`);
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > PACKAGE_FILE_MAX_BYTES) {
    throw new RangeError(`Harness package file read limit is invalid: ${maxBytes}`);
  }
}

/** Read text files from the same bounded traversal that verifies the package receipt. */
export function captureHarnessPackageTexts(
  harnessPackage: HarnessPackage,
  files: readonly { relativePath: string; maxBytes: number }[],
): HarnessPackageTextsSnapshot {
  const captureFiles = new Map<string, number>();
  for (const file of files) {
    assertHarnessPackageRelativeTextPath(file.relativePath, file.maxBytes);
    if (captureFiles.has(file.relativePath)) {
      throw new Error(`Harness package file path is duplicated: ${file.relativePath}`);
    }
    captureFiles.set(file.relativePath, file.maxBytes);
  }
  if (harnessPackage.source === "installed") {
    assertInstalledPackageOwnership(harnessPackage.rootDir);
  }
  const snapshot = packageTreeSnapshot(harnessPackage.rootDir, captureFiles);
  if (harnessPackage.source === "installed") {
    assertInstallReceiptMatches(harnessPackage.rootDir, snapshot.contentDigest);
  }
  return Object.freeze({
    contentDigest: snapshot.contentDigest,
    sources: new Map(
      [...captureFiles.keys()].map((relativePath) => [
        relativePath,
        snapshot.capturedFiles.get(relativePath)?.toString("utf8") ?? null,
      ]),
    ),
  });
}

/** Read one text file from the same bounded traversal that verifies the package receipt. */
export function captureHarnessPackageText(
  harnessPackage: HarnessPackage,
  relativePath: string,
  maxBytes: number,
): HarnessPackageTextSnapshot {
  const snapshot = captureHarnessPackageTexts(harnessPackage, [{ relativePath, maxBytes }]);
  return Object.freeze({
    contentDigest: snapshot.contentDigest,
    source: snapshot.sources.get(relativePath) ?? null,
  });
}

/** Read every matching direct child of a package directory during receipt verification. */
export function captureHarnessPackageTextDirectory(
  harnessPackage: HarnessPackage,
  relativeDirectory: string,
  suffix: string,
  maxBytes: number,
): HarnessPackageTextsSnapshot {
  assertHarnessPackageRelativeTextPath(`${relativeDirectory}/fixture${suffix}`, maxBytes);
  if (!suffix.startsWith(".") || suffix.includes("/")) {
    throw new Error(`Harness package text suffix is invalid: ${suffix}`);
  }
  if (harnessPackage.source === "installed") {
    assertInstalledPackageOwnership(harnessPackage.rootDir);
  }
  const prefix = `${relativeDirectory}/`;
  const snapshot = packageTreeSnapshot(harnessPackage.rootDir, new Map(), {
    prefix,
    suffix,
    maxBytes,
  });
  if (harnessPackage.source === "installed") {
    assertInstallReceiptMatches(harnessPackage.rootDir, snapshot.contentDigest);
  }
  return Object.freeze({
    contentDigest: snapshot.contentDigest,
    sources: new Map(
      [...snapshot.capturedFiles.entries()].map(([relativePath, bytes]) => [
        relativePath,
        bytes.toString("utf8"),
      ]),
    ),
  });
}

/** Supply a private temporary file containing receipt-verified package text. */
export function withCapturedHarnessPackageTextFile<T>(
  harnessPackage: HarnessPackage,
  relativePath: string,
  maxBytes: number,
  consume: (filePath: string) => T,
): T {
  const snapshot = captureHarnessPackageText(harnessPackage, relativePath, maxBytes);
  if (snapshot.source === null) {
    throw new Error(`Harness package file is unavailable: ${relativePath}`);
  }
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-harness-file-"));
  const temporaryFile = path.join(temporaryDirectory, path.basename(relativePath));
  try {
    fs.chmodSync(temporaryDirectory, 0o700);
    fs.writeFileSync(temporaryFile, snapshot.source, { encoding: "utf8", flag: "wx", mode: 0o400 });
    return consume(temporaryFile);
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function indexById(
  packages: readonly HarnessPackage[],
  source: string,
): Map<string, HarnessPackage> {
  const result = new Map<string, HarnessPackage>();
  for (const harnessPackage of packages) {
    if (result.has(harnessPackage.id)) {
      throw new Error(`Duplicate harness id '${harnessPackage.id}' in ${source} packages`);
    }
    result.set(harnessPackage.id, harnessPackage);
  }
  return result;
}

export function listHarnessPackages(env: NodeJS.ProcessEnv = process.env): HarnessPackage[] {
  const bundled = indexById(scanPackageRoot(BUNDLED_PACKAGES_ROOT, "bundled"), "bundled");
  const installed = indexById(
    scanPackageRoot(installedPackagesRoot(env), "installed"),
    "installed",
  );

  for (const id of installed.keys()) {
    bundled.delete(id);
  }

  return [...bundled.values(), ...installed.values()].sort((left, right) =>
    left.id.localeCompare(right.id),
  );
}

export function resolveHarnessPackage(
  id: string,
  env: NodeJS.ProcessEnv = process.env,
): HarnessPackage | null {
  const normalized = id.trim();
  if (!HARNESS_ID.test(normalized)) return null;
  return listHarnessPackages(env).find((entry) => entry.id === normalized) ?? null;
}

/** Refresh installed packages that are still bundled by this NemoClaw build. */
export function refreshInstalledBundledHarnesses(
  env: NodeJS.ProcessEnv = process.env,
  excludedId: string | null = null,
): HarnessPackage[] {
  const installedRoot = installedPackagesRoot(env);
  const candidates = scanPackageRoot(BUNDLED_PACKAGES_ROOT, "bundled")
    .filter((entry) => entry.id !== excludedId)
    .filter((entry) => {
      try {
        fs.lstatSync(path.join(installedRoot, `${PACKAGE_DIRECTORY_PREFIX}${entry.id}`));
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      }
    });
  for (const candidate of candidates) {
    const existing = existingInstalledPackage(
      path.join(installedRoot, `${PACKAGE_DIRECTORY_PREFIX}${candidate.id}`),
      candidate,
    );
    if (!existing) {
      throw new Error(`Installed harness '${candidate.id}' changed before refresh`);
    }
    assertSafeToReplace(existing, packageTreeDigest(candidate.rootDir));
  }
  return candidates.map((entry) => installBundledHarness(entry.id, env));
}

function secureInstallDirectory(candidate: string): InstallDirectoryAuthority {
  if (typeof fs.constants.O_DIRECTORY !== "number" || typeof fs.constants.O_NOFOLLOW !== "number") {
    throw new Error("Secure harness installation requires O_DIRECTORY and O_NOFOLLOW");
  }
  let descriptor: number;
  try {
    descriptor = fs.openSync(
      candidate,
      fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
    );
  } catch (error) {
    throw new Error(`Harness installation path must be a regular directory: ${candidate}`, {
      cause: error,
    });
  }
  try {
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (!opened.isDirectory()) {
      throw new Error(`Harness installation path must be a regular directory: ${candidate}`);
    }
    fs.fchmodSync(descriptor, 0o700);
    const secured = fs.fstatSync(descriptor, { bigint: true });
    const current = fs.lstatSync(candidate, { bigint: true });
    if (
      current.isSymbolicLink() ||
      !current.isDirectory() ||
      secured.dev !== current.dev ||
      secured.ino !== current.ino ||
      (secured.mode & 0o777n) !== 0o700n ||
      (current.mode & 0o777n) !== 0o700n
    ) {
      throw new Error(`Harness installation directory changed during validation: ${candidate}`);
    }
    return { path: candidate, device: secured.dev, inode: secured.ino };
  } finally {
    fs.closeSync(descriptor);
  }
}

function assertInstallDirectoryAuthority(authority: InstallDirectoryAuthority): void {
  let current: fs.BigIntStats;
  try {
    current = fs.lstatSync(authority.path, { bigint: true });
  } catch (error) {
    throw new Error(`Harness installation directory changed: ${authority.path}`, {
      cause: error,
    });
  }
  if (
    current.isSymbolicLink() ||
    !current.isDirectory() ||
    current.dev !== authority.device ||
    current.ino !== authority.inode ||
    (current.mode & 0o777n) !== 0o700n
  ) {
    throw new Error(`Harness installation directory changed: ${authority.path}`);
  }
}

function assertInstallPathAuthority(authority: InstallPathAuthority): void {
  assertInstallDirectoryAuthority(authority.stateRoot);
  assertInstallDirectoryAuthority(authority.harnessRoot);
}

function assertInstallOperationAuthority(
  authority: InstallPathAuthority,
  ...operationDirectories: readonly InstallDirectoryAuthority[]
): void {
  assertInstallPathAuthority(authority);
  operationDirectories.forEach(assertInstallDirectoryAuthority);
}

function assertInstallPathComponents(home: string, harnessRoot: string): InstallPathAuthority {
  const stateRoot = path.dirname(harnessRoot);
  for (const candidate of [stateRoot, harnessRoot]) {
    try {
      const metadata = fs.lstatSync(candidate);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw new Error(`Harness installation path must be a regular directory: ${candidate}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  fs.mkdirSync(harnessRoot, { recursive: true, mode: 0o700 });

  const relative = path.relative(path.resolve(home), path.resolve(harnessRoot));
  if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Harness installation root must be inside the selected home directory");
  }
  const stateRootAuthority = secureInstallDirectory(stateRoot);
  assertInstallDirectoryAuthority(stateRootAuthority);
  const authority = {
    stateRoot: stateRootAuthority,
    harnessRoot: secureInstallDirectory(harnessRoot),
  };
  assertInstallPathAuthority(authority);
  return authority;
}

function existingInstalledPackage(
  target: string,
  expected: HarnessPackage,
): ExistingHarnessPackage | null {
  try {
    fs.lstatSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  assertPackageRoot(target);
  let installed: HarnessPackage;
  try {
    installed = readHarnessPackage(target, "installed");
  } catch (validationError) {
    const legacyPackage = readHarnessPackageMetadata(target, "installed");
    if (legacyPackage.id !== expected.id) throw validationError;
    const installedDigest = readInstallReceipt(target);
    if (installedDigest === null) throw validationError;
    const contentDigest = packageTreeDigest(target);
    if (installedDigest !== contentDigest) {
      throw new Error(
        `Installed harness '${expected.id}' differs from the bundled package and has local changes`,
        { cause: validationError },
      );
    }
    return {
      id: legacyPackage.id,
      rootDir: target,
      harnessPackage: null,
      contentDigest,
      installedDigest,
    };
  }
  if (installed.id !== expected.id) {
    throw new Error(`Installed harness '${expected.id}' differs from the bundled package`);
  }
  return {
    id: installed.id,
    rootDir: installed.rootDir,
    harnessPackage: installed,
    contentDigest: packageTreeDigest(installed.rootDir),
    installedDigest: readInstallReceipt(installed.rootDir),
  };
}

function assertSafeToReplace(
  existing: ExistingHarnessPackage,
  bundledDigest: string,
): "identical" | "upgrade" {
  if (existing.contentDigest === bundledDigest) return "identical";
  if (existing.installedDigest === existing.contentDigest) return "upgrade";
  throw new Error(
    `Installed harness '${existing.id}' differs from the bundled package and has local changes`,
  );
}

function replaceInstalledPackage(
  target: string,
  stagedPackage: string,
  expected: HarnessPackage,
  bundledDigest: string,
  installAuthority: InstallPathAuthority,
  stagingAuthority: InstallDirectoryAuthority,
): HarnessPackage {
  assertInstallOperationAuthority(installAuthority, stagingAuthority);
  const previousDirectory = fs.mkdtempSync(
    path.join(path.dirname(target), `.previous-${expected.id}-`),
  );
  assertInstallOperationAuthority(installAuthority, stagingAuthority);
  const previousAuthority = secureInstallDirectory(previousDirectory);
  const previousPackage = path.join(previousDirectory, path.basename(target));

  let previousMoved = false;
  let replacementPublished = false;
  let preservePrevious = false;
  let publishedAuthority: InstallDirectoryAuthority | null = null;
  try {
    assertInstallOperationAuthority(installAuthority, stagingAuthority, previousAuthority);
    fs.renameSync(target, previousPackage);
    previousMoved = true;
    assertInstallOperationAuthority(installAuthority, stagingAuthority, previousAuthority);
    const moved = existingInstalledPackage(previousPackage, expected);
    if (!moved) {
      throw new Error(`Installed harness '${expected.id}' changed while it was being updated`);
    }
    assertSafeToReplace(moved, bundledDigest);
    assertInstallOperationAuthority(installAuthority, stagingAuthority, previousAuthority);
    const stagedPackageAuthority = secureInstallDirectory(stagedPackage);
    assertInstallOperationAuthority(
      installAuthority,
      stagingAuthority,
      previousAuthority,
      stagedPackageAuthority,
    );
    fs.renameSync(stagedPackage, target);
    publishedAuthority = { ...stagedPackageAuthority, path: target };
    replacementPublished = true;
    assertInstallOperationAuthority(
      installAuthority,
      stagingAuthority,
      previousAuthority,
      publishedAuthority,
    );
    const installed = readHarnessPackage(target, "installed");
    if (
      packageTreeDigest(installed.rootDir) !== bundledDigest ||
      readInstallReceipt(installed.rootDir) !== bundledDigest
    ) {
      throw new Error(`Harness '${expected.id}' changed while its update was being committed`);
    }
    return installed;
  } catch (error) {
    if (!previousMoved) throw error;
    if (replacementPublished) {
      try {
        assertInstallOperationAuthority(installAuthority, stagingAuthority, previousAuthority);
        if (!publishedAuthority) {
          throw new Error(`Harness '${expected.id}' published without directory authority`);
        }
        assertInstallDirectoryAuthority(publishedAuthority);
        fs.renameSync(target, stagedPackage);
        replacementPublished = false;
        assertInstallOperationAuthority(installAuthority, stagingAuthority, previousAuthority);
      } catch (unpublishError) {
        if ((unpublishError as NodeJS.ErrnoException).code !== "ENOENT") {
          preservePrevious = true;
          throw new Error(
            `Harness '${expected.id}' could not be updated or restored; the previous package remains at ${previousPackage}`,
            { cause: unpublishError },
          );
        }
      }
    }
    try {
      assertInstallOperationAuthority(installAuthority, stagingAuthority, previousAuthority);
      fs.renameSync(previousPackage, target);
      previousMoved = false;
      assertInstallOperationAuthority(installAuthority, stagingAuthority, previousAuthority);
    } catch (restoreError) {
      preservePrevious = previousMoved;
      switch (previousMoved) {
        case true:
          throw new Error(
            `Harness '${expected.id}' could not be updated or restored; the previous package remains at ${previousPackage}`,
            { cause: restoreError },
          );
        default:
          throw new Error(
            `Harness '${expected.id}' restored the previous package, but its installation directory changed`,
            { cause: restoreError },
          );
      }
    }
    throw error;
  } finally {
    if (!preservePrevious) {
      assertInstallOperationAuthority(installAuthority, stagingAuthority, previousAuthority);
      if (replacementPublished) {
        try {
          if (!publishedAuthority) {
            throw new Error(`Harness '${expected.id}' published without directory authority`);
          }
          assertInstallDirectoryAuthority(publishedAuthority);
        } catch (cleanupAuthorityError) {
          preservePrevious = true;
          throw new Error(
            `Harness '${expected.id}' changed before update cleanup; the previous package remains at ${previousPackage}`,
            { cause: cleanupAuthorityError },
          );
        }
      }
      fs.rmSync(previousDirectory, { recursive: true, force: true });
    }
  }
}

export function installBundledHarness(
  id: string,
  env: NodeJS.ProcessEnv = process.env,
): HarnessPackage {
  const normalized = id.trim();
  if (!HARNESS_ID.test(normalized)) {
    throw new Error(`Invalid harness id '${id}'`);
  }
  const bundled = scanPackageRoot(BUNDLED_PACKAGES_ROOT, "bundled").find(
    (entry) => entry.id === normalized,
  );
  if (!bundled) throw new Error(`Bundled harness '${normalized}' was not found`);

  // Validate the complete source tree before copying. Package code is never
  // imported or executed by this registry.
  const expectedDigest = packageTreeDigest(bundled.rootDir);
  if (fs.existsSync(installReceiptPath(bundled.rootDir))) {
    throw new Error(`Bundled harness '${normalized}' contains reserved installation state`);
  }
  const home = env.HOME?.trim() || os.homedir();
  const harnessRoot = installedPackagesRoot(env);
  const installAuthority = assertInstallPathComponents(home, harnessRoot);
  const target = path.join(harnessRoot, `${PACKAGE_DIRECTORY_PREFIX}${bundled.id}`);
  assertInstallPathAuthority(installAuthority);
  const existing = existingInstalledPackage(target, bundled);
  if (
    existing &&
    assertSafeToReplace(existing, expectedDigest) === "identical" &&
    existing.installedDigest === expectedDigest
  ) {
    if (!existing.harnessPackage) {
      throw new Error(`Installed harness '${normalized}' could not be validated`);
    }
    return readHarnessPackage(existing.rootDir, "installed");
  }

  assertInstallPathAuthority(installAuthority);
  const stagingRoot = fs.mkdtempSync(path.join(harnessRoot, `.install-${bundled.id}-`));
  assertInstallPathAuthority(installAuthority);
  const stagingAuthority = secureInstallDirectory(stagingRoot);
  const stagedPackage = path.join(stagingRoot, path.basename(target));
  let operationError: unknown = null;
  let newPublishedAuthority: InstallDirectoryAuthority | null = null;
  try {
    assertInstallOperationAuthority(installAuthority, stagingAuthority);
    fs.cpSync(bundled.rootDir, stagedPackage, {
      recursive: true,
      dereference: false,
      filter: (sourcePath) => !ignoredTreeEntry(path.basename(sourcePath)),
    });
    assertInstallOperationAuthority(installAuthority, stagingAuthority);
    const staged = readHarnessPackage(stagedPackage, "installed");
    if (packageTreeDigest(staged.rootDir) !== expectedDigest) {
      throw new Error(`Harness '${normalized}' changed while it was being installed`);
    }
    writeInstallReceipt(staged.rootDir, expectedDigest);
    assertInstallOperationAuthority(installAuthority, stagingAuthority);
    if (readInstallReceipt(staged.rootDir) !== expectedDigest) {
      throw new Error(`Harness '${normalized}' installation receipt could not be verified`);
    }

    if (existing) {
      return replaceInstalledPackage(
        target,
        stagedPackage,
        bundled,
        expectedDigest,
        installAuthority,
        stagingAuthority,
      );
    }
    try {
      assertInstallOperationAuthority(installAuthority, stagingAuthority);
      const stagedPackageAuthority = secureInstallDirectory(stagedPackage);
      assertInstallOperationAuthority(installAuthority, stagingAuthority, stagedPackageAuthority);
      fs.renameSync(stagedPackage, target);
      newPublishedAuthority = { ...stagedPackageAuthority, path: target };
      assertInstallOperationAuthority(installAuthority, stagingAuthority, newPublishedAuthority);
      const installed = readHarnessPackage(target, "installed");
      if (
        packageTreeDigest(installed.rootDir) !== expectedDigest ||
        readInstallReceipt(installed.rootDir) !== expectedDigest
      ) {
        throw new Error(`Harness '${normalized}' changed while its installation was committed`);
      }
      assertInstallDirectoryAuthority(newPublishedAuthority);
      return installed;
    } catch (error) {
      if (newPublishedAuthority) {
        try {
          assertInstallDirectoryAuthority(newPublishedAuthority);
          fs.renameSync(target, stagedPackage);
          newPublishedAuthority = null;
        } catch (unpublishError) {
          newPublishedAuthority = null;
          throw new Error(
            `Harness '${normalized}' could not be installed or safely removed from ${target}`,
            { cause: unpublishError },
          );
        }
        throw error;
      }
      if (
        (error as NodeJS.ErrnoException).code !== "EEXIST" &&
        (error as NodeJS.ErrnoException).code !== "ENOTEMPTY"
      ) {
        throw error;
      }
      const raced = existingInstalledPackage(target, bundled);
      if (raced && assertSafeToReplace(raced, expectedDigest) === "identical") {
        if (!raced.harnessPackage) {
          throw new Error(`Installed harness '${normalized}' could not be validated`);
        }
        if (raced.installedDigest !== expectedDigest) {
          throw new Error(`Installed harness '${normalized}' changed before it was committed`);
        }
        return readHarnessPackage(raced.rootDir, "installed");
      }
      throw error;
    }
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    try {
      assertInstallOperationAuthority(installAuthority, stagingAuthority);
      if (newPublishedAuthority) assertInstallDirectoryAuthority(newPublishedAuthority);
      fs.rmSync(stagingRoot, { recursive: true, force: true });
    } catch (cleanupError) {
      switch (operationError === null) {
        case true:
          throw cleanupError;
        default:
          throw new AggregateError(
            [operationError, cleanupError],
            `${operationError instanceof Error ? operationError.message : String(operationError)}; staging cleanup was refused because ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
          );
      }
    }
  }
}
