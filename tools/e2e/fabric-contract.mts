// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

const CONTRACT_VALUE_MAX_BYTES = 512;
const PROCESS_MARKER_LIMIT = 16;
const PROCESS_MARKER_MAX_BYTES = 256;
const HARNESS_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const ADAPTER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const PYTHON_MODULE_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/u;
const UNSAFE_TEXT_PATTERN = /[\p{Cc}\p{Cf}\p{Cs}]/u;
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
  readonly sandboxName: string;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
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
