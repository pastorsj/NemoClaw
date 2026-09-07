// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { pathToFileURL } from "node:url";

import {
  FABRIC_PACKAGE_REPOSITORY_ROOT,
  type FabricPackageJourney,
  fabricPackageJourneyEnvironment,
  loadFabricPackageTarget,
} from "./fabric-target.mts";

export * from "./fabric-target.mts";

export interface FabricPackageCliOptions {
  readonly fixturePath: string;
  readonly journey: FabricPackageJourney;
  readonly packageArtifact: string;
  readonly sandboxName: string | undefined;
  readonly upgradePackageArtifact: string | undefined;
}

const FABRIC_PACKAGE_USAGE =
  "Usage: fabric-package.mts run --contract <fixture.json> --package-artifact <built-directory> [--journey smoke|lifecycle] [--upgrade-package-artifact <built-directory>] [--sandbox-name <name>]";

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
        option !== "--journey" &&
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
  const packageArtifact = values.get("--package-artifact");
  if (!packageArtifact) throw new Error("Fabric package journey requires --package-artifact");
  const journey = values.get("--journey") ?? "smoke";
  if (journey !== "smoke" && journey !== "lifecycle") {
    throw new Error("Fabric package journey must be 'smoke' or 'lifecycle'");
  }
  if (journey === "smoke" && values.has("--upgrade-package-artifact")) {
    throw new Error("Fabric package upgrade artifacts require --journey lifecycle");
  }
  return {
    fixturePath,
    journey,
    packageArtifact,
    sandboxName: values.get("--sandbox-name"),
    upgradePackageArtifact: values.get("--upgrade-package-artifact"),
  };
}

/** Run the shared install-to-destroy journey from a package-owned fixture. */
export async function runFabricPackageJourney(options: FabricPackageCliOptions): Promise<number> {
  const target = loadFabricPackageTarget(options.fixturePath, {
    journey: options.journey,
    packageArtifact: options.packageArtifact,
    ...(options.sandboxName ? { sandboxName: options.sandboxName } : {}),
    ...(options.upgradePackageArtifact
      ? { upgradePackageArtifact: options.upgradePackageArtifact }
      : {}),
  });
  Object.assign(process.env, fabricPackageJourneyEnvironment(target));
  const { executeFabricPackageJourney } = await import("./fabric-journey.mts");
  const previousDirectory = process.cwd();
  try {
    process.chdir(FABRIC_PACKAGE_REPOSITORY_ROOT);
    await executeFabricPackageJourney(target, FABRIC_PACKAGE_REPOSITORY_ROOT);
    return 0;
  } catch {
    process.stderr.write(
      "Fabric package qualification failed; inspect the redacted E2E artifacts for details.\n",
    );
    return 1;
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
