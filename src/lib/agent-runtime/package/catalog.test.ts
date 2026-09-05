// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DamagedInstalledHarnessPackageError,
  HarnessPackageCatalogIntegrityError,
  HarnessPackageUnavailableError,
  listHarnessPackageInventory,
  resolveHarnessPackageInstallSelection,
} from "./catalog";
import { installHarnessPackage } from "./install";
import { promptForHarnessPackage } from "./prompt";
import type { BundledHarnessPackageSourceIdentity } from "./receipt";
import { selectOnboardHarnessPackage } from "../../onboard/package-selection";

const CATALOG_TEST_PARENT = path.join(
  process.cwd(),
  "node_modules/.cache/nemoclaw-package-catalog-tests",
);
const SOURCE_IDENTITY: BundledHarnessPackageSourceIdentity = Object.freeze({
  kind: "bundled",
  nemoclawBuildIdentity: Object.freeze({
    nemoclawVersion: "0.0.113",
    sourceRevision: "a".repeat(40),
  }),
});

interface PackageFixture {
  readonly directoryName?: string;
  readonly id: string;
  readonly displayName: string;
  readonly packageVersion: string;
  readonly manifestPath?: string;
  readonly description?: string;
  readonly aliases?: readonly string[];
  readonly defaultChoice?: boolean;
  readonly sandboxName?: string;
  readonly payload?: string;
}

const REVIEWED_FIXTURES = Object.freeze([
  {
    id: "hermes",
    displayName: "Hermes Agent",
    packageVersion: "0.1.0",
    aliases: ["nemohermes", "nemo-hermes"],
  },
  {
    id: "langchain-deepagents-code",
    displayName: "LangChain Deep Agents Code",
    packageVersion: "0.1.4",
    aliases: ["dcode", "deepagents", "deepagents-code", "langchain"],
  },
  {
    id: "openclaw",
    displayName: "OpenClaw",
    packageVersion: "0.1.1",
    aliases: ["nemoclaw", "nemo-claw"],
    defaultChoice: true,
  },
]);

fs.mkdirSync(CATALOG_TEST_PARENT, { recursive: true, mode: 0o700 });

let fixtureRoot = path.join(process.cwd(), ".nemoclaw-catalog-test-unused");
let bundledRoot = path.join(fixtureRoot, "bundled");
let storeRoot = path.join(fixtureRoot, "store");

function writeFixtureFile(root: string, relativePath: string, contents: string): void {
  const target = path.join(root, ...relativePath.split("/"));
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.writeFileSync(target, contents, { mode: 0o600 });
  fs.chmodSync(target, 0o600);
}

function writePackageFixture(parent: string, fixture: PackageFixture): string {
  const packageRoot = path.join(parent, fixture.directoryName ?? `nemoclaw-${fixture.id}`);
  const manifestPath = fixture.manifestPath ?? `packages/nemoclaw-${fixture.id}/manifest.yaml`;
  fs.mkdirSync(packageRoot, { recursive: true, mode: 0o700 });
  fs.chmodSync(packageRoot, 0o700);
  writeFixtureFile(
    packageRoot,
    "nemoclaw-package.json",
    `${JSON.stringify({
      schemaVersion: 1,
      kind: "agent-runtime",
      id: fixture.id,
      displayName: fixture.displayName,
      packageVersion: fixture.packageVersion,
      minimumNemoClawVersion: "0.0.113",
      manifest: manifestPath,
    })}\n`,
  );
  writeFixtureFile(
    packageRoot,
    manifestPath,
    [
      `name: ${fixture.id}`,
      `display_name: ${JSON.stringify(fixture.displayName)}`,
      `description: ${JSON.stringify(fixture.description ?? `${fixture.displayName} adapter`)}`,
      ...(fixture.aliases?.length
        ? ["aliases:", ...fixture.aliases.map((alias) => `  - ${alias}`)]
        : []),
      "onboarding:",
      `  default: ${fixture.defaultChoice === true ? "true" : "false"}`,
      `  sandbox_name: ${fixture.sandboxName ?? fixture.id}`,
      "",
    ].join("\n"),
  );
  writeFixtureFile(packageRoot, "runtime/payload.txt", fixture.payload ?? `${fixture.id}\n`);
  return packageRoot;
}

function writeReviewedBundle(): Map<string, string> {
  fs.mkdirSync(bundledRoot, { recursive: true, mode: 0o700 });
  return new Map(
    REVIEWED_FIXTURES.map((declaration) => [
      declaration.id,
      writePackageFixture(bundledRoot, {
        id: declaration.id,
        displayName: declaration.displayName,
        packageVersion: declaration.packageVersion,
        description: `Reviewed ${declaration.displayName} adapter`,
        aliases: declaration.aliases,
        defaultChoice: declaration.defaultChoice,
      }),
    ]),
  );
}

function installPackage(packageRoot: string) {
  return installHarnessPackage({ packageRoot, sourceIdentity: SOURCE_IDENTITY }, { storeRoot });
}

function catalogueOptions() {
  return { bundledRoot, storeRoot } as const;
}

function recursiveState(root: string): readonly string[] {
  const visit = (current: string, relative: string): readonly string[] => {
    const metadata = fs.lstatSync(current, { bigint: true });
    const currentState = [
      [
        relative,
        metadata.mode.toString(),
        metadata.size.toString(),
        metadata.mtimeNs.toString(),
        metadata.ctimeNs.toString(),
      ].join(":"),
    ];
    const descendantState = metadata.isDirectory()
      ? fs
          .readdirSync(current)
          .sort()
          .flatMap((entry) =>
            visit(path.join(current, entry), relative ? `${relative}/${entry}` : entry),
          )
      : [];
    return [...currentState, ...descendantState];
  };
  return fs.existsSync(root) ? visit(root, "") : [];
}

beforeEach(() => {
  fixtureRoot = fs.mkdtempSync(path.join(CATALOG_TEST_PARENT, "fixture-"));
  fs.chmodSync(fixtureRoot, 0o700);
  bundledRoot = path.join(fixtureRoot, "bundled");
  storeRoot = path.join(fixtureRoot, "store");
  fs.mkdirSync(storeRoot, { mode: 0o700 });
});

afterEach(() => {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
});

describe("harness package catalogue", () => {
  it("lists the exact reviewed bundle when the private store is empty", () => {
    writeReviewedBundle();

    const inventory = listHarnessPackageInventory(catalogueOptions());

    expect(inventory.available.map(({ id }) => id)).toEqual([
      "hermes",
      "langchain-deepagents-code",
      "openclaw",
    ]);
    expect(inventory.available.map(({ description }) => description)).toEqual([
      "Reviewed Hermes Agent adapter",
      "Reviewed LangChain Deep Agents Code adapter",
      "Reviewed OpenClaw adapter",
    ]);
    expect(inventory.installed).toEqual([]);
    expect(fs.readdirSync(storeRoot)).toEqual([]);
  });

  it("keeps one exact package visible in separate available and installed views", () => {
    const packageRoots = writeReviewedBundle();
    installPackage(packageRoots.get("openclaw")!);

    const inventory = listHarnessPackageInventory(catalogueOptions());
    const available = inventory.available.find(({ id }) => id === "openclaw");
    const installed = inventory.installed.find(({ id }) => id === "openclaw");

    expect(installed).toMatchObject({
      state: "installed",
      id: "openclaw",
      displayName: "OpenClaw",
      description: "Reviewed OpenClaw adapter",
      matchesAvailableIdentity: true,
    });
    expect(installed?.state === "installed" ? installed.identity : null).toEqual(
      available?.identity,
    );
  });

  it("lists a receipt-pinned local package that is not in the bundled catalogue", () => {
    writeReviewedBundle();
    const localRoot = writePackageFixture(path.join(fixtureRoot, "local"), {
      id: "future-harness",
      displayName: "Future Harness",
      packageVersion: "1.0.0",
      aliases: ["future"],
    });
    const installedPackage = installHarnessPackage(
      {
        packageRoot: localRoot,
        expectedId: "future-harness",
        sourceIdentity: { kind: "local" },
      },
      { storeRoot },
    );

    const inventory = listHarnessPackageInventory(catalogueOptions());
    const installed = inventory.installed.find(({ id }) => id === "future-harness");

    expect(inventory.available.some(({ id }) => id === "future-harness")).toBe(false);
    expect(installed).toMatchObject({
      state: "installed",
      id: "future-harness",
      displayName: "Future Harness",
      aliases: ["future"],
      matchesAvailableIdentity: false,
      identity: installedPackage.identity,
    });
  });

  it("keeps an older installed identity eligible for the current bundled install", () => {
    writeReviewedBundle();
    const olderRoot = writePackageFixture(path.join(fixtureRoot, "older"), {
      directoryName: "openclaw-old",
      id: "openclaw",
      displayName: "OpenClaw",
      packageVersion: "0.0.9",
      description: "Older OpenClaw adapter",
      payload: "older bundle\n",
    });
    installPackage(olderRoot);

    const inventory = listHarnessPackageInventory(catalogueOptions());
    const installed = inventory.installed.find(({ id }) => id === "openclaw");
    const selected = resolveHarnessPackageInstallSelection("openclaw", catalogueOptions());

    expect(installed).toMatchObject({
      state: "installed",
      identity: { packageVersion: "0.0.9" },
      matchesAvailableIdentity: false,
    });
    expect(selected.identity.packageVersion).toBe("0.1.1");
    expect(selected.identity).not.toEqual(
      installed?.state === "installed" ? installed.identity : null,
    );
  });

  it("resolves only exact canonical ids and exact current public aliases", () => {
    writeReviewedBundle();

    expect(resolveHarnessPackageInstallSelection("hermes", catalogueOptions()).id).toBe("hermes");
    expect(resolveHarnessPackageInstallSelection("nemoclaw", catalogueOptions()).id).toBe(
      "openclaw",
    );
    expect(resolveHarnessPackageInstallSelection("dcode", catalogueOptions()).id).toBe(
      "langchain-deepagents-code",
    );
  });

  it.each(["OpenClaw", "open_claw", "Deep_Agents", " dcode", "dcode "])(
    "rejects non-exact package selector %s",
    (rejected) => {
      writeReviewedBundle();
      expect(() => resolveHarnessPackageInstallSelection(rejected, catalogueOptions())).toThrow(
        HarnessPackageUnavailableError,
      );
    },
  );

  it("reports one corrupt canonical pointer as damaged without hiding healthy inventory", () => {
    const packageRoots = writeReviewedBundle();
    installPackage(packageRoots.get("openclaw")!);
    installPackage(packageRoots.get("hermes")!);
    fs.writeFileSync(path.join(storeRoot, "active/openclaw.json"), "not-json\n", { mode: 0o600 });

    const inventory = listHarnessPackageInventory(catalogueOptions());

    expect(inventory.available).toHaveLength(3);
    expect(inventory.installed).toEqual([
      expect.objectContaining({
        state: "installed",
        id: "hermes",
        matchesAvailableIdentity: true,
      }),
      {
        state: "damaged",
        id: "openclaw",
        displayName: "OpenClaw",
        description: "Reviewed OpenClaw adapter",
        aliases: ["nemoclaw", "nemo-claw"],
        aliasSummary: null,
        isDefaultOnboardingChoice: true,
        defaultSandboxName: "openclaw",
        reason: "installed-package-integrity-failed",
      },
    ]);
    expect(() => resolveHarnessPackageInstallSelection("openclaw", catalogueOptions())).toThrow(
      DamagedInstalledHarnessPackageError,
    );
    expect(resolveHarnessPackageInstallSelection("hermes", catalogueOptions()).id).toBe("hermes");
  });

  it("fails deterministically when a bundle directory does not match its declared id", () => {
    writeReviewedBundle();
    writePackageFixture(bundledRoot, {
      directoryName: "duplicate-openclaw",
      id: "openclaw",
      displayName: "OpenClaw",
      packageVersion: "0.1.0",
    });

    expect(() => listHarnessPackageInventory(catalogueOptions())).toThrowError(
      new HarnessPackageCatalogIntegrityError(
        "Bundled harness 'openclaw' does not match the package contract",
      ),
    );
  });

  it("fails when one package id conflicts with another package alias", () => {
    writeReviewedBundle();
    writePackageFixture(bundledRoot, {
      id: "future-harness",
      displayName: "Conflicting alias",
      packageVersion: "0.1.0",
      aliases: ["hermes"],
    });

    expect(() => listHarnessPackageInventory(catalogueOptions())).toThrowError(
      new HarnessPackageCatalogIntegrityError("Bundled harness aliases conflict"),
    );
  });

  it.each([
    ["pi", "Pi"],
    ["nemocua", "NemoCUA"],
  ])("accepts a fourth package %s when it implements the package contract", (id, displayName) => {
    writeReviewedBundle();
    writePackageFixture(bundledRoot, {
      id,
      displayName,
      packageVersion: "0.1.0",
    });

    expect(listHarnessPackageInventory(catalogueOptions()).available.map(({ id }) => id)).toContain(
      id,
    );
  });

  it("integrates a fourth package through catalogue metadata without a core id branch", async () => {
    fs.mkdirSync(bundledRoot, { recursive: true, mode: 0o700 });
    const packageRoots = new Map(
      REVIEWED_FIXTURES.map((declaration) => [
        declaration.id,
        writePackageFixture(bundledRoot, {
          ...declaration,
          defaultChoice: false,
        }),
      ]),
    );
    const futureRoot = writePackageFixture(bundledRoot, {
      id: "future-runtime",
      displayName: "Future Runtime",
      packageVersion: "3.2.1",
      aliases: ["future"],
      defaultChoice: true,
      sandboxName: "future-sandbox",
    });

    const available = listHarnessPackageInventory(catalogueOptions());
    expect(available.available.find(({ id }) => id === "future-runtime")).toMatchObject({
      displayName: "Future Runtime",
      aliases: ["future"],
      isDefaultOnboardingChoice: true,
      defaultSandboxName: "future-sandbox",
    });
    await expect(
      promptForHarnessPackage({
        inventory: available,
        log: () => undefined,
        prompt: async () => "",
      }),
    ).resolves.toEqual({ kind: "selected", id: "future-runtime" });

    const installSelection = resolveHarnessPackageInstallSelection("future", catalogueOptions());
    expect(installSelection.packageRoot).toBe(futureRoot);
    const installedFuture = installPackage(installSelection.packageRoot);
    installPackage(packageRoots.get("hermes")!);

    const installedInventory = listHarnessPackageInventory(catalogueOptions());
    expect(installedInventory.installed.find(({ id }) => id === "future-runtime")).toMatchObject({
      state: "installed",
      identity: installedFuture.identity,
      matchesAvailableIdentity: true,
    });

    const defaultSelection = await selectOnboardHarnessPackage({
      agentFlag: null,
      bundledRoot,
      canPrompt: false,
      environment: {},
      log: () => undefined,
      prompt: async () => "1",
      storeRoot,
    });
    expect(defaultSelection).toMatchObject({
      kind: "package",
      recordedAgent: "future-runtime",
      harnessPackage: installedFuture.identity,
    });
    expect(
      defaultSelection.kind === "package"
        ? defaultSelection.effectiveDefinition.defaultSandboxName
        : null,
    ).toBe("future-sandbox");

    const explicitAliasSelection = await selectOnboardHarnessPackage({
      agentFlag: "future",
      bundledRoot,
      canPrompt: false,
      environment: {},
      log: () => undefined,
      prompt: async () => "1",
      storeRoot,
    });
    expect(explicitAliasSelection).toMatchObject({
      kind: "package",
      recordedAgent: "future-runtime",
      harnessPackage: installedFuture.identity,
    });
  });

  it("reads data without importing package code or changing bundle and store state", () => {
    const packageRoots = writeReviewedBundle();
    const sentinel = path.join(fixtureRoot, "package-code-ran");
    writeFixtureFile(
      packageRoots.get("openclaw")!,
      "runtime/entry.mjs",
      `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(sentinel)}, "ran");\n`,
    );
    installPackage(packageRoots.get("openclaw")!);
    const bundleBefore = recursiveState(bundledRoot);
    const storeBefore = recursiveState(storeRoot);

    const inventory = listHarnessPackageInventory(catalogueOptions());

    expect(inventory.available.find(({ id }) => id === "openclaw")).toMatchObject({
      displayName: "OpenClaw",
      description: "Reviewed OpenClaw adapter",
    });
    expect(fs.existsSync(sentinel)).toBe(false);
    expect(recursiveState(bundledRoot)).toEqual(bundleBefore);
    expect(recursiveState(storeRoot)).toEqual(storeBefore);
  });
});
