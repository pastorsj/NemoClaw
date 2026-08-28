// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { listBundledHarnessSources } from "./bundled-source";
import {
  DamagedInstalledHarnessPackageError,
  HarnessPackageCatalogIntegrityError,
  HarnessPackageUnavailableError,
  listHarnessPackageInventory,
  resolveHarnessPackageInstallSelection,
} from "./package-catalog";
import { installHarnessPackage } from "./package-install";
import type { BundledHarnessPackageSourceIdentity } from "./package-receipt";

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
  readonly payload?: string;
}

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
  const manifestPath = fixture.manifestPath ?? `agents/${fixture.id}/manifest.yaml`;
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
      contractVersion: 1,
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
      "",
    ].join("\n"),
  );
  writeFixtureFile(packageRoot, "runtime/payload.txt", fixture.payload ?? `${fixture.id}\n`);
  return packageRoot;
}

function writeReviewedBundle(): Map<string, string> {
  fs.mkdirSync(bundledRoot, { recursive: true, mode: 0o700 });
  return new Map(
    listBundledHarnessSources().map((declaration) => [
      declaration.id,
      writePackageFixture(bundledRoot, {
        id: declaration.id,
        displayName: declaration.displayName,
        packageVersion: declaration.packageVersion,
        manifestPath: declaration.manifestPath,
        description: `Reviewed ${declaration.displayName} adapter`,
      }),
    ]),
  );
}

function installPackage(packageRoot: string): void {
  installHarnessPackage({ packageRoot, sourceIdentity: SOURCE_IDENTITY }, { storeRoot });
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
      "openclaw",
      "hermes",
      "langchain-deepagents-code",
    ]);
    expect(inventory.available.map(({ description }) => description)).toEqual([
      "Reviewed OpenClaw adapter",
      "Reviewed Hermes Agent adapter",
      "Reviewed LangChain Deep Agents Code adapter",
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
    expect(selected.identity.packageVersion).toBe("0.1.0");
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
      {
        state: "damaged",
        id: "openclaw",
        displayName: "OpenClaw",
        description: "Reviewed OpenClaw adapter",
        reason: "installed-package-integrity-failed",
      },
      expect.objectContaining({
        state: "installed",
        id: "hermes",
        matchesAvailableIdentity: true,
      }),
    ]);
    expect(() => resolveHarnessPackageInstallSelection("openclaw", catalogueOptions())).toThrow(
      DamagedInstalledHarnessPackageError,
    );
    expect(resolveHarnessPackageInstallSelection("hermes", catalogueOptions()).id).toBe("hermes");
  });

  it("fails deterministically when two bundle directories declare the same id", () => {
    writeReviewedBundle();
    writePackageFixture(bundledRoot, {
      directoryName: "duplicate-openclaw",
      id: "openclaw",
      displayName: "OpenClaw",
      packageVersion: "0.1.0",
    });

    expect(() => listHarnessPackageInventory(catalogueOptions())).toThrowError(
      new HarnessPackageCatalogIntegrityError("Bundled harness id 'openclaw' is duplicated"),
    );
  });

  it("fails deterministically when a bundle id conflicts with a public alias", () => {
    writeReviewedBundle();
    writePackageFixture(bundledRoot, {
      id: "nemoclaw",
      displayName: "Conflicting alias",
      packageVersion: "0.1.0",
    });

    expect(() => listHarnessPackageInventory(catalogueOptions())).toThrowError(
      new HarnessPackageCatalogIntegrityError(
        "Bundled harness id 'nemoclaw' conflicts with a public alias",
      ),
    );
  });

  it.each([
    ["pi", "Pi"],
    ["nemocua", "NemoCUA"],
  ])("keeps candidate %s out of the ordinary catalogue", (id, displayName) => {
    writeReviewedBundle();
    writePackageFixture(bundledRoot, {
      id,
      displayName,
      packageVersion: "0.1.0",
    });

    expect(() => listHarnessPackageInventory(catalogueOptions())).toThrowError(
      new HarnessPackageCatalogIntegrityError(
        `Candidate harness '${id}' leaked into the bundled catalogue`,
      ),
    );
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

    expect(inventory.available[0]).toMatchObject({
      displayName: "OpenClaw",
      description: "Reviewed OpenClaw adapter",
    });
    expect(fs.existsSync(sentinel)).toBe(false);
    expect(recursiveState(bundledRoot)).toEqual(bundleBefore);
    expect(recursiveState(storeRoot)).toEqual(storeBefore);
  });
});
