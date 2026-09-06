// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  FABRIC_PACKAGE_LIVE_SELECTOR,
  FABRIC_PACKAGE_LIVE_TEST_PATH,
  FABRIC_PACKAGE_REPOSITORY_ROOT,
  fabricPackageJourneyEnvironment,
  loadFabricPackageTarget,
} from "./fabric-target.mts";

export * from "./fabric-target.mts";

export interface FabricPackageCliOptions {
  readonly fixturePath: string;
  readonly packageArtifact: string | undefined;
  readonly sandboxName: string | undefined;
  readonly upgradePackageArtifact: string | undefined;
}

const FABRIC_PACKAGE_USAGE =
  "Usage: fabric-package.mts run --contract <fixture.json> [--package-artifact <built-directory>] [--upgrade-package-artifact <built-directory>] [--sandbox-name <name>]";

export function parseFabricPackageCliOptions(argv: readonly string[]): FabricPackageCliOptions {
  if (argv[0] !== "run") {
    throw new Error(FABRIC_PACKAGE_USAGE);
  }
  const values = new Map<string, string>();
  for (let index = 1; index < argv.length; index += 2) {
    const option = argv[index];
    const value = argv[index + 1];
    if (
      (option !== "--contract" &&
        option !== "--package-artifact" &&
        option !== "--upgrade-package-artifact" &&
        option !== "--sandbox-name") ||
      !value
    ) {
      throw new Error(FABRIC_PACKAGE_USAGE);
    }
    if (values.has(option)) throw new Error(`${option} must not be repeated`);
    values.set(option, value);
  }
  const fixturePath = values.get("--contract");
  if (!fixturePath) throw new Error("Fabric package journey requires --contract");
  return {
    fixturePath,
    packageArtifact: values.get("--package-artifact"),
    sandboxName: values.get("--sandbox-name"),
    upgradePackageArtifact: values.get("--upgrade-package-artifact"),
  };
}

/** Run the shared install-to-destroy journey from a package-owned fixture. */
export async function runFabricPackageJourney(options: FabricPackageCliOptions): Promise<number> {
  const target = loadFabricPackageTarget(options.fixturePath, {
    ...(options.packageArtifact ? { packageArtifact: options.packageArtifact } : {}),
    ...(options.sandboxName ? { sandboxName: options.sandboxName } : {}),
    ...(options.upgradePackageArtifact
      ? { upgradePackageArtifact: options.upgradePackageArtifact }
      : {}),
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
