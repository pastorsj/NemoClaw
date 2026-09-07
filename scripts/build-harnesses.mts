// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseDocument } from "yaml";

import { assertHarnessAdapterArtifactsCurrent } from "../harness-contract/build-adapters.mts";
import { materializeHarnessPackageArtifact } from "../harness-contract/build-package.mts";
import { directDockerfileContextSources } from "./lib/dockerfile-copy-sources.mts";

type HarnessPackageManifestModule = typeof import("../src/lib/agent-runtime/package/manifest");
type HarnessPackageTreeModule = typeof import("../src/lib/agent-runtime/package/tree");

const requireModule = createRequire(import.meta.url);
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
const HARNESS_PACKAGE_PREFIX = "nemoclaw-";
const PACKAGE_MANIFEST_FILE = "manifest.yaml";
const EXACT_CORE_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;

interface BundledAgentRuntimeSource {
  readonly id: string;
  readonly displayName: string;
  readonly packageVersion: string;
  readonly minimumNemoClawVersion: string;
  readonly maximumNemoClawVersionExclusive: string;
  readonly manifestPath: "manifest.yaml";
  readonly packageRoot: string;
}

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
    readonly minimumNemoClawVersion?: unknown;
    readonly maximumNemoClawVersionExclusive?: unknown;
  };
}

interface DirectorySnapshot {
  readonly path: string;
  readonly stat: fs.BigIntStats;
}

function ensureDirectory(directory: string): void {
  fs.mkdirSync(directory, { mode: 0o755, recursive: true });
  fs.chmodSync(directory, 0o755);
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

function assertDockerfileSourcesExist(repositoryRoot: string, packageRelativePath: string): void {
  for (const dockerfileName of ["Dockerfile", "Dockerfile.base"] as const) {
    const dockerfile = path.posix.join(packageRelativePath, dockerfileName);
    const dockerfilePath = path.join(repositoryRoot, dockerfile);
    if (!fs.existsSync(dockerfilePath)) {
      throw new Error(`Agent runtime package is missing ${dockerfile}`);
    }
    for (const { source } of directDockerfileContextSources(dockerfilePath, dockerfile)) {
      const normalized = source.replace(/\/+$/u, "");
      const matches = /[*?[\]]/u.test(normalized)
        ? fs.globSync(normalized, { cwd: repositoryRoot })
        : [normalized].filter((candidate) => fs.existsSync(path.join(repositoryRoot, candidate)));
      if (matches.length === 0) {
        throw new Error(`Agent runtime Dockerfile COPY source does not exist: ${source}`);
      }
    }
  }
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
        entry.name.startsWith(HARNESS_PACKAGE_PREFIX),
    )
    .flatMap((entry): BundledAgentRuntimeSource[] => {
      const packageRoot = path.join(authoringPackagesRoot, entry.name);
      const packageJson = readAuthoringPackageJson(packageRoot);
      const declaredManifest = packageJson?.nemoclaw?.harnessManifest;
      const minimumNemoClawVersion = packageJson?.nemoclaw?.minimumNemoClawVersion;
      const maximumNemoClawVersionExclusive =
        packageJson?.nemoclaw?.maximumNemoClawVersionExclusive;
      if (declaredManifest === undefined) return [];
      assertHarnessAdapterArtifactsCurrent(packageRoot);
      if (
        declaredManifest !== PACKAGE_MANIFEST_FILE ||
        typeof packageJson?.name !== "string" ||
        packageNameBase(packageJson.name) !== entry.name ||
        typeof packageJson.version !== "string" ||
        typeof minimumNemoClawVersion !== "string" ||
        !EXACT_CORE_VERSION_PATTERN.test(minimumNemoClawVersion) ||
        typeof maximumNemoClawVersionExclusive !== "string" ||
        !EXACT_CORE_VERSION_PATTERN.test(maximumNemoClawVersionExclusive)
      ) {
        throw new Error(`Agent runtime package contract is invalid: ${entry.name}`);
      }
      const id = entry.name.slice(HARNESS_PACKAGE_PREFIX.length);
      const manifestIdentity = readManifestIdentity(path.join(packageRoot, PACKAGE_MANIFEST_FILE));
      if (manifestIdentity.id !== id) {
        throw new Error(`Agent runtime package directory and manifest names differ: ${entry.name}`);
      }
      assertDockerfileSourcesExist(repositoryRoot, path.posix.join("packages", entry.name));
      return [
        Object.freeze({
          id,
          displayName: manifestIdentity.displayName,
          packageVersion: packageJson.version,
          minimumNemoClawVersion,
          maximumNemoClawVersionExclusive,
          manifestPath: PACKAGE_MANIFEST_FILE,
          packageRoot,
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
  for (const target of [DISTRIBUTION_ROOT, outputRoot].filter((candidate) =>
    fs.existsSync(candidate),
  )) {
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
  }
}

function captureAbsentOutputRoot(outputRoot: string): readonly DirectorySnapshot[] {
  if (!path.isAbsolute(outputRoot) || path.resolve(outputRoot) !== outputRoot) {
    throw new Error("Bundled harness output root must be one canonical absolute path");
  }
  if (fs.existsSync(outputRoot)) {
    throw new Error("Bundled harness output root must not already exist");
  }

  const parent = path.dirname(outputRoot);
  const currentUid = typeof process.geteuid === "function" ? process.geteuid() : undefined;
  const ancestors: DirectorySnapshot[] = [];
  let candidate = parent;
  while (true) {
    const stat = fs.lstatSync(candidate, { bigint: true });
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error("Bundled harness output ancestors must be regular directories");
    }
    if (candidate === parent && currentUid !== undefined && stat.uid !== BigInt(currentUid)) {
      throw new Error("Bundled harness output parent must be owned by the current user");
    }
    ancestors.push(Object.freeze({ path: candidate, stat }));
    const next = path.dirname(candidate);
    if (next === candidate) break;
    candidate = next;
  }
  return Object.freeze(ancestors);
}

function assertOutputAncestorsUnchanged(ancestors: readonly DirectorySnapshot[]): void {
  for (const snapshot of ancestors) {
    const current = fs.lstatSync(snapshot.path, { bigint: true });
    if (
      current.isSymbolicLink() ||
      !current.isDirectory() ||
      !loadHarnessPackageTreeModule().sameDirectoryIdentity(snapshot.stat, current)
    ) {
      throw new Error("Bundled harness output ancestor changed during materialization");
    }
  }
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

function buildArtifact(
  source: BundledAgentRuntimeSource,
  outputRoot: string,
): BuiltHarnessArtifact {
  const packageRoot = path.join(outputRoot, `${HARNESS_PACKAGE_PREFIX}${source.id}`);
  const materialized = materializeHarnessPackageArtifact(source.packageRoot, packageRoot);
  const parsed = loadHarnessPackageManifestModule().parseHarnessPackageManifest(packageRoot);
  if (
    materialized.harnessId !== source.id ||
    parsed.envelope.id !== source.id ||
    parsed.envelope.packageVersion !== source.packageVersion ||
    parsed.envelope.manifest !== PACKAGE_MANIFEST_FILE
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

/** Materialize each reviewed npm package through the public package artifact builder. */
export function materializeBundledHarnesses(
  outputRoot: string,
  authoringRepositoryRoot = REPOSITORY_ROOT,
): readonly BuiltHarnessArtifact[] {
  const repositoryRoot = assertAuthoringRepositoryRoot(authoringRepositoryRoot);
  const ancestors = captureAbsentOutputRoot(outputRoot);
  fs.mkdirSync(outputRoot, { mode: 0o755 });
  fs.chmodSync(outputRoot, 0o755);
  assertOutputAncestorsUnchanged(ancestors);
  const artifacts = listBundledAgentRuntimeSources(repositoryRoot).map((source) =>
    buildArtifact(source, outputRoot),
  );
  assertOutputAncestorsUnchanged(ancestors);
  return Object.freeze(artifacts);
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
