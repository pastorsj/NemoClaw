// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { type SpawnSyncOptions, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export type PackageTestMode = "spec" | "test";

export interface HarnessPackageTestPlan {
  readonly packageName: string;
  readonly packageRoot: string;
  readonly scriptName: "test" | "test:spec";
}

type PackageTestSpawnResult = {
  readonly error?: Error;
  readonly status: number | null;
};

type PackageTestSpawn = (
  command: string,
  args: readonly string[],
  options: SpawnSyncOptions,
) => PackageTestSpawnResult;

interface RunHarnessPackageTestsOptions {
  readonly packagesRoot?: string;
  readonly platform?: NodeJS.Platform;
  readonly spawn?: PackageTestSpawn;
  readonly writeLine?: (message: string) => void;
}

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PACKAGES_ROOT = path.join(REPOSITORY_ROOT, "packages");

function parsePackageMetadata(packageJsonPath: string): Record<string, unknown> {
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

function declaredHarnessManifest(
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

function packageScriptName(mode: PackageTestMode): "test" | "test:spec" {
  return mode === "spec" ? "test:spec" : "test";
}

/** Builds the package test plan from the marker that also identifies installable packages. */
export function discoverHarnessPackageTests(
  mode: PackageTestMode,
  packagesRoot: string = PACKAGES_ROOT,
): readonly HarnessPackageTestPlan[] {
  const scriptName = packageScriptName(mode);
  const plans = fs
    .readdirSync(packagesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry): HarnessPackageTestPlan[] => {
      const packageRoot = path.join(packagesRoot, entry.name);
      const packageJsonPath = path.join(packageRoot, "package.json");
      if (!fs.existsSync(packageJsonPath)) return [];

      const metadata = parsePackageMetadata(packageJsonPath);
      if (!declaredHarnessManifest(metadata, packageJsonPath)) return [];

      if (typeof metadata.name !== "string" || metadata.name.trim().length === 0) {
        throw new Error(`Harness package name must be a non-empty string: ${packageJsonPath}`);
      }
      const scripts = metadata.scripts;
      const script =
        scripts !== null && typeof scripts === "object" && !Array.isArray(scripts)
          ? (scripts as Record<string, unknown>)[scriptName]
          : undefined;
      if (typeof script !== "string" || script.trim().length === 0) {
        throw new Error(`Harness package '${metadata.name}' must declare scripts.${scriptName}`);
      }

      return [
        Object.freeze({
          packageName: metadata.name,
          packageRoot,
          scriptName,
        }),
      ];
    });

  if (plans.length === 0) {
    throw new Error(`No harness packages declare nemoclaw.harnessManifest under ${packagesRoot}`);
  }
  return Object.freeze(plans);
}

/** Runs each package in discovery order so subprocess output remains attributable. */
export function runHarnessPackageTests(
  mode: PackageTestMode,
  options: RunHarnessPackageTestsOptions = {},
): void {
  const plans = discoverHarnessPackageTests(mode, options.packagesRoot);
  const command = (options.platform ?? process.platform) === "win32" ? "npm.cmd" : "npm";
  const spawn =
    options.spawn ??
    ((executable: string, args: readonly string[], spawnOptions: SpawnSyncOptions) =>
      spawnSync(executable, args, spawnOptions));
  const writeLine = options.writeLine ?? console.log;

  for (const plan of plans) {
    writeLine(`Running ${plan.packageName}: npm run ${plan.scriptName}`);
    const result = spawn(command, ["run", plan.scriptName], {
      cwd: plan.packageRoot,
      stdio: "inherit",
    });
    if (result.status !== 0) {
      const detail =
        result.status === null
          ? (result.error?.message ?? "the npm process did not return an exit code")
          : `exit code ${result.status}`;
      throw new Error(`${plan.packageName}: npm run ${plan.scriptName} failed (${detail})`);
    }
  }
}

export function parsePackageTestMode(args: readonly string[]): PackageTestMode {
  if (args.length === 1 && (args[0] === "test" || args[0] === "spec")) return args[0];
  throw new Error("Usage: tsx scripts/packages/run-tests.mts <test|spec>");
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) {
  try {
    runHarnessPackageTests(parsePackageTestMode(process.argv.slice(2)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
