#!/usr/bin/env -S node --experimental-strip-types --no-warnings
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { makeManagedOutputWritable } from "../build-harnesses.mts";

const HARNESS_ID = /^[a-z][a-z0-9-]{0,62}$/u;
const EXACT_COMMIT_SHA = /^[a-f0-9]{40}$/u;
const HARNESS_CONTENT_DIGEST = /^[a-f0-9]{64}$/u;
const COMMAND_TIMEOUT_MS = 30 * 60 * 1000;
// Keep the private rehearsal root compact. Darwin limits Unix-domain socket
// paths, and tools such as tsx add their own directories beneath TMPDIR.
const REHEARSAL_PREFIX = "nc-";
const DEVELOPER_CLI_NAMES = ["nemoclaw", "nemohermes", "nemo-deepagents"] as const;
const PRIVATE_TOOL_NAMES = ["node", "npm", "npx", "corepack", "git", "tar"] as const;
const REQUIRED_PRIVATE_TOOL_NAMES = new Set(["node", "npm", "git", "tar"]);
const PACKAGE_JSON_MAX_BYTES = 64 * 1024;
const MANIFEST_MAX_BYTES = 256 * 1024;
const NON_SECRET_BASE_IMAGE =
  "ghcr.io/nvidia/nemoclaw/sandbox-base@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OMITTED_DIRECTORY_NAMES = new Set([
  ".git",
  ".cache",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "__pycache__",
]);

export type PackageCheckoutMode = "package-only" | "composed";

export interface CheckoutCommand {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly output: "inherit" | "capture";
  readonly purpose: string;
}

export interface CheckoutCommandResult {
  readonly stdout: string;
}

export type CheckoutCommandRunner = (command: CheckoutCommand) => CheckoutCommandResult;

export interface PackageCheckoutOptions {
  readonly mode: PackageCheckoutMode;
  readonly packageId: string;
  readonly candidatePackageDir: string;
  readonly coreCheckoutDir?: string;
  readonly coreCommit?: string;
  readonly temporaryParentDir?: string;
  readonly parentEnvironment?: NodeJS.ProcessEnv;
}

export interface PackageCheckoutResult {
  readonly mode: PackageCheckoutMode;
  readonly packageId: string;
  readonly coreCommit?: string;
  readonly installedDigest?: string;
}

export interface PackageCheckoutDependencies {
  readonly runCommand?: CheckoutCommandRunner;
}

interface CredentialFreeEnvironmentOptions {
  readonly parentEnvironment: NodeJS.ProcessEnv;
  readonly home: string;
  readonly temporaryDirectory: string;
  readonly npmCache: string;
  readonly toolDirectory: string;
  readonly excludedPathRoots?: readonly string[];
}

/** Restore write access only within the generated agent runtime artifact tree. */
export function prepareCheckoutRootRemoval(rehearsalRoot: string): void {
  const pathSegments = ["nemoclaw", "dist", "harnesses"] as const;
  let current = rehearsalRoot;
  for (const segment of pathSegments) {
    let metadata: fs.Stats;
    try {
      metadata = fs.lstatSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) return;
    current = path.join(current, segment);
  }
  let metadata: fs.Stats;
  try {
    metadata = fs.lstatSync(current);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) return;
  makeManagedOutputWritable(current);
}

function assertRegularDirectory(directory: string, label: string): void {
  let metadata: fs.Stats;
  try {
    metadata = fs.lstatSync(directory);
  } catch (error) {
    throw new Error(`${label} is unavailable: ${directory}`, { cause: error });
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`${label} must be a regular directory: ${directory}`);
  }
}

function openRegularFileNoFollow(filePath: string, label: string): number {
  let descriptor: number;
  try {
    descriptor = fs.openSync(
      filePath,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
  } catch (error) {
    throw new Error(`${label} must be a regular file: ${filePath}`, { cause: error });
  }
  try {
    if (!fs.fstatSync(descriptor).isFile()) {
      throw new Error(`${label} must be a regular file: ${filePath}`);
    }
    return descriptor;
  } catch (error) {
    fs.closeSync(descriptor);
    throw error;
  }
}

function assertRegularFileNoFollow(filePath: string, label: string): void {
  const descriptor = openRegularFileNoFollow(filePath, label);
  fs.closeSync(descriptor);
}

function assertNpmInstallLock(packageRoot: string, label: string): void {
  const shrinkwrapPath = path.join(packageRoot, "npm-shrinkwrap.json");
  if (fs.existsSync(shrinkwrapPath)) {
    assertRegularFileNoFollow(shrinkwrapPath, label);
    return;
  }
  assertRegularFileNoFollow(path.join(packageRoot, "package-lock.json"), label);
}

function readBoundedRegularFile(filePath: string, label: string, maxBytes: number): string {
  const descriptor = openRegularFileNoFollow(filePath, label);
  try {
    const bytes = Buffer.alloc(maxBytes + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const bytesRead = fs.readSync(descriptor, bytes, offset, bytes.length - offset, null);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > maxBytes) {
      throw new Error(`${label} exceeds ${String(maxBytes)} bytes: ${filePath}`);
    }
    return bytes.subarray(0, offset).toString("utf8");
  } finally {
    fs.closeSync(descriptor);
  }
}

function assertCandidatePackageMetadata(candidatePackageDir: string, packageId: string): void {
  assertRegularDirectory(candidatePackageDir, "Candidate package checkout");
  const packageJsonPath = path.join(candidatePackageDir, "package.json");
  const packageJsonSource = readBoundedRegularFile(
    packageJsonPath,
    "Candidate package metadata",
    PACKAGE_JSON_MAX_BYTES,
  );
  let packageJson: unknown;
  try {
    packageJson = JSON.parse(packageJsonSource);
  } catch (error) {
    throw new Error(`Candidate package metadata is invalid: ${packageJsonPath}`, { cause: error });
  }
  if (!packageJson || typeof packageJson !== "object" || Array.isArray(packageJson)) {
    throw new Error(`Candidate package metadata must be an object: ${packageJsonPath}`);
  }
  const metadata = packageJson as Record<string, unknown>;
  const packageName = typeof metadata.name === "string" ? metadata.name : "";
  if (packageName.slice(packageName.lastIndexOf("/") + 1) !== `nemoclaw-${packageId}`) {
    throw new Error(
      `Candidate package name must end with 'nemoclaw-${packageId}': ${packageJsonPath}`,
    );
  }
  const nemoclaw = metadata.nemoclaw;
  if (
    !nemoclaw ||
    typeof nemoclaw !== "object" ||
    Array.isArray(nemoclaw) ||
    (nemoclaw as Record<string, unknown>).harnessManifest !== "manifest.yaml"
  ) {
    throw new Error(`Candidate package must declare nemoclaw.harnessManifest: ${packageJsonPath}`);
  }
  assertNpmInstallLock(candidatePackageDir, "Candidate package lock");
  const manifestPath = path.join(candidatePackageDir, "manifest.yaml");
  const manifest = readBoundedRegularFile(
    manifestPath,
    "Candidate package manifest",
    MANIFEST_MAX_BYTES,
  );
  const escapedId = packageId.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  if (!new RegExp(`^name:\\s*["']?${escapedId}["']?\\s*$`, "mu").test(manifest)) {
    throw new Error(`Candidate manifest must identify '${packageId}': ${manifestPath}`);
  }
}

function isOmittedCandidatePath(sourceRoot: string, sourcePath: string): boolean {
  if (sourcePath === sourceRoot) return false;
  const basename = path.basename(sourcePath);
  return (
    OMITTED_DIRECTORY_NAMES.has(basename) ||
    basename === ".env" ||
    basename.startsWith(".env.") ||
    basename === ".npmrc" ||
    basename.startsWith(".npmrc.") ||
    basename.endsWith(".pyc")
  );
}

function copyCandidatePackage(sourceRoot: string, destination: string): void {
  fs.cpSync(sourceRoot, destination, {
    recursive: true,
    dereference: false,
    filter: (sourcePath) => {
      if (isOmittedCandidatePath(sourceRoot, sourcePath)) return false;
      const metadata = fs.lstatSync(sourcePath);
      if (metadata.isSymbolicLink() || (!metadata.isDirectory() && !metadata.isFile())) {
        throw new Error(
          `Candidate packages may contain only regular files and directories: ${sourcePath}`,
        );
      }
      return true;
    },
  });
}

function createPrivateDirectory(directory: string): void {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
}

function isPathInsideRoot(candidate: string, root: string): boolean {
  const canonicalCandidate = canonicalPath(candidate);
  const canonicalRoot = canonicalPath(root);
  const relative = path.relative(canonicalRoot, canonicalCandidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function canonicalPath(candidate: string): string {
  try {
    return fs.realpathSync(candidate);
  } catch {
    return path.resolve(candidate);
  }
}

function executableNames(commandName: string): readonly string[] {
  return process.platform === "win32"
    ? [commandName, `${commandName}.cmd`, `${commandName}.exe`]
    : [commandName];
}

function pathEntryContainsDeveloperCli(entry: string): boolean {
  return DEVELOPER_CLI_NAMES.some((commandName) =>
    executableNames(commandName).some((name) => fs.existsSync(path.join(entry, name))),
  );
}

function resolvePathExecutable(
  commandName: string,
  sourcePath: string | undefined,
  excludedPathRoots: readonly string[],
): string | undefined {
  const entries = (sourcePath || "/usr/local/bin:/usr/bin:/bin")
    .split(path.delimiter)
    .filter(Boolean);
  for (const entry of entries) {
    for (const name of executableNames(commandName)) {
      const candidate = path.resolve(entry, name);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        const resolved = fs.realpathSync(candidate);
        if (!excludedPathRoots.some((root) => isPathInsideRoot(resolved, path.resolve(root)))) {
          return resolved;
        }
      } catch {
        // Try the next PATH entry.
      }
    }
  }
  return undefined;
}

function createPrivateToolDirectory(
  toolDirectory: string,
  sourcePath: string | undefined,
  excludedPathRoots: readonly string[],
): void {
  createPrivateDirectory(toolDirectory);
  for (const commandName of PRIVATE_TOOL_NAMES) {
    const target =
      commandName === "node" &&
      !excludedPathRoots.some((root) => isPathInsideRoot(process.execPath, path.resolve(root)))
        ? fs.realpathSync(process.execPath)
        : resolvePathExecutable(commandName, sourcePath, excludedPathRoots);
    if (!target) {
      if (REQUIRED_PRIVATE_TOOL_NAMES.has(commandName)) {
        throw new Error(`Required package rehearsal tool is unavailable: ${commandName}`);
      }
      continue;
    }
    fs.symlinkSync(target, path.join(toolDirectory, path.basename(commandName)));
  }
}

function credentialFreeSystemPath(
  sourcePath: string | undefined,
  excludedPathRoots: readonly string[],
  toolDirectory: string,
): string {
  const entries = (sourcePath || "/usr/local/bin:/usr/bin:/bin")
    .split(path.delimiter)
    .filter(Boolean);
  const allowed = entries.filter((entry) => {
    const absoluteEntry = path.resolve(entry);
    if (
      path.basename(absoluteEntry) === ".bin" &&
      path.basename(path.dirname(absoluteEntry)) === "node_modules"
    ) {
      return false;
    }
    let resolvedEntry: string;
    try {
      resolvedEntry = fs.realpathSync(absoluteEntry);
    } catch {
      return false;
    }
    return (
      !pathEntryContainsDeveloperCli(resolvedEntry) &&
      !excludedPathRoots.some((root) => isPathInsideRoot(resolvedEntry, path.resolve(root)))
    );
  });
  return [toolDirectory, ...allowed].join(path.delimiter);
}

/** Build the complete environment passed to package-owned commands. */
export function createCredentialFreeEnvironment(
  options: CredentialFreeEnvironmentOptions,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  const excludedPathRoots = options.excludedPathRoots ?? [];
  createPrivateToolDirectory(
    options.toolDirectory,
    options.parentEnvironment.PATH,
    excludedPathRoots,
  );
  for (const name of ["SystemRoot", "ComSpec", "PATHEXT", "WINDIR"] as const) {
    const value = options.parentEnvironment[name];
    if (value) env[name] = value;
  }
  env.PATH = credentialFreeSystemPath(
    options.parentEnvironment.PATH,
    excludedPathRoots,
    options.toolDirectory,
  );
  env.HOME = options.home;
  env.USERPROFILE = options.home;
  env.TMPDIR = options.temporaryDirectory;
  env.TMP = options.temporaryDirectory;
  env.TEMP = options.temporaryDirectory;
  env.CI = "1";
  env.NO_COLOR = "1";
  env.FORCE_COLOR = "0";
  env.LANG = "C";
  env.LC_ALL = "C";
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_CONFIG_GLOBAL = path.join(options.home, ".gitconfig");
  env.npm_config_userconfig = path.join(options.home, ".npmrc");
  env.npm_config_globalconfig = path.join(options.home, ".npmrc-global");
  env.npm_config_cache = options.npmCache;
  env.npm_config_ignore_scripts = "true";
  env.npm_config_audit = "false";
  env.npm_config_fund = "false";
  env.NEMOCLAW_DISABLE_GATEWAY_DRIFT_PREFLIGHT = "1";
  env.NEMOCLAW_SANDBOX_BASE_IMAGE_REF = NON_SECRET_BASE_IMAGE;
  env.NEMOCLAW_TEST_TIMEOUT = "60000";
  return env;
}

/** Run one bounded command without a shell. */
export function executeCheckoutCommand(command: CheckoutCommand): CheckoutCommandResult {
  const captureOutput = command.output === "capture";
  const result = spawnSync(command.executable, [...command.args], {
    cwd: command.cwd,
    env: command.env,
    encoding: "utf8",
    timeout: COMMAND_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
    stdio: captureOutput ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (result.error) {
    throw new Error(`${command.purpose} could not start`, { cause: result.error });
  }
  if (result.status !== 0) {
    const outcome = result.signal ? `signal ${result.signal}` : `exit ${String(result.status)}`;
    throw new Error(`${command.purpose} failed with ${outcome}`);
  }
  return { stdout: captureOutput ? (result.stdout ?? "") : "" };
}

function runDependencyInstall(runCommand: CheckoutCommandRunner, command: CheckoutCommand): void {
  try {
    runCommand(command);
  } catch (error) {
    throw new Error(
      `${command.purpose} failed while dependency lifecycle scripts were disabled. ` +
        "Keep scripts disabled and record the dependency for an explicit security decision.",
      { cause: error },
    );
  }
}

function npmCommand(
  cwd: string,
  env: NodeJS.ProcessEnv,
  purpose: string,
  args: readonly string[],
): CheckoutCommand {
  return { executable: "npm", args, cwd, env, output: "inherit", purpose };
}

function installPackageDevelopmentDependencies(
  packageId: string,
  packageRoot: string,
  env: NodeJS.ProcessEnv,
  runCommand: CheckoutCommandRunner,
): void {
  runDependencyInstall(
    runCommand,
    npmCommand(packageRoot, env, "install candidate package dependencies", [
      "ci",
      "--ignore-scripts",
    ]),
  );
  if (packageId !== "openclaw") return;

  const pluginRoot = path.join(packageRoot, "plugin");
  assertNpmInstallLock(pluginRoot, "OpenClaw plugin package lock");
  runDependencyInstall(
    runCommand,
    npmCommand(pluginRoot, env, "install OpenClaw plugin dependencies", ["ci", "--ignore-scripts"]),
  );
}

function assertExactCoreRevision(
  coreCheckoutDir: string,
  coreCommit: string,
  env: NodeJS.ProcessEnv,
  runCommand: CheckoutCommandRunner,
): void {
  const { stdout } = runCommand({
    executable: "git",
    args: ["rev-parse", "--verify", "HEAD"],
    cwd: coreCheckoutDir,
    env,
    output: "capture",
    purpose: "read exact NemoClaw revision",
  });
  const checkoutCommit = stdout.trim();
  if (checkoutCommit !== coreCommit) {
    throw new Error(`NemoClaw checkout is ${checkoutCommit || "unknown"}, not ${coreCommit}`);
  }
}

function materializeExactCoreRevision(
  coreCheckoutDir: string,
  coreCommit: string,
  rehearsalRoot: string,
  coreRoot: string,
  env: NodeJS.ProcessEnv,
  runCommand: CheckoutCommandRunner,
): void {
  const archivePath = path.join(rehearsalRoot, "nemoclaw-core.tar");
  runCommand({
    executable: "git",
    args: ["archive", "--format=tar", `--output=${archivePath}`, coreCommit],
    cwd: coreCheckoutDir,
    env,
    output: "inherit",
    purpose: "archive exact NemoClaw revision",
  });
  runCommand({
    executable: "tar",
    args: ["-xf", archivePath, "-C", coreRoot],
    cwd: rehearsalRoot,
    env,
    output: "inherit",
    purpose: "extract exact NemoClaw revision",
  });
  fs.rmSync(archivePath, { force: true });
}

function requireExactJsonRecord(
  value: unknown,
  fields: ReadonlySet<string>,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Candidate package inventory is invalid");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== fields.size || keys.some((key) => !fields.has(key))) {
    throw new Error("Candidate package inventory is invalid");
  }
  return record;
}

/** Read one receipt-verified installed digest from public CLI inventory JSON. */
export function readInstalledHarnessDigest(source: string, packageId: string): string {
  let inventory: unknown;
  try {
    inventory = JSON.parse(source);
  } catch {
    throw new Error("Candidate package inventory is invalid");
  }
  const record = requireExactJsonRecord(
    inventory,
    new Set(["schemaVersion", "installed", "available"]),
  );
  if (
    record.schemaVersion !== 1 ||
    !Array.isArray(record.installed) ||
    !Array.isArray(record.available)
  ) {
    throw new Error("Candidate package inventory is invalid");
  }
  const installed = record.installed.map((row) =>
    requireExactJsonRecord(row, new Set(["id", "displayName", "health", "identity"])),
  );
  const matching = installed.filter(({ id }) => id === packageId);
  if (matching.length !== 1 || matching[0].health !== "healthy") {
    throw new Error("Candidate package inventory is invalid");
  }
  const identity = requireExactJsonRecord(
    matching[0].identity,
    new Set(["kind", "id", "packageVersion", "contentDigest"]),
  );
  if (
    identity.kind !== "agent-runtime" ||
    identity.id !== packageId ||
    typeof identity.packageVersion !== "string" ||
    identity.packageVersion.length === 0 ||
    typeof identity.contentDigest !== "string" ||
    !HARNESS_CONTENT_DIGEST.test(identity.contentDigest)
  ) {
    throw new Error("Candidate package inventory is invalid");
  }
  return identity.contentDigest;
}

function assertInstalledPackageListed(output: string, packageId: string): void {
  const installedSection = output.split(/\n\s*\n/u, 1)[0] ?? "";
  const escapedId = packageId.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  if (!new RegExp(`^\\s+${escapedId}\\s+`, "mu").test(installedSection)) {
    throw new Error(`nemoclaw harness list did not show installed package '${packageId}'`);
  }
}

function runPackageOnlyRehearsal(
  packageId: string,
  candidatePackageDir: string,
  rehearsalRoot: string,
  env: NodeJS.ProcessEnv,
  runCommand: CheckoutCommandRunner,
): PackageCheckoutResult {
  const packageRoot = path.join(rehearsalRoot, "package");
  copyCandidatePackage(candidatePackageDir, packageRoot);
  installPackageDevelopmentDependencies(packageId, packageRoot, env, runCommand);
  runCommand(
    npmCommand(packageRoot, env, "run candidate package-only tests", ["run", "test:package"]),
  );
  return { mode: "package-only", packageId };
}

function runComposedRehearsal(
  options: PackageCheckoutOptions,
  rehearsalRoot: string,
  env: NodeJS.ProcessEnv,
  runCommand: CheckoutCommandRunner,
): PackageCheckoutResult {
  const coreCheckoutDir = path.resolve(options.coreCheckoutDir ?? "");
  const coreCommit = options.coreCommit ?? "";
  assertRegularDirectory(coreCheckoutDir, "NemoClaw checkout");
  assertExactCoreRevision(coreCheckoutDir, coreCommit, env, runCommand);

  const coreRoot = path.join(rehearsalRoot, "nemoclaw");
  createPrivateDirectory(coreRoot);
  materializeExactCoreRevision(
    coreCheckoutDir,
    coreCommit,
    rehearsalRoot,
    coreRoot,
    env,
    runCommand,
  );
  fs.writeFileSync(path.join(coreRoot, ".source-revision"), `${coreCommit}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  if (!fs.existsSync(path.join(coreRoot, "package-lock.json"))) {
    throw new Error("Exact NemoClaw revision does not contain a root package lock");
  }

  const packageRoot = path.join(coreRoot, "packages", `nemoclaw-${options.packageId}`);
  fs.rmSync(packageRoot, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(packageRoot), { recursive: true });
  copyCandidatePackage(path.resolve(options.candidatePackageDir), packageRoot);

  runDependencyInstall(
    runCommand,
    npmCommand(coreRoot, env, "install NemoClaw dependencies", ["ci", "--ignore-scripts"]),
  );
  installPackageDevelopmentDependencies(options.packageId, packageRoot, env, runCommand);

  const pluginRoot = path.join(packageRoot, "plugin");
  runCommand(npmCommand(coreRoot, env, "build NemoClaw CLI", ["run", "build:cli"]));
  if (options.packageId === "openclaw") {
    runCommand(npmCommand(pluginRoot, env, "build OpenClaw plugin", ["run", "build"]));
  }

  runCommand(npmCommand(packageRoot, env, "run complete candidate tests", ["test"]));

  const cliPath = path.join(coreRoot, "bin", "nemoclaw.js");
  runCommand({
    executable: process.execPath,
    args: [cliPath, "harness", "install", options.packageId],
    cwd: coreRoot,
    env,
    output: "inherit",
    purpose: "install candidate harness",
  });
  const { stdout: listOutput } = runCommand({
    executable: process.execPath,
    args: [cliPath, "harness", "list"],
    cwd: coreRoot,
    env,
    output: "capture",
    purpose: "list installed harnesses",
  });
  assertInstalledPackageListed(listOutput, options.packageId);
  const { stdout: inventoryOutput } = runCommand({
    executable: process.execPath,
    args: [cliPath, "harness", "list", "--json"],
    cwd: coreRoot,
    env,
    output: "capture",
    purpose: "read installed harness digest",
  });
  const installedDigest = readInstalledHarnessDigest(inventoryOutput, options.packageId);
  return {
    mode: "composed",
    packageId: options.packageId,
    coreCommit,
    installedDigest,
  };
}

/** Rehearse one package checkout and remove every temporary path. */
export function runPackageCheckoutRehearsal(
  options: PackageCheckoutOptions,
  dependencies: PackageCheckoutDependencies = {},
): PackageCheckoutResult {
  if (options.mode !== "package-only" && options.mode !== "composed") {
    throw new Error("Package checkout mode must be 'package-only' or 'composed'");
  }
  if (!HARNESS_ID.test(options.packageId)) {
    throw new Error(`Invalid agent runtime package id '${options.packageId}'`);
  }
  if (
    options.mode === "composed" &&
    (!options.coreCheckoutDir || !EXACT_COMMIT_SHA.test(options.coreCommit ?? ""))
  ) {
    throw new Error(
      "Composed mode requires an explicit NemoClaw checkout and exact 40-character commit SHA",
    );
  }

  const candidatePackageDir = path.resolve(options.candidatePackageDir);
  assertCandidatePackageMetadata(candidatePackageDir, options.packageId);
  const selectedTemporaryParentDir = path.resolve(options.temporaryParentDir ?? os.tmpdir());
  assertRegularDirectory(selectedTemporaryParentDir, "Temporary parent directory");
  const temporaryParentDir = fs.realpathSync.native(selectedTemporaryParentDir);
  assertRegularDirectory(temporaryParentDir, "Temporary parent directory");
  const rehearsalRoot = fs.mkdtempSync(path.join(temporaryParentDir, REHEARSAL_PREFIX));
  try {
    fs.chmodSync(rehearsalRoot, 0o700);
    const home = path.join(rehearsalRoot, "home");
    const temporaryDirectory = path.join(rehearsalRoot, "t");
    const npmCache = path.join(rehearsalRoot, "npm-cache");
    const toolDirectory = path.join(rehearsalRoot, "tool-bin");
    createPrivateDirectory(home);
    createPrivateDirectory(temporaryDirectory);
    createPrivateDirectory(npmCache);
    fs.writeFileSync(path.join(home, ".gitconfig"), "", { mode: 0o600 });
    fs.writeFileSync(path.join(home, ".npmrc"), "", { mode: 0o600 });
    fs.writeFileSync(path.join(home, ".npmrc-global"), "", { mode: 0o600 });
    const env = createCredentialFreeEnvironment({
      parentEnvironment: options.parentEnvironment ?? process.env,
      home,
      temporaryDirectory,
      npmCache,
      toolDirectory,
      excludedPathRoots: [
        candidatePackageDir,
        ...(options.coreCheckoutDir ? [path.resolve(options.coreCheckoutDir)] : []),
      ],
    });
    const runCommand = dependencies.runCommand ?? executeCheckoutCommand;

    if (options.mode === "package-only") {
      return runPackageOnlyRehearsal(
        options.packageId,
        candidatePackageDir,
        rehearsalRoot,
        env,
        runCommand,
      );
    }
    return runComposedRehearsal(options, rehearsalRoot, env, runCommand);
  } finally {
    prepareCheckoutRootRemoval(rehearsalRoot);
    fs.rmSync(rehearsalRoot, { recursive: true, force: true });
  }
}

function usage(): string {
  return [
    "Usage:",
    "  scripts/packages/checkout.mts package-only --package <id> --candidate <path>",
    "  scripts/packages/checkout.mts composed --package <id> --candidate <path> --nemoclaw-checkout <path> --nemoclaw-commit <sha>",
  ].join("\n");
}

function readCliOptions(args: readonly string[]): PackageCheckoutOptions {
  const [mode, ...remaining] = args;
  if (mode === "--help" || mode === "-h") {
    process.stdout.write(`${usage()}\n`);
    process.exit(0);
  }
  if (mode !== "package-only" && mode !== "composed") {
    throw new Error(usage());
  }
  const { values } = parseArgs({
    args: remaining,
    allowPositionals: false,
    strict: true,
    options: {
      package: { type: "string" },
      candidate: { type: "string" },
      "nemoclaw-checkout": { type: "string" },
      "nemoclaw-commit": { type: "string" },
    },
  });
  const packageId = values.package;
  const candidatePackageDir = values.candidate;
  if (!packageId || !candidatePackageDir) throw new Error(usage());
  return {
    mode,
    packageId,
    candidatePackageDir,
    coreCheckoutDir: values["nemoclaw-checkout"],
    coreCommit: values["nemoclaw-commit"],
  };
}

/** Format the durable evidence emitted after the private rehearsal workspace is removed. */
export function formatCheckoutResult(result: PackageCheckoutResult): string {
  const revision = result.coreCommit ? ` against NemoClaw ${result.coreCommit}` : "";
  const digestEvidence = result.installedDigest
    ? ` Installed digest: ${result.installedDigest}.`
    : "";
  return `${result.mode} rehearsal passed for ${result.packageId}${revision}.${digestEvidence}`;
}

function main(): void {
  const result = runPackageCheckoutRehearsal(readCliOptions(process.argv.slice(2)));
  process.stdout.write(`${formatCheckoutResult(result)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
