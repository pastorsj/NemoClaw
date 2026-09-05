// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { installHarnessPackage } from "../../src/lib/agent-runtime/package/install";
import type { BundledHarnessPackageSourceIdentity } from "../../src/lib/agent-runtime/package/receipt";
import {
  resolvePinnedHarnessPackage,
  type InstalledHarnessPackage,
} from "../../src/lib/agent-runtime/package/store";

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, "../..");

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
  {
    id: "pi",
    displayName: "Pi",
    packageVersion: "0.1.0",
    aliases: [],
    defaultChoice: false,
  },
] as const);

interface HarnessPackageFixtureDeclaration {
  readonly id: string;
  readonly displayName: string;
  readonly packageVersion: string;
  readonly aliases: readonly string[];
  readonly defaultChoice: boolean;
  readonly manifestPath: string;
}

export type HarnessPackageFixtureId = (typeof HARNESS_PACKAGE_FIXTURES)[number]["id"];
export type McpHarnessPackageFixtureId = Exclude<HarnessPackageFixtureId, "pi">;

interface McpHarnessPackageStoreTemplate {
  readonly root: string;
  readonly storeRoot: string;
  readonly identities: ReadonlyMap<McpHarnessPackageFixtureId, InstalledHarnessPackage["identity"]>;
}

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
  installLocal(input: {
    readonly id: string;
    readonly displayName?: string;
    readonly packageVersion?: string;
    readonly aliases?: readonly string[];
    readonly defaultChoice?: boolean;
  }): InstalledHarnessPackage;
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
let mcpHarnessPackageStoreTemplate: McpHarnessPackageStoreTemplate | undefined;

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
  const terminalCommand =
    declaration.id === "langchain-deepagents-code"
      ? "deepagents"
      : declaration.id === "pi"
        ? "pi"
        : null;
  const terminalRuntime = terminalCommand
    ? ["runtime:", "  kind: terminal", `  interactive_command: ${terminalCommand}`]
    : ["runtime:", "  kind: gateway"];
  return [
    `name: ${declaration.id}`,
    `display_name: ${JSON.stringify(declaration.displayName)}`,
    `description: ${JSON.stringify(`Reviewed ${declaration.displayName} fixture adapter`)}`,
    ...(declaration.aliases.length > 0
      ? ["aliases:", ...declaration.aliases.map((alias) => `  - ${alias}`)]
      : []),
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
      minimumNemoClawVersion: "0.0.113",
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
  if (input.declaration.id === "openclaw" || input.declaration.id === "hermes") {
    writePrivateFile(
      input.packageRoot,
      path.posix.join(path.posix.dirname(input.declaration.manifestPath), "Dockerfile"),
      [
        "FROM scratch",
        "ARG NEMOCLAW_WEB_SEARCH_ENABLED=0",
        `ARG NEMOCLAW_WEB_SEARCH_PROVIDER=${input.declaration.id === "hermes" ? "tavily" : "brave"}`,
        "",
      ].join("\n"),
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
  let localPackageSequence = 0;

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

  function installLocal(input: {
    readonly id: string;
    readonly displayName?: string;
    readonly packageVersion?: string;
    readonly aliases?: readonly string[];
    readonly defaultChoice?: boolean;
  }): InstalledHarnessPackage {
    localPackageSequence += 1;
    const packageVersion = input.packageVersion ?? "1.0.0";
    const declaration: HarnessPackageFixtureDeclaration = {
      id: input.id,
      displayName: input.displayName ?? input.id,
      packageVersion,
      aliases: input.aliases ?? [],
      defaultChoice: input.defaultChoice ?? false,
      manifestPath: `packages/nemoclaw-${input.id}/manifest.yaml`,
    };
    const packageRoot = path.join(
      versionRoot,
      `local-${input.id}-${packageVersion}-${String(localPackageSequence)}`,
    );
    writePackageArtifact({
      agentPolicyAdditionsContent: options.agentPolicyAdditionsContent,
      declaration,
      executionSentinel,
      agentExpectedVersion: options.agentExpectedVersion,
      packageRoot,
      packageVersion,
      payload: `${input.id} local fixture ${String(localPackageSequence)}\n`,
    });
    return installHarnessPackage(
      { packageRoot, expectedId: input.id, sourceIdentity: { kind: "local" } },
      { storeRoot },
    );
  }

  return Object.freeze({
    fixtureRoot,
    bundledRoot,
    storeRoot,
    executionSentinel,
    packageRoots,
    install,
    installLocal,
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

function installMcpHarnessPackageFixture(
  sourceParent: string,
  storeRoot: string,
  id: McpHarnessPackageFixtureId,
): InstalledHarnessPackage {
  const declaration = HARNESS_PACKAGE_FIXTURES.find((candidate) => candidate.id === id);
  if (!declaration) throw new Error(`Unknown MCP harness fixture package '${id}'`);

  const sourceRoot = path.join(sourceParent, id);
  const packageDirectory = `packages/nemoclaw-${id}`;
  const repositoryPackageRoot = path.join(REPOSITORY_ROOT, packageDirectory);
  privateDirectory(path.join(sourceRoot, packageDirectory, "host"));
  writePrivateFile(
    sourceRoot,
    "nemoclaw-package.json",
    `${JSON.stringify({
      schemaVersion: 1,
      kind: "agent-runtime",
      id,
      displayName: declaration.displayName,
      packageVersion: declaration.packageVersion,
      minimumNemoClawVersion: "0.0.113",
      manifest: `${packageDirectory}/manifest.yaml`,
    })}\n`,
  );
  for (const relativePath of ["manifest.yaml", "host/mcp-adapter.cts"] as const) {
    writePrivateFile(
      sourceRoot,
      `${packageDirectory}/${relativePath}`,
      fs.readFileSync(path.join(repositoryPackageRoot, relativePath), "utf8"),
    );
  }

  return installHarnessPackage(
    { packageRoot: sourceRoot, sourceIdentity: SOURCE_IDENTITY },
    { storeRoot },
  );
}

function getMcpHarnessPackageStoreTemplate(): McpHarnessPackageStoreTemplate {
  if (mcpHarnessPackageStoreTemplate) return mcpHarnessPackageStoreTemplate;
  privateDirectory(FIXTURE_PARENT);
  const root = fs.mkdtempSync(path.join(FIXTURE_PARENT, "mcp-store-"));
  fs.chmodSync(root, 0o700);
  const storeRoot = path.join(root, "store");
  const sourceParent = path.join(root, "sources");
  const identities = new Map<McpHarnessPackageFixtureId, InstalledHarnessPackage["identity"]>();
  for (const id of ["openclaw", "hermes", "langchain-deepagents-code"] as const) {
    identities.set(id, installMcpHarnessPackageFixture(sourceParent, storeRoot, id).identity);
  }
  mcpHarnessPackageStoreTemplate = Object.freeze({ root, storeRoot, identities });
  return mcpHarnessPackageStoreTemplate;
}

function restorePrivateFixtureModes(root: string): void {
  fs.chmodSync(root, 0o700);
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) {
      restorePrivateFixtureModes(target);
    } else {
      fs.chmodSync(target, 0o600);
    }
  }
}

/** Install a package's real manifest and MCP adapter under an isolated test HOME. */
export function installHomeMcpHarnessPackageFixture(
  home: string,
  id: McpHarnessPackageFixtureId,
): InstalledHarnessPackage {
  const canonicalHome = fs.realpathSync(home);
  const template = getMcpHarnessPackageStoreTemplate();
  const storeRoot = path.join(canonicalHome, ".nemoclaw", "harnesses");
  if (!fs.existsSync(storeRoot)) {
    privateDirectory(path.dirname(storeRoot));
    fs.cpSync(template.storeRoot, storeRoot, { recursive: true, preserveTimestamps: true });
    restorePrivateFixtureModes(storeRoot);
  }
  const identity = template.identities.get(id);
  if (!identity) throw new Error(`Unknown MCP harness fixture package '${id}'`);
  return resolvePinnedHarnessPackage(identity, { storeRoot });
}

/** Install the real OpenClaw restore manifest and adapter under an isolated HOME. */
export function installHomeOpenClawRestorePackageFixture(home: string): InstalledHarnessPackage {
  const canonicalHome = fs.realpathSync(home);
  const sourceRoot = path.join(canonicalHome, "openclaw-restore-package");
  const packageRoot = path.join(sourceRoot, "packages", "nemoclaw-openclaw");
  const repositoryPackageRoot = path.join(
    import.meta.dirname,
    "../..",
    "packages",
    "nemoclaw-openclaw",
  );
  privateDirectory(path.join(packageRoot, "host"));
  fs.copyFileSync(
    path.join(repositoryPackageRoot, "manifest.yaml"),
    path.join(packageRoot, "manifest.yaml"),
  );
  fs.copyFileSync(
    path.join(repositoryPackageRoot, "host", "restore-adapter.cts"),
    path.join(packageRoot, "host", "restore-adapter.cts"),
  );
  writePrivateFile(
    sourceRoot,
    "nemoclaw-package.json",
    `${JSON.stringify({
      schemaVersion: 1,
      kind: "agent-runtime",
      id: "openclaw",
      displayName: "OpenClaw",
      packageVersion: "0.1.1",
      minimumNemoClawVersion: "0.0.113",
      manifest: "packages/nemoclaw-openclaw/manifest.yaml",
    })}\n`,
  );
  return installHarnessPackage(
    { packageRoot: sourceRoot, sourceIdentity: SOURCE_IDENTITY },
    { storeRoot: path.join(canonicalHome, ".nemoclaw", "harnesses") },
  );
}
