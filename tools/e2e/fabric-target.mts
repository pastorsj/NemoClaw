// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Process-free Fabric package target data shared by live tests and the outer CLI launcher. */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  fabricPackageE2eEnvironment,
  type FabricHarnessE2eContract,
  type FabricPackageE2eTarget,
  hasFabricPackageE2eTarget,
  readFabricPackageE2eTarget,
  validateFabricHarnessE2eContract,
  validateFabricPackageArtifactPath,
  validateFabricPackageId,
  validateFabricPackageSandboxName,
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

/** Load the conventional package-owned fixture without maintaining a central harness map. */
export function readBundledFabricHarnessE2eFixture(
  packageId: string,
  repositoryRoot = FABRIC_PACKAGE_REPOSITORY_ROOT,
): FabricHarnessE2eContract {
  validateFabricPackageId(packageId);
  const contract = readFabricHarnessE2eFixture(
    path.join("packages", `nemoclaw-${packageId}`, "tests", "fixtures", "live-contract.json"),
    repositoryRoot,
  );
  if (contract.packageId !== packageId) {
    throw new Error(`Fabric package fixture identity does not match '${packageId}'`);
  }
  return contract;
}

export function defaultFabricPackageSandboxName(packageId: string): string {
  validateFabricPackageId(packageId);
  const candidate = `e2e-${packageId}`;
  if (candidate.length <= 19) return candidate;
  const digest = createHash("sha256").update(packageId).digest("hex").slice(0, 10);
  const prefix = candidate.slice(0, 10).replace(/-+$/u, "");
  return `${prefix}-${digest.slice(0, 19 - prefix.length - 1)}`;
}

/** Load one reusable target from package-owned contract data and run-owned state. */
export function loadFabricPackageTarget(
  fixturePath: string,
  options: {
    readonly packageArtifact?: string;
    readonly sandboxName?: string;
    readonly upgradePackageArtifact?: string;
    readonly workingDirectory?: string;
  } = {},
): FabricPackageE2eTarget {
  const workingDirectory = options.workingDirectory ?? process.cwd();
  const contract = readFabricHarnessE2eFixture(fixturePath, workingDirectory);
  const resolveArtifact = (candidate: string | undefined): string | undefined => {
    if (!candidate) return undefined;
    const artifact = validateFabricPackageArtifactPath(path.resolve(workingDirectory, candidate));
    let metadata: fs.Stats;
    try {
      metadata = fs.lstatSync(artifact);
    } catch {
      throw new Error("Fabric package artifact must be an existing directory");
    }
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error("Fabric package artifact must be a directory without symbolic links");
    }
    return artifact;
  };
  const packageArtifact = resolveArtifact(options.packageArtifact);
  const upgradePackageArtifact = resolveArtifact(options.upgradePackageArtifact);
  if (packageArtifact && upgradePackageArtifact && packageArtifact === upgradePackageArtifact) {
    throw new Error("Fabric package lifecycle artifacts must use different directories");
  }
  return Object.freeze({
    contract,
    ...(packageArtifact ? { packageArtifact } : {}),
    ...(upgradePackageArtifact ? { upgradePackageArtifact } : {}),
    sandboxName: validateFabricPackageSandboxName(
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
