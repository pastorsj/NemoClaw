#!/usr/bin/env -S node --experimental-strip-types --no-warnings
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseDocument } from "yaml";
import type { HarnessWebSearchProviderBinding } from "./src/manifest.ts";

type ManifestValidatorModule = typeof import("./src/manifest-validator.ts");
type ProviderProfileValidatorModule = typeof import("./src/provider-profile.ts");

const require = createRequire(import.meta.url);
const sourceModule = fileURLToPath(import.meta.url).endsWith(".mts");
const manifestValidator = require(
  fileURLToPath(
    new URL(
      sourceModule ? "./dist/src/manifest-validator.js" : "./src/manifest-validator.js",
      import.meta.url,
    ),
  ),
) as ManifestValidatorModule;
const { HarnessManifestValidationError, validateHarnessManifest } = manifestValidator;
const { assertHarnessWebSearchProviderProfile } = require(
  fileURLToPath(
    new URL(
      sourceModule ? "./dist/src/provider-profile.js" : "./src/provider-profile.js",
      import.meta.url,
    ),
  ),
) as ProviderProfileValidatorModule;

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
const MAX_POLICY_PRESET_BYTES = 1024 * 1024;
const MAX_MANIFEST_DEPTH = 16;
const MAX_MANIFEST_NODES = 8192;
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
const MAX_BUILD_PROJECTS = 8;
const MAX_BUILD_PROJECT_PATH_BYTES = 128;
const MAX_BUILD_CONFIG_BYTES = 128 * 1024;
const MAX_EXTENDED_BUILD_CONFIGS = 16;
const BUILD_PROJECT_PATH = /^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/u;
const TYPESCRIPT_CONFIG_FILE = /^tsconfig(?:\.[a-z0-9_-]+)*\.json$/iu;
const TEST_CONFIG_TERM =
  /(?:^|[^a-z0-9])(?:__tests__|e2e|jest|spec|specs|test|tests|vitest)(?:[^a-z0-9]|$)/iu;

// Package Dockerfiles are composed with this small, core-owned build kit. A
// package may evolve freely beneath its own packages/nemoclaw-<id>/ prefix,
// while every dependency on NemoClaw core remains explicit here.
const CORE_BUILD_CONTEXT_DIRECTORIES = Object.freeze([
  "nemoclaw-blueprint/",
  "packages/nemoclaw-fabric/",
  "tools/mcp-tool-discovery-runtime/",
]);
const CORE_BUILD_CONTEXT_FILES = new Set([
  "ci/npm-audit-exceptions.json",
  "ci/reviewed-npm-audit.json",
  "scripts/checks/materialize-locked-npm-cache-seed.mts",
  "scripts/checks/verify-openshell-policy-boundary-dependencies.mts",
  "scripts/gateway-control.sh",
  "scripts/lib/bundled-npm-package.mts",
  "scripts/lib/corporate-ca-runtime.sh",
  "scripts/lib/entrypoint-env-wrapper.sh",
  "scripts/lib/gateway-supervisor.sh",
  "scripts/lib/npm-audit-receipt.mts",
  "scripts/lib/patch-bundled-npm-ip-address.mts",
  "scripts/lib/reviewed-npm-archive.mts",
  "scripts/lib/reviewed-npm-audit.mts",
  "scripts/lib/sandbox-init.sh",
  "scripts/lib/sandbox-rlimits.sh",
  "scripts/lib/seed-reviewed-npm-cache.mts",
  "scripts/managed-bootstrap-entrypoint.c",
  "scripts/managed-bootstrap-trampoline.sh",
  "scripts/managed-startup-hold.sh",
  "scripts/patch-bundled-npm-brace-expansion.mts",
  "scripts/patch-bundled-npm-tar.mts",
  "scripts/security/build-native-security-packages.sh",
  "scripts/security/build-perl-security-packages.sh",
  "scripts/security/patches/libssh2-1.11.1-cve-2026.patch",
  "scripts/security/patches/perl-5.44.0-net-ping-capability-tests.patch",
  "scripts/security/patches/python3.13-htmlparser-cve-2026-15308.patch",
  "scripts/upgrade-bundled-npm.mts",
  "src/lib/actions/sandbox/openshell-child-visible-credentials.v0.0.106.json",
  "tsconfig.runtime-preloads.json",
]);

const AUTHORING_DIRECTORY_NAMES = new Set([
  ".cache",
  ".e2e",
  ".git",
  ".github",
  ".turbo",
  "__pycache__",
  "__tests__",
  "cache",
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
  | "build-context-source"
  | "file-type"
  | "manifest"
  | "manifest-identity"
  | "metadata"
  | "package-root"
  | "provider-broker-artifact"
  | "provider-profile-artifact"
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
  readonly maximumNemoClawVersionExclusive: string;
  readonly manifestPath: string;
  readonly adapterArtifacts: readonly string[];
  readonly packedFiles: readonly string[];
  readonly publishedFiles: readonly HarnessPackagePublishedFile[];
}

export interface HarnessPackagePublishedFile {
  readonly path: string;
  readonly size: number;
  readonly executable: boolean;
  readonly sha256: string;
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
    readonly maximumNemoClawVersionExclusive: string;
    readonly buildProjects: readonly string[];
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

function compareExactCoreVersions(left: string, right: string): number {
  const leftParts = left.split(".").map(BigInt);
  const rightParts = right.split(".").map(BigInt);
  for (let index = 0; index < leftParts.length; index += 1) {
    if (leftParts[index] === rightParts[index]) continue;
    return leftParts[index] < rightParts[index] ? -1 : 1;
  }
  return 0;
}

function readBuildProjects(
  packageRoot: string,
  nemoclawMetadata: Readonly<Record<string, unknown>>,
): readonly string[] {
  if (Object.hasOwn(nemoclawMetadata, "authoringProjects")) {
    throw diagnostic(
      "metadata",
      PACKAGE_JSON,
      "nemoclaw.authoringProjects was renamed to nemoclaw.buildProjects",
    );
  }
  const declared = nemoclawMetadata.buildProjects;
  if (declared === undefined) return Object.freeze([]);
  if (!Array.isArray(declared) || declared.length === 0 || declared.length > MAX_BUILD_PROJECTS) {
    throw diagnostic(
      "metadata",
      PACKAGE_JSON,
      `nemoclaw.buildProjects must contain between 1 and ${String(MAX_BUILD_PROJECTS)} paths`,
    );
  }

  const projects = declared.map((value): string => {
    if (
      typeof value !== "string" ||
      Buffer.byteLength(value, "utf8") > MAX_BUILD_PROJECT_PATH_BYTES ||
      !BUILD_PROJECT_PATH.test(value)
    ) {
      throw diagnostic(
        "metadata",
        PACKAGE_JSON,
        "nemoclaw.buildProjects entries must be bounded canonical relative paths",
      );
    }
    const segments = value.toLowerCase().split("/");
    if (segments.some((segment) => AUTHORING_DIRECTORY_NAMES.has(segment))) {
      throw diagnostic(
        "metadata",
        PACKAGE_JSON,
        "nemoclaw.buildProjects must not identify a test, cache, or dependency directory",
      );
    }

    let cursor = packageRoot;
    for (const segment of value.split("/")) {
      cursor = path.join(cursor, segment);
      let stats: fs.Stats;
      try {
        stats = fs.lstatSync(cursor);
      } catch {
        throw diagnostic(
          "metadata",
          PACKAGE_JSON,
          `build project ${JSON.stringify(value)} is missing`,
        );
      }
      if (stats.isSymbolicLink() || !stats.isDirectory()) {
        throw diagnostic(
          "metadata",
          PACKAGE_JSON,
          `build project ${JSON.stringify(value)} must be a regular directory`,
        );
      }
    }
    return value;
  });
  if (new Set(projects).size !== projects.length) {
    throw diagnostic("metadata", PACKAGE_JSON, "nemoclaw.buildProjects entries must be unique");
  }
  return Object.freeze(projects);
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
  if (
    typeof parsed.nemoclaw.maximumNemoClawVersionExclusive !== "string" ||
    !isExactCoreVersion(parsed.nemoclaw.maximumNemoClawVersionExclusive)
  ) {
    throw diagnostic(
      "metadata",
      PACKAGE_JSON,
      "nemoclaw.maximumNemoClawVersionExclusive must be one exact x.y.z version",
    );
  }
  if (
    compareExactCoreVersions(
      parsed.nemoclaw.maximumNemoClawVersionExclusive,
      parsed.nemoclaw.minimumNemoClawVersion,
    ) <= 0
  ) {
    throw diagnostic(
      "metadata",
      PACKAGE_JSON,
      "nemoclaw.maximumNemoClawVersionExclusive must be greater than minimumNemoClawVersion",
    );
  }
  const buildProjects = readBuildProjects(packageRoot, parsed.nemoclaw);
  return Object.freeze({
    name: parsed.name,
    version: parsed.version,
    nemoclaw: Object.freeze({
      harnessManifest: "manifest.yaml",
      minimumNemoClawVersion: parsed.nemoclaw.minimumNemoClawVersion,
      maximumNemoClawVersionExclusive: parsed.nemoclaw.maximumNemoClawVersionExclusive,
      buildProjects,
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
  const displayName =
    typeof value.display_name === "string" ? value.display_name : expectedHarnessId;
  return Object.freeze({ displayName, value: Object.freeze(value) });
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requiredAdapterArtifacts(manifest: Readonly<Record<string, unknown>>): readonly string[] {
  const required = [
    "host/config-adapter.cts",
    "host/messaging-adapter.cts",
    "host/startup-adapter.cts",
  ];
  if (isRecord(manifest.mcp) && manifest.mcp.support === "bridge") {
    required.push("host/mcp-adapter.cts");
  }
  if (isRecord(manifest.sessions)) {
    required.push("host/session-adapter.cts");
  }
  if (isRecord(manifest.agent_roster) && manifest.agent_roster.support === "managed") {
    required.push("host/agent-roster-adapter.cts");
  }
  if (isRecord(manifest.provider_broker) && manifest.provider_broker.support === "managed") {
    required.push("host/provider-broker-adapter.cts");
  }
  if (isRecord(manifest.provider_auth) && manifest.provider_auth.support === "managed") {
    required.push("host/provider-auth-adapter.cts");
  }
  if (
    Array.isArray(manifest.state_files) &&
    manifest.state_files.some(
      (entry) =>
        isRecord(entry) && isRecord(entry.restore) && entry.restore.merge === "package-config",
    )
  ) {
    required.push("host/restore-adapter.cts");
  }
  return Object.freeze(required);
}

function assertOwnedPolicyPresetAssets(
  packageRoot: string,
  manifest: Readonly<Record<string, unknown>>,
): void {
  if (!isRecord(manifest.policy) || !Array.isArray(manifest.policy.owned_presets)) return;

  const baselineSource = readBoundedUtf8File(
    packageRoot,
    "policy-additions.yaml",
    MAX_POLICY_PRESET_BYTES,
  );
  const baselineDocument = parseDocument(baselineSource, {
    prettyErrors: false,
    schema: "core",
    strict: true,
    uniqueKeys: true,
  });
  let baselineValue: unknown = null;
  if (baselineDocument.errors.length === 0 && baselineDocument.warnings.length === 0) {
    try {
      baselineValue = baselineDocument.toJS({ maxAliasCount: 0 }) as unknown;
    } catch {
      baselineValue = null;
    }
  }
  const baselinePolicyKeys = new Set(
    isRecord(baselineValue) && isRecord(baselineValue.network_policies)
      ? Object.keys(baselineValue.network_policies)
      : [],
  );

  for (const presetName of manifest.policy.owned_presets) {
    if (typeof presetName !== "string") continue;
    const relativePath = `policies/presets/${presetName}.yaml`;
    let source: string;
    try {
      source = readBoundedUtf8File(packageRoot, relativePath, MAX_POLICY_PRESET_BYTES);
    } catch (error) {
      if (error instanceof HarnessPackageConformanceError) throw error;
      throw diagnostic(
        "file-type",
        relativePath,
        "declared package policy preset is missing or unreadable",
      );
    }

    const document = parseDocument(source, {
      prettyErrors: false,
      schema: "core",
      strict: true,
      uniqueKeys: true,
    });
    if (document.errors.length > 0 || document.warnings.length > 0) {
      throw diagnostic("manifest", relativePath, "must contain unambiguous YAML");
    }
    let value: unknown;
    try {
      value = document.toJS({ maxAliasCount: 0 }) as unknown;
    } catch {
      throw diagnostic("manifest", relativePath, "must not contain YAML aliases");
    }
    if (
      !isRecord(value) ||
      !isRecord(value.preset) ||
      value.preset.name !== presetName ||
      typeof value.preset.description !== "string" ||
      !isRecord(value.network_policies)
    ) {
      throw diagnostic(
        "manifest",
        relativePath,
        "must declare matching preset metadata and a network_policies mapping",
      );
    }
    const overlappingPolicyKey = Object.keys(value.network_policies).find((key) =>
      baselinePolicyKeys.has(key),
    );
    if (overlappingPolicyKey) {
      throw diagnostic(
        "manifest",
        relativePath,
        `optional policy key '${overlappingPolicyKey}' must not also be present in policy-additions.yaml`,
      );
    }
  }
}

function parsePackageYamlAsset(
  packageRoot: string,
  relativePath: string,
  maximumBytes: number,
): unknown {
  let source: string;
  try {
    source = readBoundedUtf8File(packageRoot, relativePath, maximumBytes);
  } catch {
    throw diagnostic(
      "provider-profile-artifact",
      relativePath,
      "declared provider profile is missing or unreadable",
    );
  }
  const document = parseDocument(source, {
    prettyErrors: false,
    schema: "core",
    strict: true,
    uniqueKeys: true,
  });
  if (document.errors.length > 0 || document.warnings.length > 0) {
    throw diagnostic(
      "provider-profile-artifact",
      relativePath,
      "must contain unambiguous YAML using the core schema",
    );
  }
  try {
    return document.toJS({ maxAliasCount: 0 }) as unknown;
  } catch {
    throw diagnostic("provider-profile-artifact", relativePath, "must not contain YAML aliases");
  }
}

function assertWebSearchProviderProfileAssets(
  packageRoot: string,
  manifest: Readonly<Record<string, unknown>>,
): void {
  if (!isRecord(manifest.web_search) || manifest.web_search.support !== "providers") return;
  if (!Array.isArray(manifest.web_search.providers)) return;

  for (const rawBinding of manifest.web_search.providers) {
    if (!isRecord(rawBinding) || typeof rawBinding.profile_type !== "string") continue;
    const binding = rawBinding as unknown as HarnessWebSearchProviderBinding;
    const relativePath = `provider-profiles/${binding.profile_type}.yaml`;
    const profileDocument = parsePackageYamlAsset(packageRoot, relativePath, MAX_MANIFEST_BYTES);
    try {
      assertHarnessWebSearchProviderProfile(binding, binding.profile_type, profileDocument);
    } catch (error) {
      throw diagnostic(
        "provider-profile-artifact",
        relativePath,
        error instanceof Error ? error.message : "provider profile does not match its declaration",
      );
    }
  }
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

function requiredProviderBrokerArtifacts(
  packageRoot: string,
  manifest: Readonly<Record<string, unknown>>,
): readonly string[] {
  if (!isRecord(manifest.provider_broker) || manifest.provider_broker.support !== "managed") {
    return Object.freeze([]);
  }
  const relativePath = "host/provider-broker-control.cts";
  const absolutePath = path.join(packageRoot, relativePath);
  let stats: fs.Stats;
  try {
    stats = fs.lstatSync(absolutePath);
  } catch {
    throw diagnostic(
      "provider-broker-artifact",
      relativePath,
      "managed provider broker requires its conventional controller",
    );
  }
  if (stats.isSymbolicLink() || !stats.isFile() || stats.size === 0) {
    throw diagnostic(
      "provider-broker-artifact",
      relativePath,
      "provider-broker controller must be one non-empty regular file",
    );
  }
  return Object.freeze([relativePath]);
}

function requiredManagedImageArtifacts(
  manifest: Readonly<Record<string, unknown>>,
): readonly string[] {
  const managedImage = isRecord(manifest.managed_image) ? manifest.managed_image : undefined;
  const baseImage = isRecord(managedImage?.base_image) ? managedImage.base_image : undefined;
  return baseImage?.package_probe === true
    ? Object.freeze(["checks/image-probe.py"])
    : Object.freeze([]);
}

function assertRequiredManagedImageArtifacts(
  packageRoot: string,
  artifacts: readonly string[],
): void {
  for (const relativePath of artifacts) {
    const absolutePath = path.join(packageRoot, ...relativePath.split("/"));
    let stats: fs.Stats;
    try {
      stats = fs.lstatSync(absolutePath);
    } catch {
      throw diagnostic(
        "file-type",
        relativePath,
        "managed image declaration requires this conventional package probe",
      );
    }
    if (stats.isSymbolicLink() || !stats.isFile() || stats.size === 0) {
      throw diagnostic(
        "file-type",
        relativePath,
        "managed image probe must be one non-empty regular file",
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

function sameRegularFileSnapshot(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
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

function digestStablePackedFile(packageRoot: string, relativePath: string): string {
  const absolutePath = path.join(packageRoot, ...relativePath.split("/"));
  if (typeof fs.constants.O_NOFOLLOW !== "number") {
    throw diagnostic("archive", relativePath, "secure archive inspection requires O_NOFOLLOW");
  }
  const before = fs.lstatSync(absolutePath, { bigint: true });
  const descriptor = fs.openSync(absolutePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (!sameRegularFileSnapshot(before, opened)) {
      throw diagnostic("archive", relativePath, "archive member changed before hashing");
    }
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor, { bigint: true });
    const namedAfter = fs.lstatSync(absolutePath, { bigint: true });
    if (!sameRegularFileSnapshot(opened, after) || !sameRegularFileSnapshot(opened, namedAfter)) {
      throw diagnostic("archive", relativePath, "archive member changed while hashing");
    }
    return createHash("sha256").update(bytes).digest("hex");
  } finally {
    fs.closeSync(descriptor);
  }
}

function isTypeScriptConfigPath(relativePath: string): boolean {
  return TYPESCRIPT_CONFIG_FILE.test(relativePath.split("/").at(-1) ?? "");
}

function buildProjectForConfig(
  relativePath: string,
  buildProjects: readonly string[],
): string | undefined {
  return [...buildProjects]
    .sort((left, right) => right.length - left.length)
    .find((project) => relativePath.startsWith(`${project}/`));
}

function buildConfigFailure(relativePath: string, message: string): HarnessPackageConformanceError {
  return diagnostic("archive-authoring-path", relativePath, message);
}

function readBuildConfig(
  packageRoot: string,
  relativePath: string,
): Readonly<Record<string, unknown>> {
  const absolutePath = path.join(packageRoot, ...relativePath.split("/"));
  let stats: fs.Stats;
  try {
    stats = fs.lstatSync(absolutePath);
  } catch {
    throw buildConfigFailure(relativePath, "Dockerfile-referenced build config is missing");
  }
  if (
    stats.isSymbolicLink() ||
    !stats.isFile() ||
    stats.size === 0 ||
    stats.size > MAX_BUILD_CONFIG_BYTES
  ) {
    throw buildConfigFailure(relativePath, "published build configs must be bounded regular files");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(absolutePath, "utf8")) as unknown;
  } catch {
    throw buildConfigFailure(relativePath, "published build configs must contain strict JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw buildConfigFailure(relativePath, "published build configs must contain one JSON object");
  }
  return parsed as Readonly<Record<string, unknown>>;
}

function isTestBuildConfig(
  relativePath: string,
  config: Readonly<Record<string, unknown>>,
): boolean {
  const fileName = relativePath.split("/").at(-1) ?? "";
  if (TEST_CONFIG_TERM.test(fileName)) return true;
  const containsTestInput = (value: unknown): boolean =>
    typeof value === "string" && TEST_CONFIG_TERM.test(value);
  for (const field of ["files", "include"] as const) {
    const values = config[field];
    if (Array.isArray(values) && values.some(containsTestInput)) return true;
  }
  const references = config.references;
  if (
    Array.isArray(references) &&
    references.some(
      (reference) =>
        reference !== null &&
        typeof reference === "object" &&
        !Array.isArray(reference) &&
        containsTestInput((reference as Readonly<Record<string, unknown>>).path),
    )
  ) {
    return true;
  }
  const compilerOptions = config.compilerOptions;
  if (
    compilerOptions !== null &&
    typeof compilerOptions === "object" &&
    !Array.isArray(compilerOptions)
  ) {
    const types = (compilerOptions as Readonly<Record<string, unknown>>).types;
    if (Array.isArray(types) && types.some(containsTestInput)) return true;
  }
  return false;
}

function logicalDockerfileLines(source: string): readonly string[] {
  const lines: string[] = [];
  let current = "";
  for (const rawLine of source.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const continued = line.endsWith("\\");
    current = `${current}${current ? " " : ""}${continued ? line.slice(0, -1).trimEnd() : line}`;
    if (!continued) {
      lines.push(current);
      current = "";
    }
  }
  if (current) lines.push(current);
  return lines;
}

interface DockerContextInstruction {
  readonly instruction: "ADD" | "COPY";
  readonly externalStage: boolean;
  readonly checksum: string | null;
  readonly sources: readonly string[];
}

function parseShellContextOperands(
  dockerfileName: string,
  instruction: "ADD" | "COPY",
  source: string,
): readonly string[] {
  const operands: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  let hasCurrent = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quote !== undefined) {
      if (character === quote) {
        quote = undefined;
      } else if (character === "\\" && quote === '"') {
        index += 1;
        if (index >= source.length) {
          throw buildConfigFailure(
            dockerfileName,
            `${instruction} instruction ends with an escape`,
          );
        }
        current += source[index];
      } else {
        current += character;
      }
      hasCurrent = true;
      continue;
    }
    if (/\s/u.test(character)) {
      if (hasCurrent) {
        operands.push(current);
        current = "";
        hasCurrent = false;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      hasCurrent = true;
      continue;
    }
    if (character === "\\") {
      index += 1;
      if (index >= source.length) {
        throw buildConfigFailure(dockerfileName, `${instruction} instruction ends with an escape`);
      }
      current += source[index];
      hasCurrent = true;
      continue;
    }
    current += character;
    hasCurrent = true;
  }
  if (quote !== undefined) {
    throw buildConfigFailure(
      dockerfileName,
      `${instruction} instruction contains an unterminated quote`,
    );
  }
  if (hasCurrent) operands.push(current);
  return operands;
}

function parseDockerContextInstruction(
  dockerfileName: string,
  line: string,
): DockerContextInstruction | undefined {
  const match = /^(ADD|COPY)\s+(.+)$/iu.exec(line);
  if (!match) return undefined;
  const instruction = match[1].toUpperCase() as "ADD" | "COPY";
  let remaining = match[2].trim();
  let externalStage = false;
  let checksum: string | null = null;
  while (remaining.startsWith("--")) {
    const option = /^(--[a-z][a-z0-9-]*(?:=(?:"(?:[^"\\]|\\.)*"|'[^']*'|[^\s]+))?)(?:\s+|$)/iu.exec(
      remaining,
    );
    if (!option) {
      throw buildConfigFailure(
        dockerfileName,
        `${instruction} instruction contains an unsupported option`,
      );
    }
    if (/^--from(?:=|$)/iu.test(option[1])) {
      if (instruction !== "COPY") {
        throw buildConfigFailure(dockerfileName, "ADD instruction cannot copy from a build stage");
      }
      externalStage = true;
    }
    const checksumMatch = /^--checksum=(.+)$/iu.exec(option[1]);
    if (checksumMatch) {
      if (instruction !== "ADD" || checksum !== null) {
        throw buildConfigFailure(
          dockerfileName,
          `${instruction} instruction contains an invalid checksum option`,
        );
      }
      checksum = checksumMatch[1];
    }
    remaining = remaining.slice(option[0].length).trimStart();
  }
  if (externalStage) {
    return Object.freeze({ instruction, externalStage: true, checksum, sources: [] });
  }

  let operands: readonly string[];
  if (remaining.startsWith("[")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(remaining) as unknown;
    } catch {
      throw buildConfigFailure(
        dockerfileName,
        `JSON-array ${instruction} instruction must contain valid JSON`,
      );
    }
    if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== "string")) {
      throw buildConfigFailure(
        dockerfileName,
        `JSON-array ${instruction} operands must all be strings`,
      );
    }
    operands = parsed;
  } else {
    operands = parseShellContextOperands(dockerfileName, instruction, remaining);
  }
  if (operands.length < 2) {
    throw buildConfigFailure(
      dockerfileName,
      `${instruction} instruction must contain at least one source and one destination`,
    );
  }
  return Object.freeze({
    instruction,
    externalStage: false,
    checksum,
    sources: Object.freeze(operands.slice(0, -1)),
  });
}

function normalizedDockerContextSource(
  dockerfileName: string,
  instruction: "ADD" | "COPY",
  sourcePath: string,
): string {
  const normalized = sourcePath.replace(/^(?:\.\/)+/u, "");
  const pathSegments = normalized.replace(/\/+$/u, "").split("/");
  if (
    !normalized ||
    normalized.includes("\\") ||
    path.posix.isAbsolute(normalized) ||
    pathSegments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw diagnostic(
      "build-context-source",
      dockerfileName,
      `direct ${instruction} source '${sourcePath}' is not a canonical repository-relative path`,
    );
  }
  return normalized;
}

function isCoreBuildContextSource(sourcePath: string): boolean {
  return (
    CORE_BUILD_CONTEXT_FILES.has(sourcePath) ||
    CORE_BUILD_CONTEXT_DIRECTORIES.some((prefix) => sourcePath.startsWith(prefix))
  );
}

function isRemoteAddSource(sourcePath: string): boolean {
  return /^https:\/\//iu.test(sourcePath);
}

function assertDockerContextSourceAuthority(packageRoot: string, harnessId: string): void {
  const packagePrefix = `packages/nemoclaw-${harnessId}/`;
  for (const dockerfileName of ["Dockerfile", "Dockerfile.base"] as const) {
    const source = readBoundedUtf8File(packageRoot, dockerfileName, MAX_BUILD_CONFIG_BYTES * 32);
    for (const line of logicalDockerfileLines(source)) {
      const contextInstruction = parseDockerContextInstruction(dockerfileName, line);
      if (!contextInstruction || contextInstruction.externalStage) continue;
      const remoteSources = contextInstruction.sources.filter(isRemoteAddSource);
      if (remoteSources.length > 0) {
        if (
          contextInstruction.instruction !== "ADD" ||
          contextInstruction.sources.length !== 1 ||
          !/^sha256:[a-f0-9]{64}$/u.test(contextInstruction.checksum ?? "")
        ) {
          throw diagnostic(
            "build-context-source",
            dockerfileName,
            "remote ADD requires one HTTPS source and one exact SHA-256 checksum",
          );
        }
        continue;
      }
      if (contextInstruction.checksum !== null) {
        throw diagnostic(
          "build-context-source",
          dockerfileName,
          "a checksum is valid only for one remote HTTPS ADD source",
        );
      }
      for (const rawSourcePath of contextInstruction.sources) {
        const sourcePath = normalizedDockerContextSource(
          dockerfileName,
          contextInstruction.instruction,
          rawSourcePath,
        );
        if (sourcePath.startsWith(packagePrefix) || isCoreBuildContextSource(sourcePath)) continue;
        throw diagnostic(
          "build-context-source",
          dockerfileName,
          `direct ${contextInstruction.instruction} source '${rawSourcePath}' is outside this package and the NemoClaw core build kit`,
        );
      }
    }
  }
}

function directPackageBuildConfigs(packageRoot: string, harnessId: string): readonly string[] {
  const packagePrefix = `packages/nemoclaw-${harnessId}/`;
  const configs = new Set<string>();
  for (const dockerfileName of ["Dockerfile", "Dockerfile.base"] as const) {
    const source = readBoundedUtf8File(packageRoot, dockerfileName, MAX_BUILD_CONFIG_BYTES * 32);
    for (const line of logicalDockerfileLines(source)) {
      const contextInstruction = parseDockerContextInstruction(dockerfileName, line);
      if (!contextInstruction || contextInstruction.externalStage) continue;
      for (const sourcePath of contextInstruction.sources) {
        if (isRemoteAddSource(sourcePath)) continue;
        const normalizedSourcePath = sourcePath.replace(/^(?:\.\/)+/u, "");
        if (!normalizedSourcePath.startsWith(packagePrefix)) continue;
        const relativePath = normalizedSourcePath.slice(packagePrefix.length);
        if (isTypeScriptConfigPath(relativePath)) configs.add(relativePath);
      }
    }
  }
  return Object.freeze([...configs].sort((left, right) => left.localeCompare(right)));
}

function resolveExtendedBuildConfig(relativePath: string, extendedPath: string): string {
  if (
    (!extendedPath.startsWith("./") && !extendedPath.startsWith("../")) ||
    extendedPath.includes("\\") ||
    path.posix.isAbsolute(extendedPath)
  ) {
    throw buildConfigFailure(
      relativePath,
      "published build configs may extend only another local build-project config",
    );
  }
  const withExtension = extendedPath.endsWith(".json") ? extendedPath : `${extendedPath}.json`;
  const resolved = path.posix.normalize(
    path.posix.join(path.posix.dirname(relativePath), withExtension),
  );
  if (resolved.startsWith("../") || path.posix.isAbsolute(resolved)) {
    throw buildConfigFailure(relativePath, "published build config extends outside the package");
  }
  return resolved;
}

function allowedPublishedBuildConfigs(
  packageRoot: string,
  metadata: PackageMetadata & { readonly harnessId: string },
): ReadonlySet<string> {
  const allowed = new Set<string>();
  const visiting = new Set<string>();
  const visit = (relativePath: string, requiredProject?: string): void => {
    const project = buildProjectForConfig(relativePath, metadata.nemoclaw.buildProjects);
    if (!project || (requiredProject !== undefined && project !== requiredProject)) {
      throw buildConfigFailure(
        relativePath,
        "published TypeScript configs must stay within one declared nemoclaw.buildProjects directory",
      );
    }
    if (!isTypeScriptConfigPath(relativePath)) {
      throw buildConfigFailure(relativePath, "build config must use a tsconfig*.json name");
    }
    if (allowed.has(relativePath)) return;
    if (visiting.has(relativePath)) {
      throw buildConfigFailure(
        relativePath,
        "published build config extends chain contains a cycle",
      );
    }
    visiting.add(relativePath);
    const config = readBuildConfig(packageRoot, relativePath);
    if (isTestBuildConfig(relativePath, config)) {
      throw buildConfigFailure(relativePath, "test TypeScript configs must not be published");
    }
    const extended = config.extends;
    if (extended !== undefined) {
      const extendedPaths = typeof extended === "string" ? [extended] : extended;
      if (
        !Array.isArray(extendedPaths) ||
        extendedPaths.length === 0 ||
        extendedPaths.length > MAX_EXTENDED_BUILD_CONFIGS ||
        extendedPaths.some((value) => typeof value !== "string")
      ) {
        throw buildConfigFailure(
          relativePath,
          `published build config extends must be one string or between 1 and ${String(MAX_EXTENDED_BUILD_CONFIGS)} strings`,
        );
      }
      for (const extendedPath of extendedPaths as readonly string[]) {
        visit(resolveExtendedBuildConfig(relativePath, extendedPath), project);
      }
    }
    visiting.delete(relativePath);
    allowed.add(relativePath);
  };

  for (const relativePath of directPackageBuildConfigs(packageRoot, metadata.harnessId)) {
    visit(relativePath);
  }
  return allowed;
}

function isAuthoringPath(relativePath: string, allowedBuildConfigs: ReadonlySet<string>): boolean {
  const segments = relativePath.toLowerCase().split("/");
  if (segments.some((segment) => AUTHORING_DIRECTORY_NAMES.has(segment))) return true;
  if (segments.length >= 2 && segments[0] === "host" && segments[1] === "source") return true;
  const fileName = segments.at(-1) ?? "";
  return (
    relativePath === "nemoclaw-package.json" ||
    (segments.length === 1 && AUTHORING_ROOT_FILES.has(fileName)) ||
    (TYPESCRIPT_CONFIG_FILE.test(fileName) && !allowedBuildConfigs.has(relativePath)) ||
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
  metadata: PackageMetadata & { readonly harnessId: string },
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
  const allowedBuildConfigs = allowedPublishedBuildConfigs(packageRoot, metadata);
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
    if (isAuthoringPath(file.path, allowedBuildConfigs)) {
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
  for (const requiredConfig of allowedBuildConfigs) {
    if (!packedPaths.has(requiredConfig)) {
      throw diagnostic(
        "archive-membership",
        requiredConfig,
        "Dockerfile build config or its local extends dependency is missing from the npm archive",
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
          sha256: digestStablePackedFile(packageRoot, file.path),
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
    // Validation is deliberately static. Adapter compilation/currentness is
    // the separately invoked, explicitly trusted authoring build boundary;
    // never execute a compiler or binary selected from the candidate tree.
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
  assertDockerContextSourceAuthority(packageRoot, metadata.harnessId);
  const manifest = readManifest(packageRoot, metadata.harnessId);
  try {
    validateHarnessManifest(manifest.value, metadata.harnessId);
  } catch (error) {
    const message =
      error instanceof HarnessManifestValidationError
        ? error.message
        : "manifest semantic validation failed";
    throw diagnostic("manifest", "manifest.yaml", message);
  }
  assertOwnedPolicyPresetAssets(packageRoot, manifest.value);
  assertWebSearchProviderProfileAssets(packageRoot, manifest.value);
  const adapterArtifacts = listAdapterArtifacts(packageRoot);
  assertRequiredAdapterArtifacts(adapterArtifacts, manifest.value);
  const managedImageArtifacts = requiredManagedImageArtifacts(manifest.value);
  const providerBrokerArtifacts = requiredProviderBrokerArtifacts(packageRoot, manifest.value);
  assertRequiredManagedImageArtifacts(packageRoot, managedImageArtifacts);
  const publishedFiles = inspectPackedFiles(packageRoot, metadata, [
    ...adapterArtifacts,
    ...managedImageArtifacts,
    ...providerBrokerArtifacts,
  ]);
  return Object.freeze({
    harnessId: metadata.harnessId,
    displayName: manifest.displayName,
    packageName: metadata.name,
    packageVersion: metadata.version,
    minimumNemoClawVersion: metadata.nemoclaw.minimumNemoClawVersion,
    maximumNemoClawVersionExclusive: metadata.nemoclaw.maximumNemoClawVersionExclusive,
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
