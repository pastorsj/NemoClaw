// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { parseHarnessPackageManifest } from "../../src/lib/agent-runtime/package/manifest.ts";
import { readPrivateRegularFile } from "./private-file.mts";

const CONTRACT_VALUE_MAX_BYTES = 512;
const PROCESS_MARKER_LIMIT = 16;
const PROCESS_MARKER_MAX_BYTES = 256;
const HARNESS_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const ADAPTER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const PYTHON_MODULE_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/u;
const SHA256_DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
const UNSAFE_TEXT_PATTERN = /[\p{Cc}\p{Cf}\p{Cs}]/u;
const FABRIC_DESCRIPTOR_MAX_BYTES = 256 * 1024;
const PACKAGE_DIRECTORY_ENTRY_LIMIT = 256;
const UPSTREAM_FABRIC_DESCRIPTOR_ROOT = "/opt/nemoclaw-fabric-venv/share/nemo-fabric";
const CONTRACT_FIELDS = new Set([
  "$comment",
  "adapterId",
  "artifactRoot",
  "configPath",
  "descriptorGlob",
  "descriptorPathPrefix",
  "descriptorRunnerModule",
  "packageId",
  "processMarkers",
]);
const TARGET_ENVIRONMENT = {
  adapterId: "E2E_FABRIC_ADAPTER_ID",
  artifactRoot: "E2E_FABRIC_ARTIFACT_ROOT",
  configPath: "E2E_FABRIC_CONFIG_PATH",
  descriptorGlob: "E2E_FABRIC_DESCRIPTOR_GLOB",
  descriptorPathPrefix: "E2E_FABRIC_DESCRIPTOR_ROOT",
  descriptorRunnerModule: "E2E_FABRIC_RUNNER_MODULE",
  packageId: "E2E_FABRIC_PACKAGE_ID",
  packageArtifact: "E2E_FABRIC_PACKAGE_ARTIFACT",
  upgradePackageArtifact: "E2E_FABRIC_UPGRADE_PACKAGE_ARTIFACT",
  processMarkers: "E2E_FABRIC_PROCESS_MARKERS",
  sandboxName: "NEMOCLAW_SANDBOX_NAME",
} as const;

export interface FabricHarnessE2eContract {
  readonly packageId: string;
  readonly adapterId: string;
  readonly artifactRoot: string;
  readonly configPath: string;
  readonly descriptorGlob: string;
  readonly descriptorPathPrefix: string;
  readonly descriptorRunnerModule: string;
  readonly processMarkers?: readonly string[];
}

export interface FabricPackageE2eTarget {
  readonly contract: FabricHarnessE2eContract;
  readonly packageArtifact?: string;
  readonly upgradePackageArtifact?: string;
  readonly sandboxName: string;
}

export interface InstalledFabricPackageReference {
  readonly contentDigest: string;
  readonly packageRoot: string;
}

export interface InstalledFabricE2eBinding {
  readonly adapterId: string;
  readonly configPath: string;
  readonly descriptorAuthority: "nemo-fabric" | "package";
  readonly packageId: string;
  readonly runnerModule: string;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function readBoundedRegularFile(file: string, maxBytes: number): string {
  const source = readPrivateRegularFile(file, { maxBytes });
  if (source === null) throw new Error("Installed Fabric package file is invalid");
  return source;
}

function requireFabricHeadlessCommand(value: unknown, configPath: string): void {
  if (typeof value !== "string" || value !== value.trim() || !isBoundedSafeText(value, 4096)) {
    throw new Error("Installed Fabric package headless command is invalid");
  }
  const tokens = value.split(" ");
  if (tokens[0] !== "nemoclaw-fabric-run" || tokens.length < 3 || tokens.length % 2 === 0) {
    throw new Error("Installed Fabric package headless command is invalid");
  }
  const options = new Map<string, string>();
  for (let index = 1; index < tokens.length; index += 2) {
    const option = tokens[index];
    const optionValue = tokens[index + 1];
    if (
      (option !== "--config" &&
        option !== "--deadline-seconds" &&
        option !== "--kill-grace-seconds") ||
      !optionValue ||
      options.has(option)
    ) {
      throw new Error("Installed Fabric package headless command is invalid");
    }
    options.set(option, optionValue);
  }
  if (options.get("--config") !== configPath) {
    throw new Error("Installed Fabric package headless command does not select its E2E config");
  }
  const deadline = options.get("--deadline-seconds");
  const killGrace = options.get("--kill-grace-seconds");
  if (
    (deadline !== undefined && !/^[1-9][0-9]{0,3}$/u.test(deadline)) ||
    (killGrace !== undefined && !/^[1-9][0-9]{0,2}$/u.test(killGrace))
  ) {
    throw new Error("Installed Fabric package headless command limits are invalid");
  }
}

function readPackageOwnedFabricDescriptor(
  packageDirectory: string,
): { readonly adapterId: string; readonly fileName: string; readonly runnerModule: string } | null {
  const fabricDirectory = path.join(packageDirectory, "fabric");
  let metadata: fs.BigIntStats;
  try {
    metadata = fs.lstatSync(fabricDirectory, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error("Installed Fabric package descriptor directory is invalid");
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error("Installed Fabric package descriptor directory is invalid");
  }
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(fabricDirectory, { withFileTypes: true });
  } catch {
    throw new Error("Installed Fabric package descriptor directory is invalid");
  }
  if (entries.length > PACKAGE_DIRECTORY_ENTRY_LIMIT) {
    throw new Error("Installed Fabric package descriptor directory is invalid");
  }
  const descriptors = entries.filter((entry) => entry.name.endsWith(".fabric-adapter.json"));
  if (descriptors.length === 0) return null;
  const descriptor = descriptors[0];
  if (descriptors.length !== 1 || !descriptor?.isFile()) {
    throw new Error("Installed Fabric package must own at most one regular Fabric descriptor");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      readBoundedRegularFile(
        path.join(fabricDirectory, descriptor.name),
        FABRIC_DESCRIPTOR_MAX_BYTES,
      ),
    );
  } catch {
    throw new Error("Installed Fabric package descriptor is invalid");
  }
  if (!isPlainRecord(parsed) || !isPlainRecord(parsed.runner)) {
    throw new Error("Installed Fabric package descriptor is invalid");
  }
  const adapterId = parsed.adapter_id;
  const runnerModule = parsed.runner.module;
  if (
    typeof adapterId !== "string" ||
    !ADAPTER_ID_PATTERN.test(adapterId) ||
    typeof runnerModule !== "string" ||
    !PYTHON_MODULE_PATTERN.test(runnerModule)
  ) {
    throw new Error("Installed Fabric package descriptor is invalid");
  }
  return { adapterId, fileName: descriptor.name, runnerModule };
}

function requireUpstreamFabricDescriptor(contract: FabricHarnessE2eContract): void {
  if (
    contract.descriptorPathPrefix !== UPSTREAM_FABRIC_DESCRIPTOR_ROOT ||
    !contract.descriptorGlob.startsWith(`${UPSTREAM_FABRIC_DESCRIPTOR_ROOT}/adapters/`) ||
    !contract.descriptorGlob.endsWith(".fabric-adapter.json") ||
    !contract.adapterId.startsWith("nvidia.fabric.") ||
    !contract.descriptorRunnerModule.startsWith("nemo_fabric_adapters.")
  ) {
    throw new Error("Installed package without a descriptor must use the upstream Fabric contract");
  }
}

function isBoundedSafeText(value: string, maxBytes = CONTRACT_VALUE_MAX_BYTES): boolean {
  return (
    value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= maxBytes &&
    !UNSAFE_TEXT_PATTERN.test(value)
  );
}

function isCanonicalAbsolutePath(value: string): boolean {
  return (
    isBoundedSafeText(value) &&
    path.posix.isAbsolute(value) &&
    path.posix.normalize(value) === value
  );
}

function requiredString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string") throw new Error(`Fabric package fixture ${field} is invalid`);
  return value;
}

function validateProcessMarkers(value: unknown): readonly string[] {
  if (
    value !== undefined &&
    (!Array.isArray(value) ||
      value.length > PROCESS_MARKER_LIMIT ||
      value.some(
        (marker) =>
          typeof marker !== "string" || !isBoundedSafeText(marker, PROCESS_MARKER_MAX_BYTES),
      ))
  ) {
    throw new Error("Fabric package fixture processMarkers is invalid");
  }
  return Object.freeze([...(value ?? [])] as string[]);
}

function requiredEnvironmentValue(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`Fabric package E2E requires ${name}`);
  return value;
}

function parseProcessMarkers(source: string): readonly string[] {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw new Error("Fabric package E2E process markers must be JSON");
  }
  return validateProcessMarkers(value);
}

export function validateFabricPackageSandboxName(value: string): string {
  if (value.length > 19 || !HARNESS_ID_PATTERN.test(value)) {
    throw new Error("Fabric package E2E sandbox name must be a canonical identifier");
  }
  return value;
}

export function validateFabricPackageId(value: string): string {
  if (value.length > 63 || !HARNESS_ID_PATTERN.test(value)) {
    throw new Error("Fabric package id must be a canonical identifier");
  }
  return value;
}

/** Validate a host path transported to the trusted-local package installer. */
export function validateFabricPackageArtifactPath(value: string): string {
  if (!isBoundedSafeText(value, 4096) || !path.isAbsolute(value) || path.resolve(value) !== value) {
    throw new Error("Fabric package artifact must be a canonical absolute host path");
  }
  return value;
}

/** Validate the package-owned data used by the generic public Fabric proof. */
export function validateFabricHarnessE2eContract(value: unknown): FabricHarnessE2eContract {
  if (!isPlainRecord(value)) throw new Error("Fabric package fixture must contain one object");
  const unexpected = Object.keys(value).filter((field) => !CONTRACT_FIELDS.has(field));
  if (unexpected.length > 0) throw new Error("Fabric package fixture contains unknown fields");

  const packageId = validateFabricPackageId(requiredString(value, "packageId"));
  const adapterId = requiredString(value, "adapterId");
  const artifactRoot = requiredString(value, "artifactRoot");
  const configPath = requiredString(value, "configPath");
  const descriptorGlob = requiredString(value, "descriptorGlob");
  const descriptorPathPrefix = requiredString(value, "descriptorPathPrefix");
  const descriptorRunnerModule = requiredString(value, "descriptorRunnerModule");
  const processMarkers = validateProcessMarkers(value.processMarkers);
  const descriptorRelative = descriptorGlob.slice(descriptorPathPrefix.length);
  const descriptorName = descriptorGlob.slice(descriptorGlob.lastIndexOf("/") + 1);
  const invalid =
    !isBoundedSafeText(adapterId, PROCESS_MARKER_MAX_BYTES) ||
    !ADAPTER_ID_PATTERN.test(adapterId) ||
    !isCanonicalAbsolutePath(artifactRoot) ||
    !isCanonicalAbsolutePath(configPath) ||
    !isCanonicalAbsolutePath(descriptorGlob) ||
    !isCanonicalAbsolutePath(descriptorPathPrefix) ||
    !descriptorRelative.startsWith("/") ||
    !isBoundedSafeText(descriptorName, PROCESS_MARKER_MAX_BYTES) ||
    !isBoundedSafeText(descriptorRunnerModule, PROCESS_MARKER_MAX_BYTES) ||
    !PYTHON_MODULE_PATTERN.test(descriptorRunnerModule);
  if (invalid) throw new Error("Fabric package fixture contract is invalid");

  return Object.freeze({
    packageId,
    adapterId,
    artifactRoot,
    configPath,
    descriptorGlob,
    descriptorPathPrefix,
    descriptorRunnerModule,
    ...(processMarkers.length > 0 ? { processMarkers } : {}),
  });
}

/** Bind package-owned live expectations to the exact immutable object selected by its receipt. */
export function requireInstalledFabricE2eBinding(
  contractValue: FabricHarnessE2eContract,
  reference: InstalledFabricPackageReference,
): InstalledFabricE2eBinding {
  try {
    const contract = validateFabricHarnessE2eContract(contractValue);
    if (
      !SHA256_DIGEST_PATTERN.test(reference.contentDigest) ||
      !path.isAbsolute(reference.packageRoot) ||
      path.resolve(reference.packageRoot) !== reference.packageRoot ||
      path.basename(reference.packageRoot) !== reference.contentDigest
    ) {
      throw new Error("Installed Fabric package receipt is invalid");
    }

    const installed = parseHarnessPackageManifest(reference.packageRoot);
    if (installed.envelope.id !== contract.packageId) {
      throw new Error("Installed Fabric package identity does not match its E2E contract");
    }
    if (installed.manifest.name !== contract.packageId) {
      throw new Error("Installed Fabric package manifest does not match its E2E contract");
    }
    const runtime = installed.manifest.runtime;
    if (!isPlainRecord(runtime)) {
      throw new Error("Installed Fabric package runtime is invalid");
    }
    requireFabricHeadlessCommand(runtime.headless_command, contract.configPath);

    const descriptor = readPackageOwnedFabricDescriptor(path.dirname(installed.manifestPath));
    if (descriptor) {
      if (
        descriptor.adapterId !== contract.adapterId ||
        descriptor.runnerModule !== contract.descriptorRunnerModule ||
        path.posix.basename(contract.descriptorGlob) !== descriptor.fileName
      ) {
        throw new Error("Installed Fabric package descriptor does not match its E2E contract");
      }
    } else {
      requireUpstreamFabricDescriptor(contract);
    }
    return Object.freeze({
      adapterId: contract.adapterId,
      configPath: contract.configPath,
      descriptorAuthority: descriptor ? "package" : "nemo-fabric",
      packageId: contract.packageId,
      runnerModule: contract.descriptorRunnerModule,
    });
  } catch {
    // Do not surface receipt-store host paths or parser details in shared E2E diagnostics.
    throw new Error("Installed Fabric package does not match its package-owned E2E contract");
  }
}

/** True only when a target selected the explicit Fabric package journey. */
export function hasFabricPackageE2eTarget(environment: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(environment[TARGET_ENVIRONMENT.packageId]?.trim());
}

/** Decode one explicit target contract without knowing the harness name. */
export function readFabricPackageE2eTarget(
  environment: NodeJS.ProcessEnv = process.env,
): FabricPackageE2eTarget {
  const processMarkers = parseProcessMarkers(
    requiredEnvironmentValue(environment, TARGET_ENVIRONMENT.processMarkers),
  );
  const contract = validateFabricHarnessE2eContract({
    packageId: requiredEnvironmentValue(environment, TARGET_ENVIRONMENT.packageId),
    adapterId: requiredEnvironmentValue(environment, TARGET_ENVIRONMENT.adapterId),
    artifactRoot: requiredEnvironmentValue(environment, TARGET_ENVIRONMENT.artifactRoot),
    configPath: requiredEnvironmentValue(environment, TARGET_ENVIRONMENT.configPath),
    descriptorGlob: requiredEnvironmentValue(environment, TARGET_ENVIRONMENT.descriptorGlob),
    descriptorPathPrefix: requiredEnvironmentValue(
      environment,
      TARGET_ENVIRONMENT.descriptorPathPrefix,
    ),
    descriptorRunnerModule: requiredEnvironmentValue(
      environment,
      TARGET_ENVIRONMENT.descriptorRunnerModule,
    ),
    ...(processMarkers.length > 0 ? { processMarkers } : {}),
  });
  return Object.freeze({
    contract,
    ...(environment[TARGET_ENVIRONMENT.packageArtifact]?.trim()
      ? {
          packageArtifact: validateFabricPackageArtifactPath(
            requiredEnvironmentValue(environment, TARGET_ENVIRONMENT.packageArtifact),
          ),
        }
      : {}),
    ...(environment[TARGET_ENVIRONMENT.upgradePackageArtifact]?.trim()
      ? {
          upgradePackageArtifact: validateFabricPackageArtifactPath(
            requiredEnvironmentValue(environment, TARGET_ENVIRONMENT.upgradePackageArtifact),
          ),
        }
      : {}),
    sandboxName: validateFabricPackageSandboxName(
      requiredEnvironmentValue(environment, TARGET_ENVIRONMENT.sandboxName),
    ),
  });
}

/** Encode the typed contract as the environment consumed by the reusable live test. */
export function fabricPackageE2eEnvironment(
  target: FabricPackageE2eTarget,
): Readonly<Record<string, string>> {
  const contract = validateFabricHarnessE2eContract(target.contract);
  return Object.freeze({
    [TARGET_ENVIRONMENT.packageId]: contract.packageId,
    ...(target.packageArtifact
      ? {
          [TARGET_ENVIRONMENT.packageArtifact]: validateFabricPackageArtifactPath(
            target.packageArtifact,
          ),
        }
      : {}),
    ...(target.upgradePackageArtifact
      ? {
          [TARGET_ENVIRONMENT.upgradePackageArtifact]: validateFabricPackageArtifactPath(
            target.upgradePackageArtifact,
          ),
        }
      : {}),
    [TARGET_ENVIRONMENT.adapterId]: contract.adapterId,
    [TARGET_ENVIRONMENT.artifactRoot]: contract.artifactRoot,
    [TARGET_ENVIRONMENT.configPath]: contract.configPath,
    [TARGET_ENVIRONMENT.descriptorGlob]: contract.descriptorGlob,
    [TARGET_ENVIRONMENT.descriptorPathPrefix]: contract.descriptorPathPrefix,
    [TARGET_ENVIRONMENT.descriptorRunnerModule]: contract.descriptorRunnerModule,
    [TARGET_ENVIRONMENT.processMarkers]: JSON.stringify(contract.processMarkers ?? []),
    [TARGET_ENVIRONMENT.sandboxName]: validateFabricPackageSandboxName(target.sandboxName),
  });
}
