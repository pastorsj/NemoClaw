// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseDocument } from "yaml";

import type { HarnessPackageEnvelope } from "../src/lib/agent-runtime/package/types";
import { directDockerfileCopySources } from "./lib/dockerfile-copy-sources.mts";

const requireModule = createRequire(import.meta.url);
const { isInsideIgnoredCustomBuildContextPath } = requireModule(
  "../src/lib/onboard/custom-build-context.ts",
) as typeof import("../src/lib/onboard/custom-build-context");

type HarnessPackageManifestModule = typeof import("../src/lib/agent-runtime/package/manifest");
type HarnessPackageTreeModule = typeof import("../src/lib/agent-runtime/package/tree");

let harnessPackageManifestModule: HarnessPackageManifestModule | undefined;
let harnessPackageTreeModule: HarnessPackageTreeModule | undefined;

function loadHarnessPackageManifestModule(): HarnessPackageManifestModule {
  harnessPackageManifestModule ??= requireModule(
    "../src/lib/agent-runtime/package/manifest.ts",
  ) as HarnessPackageManifestModule;
  return harnessPackageManifestModule;
}

function loadHarnessPackageTreeModule(): HarnessPackageTreeModule {
  harnessPackageTreeModule ??= requireModule(
    "../src/lib/agent-runtime/package/tree.ts",
  ) as HarnessPackageTreeModule;
  return harnessPackageTreeModule;
}

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DISTRIBUTION_ROOT = path.join(REPOSITORY_ROOT, "dist");
export const BUNDLED_HARNESS_OUTPUT_ROOT = path.join(DISTRIBUTION_ROOT, "harnesses");
const AGENT_RUNTIME_PACKAGE_PREFIX = "nemoclaw-";
const PACKAGE_MANIFEST_FILE = "manifest.yaml";

interface BundledAgentRuntimeSourceMapping {
  readonly sourcePath: string;
  readonly destinationPath: string;
  readonly sourceType: "file" | "tree";
}

interface BundledAgentRuntimeSource {
  readonly id: string;
  readonly displayName: string;
  readonly packageVersion: string;
  readonly manifestPath: string;
  readonly mappings: readonly BundledAgentRuntimeSourceMapping[];
}

const OMITTED_DIRECTORY_NAMES = new Set([
  ".e2e",
  ".git",
  ".cache",
  ".mypy_cache",
  ".npm",
  ".pytest_cache",
  ".ruff_cache",
  ".tox",
  "__pycache__",
  "coverage",
  "dist",
  "node_modules",
  "tests",
]);
const OMITTED_FILE_NAMES = new Set([
  ".DS_Store",
  ".gitignore",
  ".gitkeep",
  "dependency-review.md",
  "tsconfig.test.json",
  "vitest.config.ts",
  "vitest.nemoclaw.ts",
  "vitest.project.ts",
]);
const TEST_FILE_PATTERN = /(?:^test_[^/]+\.py$|\.test\.[cm]?[jt]sx?$)/u;
const SPEC_FILE_PATTERN = /\.spec\.[cm]?[jt]sx?$/u;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/u;
const TRANSITIONAL_GITLINK_PATH = "nemoclaw-blueprint/router/llm-router";

export interface BuiltHarnessArtifact {
  readonly id: string;
  readonly packageRoot: string;
  readonly contentDigest: string;
}

interface AuthoringPackageJson {
  readonly name?: unknown;
  readonly version?: unknown;
  readonly nemoclaw?: {
    readonly harnessManifest?: unknown;
  };
}

function readAuthoringPackageJson(packageRoot: string): AuthoringPackageJson | null {
  const packageJsonPath = path.join(packageRoot, "package.json");
  if (!fs.existsSync(packageJsonPath)) return null;
  const parsed = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as unknown;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Agent runtime package metadata is invalid: ${packageJsonPath}`);
  }
  return parsed as AuthoringPackageJson;
}

function packageNameBase(packageName: string): string {
  const slash = packageName.lastIndexOf("/");
  return slash === -1 ? packageName : packageName.slice(slash + 1);
}

function readManifestIdentity(manifestPath: string): { id: string; displayName: string } {
  const document = parseDocument(fs.readFileSync(manifestPath, "utf8"), {
    strict: true,
    uniqueKeys: true,
  });
  if (document.errors.length > 0 || document.warnings.length > 0) {
    throw new Error(`Agent runtime manifest is invalid: ${manifestPath}`);
  }
  const value = document.toJS() as unknown;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Agent runtime manifest must contain one object: ${manifestPath}`);
  }
  const record = value as Record<string, unknown>;
  if (typeof record.name !== "string" || record.name.length === 0) {
    throw new Error(`Agent runtime manifest must declare its name: ${manifestPath}`);
  }
  const displayName = record.display_name;
  if (displayName !== undefined && (typeof displayName !== "string" || displayName.length === 0)) {
    throw new Error(`Agent runtime manifest display_name is invalid: ${manifestPath}`);
  }
  return { id: record.name, displayName: displayName ?? record.name };
}

function expandBuildInput(source: string, repositoryRoot: string): readonly string[] {
  const normalized = source.replace(/\/+$/u, "");
  if (!/[*?[\]]/u.test(normalized)) return [normalized];
  const matches = fs.globSync(normalized, { cwd: repositoryRoot }).sort();
  if (matches.length === 0) {
    throw new Error(`Agent runtime Dockerfile COPY source did not match any files: ${source}`);
  }
  return matches;
}

function buildInputMappings(
  repositoryRoot: string,
  packageRelativePath: string,
  dockerfiles: readonly string[],
): readonly BundledAgentRuntimeSourceMapping[] {
  const sourcePaths = new Set<string>([packageRelativePath]);
  for (const dockerfile of dockerfiles) {
    for (const { source } of directDockerfileCopySources(
      path.join(repositoryRoot, dockerfile),
      dockerfile,
    )) {
      for (const match of expandBuildInput(source, repositoryRoot)) sourcePaths.add(match);
    }
  }

  const candidates = [...sourcePaths]
    .sort((left, right) => left.localeCompare(right))
    .map((sourcePath) => {
      const stat = fs.lstatSync(path.join(repositoryRoot, sourcePath));
      if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) {
        throw new Error(
          `Agent runtime build input must be a regular file or directory: ${sourcePath}`,
        );
      }
      return {
        sourcePath,
        destinationPath: sourcePath,
        sourceType: stat.isDirectory() ? ("tree" as const) : ("file" as const),
      };
    });

  return Object.freeze(
    candidates.filter(
      (candidate, index) =>
        !candidates.some(
          (other, otherIndex) =>
            index !== otherIndex &&
            other.sourceType === "tree" &&
            candidate.sourcePath.startsWith(`${other.sourcePath}/`),
        ),
    ),
  );
}

function assertAuthoringRepositoryRoot(repositoryRoot: string): string {
  if (!path.isAbsolute(repositoryRoot) || path.resolve(repositoryRoot) !== repositoryRoot) {
    throw new Error("Agent runtime authoring repository root must be one canonical absolute path");
  }
  const repositoryStat = fs.lstatSync(repositoryRoot);
  const packagesRoot = path.join(repositoryRoot, "packages");
  const packagesStat = fs.lstatSync(packagesRoot);
  if (
    repositoryStat.isSymbolicLink() ||
    !repositoryStat.isDirectory() ||
    packagesStat.isSymbolicLink() ||
    !packagesStat.isDirectory()
  ) {
    throw new Error("Agent runtime authoring roots must be regular directories");
  }
  return repositoryRoot;
}

/** Discover every in-tree package that declares the data-only agent runtime contract. */
export function listBundledAgentRuntimeSources(
  authoringRepositoryRoot = REPOSITORY_ROOT,
): readonly BundledAgentRuntimeSource[] {
  const repositoryRoot = assertAuthoringRepositoryRoot(authoringRepositoryRoot);
  const authoringPackagesRoot = path.join(repositoryRoot, "packages");
  const sources = fs
    .readdirSync(authoringPackagesRoot, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        !entry.isSymbolicLink() &&
        entry.name.startsWith(AGENT_RUNTIME_PACKAGE_PREFIX),
    )
    .flatMap((entry): BundledAgentRuntimeSource[] => {
      const packageRoot = path.join(authoringPackagesRoot, entry.name);
      const packageJson = readAuthoringPackageJson(packageRoot);
      const declaredManifest = packageJson?.nemoclaw?.harnessManifest;
      if (declaredManifest === undefined) return [];
      if (
        declaredManifest !== PACKAGE_MANIFEST_FILE ||
        typeof packageJson?.name !== "string" ||
        packageNameBase(packageJson.name) !== entry.name ||
        typeof packageJson.version !== "string"
      ) {
        throw new Error(`Agent runtime package contract is invalid: ${entry.name}`);
      }
      const id = entry.name.slice(AGENT_RUNTIME_PACKAGE_PREFIX.length);
      const manifestIdentity = readManifestIdentity(path.join(packageRoot, PACKAGE_MANIFEST_FILE));
      if (manifestIdentity.id !== id) {
        throw new Error(`Agent runtime package directory and manifest names differ: ${entry.name}`);
      }
      const packageRelativePath = path.posix.join("packages", entry.name);
      const dockerfiles = [
        path.posix.join(packageRelativePath, "Dockerfile"),
        path.posix.join(packageRelativePath, "Dockerfile.base"),
      ];
      dockerfiles.forEach((dockerfile) => {
        if (!fs.existsSync(path.join(repositoryRoot, dockerfile))) {
          throw new Error(`Agent runtime package is missing ${dockerfile}`);
        }
      });
      return [
        Object.freeze({
          id,
          displayName: manifestIdentity.displayName,
          packageVersion: packageJson.version,
          manifestPath: path.posix.join(packageRelativePath, PACKAGE_MANIFEST_FILE),
          mappings: buildInputMappings(repositoryRoot, packageRelativePath, dockerfiles),
        }),
      ];
    })
    .sort((left, right) => left.id.localeCompare(right.id));
  if (sources.length === 0) throw new Error("No agent runtime packages are available to bundle");
  if (new Set(sources.map(({ id }) => id)).size !== sources.length) {
    throw new Error("Agent runtime package ids must be unique");
  }
  return Object.freeze(sources);
}

function assertManagedOutputRoot(outputRoot: string): void {
  if (
    path.resolve(outputRoot) !== BUNDLED_HARNESS_OUTPUT_ROOT ||
    path.dirname(outputRoot) !== DISTRIBUTION_ROOT ||
    path.basename(outputRoot) !== "harnesses"
  ) {
    throw new Error("Refusing to replace an unrecognized bundled harness output root");
  }
  [DISTRIBUTION_ROOT, outputRoot]
    .filter((target) => fs.existsSync(target))
    .forEach((target) => {
      const stat = fs.lstatSync(target);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error("Refusing to replace a redirected bundled harness output root");
      }
      const relative = path.relative(
        fs.realpathSync.native(REPOSITORY_ROOT),
        fs.realpathSync.native(target),
      );
      if (relative.startsWith("..") || path.isAbsolute(relative)) {
        throw new Error("Refusing to replace a bundled harness output outside the repository");
      }
    });
}

function normalizedRelativePath(value: string, label: string): string {
  if (
    value.length === 0 ||
    value.includes("\\") ||
    path.posix.isAbsolute(value) ||
    path.posix.normalize(value) !== value ||
    value.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error(`${label} must be a canonical repository-relative path`);
  }
  return value;
}

function resolveContained(root: string, relativePath: string, label: string): string {
  const normalized = normalizedRelativePath(relativePath, label);
  const resolved = path.resolve(root, ...normalized.split("/"));
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${label} escapes its approved root`);
  }
  return resolved;
}

function assertReviewedSourcePath(repositoryRoot: string, relativePath: string): string {
  const resolved = resolveContained(repositoryRoot, relativePath, "Bundled harness source");
  const rootRealPath = fs.realpathSync.native(repositoryRoot);
  const sourceRealPath = fs.realpathSync.native(resolved);
  const realRelative = path.relative(rootRealPath, sourceRealPath);
  if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) {
    throw new Error("Bundled harness source resolves outside the repository root");
  }
  relativePath.split("/").reduce((parent, segment) => {
    const current = path.join(parent, segment);
    if (fs.lstatSync(current).isSymbolicLink()) {
      throw new Error(`Bundled harness source '${relativePath}' has a symbolic-link ancestor`);
    }
    return current;
  }, repositoryRoot);
  return resolved;
}

function duplicateKey(relativePath: string): string {
  return relativePath.normalize("NFKC").toLowerCase();
}

function assertCanonicalName(name: string): void {
  if (
    name.length === 0 ||
    name === "." ||
    name === ".." ||
    name.includes("/") ||
    name.includes("\\") ||
    name.normalize("NFC") !== name ||
    CONTROL_CHARACTER_PATTERN.test(name)
  ) {
    throw new Error("Bundled harness sources must use canonical path components");
  }
}

function isOmittedAuthoringPath(relativePath: string, type: "directory" | "file"): boolean {
  const name = path.posix.basename(relativePath);
  const normalizedName = name.toLowerCase();
  if (relativePath === TRANSITIONAL_GITLINK_PATH) return true;
  if (type === "directory") {
    return (
      OMITTED_DIRECTORY_NAMES.has(normalizedName) ||
      normalizedName.endsWith(".egg-info") ||
      (normalizedName.endsWith("-cache") && normalizedName !== "npm-cache-seed")
    );
  }
  return (
    OMITTED_FILE_NAMES.has(name) ||
    normalizedName.startsWith("dependency-review") ||
    TEST_FILE_PATTERN.test(name) ||
    SPEC_FILE_PATTERN.test(name) ||
    name.endsWith(".pyc") ||
    isInsideIgnoredCustomBuildContextPath(relativePath)
  );
}

interface OutputAncestorSnapshot {
  readonly absolutePath: string;
  readonly stat: fs.BigIntStats;
}

function captureAbsentCallerOwnedOutputRoot(outputRoot: string): readonly OutputAncestorSnapshot[] {
  if (!path.isAbsolute(outputRoot) || path.resolve(outputRoot) !== outputRoot) {
    throw new Error("Bundled harness output root must be one canonical absolute path");
  }
  if (fs.existsSync(outputRoot)) {
    throw new Error("Bundled harness output root must not already exist");
  }

  const parent = path.dirname(outputRoot);
  const currentUid = typeof process.geteuid === "function" ? process.geteuid() : undefined;
  const ancestors: OutputAncestorSnapshot[] = [];
  let candidate = parent;
  while (true) {
    const stat = fs.lstatSync(candidate, { bigint: true });
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error("Bundled harness output ancestors must be regular directories");
    }
    if (candidate === parent && currentUid !== undefined && stat.uid !== BigInt(currentUid)) {
      throw new Error("Bundled harness output parent must be owned by the current user");
    }
    ancestors.push(Object.freeze({ absolutePath: candidate, stat }));
    const next = path.dirname(candidate);
    if (next === candidate) break;
    candidate = next;
  }
  return Object.freeze(ancestors);
}

function assertOutputAncestorsUnchanged(ancestors: readonly OutputAncestorSnapshot[]): void {
  ancestors.forEach(({ absolutePath, stat }) => {
    const current = fs.lstatSync(absolutePath, { bigint: true });
    if (
      current.isSymbolicLink() ||
      !current.isDirectory() ||
      !loadHarnessPackageTreeModule().sameDirectoryIdentity(stat, current)
    ) {
      throw new Error("Bundled harness output ancestor changed during materialization");
    }
  });
}

function ensureDirectory(destination: string): void {
  fs.mkdirSync(destination, { mode: 0o755, recursive: true });
  fs.chmodSync(destination, 0o755);
}

export function makeManagedOutputWritable(outputRoot: string): void {
  if (!fs.existsSync(outputRoot)) return;
  const stat = fs.lstatSync(outputRoot);
  if (stat.isSymbolicLink() || !stat.isDirectory()) return;
  fs.chmodSync(outputRoot, 0o700);
  fs.readdirSync(outputRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .forEach((entry) => makeManagedOutputWritable(path.join(outputRoot, entry.name)));
}

function assertUniqueDestination(destinationPath: string, destinationFiles: Set<string>): void {
  const key = duplicateKey(destinationPath);
  if (destinationFiles.has(key)) {
    throw new Error(`Bundled harness mapping writes '${destinationPath}' more than once`);
  }
  destinationFiles.add(key);
}

function readStableSourceFile(sourcePath: string): {
  readonly bytes: Buffer;
  readonly mode: number;
} {
  const before = fs.lstatSync(sourcePath, { bigint: true });
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new Error(`Bundled harness source '${sourcePath}' must be one regular file`);
  }
  if (typeof fs.constants.O_NOFOLLOW !== "number") {
    throw new Error("Bundled harness builds require O_NOFOLLOW support");
  }
  const descriptor = fs.openSync(sourcePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (!loadHarnessPackageTreeModule().sameSnapshot(before, opened)) {
      throw new Error(`Bundled harness source '${sourcePath}' changed before reading`);
    }
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor, { bigint: true });
    const current = fs.lstatSync(sourcePath, { bigint: true });
    if (
      !loadHarnessPackageTreeModule().sameSnapshot(opened, after) ||
      !loadHarnessPackageTreeModule().sameSnapshot(after, current)
    ) {
      throw new Error(`Bundled harness source '${sourcePath}' changed while reading`);
    }
    return { bytes, mode: Number(after.mode & 0o111n) === 0 ? 0o644 : 0o755 };
  } finally {
    fs.closeSync(descriptor);
  }
}

function copyStableFile(
  sourcePath: string,
  destinationPath: string,
  destinationRelativePath: string,
  destinationFiles: Set<string>,
): void {
  assertUniqueDestination(destinationRelativePath, destinationFiles);
  const source = readStableSourceFile(sourcePath);
  ensureDirectory(path.dirname(destinationPath));
  fs.writeFileSync(destinationPath, source.bytes, { flag: "wx", mode: 0o600 });
  fs.chmodSync(destinationPath, source.mode);
}

function copyStableTree(
  sourceRoot: string,
  destinationRoot: string,
  destinationRelativeRoot: string,
  destinationFiles: Set<string>,
): void {
  const walk = (
    sourceDirectory: string,
    destinationDirectory: string,
    relativeDirectory: string,
  ) => {
    const before = fs.lstatSync(sourceDirectory, { bigint: true });
    if (before.isSymbolicLink() || !before.isDirectory()) {
      throw new Error(`Bundled harness source '${sourceDirectory}' must be one regular directory`);
    }
    const entries = fs
      .readdirSync(sourceDirectory, { withFileTypes: true })
      .sort((left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)));
    for (const entry of entries) {
      assertCanonicalName(entry.name);
      const sourcePath = path.join(sourceDirectory, entry.name);
      const destinationPath = path.join(destinationDirectory, entry.name);
      const destinationRelativePath = `${relativeDirectory}/${entry.name}`;
      const sourceStat = fs.lstatSync(sourcePath, { bigint: true });
      if (sourceStat.isSymbolicLink()) {
        throw new Error(`Bundled harness source '${sourcePath}' must not be a symbolic link`);
      }
      if (sourceStat.isDirectory()) {
        if (!isOmittedAuthoringPath(destinationRelativePath, "directory")) {
          walk(sourcePath, destinationPath, destinationRelativePath);
        }
      } else if (sourceStat.isFile()) {
        if (!isOmittedAuthoringPath(destinationRelativePath, "file")) {
          copyStableFile(sourcePath, destinationPath, destinationRelativePath, destinationFiles);
        }
      } else {
        throw new Error(
          `Bundled harness source '${sourcePath}' must be a regular file or directory`,
        );
      }
    }
    const after = fs.lstatSync(sourceDirectory, { bigint: true });
    if (!loadHarnessPackageTreeModule().sameSnapshot(before, after)) {
      throw new Error(`Bundled harness source '${sourceDirectory}' changed while copying`);
    }
  };

  walk(sourceRoot, destinationRoot, destinationRelativeRoot);
}

function assertMappingAuthority(mappings: readonly BundledAgentRuntimeSourceMapping[]): void {
  const destinations = mappings.map(({ destinationPath }) =>
    normalizedRelativePath(destinationPath, "Bundled harness destination"),
  );
  for (const [index, destination] of destinations.entries()) {
    for (const other of destinations.slice(index + 1)) {
      if (
        destination === other ||
        destination.startsWith(`${other}/`) ||
        other.startsWith(`${destination}/`)
      ) {
        throw new Error(`Bundled harness mappings overlap at '${destination}' and '${other}'`);
      }
    }
  }
}

function copyMapping(
  repositoryRoot: string,
  mapping: BundledAgentRuntimeSourceMapping,
  packageRoot: string,
  destinationFiles: Set<string>,
): void {
  const sourcePath = assertReviewedSourcePath(repositoryRoot, mapping.sourcePath);
  const destinationRelativePath = normalizedRelativePath(
    mapping.destinationPath,
    "Bundled harness destination",
  );
  const destinationPath = resolveContained(
    packageRoot,
    destinationRelativePath,
    "Bundled harness destination",
  );
  if (isInsideIgnoredCustomBuildContextPath(destinationRelativePath)) {
    throw new Error(`Bundled harness destination '${destinationRelativePath}' is sensitive`);
  }
  if (mapping.sourceType === "tree") {
    copyStableTree(sourcePath, destinationPath, destinationRelativePath, destinationFiles);
    return;
  }
  copyStableFile(sourcePath, destinationPath, destinationRelativePath, destinationFiles);
}

function makeArtifactReadOnly(packageRoot: string): void {
  const directories: string[] = [packageRoot];
  const visit = (directory: string): void => {
    fs.readdirSync(directory, { withFileTypes: true }).forEach((entry) => {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        directories.push(target);
        visit(target);
      } else {
        const mode = Number(fs.lstatSync(target, { bigint: true }).mode & 0o111n);
        fs.chmodSync(target, mode === 0 ? 0o444 : 0o555);
      }
    });
  };
  visit(packageRoot);
  directories.reverse().forEach((directory) => fs.chmodSync(directory, 0o555));
}

function buildEnvelope(source: BundledAgentRuntimeSource): HarnessPackageEnvelope {
  return {
    schemaVersion: 1,
    kind: "agent-runtime",
    id: source.id,
    displayName: source.displayName,
    packageVersion: source.packageVersion,
    manifest: source.manifestPath,
  };
}

function buildArtifact(
  repositoryRoot: string,
  source: BundledAgentRuntimeSource,
  outputRoot: string,
): BuiltHarnessArtifact {
  const packageRoot = path.join(outputRoot, `nemoclaw-${source.id}`);
  ensureDirectory(packageRoot);
  assertMappingAuthority(source.mappings);
  const destinationFiles = new Set<string>();
  for (const mapping of source.mappings) {
    copyMapping(repositoryRoot, mapping, packageRoot, destinationFiles);
  }

  const metadataPath = path.join(packageRoot, "nemoclaw-package.json");
  assertUniqueDestination("nemoclaw-package.json", destinationFiles);
  fs.writeFileSync(metadataPath, `${JSON.stringify(buildEnvelope(source), null, 2)}\n`, {
    flag: "wx",
    mode: 0o644,
  });
  fs.chmodSync(metadataPath, 0o644);

  makeArtifactReadOnly(packageRoot);

  const parsed = loadHarnessPackageManifestModule().parseHarnessPackageManifest(packageRoot);
  if (
    parsed.envelope.id !== source.id ||
    parsed.envelope.packageVersion !== source.packageVersion ||
    parsed.envelope.manifest !== source.manifestPath
  ) {
    throw new Error(`Bundled harness '${source.id}' did not preserve its declared identity`);
  }
  const validated = loadHarnessPackageTreeModule().validateHarnessPackageTree(packageRoot, {
    sourceTrust: "reviewed",
  });
  return Object.freeze({ id: source.id, packageRoot, contentDigest: validated.contentDigest });
}

/** Replace only the managed distribution subtree with reviewed bundled harness artifacts. */
export function cleanBundledHarnesses(): void {
  assertManagedOutputRoot(BUNDLED_HARNESS_OUTPUT_ROOT);
  makeManagedOutputWritable(BUNDLED_HARNESS_OUTPUT_ROOT);
  fs.rmSync(BUNDLED_HARNESS_OUTPUT_ROOT, { recursive: true, force: true });
}

/** Materialize reviewed artifacts into one absent, caller-owned output root without replacing it. */
export function materializeBundledHarnesses(
  outputRoot: string,
  authoringRepositoryRoot = REPOSITORY_ROOT,
): readonly BuiltHarnessArtifact[] {
  const repositoryRoot = assertAuthoringRepositoryRoot(authoringRepositoryRoot);
  const ancestors = captureAbsentCallerOwnedOutputRoot(outputRoot);
  fs.mkdirSync(outputRoot, { mode: 0o755 });
  fs.chmodSync(outputRoot, 0o755);
  const outputStat = fs.lstatSync(outputRoot);
  if (outputStat.isSymbolicLink() || !outputStat.isDirectory()) {
    throw new Error("Bundled harness output root must remain one regular directory");
  }
  assertOutputAncestorsUnchanged(ancestors);
  return Object.freeze(
    listBundledAgentRuntimeSources(repositoryRoot).map((source) =>
      buildArtifact(repositoryRoot, source, outputRoot),
    ),
  );
}

/** Replace only the managed distribution subtree with reviewed bundled harness artifacts. */
export function buildBundledHarnesses(): readonly BuiltHarnessArtifact[] {
  cleanBundledHarnesses();
  ensureDirectory(DISTRIBUTION_ROOT);
  return materializeBundledHarnesses(BUNDLED_HARNESS_OUTPUT_ROOT);
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const [command, ...unexpectedArguments] = process.argv.slice(2);
  if (unexpectedArguments.length > 0 || (command !== undefined && command !== "--clean")) {
    throw new Error("Usage: tsx scripts/build-harnesses.mts [--clean]");
  }
  if (command === "--clean") {
    cleanBundledHarnesses();
  } else {
    for (const artifact of buildBundledHarnesses()) {
      console.log(`${artifact.id} ${artifact.contentDigest}`);
    }
  }
}
