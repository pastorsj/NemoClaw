// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  fabricPackageE2eEnvironment,
  type FabricHarnessE2eContract,
  type FabricPackageE2eTarget,
  hasFabricPackageE2eTarget,
  readFabricPackageE2eTarget,
  validateFabricHarnessE2eContract,
  validateFabricPackageId,
} from "./fabric-contract.mts";

export { fabricPackageE2eEnvironment, hasFabricPackageE2eTarget, readFabricPackageE2eTarget };
export type { FabricPackageE2eTarget };

const CONTRACT_FIXTURE_MAX_BYTES = 16 * 1024;

export const FABRIC_PACKAGE_LIVE_TEST_PATH = "test/e2e/live/fabric-package.test.ts";
export const FABRIC_PACKAGE_LIVE_SELECTOR = "^fabric-package$";
export const FABRIC_PACKAGE_REPOSITORY_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

/** Read a bounded package-owned contract fixture from this or another checkout. */
export function readFabricHarnessE2eFixture(
  fixturePath: string,
  workingDirectory = process.cwd(),
): FabricHarnessE2eContract {
  const resolvedPath = path.resolve(workingDirectory, fixturePath);
  const metadata = fs.lstatSync(resolvedPath);
  if (
    metadata.isSymbolicLink() ||
    !metadata.isFile() ||
    metadata.size > CONTRACT_FIXTURE_MAX_BYTES
  ) {
    throw new Error("Fabric package fixture must be a bounded regular file");
  }
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(resolvedPath, "utf8"));
  } catch {
    throw new Error("Fabric package fixture must contain valid JSON");
  }
  return validateFabricHarnessE2eContract(value);
}

function validateSandboxName(value: string): string {
  try {
    validateFabricPackageId(value);
  } catch {
    throw new Error("Fabric package E2E sandbox name must be a canonical identifier");
  }
  return value;
}

export function defaultFabricPackageSandboxName(packageId: string): string {
  validateFabricPackageId(packageId);
  const candidate = `e2e-${packageId}`;
  if (candidate.length <= 63) return candidate;
  const digest = createHash("sha256").update(packageId).digest("hex").slice(0, 10);
  return `${candidate.slice(0, 52)}-${digest}`;
}

/** Load one reusable target from package-owned contract data and run-owned state. */
export function loadFabricPackageTarget(
  fixturePath: string,
  options: { readonly sandboxName?: string; readonly workingDirectory?: string } = {},
): FabricPackageE2eTarget {
  const contract = readFabricHarnessE2eFixture(
    fixturePath,
    options.workingDirectory ?? process.cwd(),
  );
  return Object.freeze({
    contract,
    sandboxName: validateSandboxName(
      options.sandboxName ?? defaultFabricPackageSandboxName(contract.packageId),
    ),
  });
}

/** Derive a non-default gateway binding so a package proof does not mutate the user's gateway. */
export function fabricPackageGatewayEnvironment(
  packageId: string,
): Readonly<Record<"NEMOCLAW_GATEWAY_PORT" | "OPENSHELL_GATEWAY", string>> {
  validateFabricPackageId(packageId);
  const digest = createHash("sha256").update(packageId).digest();
  const port = 20_000 + (digest.readUInt16BE(0) % 20_000);
  return Object.freeze({
    NEMOCLAW_GATEWAY_PORT: String(port),
    OPENSHELL_GATEWAY: `nemoclaw-${String(port)}`,
  });
}

/** Build the generic direct-run environment shared by local and catalogue dispatch. */
export function fabricPackageJourneyEnvironment(
  target: FabricPackageE2eTarget,
  environment: NodeJS.ProcessEnv = process.env,
): Readonly<Record<string, string>> {
  const model =
    environment.NEMOCLAW_MODEL ??
    environment.NEMOCLAW_COMPAT_MODEL ??
    "nvidia/nvidia/nemotron-3-ultra";
  return Object.freeze({
    ...fabricPackageGatewayEnvironment(target.contract.packageId),
    ...fabricPackageE2eEnvironment(target),
    E2E_TARGET_ID: environment.E2E_TARGET_ID ?? `${target.contract.packageId}-fabric`,
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
    NEMOCLAW_AGENT: target.contract.packageId,
    NEMOCLAW_COMPAT_MODEL: model,
    NEMOCLAW_E2E_REQUIRE_EXECUTED_TEST: "1",
    NEMOCLAW_E2E_USE_HOSTED_INFERENCE: "1",
    NEMOCLAW_ENDPOINT_URL:
      environment.NEMOCLAW_ENDPOINT_URL ?? "https://inference-api.nvidia.com/v1",
    NEMOCLAW_MODEL: model,
    NEMOCLAW_NON_INTERACTIVE: "1",
    NEMOCLAW_PREFERRED_API: environment.NEMOCLAW_PREFERRED_API ?? "openai-completions",
    NEMOCLAW_PROVIDER: "custom",
    NEMOCLAW_RUN_LIVE_E2E: "1",
    NEMOCLAW_SANDBOX_GPU: "0",
  });
}

export interface FabricPackageCliOptions {
  readonly fixturePath: string;
  readonly sandboxName: string | undefined;
}

export function parseFabricPackageCliOptions(argv: readonly string[]): FabricPackageCliOptions {
  if (argv[0] !== "run") {
    throw new Error(
      "Usage: fabric-package.mts run --contract <fixture.json> [--sandbox-name <name>]",
    );
  }
  const values = new Map<string, string>();
  for (let index = 1; index < argv.length; index += 2) {
    const option = argv[index];
    const value = argv[index + 1];
    if ((option !== "--contract" && option !== "--sandbox-name") || !value) {
      throw new Error(
        "Usage: fabric-package.mts run --contract <fixture.json> [--sandbox-name <name>]",
      );
    }
    if (values.has(option)) throw new Error(`${option} must not be repeated`);
    values.set(option, value);
  }
  const fixturePath = values.get("--contract");
  if (!fixturePath) throw new Error("Fabric package journey requires --contract");
  return { fixturePath, sandboxName: values.get("--sandbox-name") };
}

/** Run the shared install-to-destroy journey from a package-owned fixture. */
export async function runFabricPackageJourney(options: FabricPackageCliOptions): Promise<number> {
  const target = loadFabricPackageTarget(options.fixturePath, {
    ...(options.sandboxName ? { sandboxName: options.sandboxName } : {}),
  });
  Object.assign(process.env, fabricPackageJourneyEnvironment(target));
  process.env.NEMOCLAW_CLI_BIN ??= path.join(FABRIC_PACKAGE_REPOSITORY_ROOT, "bin/nemoclaw.js");
  const { runLiveVitestCommand } = await import("./live-vitest-invocation.mts");
  const previousDirectory = process.cwd();
  try {
    process.chdir(FABRIC_PACKAGE_REPOSITORY_ROOT);
    return runLiveVitestCommand(
      [
        "run",
        "--test-path",
        FABRIC_PACKAGE_LIVE_TEST_PATH,
        "--selector",
        FABRIC_PACKAGE_LIVE_SELECTOR,
      ],
      undefined,
      process.env,
    );
  } finally {
    process.chdir(previousDirectory);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runFabricPackageJourney(parseFabricPackageCliOptions(process.argv.slice(2))).then(
    (exitCode) => {
      process.exitCode = exitCode;
    },
  );
}
