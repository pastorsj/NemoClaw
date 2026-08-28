// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import {
  listBundledHarnessSources,
  type BundledHarnessSourceDeclaration,
} from "../../src/lib/harness/bundled-source";
import { installHarnessPackage } from "../../src/lib/harness/package-install";
import type { BundledHarnessPackageSourceIdentity } from "../../src/lib/harness/package-receipt";
import type { InstalledHarnessPackage } from "../../src/lib/harness/package-store";

export type HarnessPackageFixtureId = BundledHarnessSourceDeclaration["id"];

export interface HarnessPackageFixtureOptions {
  readonly fixtureParent?: string;
  readonly storeRoot?: string;
}

export interface HarnessPackageFixture {
  readonly fixtureRoot: string;
  readonly bundledRoot: string;
  readonly storeRoot: string;
  readonly executionSentinel: string;
  readonly packageRoots: ReadonlyMap<HarnessPackageFixtureId, string>;
  install(id: HarnessPackageFixtureId): InstalledHarnessPackage;
  installMany(ids: readonly HarnessPackageFixtureId[]): readonly InstalledHarnessPackage[];
  advanceActivePointer(
    id: HarnessPackageFixtureId,
    packageVersion?: string,
  ): InstalledHarnessPackage;
  damageActivePointer(id: HarnessPackageFixtureId): void;
  cleanup(): void;
}

const FIXTURE_PARENT = path.join(
  process.cwd(),
  "node_modules/.cache/nemoclaw-harness-package-fixtures",
);
const SOURCE_IDENTITY: BundledHarnessPackageSourceIdentity = Object.freeze({
  kind: "bundled",
  nemoclawBuildIdentity: Object.freeze({
    nemoclawVersion: "0.0.113",
    sourceRevision: "d".repeat(40),
  }),
});

function privateDirectory(directory: string): void {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
}

function writePrivateFile(root: string, relativePath: string, contents: string): void {
  const target = path.join(root, ...relativePath.split("/"));
  privateDirectory(path.dirname(target));
  fs.writeFileSync(target, contents, { mode: 0o600 });
  fs.chmodSync(target, 0o600);
}

function fixtureManifest(
  declaration: BundledHarnessSourceDeclaration,
  executionSentinel: string,
): string {
  const terminalRuntime =
    declaration.id === "langchain-deepagents-code"
      ? ["runtime:", "  kind: terminal", "  interactive_command: deepagents"]
      : ["runtime:", "  kind: gateway"];
  return [
    `name: ${declaration.id}`,
    `display_name: ${JSON.stringify(declaration.displayName)}`,
    `description: ${JSON.stringify(`Reviewed ${declaration.displayName} fixture adapter`)}`,
    `binary_path: ${declaration.id}`,
    ...terminalRuntime,
    `fixture_execution_sentinel: ${JSON.stringify(executionSentinel)}`,
    "",
  ].join("\n");
}

function writePackageArtifact(input: {
  readonly declaration: BundledHarnessSourceDeclaration;
  readonly executionSentinel: string;
  readonly packageRoot: string;
  readonly packageVersion: string;
  readonly payload: string;
}): string {
  privateDirectory(input.packageRoot);
  writePrivateFile(
    input.packageRoot,
    "nemoclaw-package.json",
    `${JSON.stringify({
      schemaVersion: 1,
      kind: "agent-runtime",
      id: input.declaration.id,
      displayName: input.declaration.displayName,
      packageVersion: input.packageVersion,
      contractVersion: 1,
      manifest: input.declaration.manifestPath,
    })}\n`,
  );
  writePrivateFile(
    input.packageRoot,
    input.declaration.manifestPath,
    fixtureManifest(input.declaration, input.executionSentinel),
  );
  writePrivateFile(input.packageRoot, "runtime/payload.txt", input.payload);
  writePrivateFile(
    input.packageRoot,
    "runtime/install-sentinel.cjs",
    `require("node:fs").writeFileSync(${JSON.stringify(input.executionSentinel)}, "ran");\n`,
  );
  writePrivateFile(
    input.packageRoot,
    "package.json",
    `${JSON.stringify({ scripts: { install: "node runtime/install-sentinel.cjs" } })}\n`,
  );
  return input.packageRoot;
}

/** Create reviewed package bytes and an installed store under one exact private test root. */
export function createHarnessPackageFixture(
  options: HarnessPackageFixtureOptions = {},
): HarnessPackageFixture {
  const fixtureParent = options.fixtureParent ?? FIXTURE_PARENT;
  privateDirectory(fixtureParent);
  const fixtureRoot = fs.mkdtempSync(path.join(fixtureParent, "fixture-"));
  fs.chmodSync(fixtureRoot, 0o700);
  const bundledRoot = path.join(fixtureRoot, "bundled");
  const storeRoot = options.storeRoot ?? path.join(fixtureRoot, "store");
  const versionRoot = path.join(fixtureRoot, "versions");
  const executionSentinel = path.join(fixtureRoot, "package-code-ran");
  privateDirectory(bundledRoot);
  privateDirectory(storeRoot);
  privateDirectory(versionRoot);

  const declarations = listBundledHarnessSources();
  const declarationById = new Map(declarations.map((declaration) => [declaration.id, declaration]));
  const packageRoots = new Map(
    declarations.map((declaration) => {
      const packageRoot = path.join(bundledRoot, `nemoclaw-${declaration.id}`);
      writePackageArtifact({
        declaration,
        executionSentinel,
        packageRoot,
        packageVersion: declaration.packageVersion,
        payload: `${declaration.id} reviewed fixture\n`,
      });
      return [declaration.id, packageRoot] as const;
    }),
  );
  let advancedVersionSequence = 0;

  function install(id: HarnessPackageFixtureId): InstalledHarnessPackage {
    const packageRoot = packageRoots.get(id);
    if (!packageRoot) throw new Error(`Unknown harness fixture package '${id}'`);
    return installHarnessPackage({ packageRoot, sourceIdentity: SOURCE_IDENTITY }, { storeRoot });
  }

  function advanceActivePointer(
    id: HarnessPackageFixtureId,
    packageVersion = "0.2.0",
  ): InstalledHarnessPackage {
    const declaration = declarationById.get(id);
    if (!declaration) throw new Error(`Unknown harness fixture package '${id}'`);
    advancedVersionSequence += 1;
    const packageRoot = path.join(
      versionRoot,
      `${id}-${packageVersion}-${String(advancedVersionSequence)}`,
    );
    writePackageArtifact({
      declaration,
      executionSentinel,
      packageRoot,
      packageVersion,
      payload: `${id} advanced fixture ${String(advancedVersionSequence)}\n`,
    });
    return installHarnessPackage({ packageRoot, sourceIdentity: SOURCE_IDENTITY }, { storeRoot });
  }

  return Object.freeze({
    fixtureRoot,
    bundledRoot,
    storeRoot,
    executionSentinel,
    packageRoots,
    install,
    installMany: (ids: readonly HarnessPackageFixtureId[]) => ids.map(install),
    advanceActivePointer,
    damageActivePointer(id: HarnessPackageFixtureId): void {
      const pointer = path.join(storeRoot, "active", `${id}.json`);
      fs.writeFileSync(pointer, "damaged\n", { mode: 0o600 });
      fs.chmodSync(pointer, 0o600);
    },
    cleanup(): void {
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    },
  });
}
