// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { openRegularFileNoFollow } from "../adapters/fs/regular-file";
import { parseManifestRecord, readString } from "../agent/manifest-readers";

const PACKAGE_DIRECTORY_PREFIX = "nemoclaw-";
const INSTALL_RECEIPT_FILENAME = ".nemoclaw-install.json";
const INSTALL_RECEIPT_MAX_BYTES = 4 * 1024;
const PACKAGE_JSON_MAX_BYTES = 64 * 1024;
const MANIFEST_MAX_BYTES = 256 * 1024;
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

type JsonRecord = Record<string, unknown>;

interface ExistingHarnessPackage {
  readonly harnessPackage: HarnessPackage;
  readonly contentDigest: string;
  readonly installedDigest: string | null;
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

function readHarnessPackage(rootDir: string, source: HarnessPackage["source"]): HarnessPackage {
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
  assertRequiredHarnessFiles(rootDir);

  return Object.freeze({
    id,
    packageName,
    version,
    rootDir,
    manifestPath,
    source,
  });
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
    if (source === "installed") packageTreeDigest(rootDir);
    packages.push(harnessPackage);
  }
  return packages;
}

function ignoredTreeEntry(name: string): boolean {
  return (
    name === ".git" || name === ".DS_Store" || name === "node_modules" || name === "__pycache__"
  );
}

function visitPackageTree(
  rootDir: string,
  visitor: (relativePath: string, metadata: fs.Stats) => void,
): void {
  const walk = (directory: string, prefix: string): void => {
    for (const entry of fs
      .readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      if (ignoredTreeEntry(entry.name)) continue;
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolutePath = path.join(directory, entry.name);
      const metadata = fs.lstatSync(absolutePath);
      if (metadata.isSymbolicLink()) {
        throw new Error(`Harness packages may not contain symbolic links: ${absolutePath}`);
      }
      if (!metadata.isDirectory() && !metadata.isFile()) {
        throw new Error(
          `Harness packages may contain only directories and regular files: ${absolutePath}`,
        );
      }
      visitor(relativePath, metadata);
      if (metadata.isDirectory()) walk(absolutePath, relativePath);
    }
  };
  walk(rootDir, "");
}

function packageTreeDigest(rootDir: string): string {
  const hash = crypto.createHash("sha256");
  visitPackageTree(rootDir, (relativePath, metadata) => {
    if (relativePath === INSTALL_RECEIPT_FILENAME) {
      if (!metadata.isFile()) {
        throw new Error(
          `Harness installation receipt must be a regular file: ${path.join(rootDir, relativePath)}`,
        );
      }
      return;
    }
    const executable = (metadata.mode & 0o111) === 0 ? "0" : "1";
    if (metadata.isDirectory()) {
      hash.update(`d\0${relativePath}\0${executable}\0`);
      return;
    }
    const filePath = path.join(rootDir, ...relativePath.split("/"));
    const opened = openRegularFileNoFollow(filePath);
    try {
      const bytes = opened.readBytes(metadata.size);
      if (bytes.length !== metadata.size) {
        throw new Error(`Harness package file changed while it was read: ${filePath}`);
      }
      hash.update(`f\0${relativePath}\0${executable}\0${String(bytes.length)}\0`);
      hash.update(bytes);
      hash.update("\0");
    } finally {
      opened.close();
    }
  });
  return hash.digest("hex");
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

  for (const [id, installedPackage] of installed) {
    const bundledPackage = bundled.get(id);
    if (!bundledPackage) continue;
    const bundledDigest = packageTreeDigest(bundledPackage.rootDir);
    const installedDigest = packageTreeDigest(installedPackage.rootDir);
    if (
      bundledDigest !== installedDigest &&
      readInstallReceipt(installedPackage.rootDir) === null
    ) {
      throw new Error(`Duplicate harness id '${id}' has different bundled and installed content`);
    }
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

function assertInstallPathComponents(home: string, harnessRoot: string): void {
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
  fs.chmodSync(stateRoot, 0o700);
  fs.chmodSync(harnessRoot, 0o700);

  const relative = path.relative(path.resolve(home), path.resolve(harnessRoot));
  if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Harness installation root must be inside the selected home directory");
  }
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
  const installed = readHarnessPackage(target, "installed");
  if (installed.id !== expected.id) {
    throw new Error(`Installed harness '${expected.id}' differs from the bundled package`);
  }
  return {
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
    `Installed harness '${existing.harnessPackage.id}' differs from the bundled package and has local changes`,
  );
}

function replaceInstalledPackage(
  target: string,
  stagedPackage: string,
  expected: HarnessPackage,
  bundledDigest: string,
): HarnessPackage {
  const previousDirectory = fs.mkdtempSync(
    path.join(path.dirname(target), `.previous-${expected.id}-`),
  );
  fs.chmodSync(previousDirectory, 0o700);
  const previousPackage = path.join(previousDirectory, path.basename(target));

  let previousMoved = false;
  let replacementPublished = false;
  let preservePrevious = false;
  try {
    fs.renameSync(target, previousPackage);
    previousMoved = true;
    const moved = existingInstalledPackage(previousPackage, expected);
    if (!moved || assertSafeToReplace(moved, bundledDigest) !== "upgrade") {
      throw new Error(`Installed harness '${expected.id}' changed while it was being updated`);
    }
    fs.renameSync(stagedPackage, target);
    replacementPublished = true;
    const installed = existingInstalledPackage(target, expected);
    if (
      !installed ||
      installed.contentDigest !== bundledDigest ||
      installed.installedDigest !== bundledDigest
    ) {
      throw new Error(`Harness '${expected.id}' changed while its update was being committed`);
    }
    return installed.harnessPackage;
  } catch (error) {
    if (!previousMoved) throw error;
    if (replacementPublished) {
      try {
        fs.renameSync(target, stagedPackage);
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
      fs.renameSync(previousPackage, target);
    } catch (restoreError) {
      preservePrevious = true;
      throw new Error(
        `Harness '${expected.id}' could not be updated or restored; the previous package remains at ${previousPackage}`,
        { cause: restoreError },
      );
    }
    throw error;
  } finally {
    if (!preservePrevious) {
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
  assertInstallPathComponents(home, harnessRoot);
  const target = path.join(harnessRoot, `${PACKAGE_DIRECTORY_PREFIX}${bundled.id}`);
  const existing = existingInstalledPackage(target, bundled);
  if (existing && assertSafeToReplace(existing, expectedDigest) === "identical") {
    if (existing.installedDigest !== expectedDigest) {
      writeInstallReceipt(existing.harnessPackage.rootDir, expectedDigest);
    }
    return readHarnessPackage(existing.harnessPackage.rootDir, "installed");
  }

  const stagingRoot = fs.mkdtempSync(path.join(harnessRoot, `.install-${bundled.id}-`));
  fs.chmodSync(stagingRoot, 0o700);
  const stagedPackage = path.join(stagingRoot, path.basename(target));
  try {
    fs.cpSync(bundled.rootDir, stagedPackage, {
      recursive: true,
      dereference: false,
      filter: (sourcePath) => !ignoredTreeEntry(path.basename(sourcePath)),
    });
    const staged = readHarnessPackage(stagedPackage, "installed");
    if (packageTreeDigest(staged.rootDir) !== expectedDigest) {
      throw new Error(`Harness '${normalized}' changed while it was being installed`);
    }
    writeInstallReceipt(staged.rootDir, expectedDigest);
    if (readInstallReceipt(staged.rootDir) !== expectedDigest) {
      throw new Error(`Harness '${normalized}' installation receipt could not be verified`);
    }

    if (existing) {
      return replaceInstalledPackage(target, stagedPackage, bundled, expectedDigest);
    }
    try {
      fs.renameSync(stagedPackage, target);
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== "EEXIST" &&
        (error as NodeJS.ErrnoException).code !== "ENOTEMPTY"
      ) {
        throw error;
      }
      const raced = existingInstalledPackage(target, bundled);
      if (raced && assertSafeToReplace(raced, expectedDigest) === "identical") {
        if (raced.installedDigest !== expectedDigest) {
          writeInstallReceipt(raced.harnessPackage.rootDir, expectedDigest);
        }
        return readHarnessPackage(raced.harnessPackage.rootDir, "installed");
      }
      throw error;
    }
    return readHarnessPackage(target, "installed");
  } finally {
    fs.rmSync(stagingRoot, { recursive: true, force: true });
  }
}
