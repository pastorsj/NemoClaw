#!/usr/bin/env -S node --experimental-strip-types --no-warnings
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import {
  formatCheckoutResult,
  type PackageCheckoutOptions,
  type PackageCheckoutResult,
  runPackageCheckoutRehearsal,
} from "./checkout.mts";

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, "../..");
const PACKAGES_ROOT = path.join(REPOSITORY_ROOT, "packages");
const PACKAGE_JSON_MAX_BYTES = 64 * 1024;
const EXACT_COMMIT_SHA = /^[a-f0-9]{40}$/u;
const HARNESS_ID = /^[a-z][a-z0-9-]{0,62}$/u;
const MATRIX_MODES = ["package-only", "composed"] as const;

export interface PackageRehearsalTarget {
  readonly packageId: string;
  readonly packageName: string;
  readonly packageRoot: string;
}

export interface PackageRehearsalMatrixOptions {
  readonly packagesRoot?: string;
  readonly coreCheckoutDir: string;
  readonly coreCommit: string;
  /** Acknowledge that every selected rehearsal executes trusted package code on the host. */
  readonly allowPackageCode?: boolean;
}

export interface PackageRehearsalMatrixCliOptions extends PackageRehearsalMatrixOptions {
  readonly planOnly: boolean;
}

export interface PackageRehearsalMatrixDependencies {
  readonly runRehearsal?: (options: PackageCheckoutOptions) => PackageCheckoutResult;
  readonly writeLine?: (message: string) => void;
}

function readPackageMetadata(packageJsonPath: string): Record<string, unknown> {
  const stats = fs.lstatSync(packageJsonPath);
  if (stats.isSymbolicLink() || !stats.isFile() || stats.size > PACKAGE_JSON_MAX_BYTES) {
    throw new Error(`Package metadata must be a bounded regular file: ${packageJsonPath}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as unknown;
  } catch (cause) {
    throw new Error(`Package metadata is invalid: ${packageJsonPath}`, { cause });
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Package metadata must contain one object: ${packageJsonPath}`);
  }
  return value as Record<string, unknown>;
}

function harnessManifestMarker(
  metadata: Record<string, unknown>,
  packageJsonPath: string,
): boolean {
  const nemoclaw = metadata.nemoclaw;
  if (nemoclaw === null || typeof nemoclaw !== "object" || Array.isArray(nemoclaw)) return false;
  const declaration = nemoclaw as Record<string, unknown>;
  if (!Object.hasOwn(declaration, "harnessManifest")) return false;
  if (declaration.harnessManifest !== "manifest.yaml") {
    throw new Error(`nemoclaw.harnessManifest must equal 'manifest.yaml': ${packageJsonPath}`);
  }
  return true;
}

function packageIdFromName(packageName: unknown, packageJsonPath: string): string {
  if (typeof packageName !== "string") {
    throw new Error(`Harness package name must identify nemoclaw-<id>: ${packageJsonPath}`);
  }
  const unscopedName = packageName.slice(packageName.lastIndexOf("/") + 1);
  const packageId = unscopedName.startsWith("nemoclaw-")
    ? unscopedName.slice("nemoclaw-".length)
    : "";
  if (!HARNESS_ID.test(packageId)) {
    throw new Error(`Harness package name must identify nemoclaw-<id>: ${packageJsonPath}`);
  }
  return packageId;
}

/** Discover every installable package through the same package metadata marker used by tests. */
export function discoverPackageRehearsalTargets(
  packagesRoot: string = PACKAGES_ROOT,
): readonly PackageRehearsalTarget[] {
  const canonicalRoot = path.resolve(packagesRoot);
  const rootStats = fs.lstatSync(canonicalRoot);
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw new Error(`Packages root must be a regular directory: ${canonicalRoot}`);
  }
  const targets = fs
    .readdirSync(canonicalRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .flatMap((entry): PackageRehearsalTarget[] => {
      const packageRoot = path.join(canonicalRoot, entry.name);
      const packageJsonPath = path.join(packageRoot, "package.json");
      if (!fs.existsSync(packageJsonPath)) return [];
      const metadata = readPackageMetadata(packageJsonPath);
      if (!harnessManifestMarker(metadata, packageJsonPath)) return [];
      const packageId = packageIdFromName(metadata.name, packageJsonPath);
      const manifestPath = path.join(packageRoot, "manifest.yaml");
      const manifestStats = fs.lstatSync(manifestPath);
      if (manifestStats.isSymbolicLink() || !manifestStats.isFile()) {
        throw new Error(`Harness package manifest must be a regular file: ${manifestPath}`);
      }
      return [
        Object.freeze({
          packageId,
          packageName: metadata.name as string,
          packageRoot,
        }),
      ];
    })
    .sort((left, right) => left.packageId.localeCompare(right.packageId));

  if (targets.length === 0) {
    throw new Error(`No harness packages declare nemoclaw.harnessManifest under ${canonicalRoot}`);
  }
  const packageIds = targets.map(({ packageId }) => packageId);
  if (new Set(packageIds).size !== packageIds.length) {
    throw new Error(`Harness package IDs must be unique under ${canonicalRoot}`);
  }
  return Object.freeze(targets);
}

/** Plan package-only rehearsals first, then revision-pinned composed rehearsals. */
export function buildPackageRehearsalMatrix(
  options: PackageRehearsalMatrixOptions,
): readonly PackageCheckoutOptions[] {
  if (!EXACT_COMMIT_SHA.test(options.coreCommit)) {
    throw new Error("Package rehearsal matrix requires an exact 40-character commit SHA");
  }
  const coreCheckoutDir = path.resolve(options.coreCheckoutDir);
  return Object.freeze(
    MATRIX_MODES.flatMap((mode) =>
      discoverPackageRehearsalTargets(options.packagesRoot).map((target) =>
        Object.freeze({
          mode,
          packageId: target.packageId,
          candidatePackageDir: target.packageRoot,
          ...(options.allowPackageCode === true ? { allowPackageCode: true } : {}),
          ...(mode === "composed" ? { coreCheckoutDir, coreCommit: options.coreCommit } : {}),
        }),
      ),
    ),
  );
}

/** Run every discovered package through both independent checkout boundaries. */
export function runPackageRehearsalMatrix(
  options: PackageRehearsalMatrixOptions,
  dependencies: PackageRehearsalMatrixDependencies = {},
): readonly PackageCheckoutResult[] {
  if (options.allowPackageCode !== true) {
    throw new Error(
      "Package rehearsal matrix executes trusted candidate package code on this host and is not an untrusted-package sandbox. Pass allowPackageCode: true through the API or --allow-package-code through the CLI only for trusted candidates.",
    );
  }
  const runRehearsal = dependencies.runRehearsal ?? runPackageCheckoutRehearsal;
  const writeLine = dependencies.writeLine ?? console.log;
  const results: PackageCheckoutResult[] = [];
  for (const plan of buildPackageRehearsalMatrix(options)) {
    writeLine(`Running ${plan.mode} rehearsal for ${plan.packageId}`);
    const result = runRehearsal(plan);
    results.push(result);
    writeLine(formatCheckoutResult(result));
  }
  return Object.freeze(results);
}

function usage(): string {
  return [
    "Usage:",
    "  scripts/packages/rehearsal-matrix.mts --nemoclaw-commit <sha> [--nemoclaw-checkout <path>] [--packages-root <path>] [--plan] [--allow-package-code]",
    "",
    "--plan only discovers and prints rehearsals; it does not execute package code.",
    "--allow-package-code acknowledges that a non-plan run executes trusted candidate package code on the host. It is not an untrusted-package sandbox.",
  ].join("\n");
}

export function readPackageRehearsalMatrixCliOptions(
  args: readonly string[],
): PackageRehearsalMatrixCliOptions {
  const { values } = parseArgs({
    args,
    allowPositionals: false,
    strict: true,
    options: {
      help: { type: "boolean", short: "h" },
      "nemoclaw-checkout": { type: "string" },
      "nemoclaw-commit": { type: "string" },
      "packages-root": { type: "string" },
      plan: { type: "boolean" },
      "allow-package-code": { type: "boolean" },
    },
  });
  if (values.help) throw new Error(usage());
  if (!values["nemoclaw-commit"]) throw new Error(usage());
  return Object.freeze({
    packagesRoot: values["packages-root"],
    coreCheckoutDir: path.resolve(values["nemoclaw-checkout"] ?? REPOSITORY_ROOT),
    coreCommit: values["nemoclaw-commit"],
    planOnly: values.plan ?? false,
    allowPackageCode: values["allow-package-code"] ?? false,
  });
}

export function formatPackageRehearsalPlan(plans: readonly PackageCheckoutOptions[]): string {
  return plans
    .map(
      (plan) =>
        `${plan.mode}\t${plan.packageId}\t${plan.candidatePackageDir}\t${plan.coreCommit ?? "-"}`,
    )
    .join("\n");
}

function main(): void {
  if (process.argv.slice(2).some((argument) => argument === "--help" || argument === "-h")) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const options = readPackageRehearsalMatrixCliOptions(process.argv.slice(2));
  if (options.planOnly) {
    process.stdout.write(`${formatPackageRehearsalPlan(buildPackageRehearsalMatrix(options))}\n`);
    return;
  }
  runPackageRehearsalMatrix(options);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
