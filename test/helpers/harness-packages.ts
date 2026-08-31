// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { installHarnessPackage } from "../../src/lib/agent-runtime/package/install";
import type { BundledHarnessPackageSourceIdentity } from "../../src/lib/agent-runtime/package/receipt";
import type { InstalledHarnessPackage } from "../../src/lib/agent-runtime/package/store";

const HARNESS_PACKAGE_FIXTURES = Object.freeze([
  {
    id: "hermes",
    displayName: "Hermes Agent",
    packageVersion: "0.1.0",
    aliases: ["nemohermes", "nemo-hermes"],
    defaultChoice: false,
  },
  {
    id: "langchain-deepagents-code",
    displayName: "LangChain Deep Agents Code",
    packageVersion: "0.1.4",
    aliases: [
      "nemo-deepagents",
      "dcode",
      "deepagent",
      "deepagents",
      "deepagents-code",
      "langchain",
    ],
    defaultChoice: false,
  },
  {
    id: "openclaw",
    displayName: "OpenClaw",
    packageVersion: "0.1.1",
    aliases: ["nemoclaw", "nemo-claw"],
    defaultChoice: true,
  },
] as const);

type HarnessPackageFixtureDeclaration = (typeof HARNESS_PACKAGE_FIXTURES)[number] & {
  readonly manifestPath: string;
};

export type HarnessPackageFixtureId = (typeof HARNESS_PACKAGE_FIXTURES)[number]["id"];

export interface HarnessPackageFixtureOptions {
  readonly fixtureParent?: string;
  readonly storeRoot?: string;
  /** Optional agent runtime version declared by generated package manifests. */
  readonly agentExpectedVersion?: string;
  /** Optional non-OpenClaw baseline used by package-authority tests. */
  readonly agentPolicyAdditionsContent?: string;
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
  declaration: HarnessPackageFixtureDeclaration,
  executionSentinel: string,
  agentExpectedVersion?: string,
): string {
  const terminalRuntime =
    declaration.id === "langchain-deepagents-code"
      ? ["runtime:", "  kind: terminal", "  interactive_command: deepagents"]
      : ["runtime:", "  kind: gateway"];
  return [
    `name: ${declaration.id}`,
    `display_name: ${JSON.stringify(declaration.displayName)}`,
    `description: ${JSON.stringify(`Reviewed ${declaration.displayName} fixture adapter`)}`,
    "aliases:",
    ...declaration.aliases.map((alias) => `  - ${alias}`),
    "onboarding:",
    `  default: ${declaration.defaultChoice ? "true" : "false"}`,
    `  sandbox_name: ${declaration.id === "openclaw" ? "my-assistant" : declaration.id}`,
    `binary_path: ${declaration.id}`,
    ...(agentExpectedVersion ? [`expected_version: ${JSON.stringify(agentExpectedVersion)}`] : []),
    ...terminalRuntime,
    `fixture_execution_sentinel: ${JSON.stringify(executionSentinel)}`,
    "",
  ].join("\n");
}

function writePackageArtifact(input: {
  readonly agentPolicyAdditionsContent?: string;
  readonly declaration: HarnessPackageFixtureDeclaration;
  readonly executionSentinel: string;
  readonly agentExpectedVersion?: string;
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
      manifest: input.declaration.manifestPath,
    })}\n`,
  );
  writePrivateFile(
    input.packageRoot,
    input.declaration.manifestPath,
    fixtureManifest(input.declaration, input.executionSentinel, input.agentExpectedVersion),
  );
  const baselineContent = input.agentPolicyAdditionsContent ?? "version: 1\nnetwork_policies: {}\n";
  if (input.declaration.id === "openclaw") {
    writePrivateFile(
      input.packageRoot,
      "nemoclaw-blueprint/policies/openclaw-sandbox.yaml",
      baselineContent,
    );
  } else {
    writePrivateFile(
      input.packageRoot,
      path.posix.join(path.posix.dirname(input.declaration.manifestPath), "policy-additions.yaml"),
      baselineContent,
    );
  }
  if (input.declaration.id === "langchain-deepagents-code") {
    writePrivateFile(
      input.packageRoot,
      path.posix.join(path.posix.dirname(input.declaration.manifestPath), "Dockerfile.base"),
      "FROM scratch\n",
    );
  }
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

  const declarations = HARNESS_PACKAGE_FIXTURES.map((declaration) => ({
    ...declaration,
    manifestPath: `packages/nemoclaw-${declaration.id}/manifest.yaml`,
  }));
  const declarationById = new Map(declarations.map((declaration) => [declaration.id, declaration]));
  const packageRoots = new Map(
    declarations.map((declaration) => {
      const packageRoot = path.join(bundledRoot, `nemoclaw-${declaration.id}`);
      writePackageArtifact({
        agentPolicyAdditionsContent: options.agentPolicyAdditionsContent,
        declaration,
        executionSentinel,
        agentExpectedVersion: options.agentExpectedVersion,
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
      agentPolicyAdditionsContent: options.agentPolicyAdditionsContent,
      declaration,
      executionSentinel,
      agentExpectedVersion: options.agentExpectedVersion,
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

/** Install one reviewed package fixture into the default store owned by an isolated HOME. */
export function installHomeHarnessPackageFixture(
  home: string,
  id: HarnessPackageFixtureId,
): InstalledHarnessPackage {
  const canonicalHome = fs.realpathSync(home);
  const agentPolicyAdditionsContent =
    id === "openclaw"
      ? fs.readFileSync(
          path.join(
            import.meta.dirname,
            "../..",
            "nemoclaw-blueprint/policies/openclaw-sandbox.yaml",
          ),
          "utf8",
        )
      : undefined;
  const fixture = createHarnessPackageFixture({
    fixtureParent: path.join(canonicalHome, "harness-package-fixtures"),
    storeRoot: path.join(canonicalHome, ".nemoclaw", "harnesses"),
    agentPolicyAdditionsContent,
  });
  if (id === "openclaw") {
    const packageRoot = fixture.packageRoots.get(id);
    if (!packageRoot) throw new Error("OpenClaw fixture package root is unavailable");
    writePrivateFile(packageRoot, "Dockerfile.base", "FROM scratch\n");
    writePrivateFile(packageRoot, "packages/nemoclaw-openclaw/Dockerfile", "FROM scratch\n");
  }
  return fixture.install(id);
}
