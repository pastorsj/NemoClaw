#!/usr/bin/env -S node --experimental-strip-types --no-warnings
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseDocument } from "yaml";

import { assertHarnessAdapterArtifactsCurrent } from "./build-adapters.mts";

const PACKAGE_JSON = "package.json";
const REQUIRED_ROOT_FILES = Object.freeze([
  PACKAGE_JSON,
  "manifest.yaml",
  "Dockerfile.base",
  "Dockerfile",
  "start.sh",
  "policy-additions.yaml",
]);
const ADAPTER_FILE = /^[a-z][a-z0-9-]*-adapter\.cts$/u;
const HARNESS_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const PACKAGE_SCOPE = /^[a-z0-9][a-z0-9._-]*$/u;
const MAX_PACKAGE_JSON_BYTES = 128 * 1024;
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_MANIFEST_DEPTH = 16;
const MAX_MANIFEST_NODES = 10_000;
const MAX_MAPPING_ENTRIES = 512;
const MAX_SEQUENCE_ENTRIES = 512;
const MAX_KEY_LENGTH = 128;
const MAX_STRING_LENGTH = 32 * 1024;
const MAX_PACK_FILES = 50_000;
const MAX_PACK_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_PACKED_BYTES = 1024 * 1024 * 1024;
const MAX_RELATIVE_PATH_BYTES = 1024;
const MAX_RELATIVE_PATH_DEPTH = 32;
const PACK_TIMEOUT_MILLISECONDS = 90_000;

const AUTHORING_DIRECTORY_NAMES = new Set([
  ".e2e",
  ".git",
  ".github",
  "__tests__",
  "coverage",
  "node_modules",
  "test",
  "tests",
]);
const AUTHORING_ROOT_FILES = new Set(["coverage-threshold.json", "package-lock.json"]);
const CREDENTIAL_FILE_NAMES = new Set([
  ".netrc",
  ".npmrc",
  ".pypirc",
  "auth.json",
  "credentials.json",
  "id_ed25519",
  "id_rsa",
  "secrets.json",
  "token.json",
]);
const UNSAFE_MANIFEST_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const WINDOWS_RESERVED_NAME = /^(?:aux|con|nul|prn|com[1-9]|lpt[1-9])(?:\..*)?$/iu;
const WINDOWS_RESERVED_CHARACTERS = /[<>:"|?*]/u;

export type HarnessPackageDiagnosticCode =
  | "adapter-artifact"
  | "archive"
  | "archive-authoring-path"
  | "archive-credential-path"
  | "archive-membership"
  | "file-type"
  | "manifest"
  | "manifest-identity"
  | "metadata"
  | "package-root"
  | "start-mode";

export interface HarnessPackageDiagnostic {
  readonly code: HarnessPackageDiagnosticCode;
  readonly path: string;
  readonly message: string;
}

export interface HarnessPackageConformanceReport {
  readonly harnessId: string;
  readonly displayName: string;
  readonly packageName: string;
  readonly packageVersion: string;
  readonly minimumNemoClawVersion: string;
  readonly manifestPath: string;
  readonly adapterArtifacts: readonly string[];
  readonly packedFiles: readonly string[];
  readonly publishedFiles: readonly HarnessPackagePublishedFile[];
}

export interface HarnessPackagePublishedFile {
  readonly path: string;
  readonly size: number;
  readonly executable: boolean;
}

export class HarnessPackageConformanceError extends Error {
  readonly diagnostics: readonly HarnessPackageDiagnostic[];

  constructor(diagnostics: readonly HarnessPackageDiagnostic[]) {
    super(formatDiagnostics(diagnostics));
    this.name = "HarnessPackageConformanceError";
    this.diagnostics = Object.freeze([...diagnostics]);
  }
}

interface PackageMetadata {
  readonly name: string;
  readonly version: string;
  readonly nemoclaw: {
    readonly harnessManifest: string;
    readonly minimumNemoClawVersion: string;
  };
}

interface ParsedManifest {
  readonly displayName: string;
  readonly value: Readonly<Record<string, unknown>>;
}

interface NpmPackFile {
  readonly path: string;
  readonly size: number;
  readonly mode: number;
}

interface NpmPackResult {
  readonly name: string;
  readonly version: string;
  readonly files: readonly NpmPackFile[];
}

function diagnostic(
  code: HarnessPackageDiagnosticCode,
  relativePath: string,
  message: string,
): HarnessPackageConformanceError {
  return new HarnessPackageConformanceError([Object.freeze({ code, path: relativePath, message })]);
}

function formatDiagnostics(diagnostics: readonly HarnessPackageDiagnostic[]): string {
  const lines = diagnostics.map(
    ({ code, path: relativePath, message }) => `- [${code}] ${relativePath}: ${message}`,
  );
  return `Harness package validation failed:\n${lines.join("\n")}`;
}

function assertPlainRecord(
  value: unknown,
  code: HarnessPackageDiagnosticCode,
  relativePath: string,
  message: string,
): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw diagnostic(code, relativePath, message);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw diagnostic(code, relativePath, message);
  }
}

function readBoundedUtf8File(
  packageRoot: string,
  relativePath: string,
  maximumBytes: number,
): string {
  const absolutePath = path.join(packageRoot, relativePath);
  const stats = fs.lstatSync(absolutePath);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw diagnostic(
      "file-type",
      relativePath,
      "must be a regular file, not a link or special file",
    );
  }
  if (stats.size === 0 || stats.size > maximumBytes) {
    throw diagnostic(
      relativePath === PACKAGE_JSON ? "metadata" : "manifest",
      relativePath,
      `must contain between 1 and ${String(maximumBytes)} bytes`,
    );
  }
  return fs.readFileSync(absolutePath, "utf8");
}

function assertRequiredRootFiles(packageRoot: string): void {
  for (const relativePath of REQUIRED_ROOT_FILES) {
    const absolutePath = path.join(packageRoot, relativePath);
    let stats: fs.Stats;
    try {
      stats = fs.lstatSync(absolutePath);
    } catch {
      throw diagnostic("file-type", relativePath, "required package file is missing");
    }
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw diagnostic(
        "file-type",
        relativePath,
        "required package file must be a regular file, not a link or special file",
      );
    }
    if (stats.size === 0) {
      throw diagnostic("file-type", relativePath, "required package file must not be empty");
    }
  }
  const startMode = fs.statSync(path.join(packageRoot, "start.sh")).mode;
  if ((startMode & 0o111) === 0) {
    throw diagnostic("start-mode", "start.sh", "must have at least one executable mode bit");
  }
}

function packageIdentity(packageName: string): string | null {
  if (packageName.length === 0 || packageName.length > 214) return null;
  const parts = packageName.split("/");
  let baseName: string;
  if (parts.length === 1) {
    [baseName] = parts;
  } else if (
    parts.length === 2 &&
    parts[0].startsWith("@") &&
    PACKAGE_SCOPE.test(parts[0].slice(1))
  ) {
    baseName = parts[1];
  } else {
    return null;
  }
  if (!baseName.startsWith("nemoclaw-")) return null;
  const id = baseName.slice("nemoclaw-".length);
  return id.length <= 63 && HARNESS_ID.test(id) ? id : null;
}

function isSemverIdentifierList(value: string, allowNumericLeadingZero: boolean): boolean {
  if (value.length === 0) return false;
  return value.split(".").every((identifier) => {
    if (!/^[0-9A-Za-z-]+$/u.test(identifier)) return false;
    if (!allowNumericLeadingZero && /^\d+$/u.test(identifier)) {
      return identifier === "0" || !identifier.startsWith("0");
    }
    return true;
  });
}

function isExactSemanticVersion(version: string): boolean {
  if (version.length === 0 || version.length > 128) return false;
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([^+]+))?(?:\+(.+))?$/u.exec(version);
  if (!match) return false;
  const prerelease = match[4];
  const build = match[5];
  return (
    (prerelease === undefined || isSemverIdentifierList(prerelease, false)) &&
    (build === undefined || isSemverIdentifierList(build, true))
  );
}

function isExactCoreVersion(version: string): boolean {
  return /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(version);
}

function readPackageMetadata(
  packageRoot: string,
): PackageMetadata & { readonly harnessId: string } {
  const source = readBoundedUtf8File(packageRoot, PACKAGE_JSON, MAX_PACKAGE_JSON_BYTES);
  let parsed: unknown;
  try {
    parsed = JSON.parse(source) as unknown;
  } catch {
    throw diagnostic("metadata", PACKAGE_JSON, "must contain valid JSON");
  }
  assertPlainRecord(parsed, "metadata", PACKAGE_JSON, "must contain one JSON object");
  if (typeof parsed.name !== "string") {
    throw diagnostic("metadata", PACKAGE_JSON, "name must identify a nemoclaw-<id> package");
  }
  const harnessId = packageIdentity(parsed.name);
  if (harnessId === null) {
    throw diagnostic(
      "metadata",
      PACKAGE_JSON,
      "name must be nemoclaw-<id> or @scope/nemoclaw-<id> using lowercase safe characters",
    );
  }
  if (typeof parsed.version !== "string" || !isExactSemanticVersion(parsed.version)) {
    throw diagnostic("metadata", PACKAGE_JSON, "version must be one exact Semantic Version");
  }
  assertPlainRecord(
    parsed.nemoclaw,
    "metadata",
    PACKAGE_JSON,
    "nemoclaw must contain the harness manifest declaration",
  );
  if (parsed.nemoclaw.harnessManifest !== "manifest.yaml") {
    throw diagnostic(
      "metadata",
      PACKAGE_JSON,
      'nemoclaw.harnessManifest must be the package-root file "manifest.yaml"',
    );
  }
  if (
    typeof parsed.nemoclaw.minimumNemoClawVersion !== "string" ||
    !isExactCoreVersion(parsed.nemoclaw.minimumNemoClawVersion)
  ) {
    throw diagnostic(
      "metadata",
      PACKAGE_JSON,
      "nemoclaw.minimumNemoClawVersion must be one exact x.y.z version",
    );
  }
  return Object.freeze({
    name: parsed.name,
    version: parsed.version,
    nemoclaw: Object.freeze({
      harnessManifest: "manifest.yaml",
      minimumNemoClawVersion: parsed.nemoclaw.minimumNemoClawVersion,
    }),
    harnessId,
  });
}

function assertBoundedManifestValue(value: unknown): void {
  let nodes = 0;
  const visit = (current: unknown, depth: number): void => {
    nodes += 1;
    if (nodes > MAX_MANIFEST_NODES) {
      throw diagnostic("manifest", "manifest.yaml", "contains too many YAML values");
    }
    if (depth > MAX_MANIFEST_DEPTH) {
      throw diagnostic("manifest", "manifest.yaml", "exceeds the maximum YAML nesting depth");
    }
    if (current === null || typeof current === "boolean") return;
    if (typeof current === "number") {
      if (!Number.isFinite(current)) {
        throw diagnostic("manifest", "manifest.yaml", "numbers must be finite");
      }
      return;
    }
    if (typeof current === "string") {
      if (current.length > MAX_STRING_LENGTH || /[\u0000]/u.test(current)) {
        throw diagnostic("manifest", "manifest.yaml", "contains an invalid or oversized string");
      }
      return;
    }
    if (Array.isArray(current)) {
      if (current.length > MAX_SEQUENCE_ENTRIES) {
        throw diagnostic("manifest", "manifest.yaml", "contains an oversized YAML sequence");
      }
      current.forEach((entry) => visit(entry, depth + 1));
      return;
    }
    assertPlainRecord(
      current,
      "manifest",
      "manifest.yaml",
      "may contain only mappings, sequences, and JSON-compatible scalar values",
    );
    const entries = Object.entries(current);
    if (entries.length > MAX_MAPPING_ENTRIES) {
      throw diagnostic("manifest", "manifest.yaml", "contains an oversized YAML mapping");
    }
    for (const [key, entry] of entries) {
      if (
        key.length === 0 ||
        key.length > MAX_KEY_LENGTH ||
        key !== key.normalize("NFC") ||
        /[\u0000-\u001f\u007f-\u009f]/u.test(key) ||
        UNSAFE_MANIFEST_KEYS.has(key)
      ) {
        throw diagnostic("manifest", "manifest.yaml", "contains an unsafe mapping key");
      }
      visit(entry, depth + 1);
    }
  };
  visit(value, 0);
}

function readManifest(packageRoot: string, expectedHarnessId: string): ParsedManifest {
  const source = readBoundedUtf8File(packageRoot, "manifest.yaml", MAX_MANIFEST_BYTES);
  const document = parseDocument(source, {
    prettyErrors: false,
    schema: "core",
    strict: true,
    uniqueKeys: true,
  });
  if (document.errors.length > 0 || document.warnings.length > 0) {
    throw diagnostic(
      "manifest",
      "manifest.yaml",
      "must contain unambiguous YAML using the core schema",
    );
  }
  let value: unknown;
  try {
    value = document.toJS({ maxAliasCount: 0 }) as unknown;
  } catch {
    throw diagnostic("manifest", "manifest.yaml", "must not contain YAML aliases");
  }
  assertBoundedManifestValue(value);
  assertPlainRecord(value, "manifest", "manifest.yaml", "must contain one YAML mapping");
  if (value.name !== expectedHarnessId) {
    throw diagnostic(
      "manifest-identity",
      "manifest.yaml",
      `name must exactly match package harness id ${JSON.stringify(expectedHarnessId)}`,
    );
  }
  if (value.display_name === undefined) {
    return Object.freeze({ displayName: expectedHarnessId, value: Object.freeze(value) });
  }
  if (
    typeof value.display_name !== "string" ||
    value.display_name.trim().length === 0 ||
    value.display_name.length > 128 ||
    Buffer.byteLength(value.display_name, "utf8") > 512 ||
    /[\p{Cc}\p{Cf}\p{Cs}]/u.test(value.display_name)
  ) {
    throw diagnostic("manifest", "manifest.yaml", "display_name must be one bounded safe string");
  }
  return Object.freeze({ displayName: value.display_name, value: Object.freeze(value) });
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requiredAdapterArtifacts(
  manifest: Readonly<Record<string, unknown>>,
): readonly string[] {
  const required = ["host/config-adapter.cts"];
  if (isRecord(manifest.mcp) && manifest.mcp.support === "bridge") {
    required.push("host/mcp-adapter.cts");
  }
  if (manifest.managed_image !== undefined) {
    required.push("host/startup-adapter.cts");
  }
  if (
    Array.isArray(manifest.state_files) &&
    manifest.state_files.some(
      (entry) =>
        isRecord(entry) &&
        isRecord(entry.restore) &&
        entry.restore.merge === "package-config",
    )
  ) {
    required.push("host/restore-adapter.cts");
  }
  return Object.freeze(required);
}

function assertRequiredAdapterArtifacts(
  artifacts: readonly string[],
  manifest: Readonly<Record<string, unknown>>,
): void {
  const available = new Set(artifacts);
  for (const relativePath of requiredAdapterArtifacts(manifest)) {
    if (!available.has(relativePath)) {
      throw diagnostic(
        "adapter-artifact",
        relativePath,
        "manifest capabilities require this compiled adapter artifact",
      );
    }
  }
}

function safeRelativePath(value: unknown): string {
  if (typeof value !== "string") {
    throw diagnostic("archive", "<archive>", "npm returned a non-string archive path");
  }
  const bytes = Buffer.byteLength(value, "utf8");
  const segments = value.split("/");
  if (
    value.length === 0 ||
    bytes > MAX_RELATIVE_PATH_BYTES ||
    path.posix.isAbsolute(value) ||
    value.includes("\\") ||
    value !== value.normalize("NFC") ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(value) ||
    segments.length > MAX_RELATIVE_PATH_DEPTH ||
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === "." ||
        segment === ".." ||
        segment.endsWith(".") ||
        segment.endsWith(" ") ||
        WINDOWS_RESERVED_NAME.test(segment) ||
        WINDOWS_RESERVED_CHARACTERS.test(segment),
    ) ||
    path.posix.normalize(value) !== value
  ) {
    throw diagnostic("archive", "<archive>", "npm returned an unsafe archive path");
  }
  return value;
}

function assertRegularPackedFile(packageRoot: string, relativePath: string): fs.Stats {
  const segments = relativePath.split("/");
  let cursor = packageRoot;
  for (const [index, segment] of segments.entries()) {
    cursor = path.join(cursor, segment);
    let stats: fs.Stats;
    try {
      stats = fs.lstatSync(cursor);
    } catch {
      throw diagnostic(
        "archive",
        relativePath,
        "archive member does not exist in the package tree",
      );
    }
    if (stats.isSymbolicLink()) {
      throw diagnostic(
        "file-type",
        relativePath,
        "archive member must not traverse a symbolic link",
      );
    }
    if (index < segments.length - 1 && !stats.isDirectory()) {
      throw diagnostic("file-type", relativePath, "archive member parent must be a directory");
    }
    if (index === segments.length - 1 && !stats.isFile()) {
      throw diagnostic("file-type", relativePath, "archive member must be a regular file");
    }
  }
  return fs.statSync(cursor);
}

function isAuthoringPath(relativePath: string): boolean {
  const segments = relativePath.toLowerCase().split("/");
  if (segments.some((segment) => AUTHORING_DIRECTORY_NAMES.has(segment))) return true;
  if (segments.length >= 2 && segments[0] === "host" && segments[1] === "source") return true;
  const fileName = segments.at(-1) ?? "";
  return (
    relativePath === "nemoclaw-package.json" ||
    (segments.length === 1 && AUTHORING_ROOT_FILES.has(fileName)) ||
    /^tsconfig(?:\.[^.]+)*\.json$/u.test(fileName) ||
    /^(?:vitest|jest)(?:\.[^.]+)*\.(?:[cm]?[jt]s|json)$/u.test(fileName) ||
    /(?:^test_[^/]+\.py$|\.(?:test|spec)\.[cm]?[jt]sx?$)/u.test(fileName)
  );
}

function isCredentialPath(relativePath: string): boolean {
  const fileName = relativePath.toLowerCase().split("/").at(-1) ?? "";
  return (
    CREDENTIAL_FILE_NAMES.has(fileName) ||
    fileName === ".env" ||
    fileName.startsWith(".env.") ||
    fileName.endsWith(".env") ||
    /\.(?:key|p12|pem|pfx)$/u.test(fileName)
  );
}

function parseNpmPackResult(stdout: string): NpmPackResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout) as unknown;
  } catch {
    throw diagnostic("archive", "<archive>", "npm pack did not return bounded JSON");
  }
  if (!Array.isArray(parsed) || parsed.length !== 1) {
    throw diagnostic("archive", "<archive>", "npm pack must describe exactly one package");
  }
  const [entry] = parsed;
  assertPlainRecord(entry, "archive", "<archive>", "npm pack returned an invalid package record");
  if (typeof entry.name !== "string" || typeof entry.version !== "string") {
    throw diagnostic("archive", "<archive>", "npm pack omitted package identity");
  }
  if (
    !Array.isArray(entry.files) ||
    entry.files.length === 0 ||
    entry.files.length > MAX_PACK_FILES
  ) {
    throw diagnostic("archive", "<archive>", "npm pack returned an invalid number of files");
  }
  const files = entry.files.map((file): NpmPackFile => {
    assertPlainRecord(file, "archive", "<archive>", "npm pack returned an invalid file record");
    const relativePath = safeRelativePath(file.path);
    if (
      typeof file.size !== "number" ||
      !Number.isSafeInteger(file.size) ||
      file.size < 0 ||
      typeof file.mode !== "number" ||
      !Number.isSafeInteger(file.mode) ||
      file.mode < 0
    ) {
      throw diagnostic("archive", relativePath, "npm pack returned invalid file metadata");
    }
    return Object.freeze({ path: relativePath, size: file.size, mode: file.mode });
  });
  return Object.freeze({ name: entry.name, version: entry.version, files: Object.freeze(files) });
}

function inspectPackedFiles(
  packageRoot: string,
  metadata: PackageMetadata,
  expectedArtifacts: readonly string[],
): readonly HarnessPackagePublishedFile[] {
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  const result = spawnSync(npmCommand, ["pack", "--dry-run", "--json", "--ignore-scripts", "."], {
    cwd: packageRoot,
    encoding: "utf8",
    env: { ...process.env, npm_config_ignore_scripts: "true" },
    maxBuffer: MAX_PACK_OUTPUT_BYTES,
    shell: false,
    timeout: PACK_TIMEOUT_MILLISECONDS,
  });
  if (result.error || result.status !== 0) {
    throw diagnostic(
      "archive",
      PACKAGE_JSON,
      "npm pack --dry-run --json --ignore-scripts did not complete successfully",
    );
  }
  const packed = parseNpmPackResult(result.stdout);
  if (packed.name !== metadata.name || packed.version !== metadata.version) {
    throw diagnostic("archive", PACKAGE_JSON, "npm pack reported a different package identity");
  }
  const packedPaths = new Set<string>();
  let totalBytes = 0;
  for (const file of packed.files) {
    if (packedPaths.has(file.path)) {
      throw diagnostic("archive", file.path, "archive path appears more than once");
    }
    packedPaths.add(file.path);
    const stats = assertRegularPackedFile(packageRoot, file.path);
    if (stats.size !== file.size) {
      throw diagnostic("archive", file.path, "npm pack file size differs from the package tree");
    }
    if (file.path === "start.sh" && (file.mode & 0o111) === 0) {
      throw diagnostic(
        "archive-membership",
        file.path,
        "npm must preserve an executable mode for the startup script",
      );
    }
    if (((stats.mode & 0o111) !== 0) !== ((file.mode & 0o111) !== 0)) {
      throw diagnostic("archive", file.path, "npm pack changed the executable mode class");
    }
    totalBytes += file.size;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_PACKED_BYTES) {
      throw diagnostic("archive", "<archive>", "packed package exceeds the size limit");
    }
    if (isAuthoringPath(file.path)) {
      throw diagnostic(
        "archive-authoring-path",
        file.path,
        "authoring and test files must be excluded from the published package",
      );
    }
    if (isCredentialPath(file.path)) {
      throw diagnostic(
        "archive-credential-path",
        file.path,
        "credential-shaped files must be excluded from the published package",
      );
    }
  }
  for (const requiredPath of [...REQUIRED_ROOT_FILES, ...expectedArtifacts]) {
    if (!packedPaths.has(requiredPath)) {
      throw diagnostic(
        "archive-membership",
        requiredPath,
        "required runtime artifact is missing from the npm archive",
      );
    }
  }
  return Object.freeze(
    packed.files
      .map((file) =>
        Object.freeze({
          path: file.path,
          size: file.size,
          executable: (file.mode & 0o111) !== 0,
        }),
      )
      .sort((left, right) => left.path.localeCompare(right.path)),
  );
}

function listAdapterArtifacts(packageRoot: string): readonly string[] {
  const hostRoot = path.join(packageRoot, "host");
  const sourceRoot = path.join(hostRoot, "source");
  if (fs.existsSync(sourceRoot)) {
    const sourceStats = fs.lstatSync(sourceRoot);
    if (sourceStats.isSymbolicLink() || !sourceStats.isDirectory()) {
      throw diagnostic("file-type", "host/source", "must be a regular directory");
    }
    try {
      assertHarnessAdapterArtifactsCurrent(packageRoot);
    } catch {
      throw diagnostic(
        "adapter-artifact",
        "host",
        "typed adapter artifacts are stale or invalid; run nemoclaw-build-adapters .",
      );
    }
  }
  if (!fs.existsSync(hostRoot)) return Object.freeze([]);
  const hostStats = fs.lstatSync(hostRoot);
  if (hostStats.isSymbolicLink() || !hostStats.isDirectory()) {
    throw diagnostic("file-type", "host", "must be a regular directory");
  }
  const artifacts = fs
    .readdirSync(hostRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && ADAPTER_FILE.test(entry.name))
    .map((entry) => `host/${entry.name}`)
    .sort((left, right) => left.localeCompare(right));
  for (const relativePath of artifacts) {
    const stats = fs.lstatSync(path.join(packageRoot, relativePath));
    if (stats.size === 0) {
      throw diagnostic("adapter-artifact", relativePath, "adapter artifact must not be empty");
    }
  }
  return Object.freeze(artifacts);
}

function resolvePackageRoot(packageRootInput: string): string {
  if (
    typeof packageRootInput !== "string" ||
    packageRootInput.length === 0 ||
    packageRootInput.length > 4096 ||
    packageRootInput.includes("\0")
  ) {
    throw diagnostic("package-root", "<package-root>", "must be one bounded filesystem path");
  }
  const packageRoot = path.resolve(packageRootInput);
  let stats: fs.Stats;
  try {
    stats = fs.lstatSync(packageRoot);
  } catch {
    throw diagnostic("package-root", "<package-root>", "does not exist");
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw diagnostic("package-root", "<package-root>", "must be a regular directory");
  }
  return packageRoot;
}

/** Validate a harness package's static authoring and npm archive contract. */
export function validateHarnessPackage(packageRootInput: string): HarnessPackageConformanceReport {
  const packageRoot = resolvePackageRoot(packageRootInput);
  assertRequiredRootFiles(packageRoot);
  const metadata = readPackageMetadata(packageRoot);
  const manifest = readManifest(packageRoot, metadata.harnessId);
  const adapterArtifacts = listAdapterArtifacts(packageRoot);
  assertRequiredAdapterArtifacts(adapterArtifacts, manifest.value);
  const publishedFiles = inspectPackedFiles(packageRoot, metadata, adapterArtifacts);
  return Object.freeze({
    harnessId: metadata.harnessId,
    displayName: manifest.displayName,
    packageName: metadata.name,
    packageVersion: metadata.version,
    minimumNemoClawVersion: metadata.nemoclaw.minimumNemoClawVersion,
    manifestPath: metadata.nemoclaw.harnessManifest,
    adapterArtifacts,
    packedFiles: Object.freeze(publishedFiles.map((file) => file.path)),
    publishedFiles,
  });
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
  const packageArguments = arguments_.filter((argument) => argument !== "--json");
  if (
    packageArguments.length !== 1 ||
    arguments_.filter((argument) => argument === "--json").length > 1 ||
    arguments_.some((argument) => argument.startsWith("-") && argument !== "--json")
  ) {
    process.stderr.write("Usage: nemoclaw-validate-package [--json] <package-root>\n");
    process.exitCode = 2;
    return;
  }
  try {
    const report = validateHarnessPackage(packageArguments[0]);
    process.stdout.write(
      json
        ? `${JSON.stringify(report)}\n`
        : `Harness package ${JSON.stringify(report.harnessId)} conforms (${String(report.packedFiles.length)} packed files).\n`,
    );
  } catch (error) {
    const message =
      error instanceof HarnessPackageConformanceError
        ? error.message
        : "Harness package validation failed unexpectedly.";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}

if (isMainModule()) main();
