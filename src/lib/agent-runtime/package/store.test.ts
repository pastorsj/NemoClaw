// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { copyVerifiedPackageTree } from "./copy";
import {
  activateHarnessPackage,
  deactivateHarnessPackage,
  getHarnessPackageStoreRoot,
  HarnessPackageStoreIntegrityError,
  HarnessPackageVersionConflictError,
  listActiveHarnessPackageIds,
  publishHarnessPackage,
  readInstalledHarnessPackage,
  resolvePinnedHarnessPackage,
  type HarnessPackagePublicationCheckpoint,
  type InstalledHarnessPackage,
  type PublishHarnessPackageInput,
} from "./store";
import type { BundledHarnessPackageSourceIdentity } from "./receipt";
import {
  ensureHarnessPackageStore,
  harnessPackageStorePaths,
  removeStagedStoreFile,
  writeStagedStoreFile,
} from "./store-files";
import { validateHarnessPackageTree } from "./tree";

const SOURCE_IDENTITY: BundledHarnessPackageSourceIdentity = {
  kind: "bundled",
  nemoclawBuildIdentity: {
    nemoclawVersion: "0.0.113",
    sourceRevision: "b".repeat(40),
  },
};
const SECOND_SOURCE_IDENTITY: BundledHarnessPackageSourceIdentity = {
  kind: "bundled",
  nemoclawBuildIdentity: {
    nemoclawVersion: "0.0.114",
    sourceRevision: "c".repeat(40),
  },
};
const STORE_TEST_PARENT = path.join(
  process.cwd(),
  "node_modules/.cache/nemoclaw-package-store-tests",
);
const INSTALL_TEST_PARENT = path.join(
  process.cwd(),
  "node_modules/.cache/nemoclaw-package-install-tests",
);
fs.mkdirSync(STORE_TEST_PARENT, { recursive: true, mode: 0o700 });
fs.mkdirSync(INSTALL_TEST_PARENT, { recursive: true, mode: 0o700 });

let fixtureRoot = path.join(process.cwd(), ".nemoclaw-store-test-unused");
let sourceRoot = path.join(fixtureRoot, "source");
let storeRoot = path.join(fixtureRoot, "store");
let activeFirstChild: ChildProcess | null = null;
let activeSecondChild: ChildProcess | null = null;

function packageEnvelope(packageVersion: string): Record<string, unknown> {
  return {
    schemaVersion: 1,
    kind: "agent-runtime",
    id: "openclaw",
    displayName: "OpenClaw",
    packageVersion,
    manifest: "packages/nemoclaw-openclaw/manifest.yaml",
  };
}

function writeFile(root: string, relativePath: string, contents: string, mode = 0o600): void {
  const target = path.join(root, ...relativePath.split("/"));
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.writeFileSync(target, contents, { mode });
  fs.chmodSync(target, mode);
}

function writePackageAt(root: string, packageVersion: string, payload: string): void {
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  fs.chmodSync(root, 0o700);
  writeFile(root, "nemoclaw-package.json", `${JSON.stringify(packageEnvelope(packageVersion))}\n`);
  writeFile(
    root,
    "packages/nemoclaw-openclaw/manifest.yaml",
    "name: openclaw\ndisplay_name: OpenClaw\ndescription: Reviewed runtime adapter\n",
  );
  writeFile(root, "runtime/payload.txt", payload);
}

function writePackage(packageVersion = "1.0.0", payload = "first payload\n"): void {
  writePackageAt(sourceRoot, packageVersion, payload);
}

function publicationInput(
  dependencies?: PublishHarnessPackageInput["dependencies"],
): PublishHarnessPackageInput {
  const validatedTree = validateHarnessPackageTree(sourceRoot, { sourceTrust: "reviewed" });
  return {
    validatedTree,
    expectedIdentity: {
      kind: "agent-runtime",
      id: "openclaw",
      packageVersion: JSON.parse(
        fs.readFileSync(path.join(sourceRoot, "nemoclaw-package.json"), "utf8"),
      ).packageVersion as string,
      contentDigest: validatedTree.contentDigest,
    },
    sourceIdentity: SOURCE_IDENTITY,
    storeRoot,
    ...(dependencies === undefined ? {} : { dependencies }),
  };
}

function publish(
  dependencies?: PublishHarnessPackageInput["dependencies"],
): InstalledHarnessPackage {
  return publishHarnessPackage(publicationInput(dependencies));
}

function requiredActive(): InstalledHarnessPackage {
  return (
    readInstalledHarnessPackage("openclaw", { storeRoot }) ??
    (() => {
      throw new Error("expected one active harness package");
    })()
  );
}

function objectPath(installed: InstalledHarnessPackage): string {
  return path.join(storeRoot, "objects", "sha256", installed.identity.contentDigest);
}

function receiptPath(installed: InstalledHarnessPackage): string {
  return path.join(
    storeRoot,
    "receipts",
    installed.identity.id,
    "sha256",
    `${installed.identity.contentDigest}.json`,
  );
}

function activePointerPath(): string {
  return path.join(storeRoot, "active", "openclaw.json");
}

function failAt(selected: HarnessPackagePublicationCheckpoint) {
  const failures = new Map<HarnessPackagePublicationCheckpoint, () => never>([
    [
      selected,
      () => {
        throw new Error(`injected failure at ${selected}`);
      },
    ],
  ]);
  return {
    onPublicationCheckpoint(checkpoint: HarnessPackagePublicationCheckpoint): void {
      failures.get(checkpoint)?.();
    },
  };
}

function childResult(
  child: ChildProcess,
): Promise<{ readonly code: number | null; readonly output: string }> {
  return new Promise((resolve, reject) => {
    let output = "";
    let errors = "";
    child.stdout?.on("data", (chunk) => (output += String(chunk)));
    child.stderr?.on("data", (chunk) => (errors += String(chunk)));
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, output: `${output}${errors}` }));
  });
}

async function waitForFile(target: string): Promise<void> {
  await vi.waitFor(() => expect(fs.existsSync(target)).toBe(true), {
    interval: 20,
    timeout: 10_000,
  });
}

function spawnInstall(options: {
  readonly source: string;
  readonly ready?: string;
  readonly release?: string;
}): ChildProcess {
  const installModule = pathToFileURL(
    path.join(process.cwd(), "src/lib/agent-runtime/package/install.ts"),
  ).href;
  const sourceIdentity = JSON.stringify(SOURCE_IDENTITY);
  const script = `
    import fs from "node:fs";
    import packageInstall from ${JSON.stringify(installModule)};
    const { installHarnessPackage } = packageInstall;
    const [source, store, ready, release] = process.argv.slice(1);
    const dependencies = ready === "-" ? undefined : {
      onPublicationCheckpoint(checkpoint) {
        if (checkpoint !== "before-object-publication") return;
        fs.writeFileSync(ready, "ready");
        const sleeper = new Int32Array(new SharedArrayBuffer(4));
        while (!fs.existsSync(release)) Atomics.wait(sleeper, 0, 0, 20);
      },
    };
    const installed = installHarnessPackage(
      { packageRoot: source, sourceIdentity: ${sourceIdentity} },
      { storeRoot: store, dependencies },
    );
    process.stdout.write(JSON.stringify(installed.identity));
  `;
  return spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "--eval",
      script,
      options.source,
      storeRoot,
      options.ready ?? "-",
      options.release ?? "-",
    ],
    { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
  );
}

beforeEach(() => {
  fixtureRoot = fs.mkdtempSync(path.join(STORE_TEST_PARENT, "fixture-"));
  fs.chmodSync(fixtureRoot, 0o700);
  sourceRoot = path.join(fixtureRoot, "source");
  storeRoot = path.join(fixtureRoot, "store");
  fs.mkdirSync(storeRoot, { mode: 0o700 });
  writePackage();
});

afterEach(() => {
  activeFirstChild?.kill("SIGKILL");
  activeSecondChild?.kill("SIGKILL");
  activeFirstChild = null;
  activeSecondChild = null;
  vi.restoreAllMocks();
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
});

describe("harness package store", () => {
  it("removes its exact temporary record when a staged file sync fails", () => {
    const paths = harnessPackageStorePaths(storeRoot, "openclaw");
    const authority = ensureHarnessPackageStore(paths);
    const syncFailure = vi.spyOn(fs, "fsyncSync").mockImplementationOnce(() => {
      throw new Error("injected staged file sync failure");
    });

    expect(() => writeStagedStoreFile(paths.staging, "receipt", "record\n", authority)).toThrow(
      "injected staged file sync failure",
    );
    syncFailure.mockRestore();
    expect(fs.readdirSync(paths.staging)).toEqual([]);
  });

  it("does not treat a missing staged ancestor as an absent staged file", () => {
    const paths = harnessPackageStorePaths(storeRoot, "openclaw");
    const authority = ensureHarnessPackageStore(paths);
    const staged = writeStagedStoreFile(paths.staging, "receipt", "record\n", authority);
    const displaced = `${paths.staging}-displaced`;
    fs.renameSync(paths.staging, displaced);

    expect(() => removeStagedStoreFile(staged, authority)).toThrow();
    fs.renameSync(displaced, paths.staging);
    removeStagedStoreFile(staged, authority);
    expect(fs.readdirSync(paths.staging)).toEqual([]);
  });

  it("publishes private object, receipt, and active-pointer state in order", () => {
    const installed = publish();

    expect(requiredActive().identity).toEqual(installed.identity);
    expect(listActiveHarnessPackageIds({ storeRoot })).toEqual(["openclaw"]);
    expect(fs.lstatSync(storeRoot).mode & 0o777).toBe(0o700);
    expect(fs.lstatSync(objectPath(installed)).mode & 0o777).toBe(0o700);
    expect(fs.lstatSync(receiptPath(installed)).mode & 0o777).toBe(0o600);
    expect(fs.lstatSync(activePointerPath()).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(path.join(storeRoot, "staging"))).toEqual([]);
  });

  it.each([
    "before-object-publication",
    "before-receipt-publication",
    "before-active-pointer-replacement",
  ] as const)("keeps the previous pointer usable after %s failure", (checkpoint) => {
    const first = publish();
    writePackage("1.1.0", "second payload\n");

    expect(() => publish(failAt(checkpoint))).toThrow(HarnessPackageStoreIntegrityError);
    expect(requiredActive().identity).toEqual(first.identity);
    expect(fs.readdirSync(path.join(storeRoot, "staging"))).toEqual([]);
  });

  it("repairs an orphan object with exact bytes and rejects a different same-version digest", () => {
    const expected = publicationInput().expectedIdentity;

    expect(() => publish(failAt("before-receipt-publication"))).toThrow(
      HarnessPackageStoreIntegrityError,
    );
    expect(readInstalledHarnessPackage("openclaw", { storeRoot })).toBe(null);

    writePackage("1.0.0", "different bytes with the same version\n");
    expect(() => publish()).toThrow(HarnessPackageVersionConflictError);

    writePackage("1.0.0", "first payload\n");
    expect(publish()).toMatchObject({ state: "installed", identity: expected });
    expect(requiredActive()).toMatchObject({ state: "installed", identity: expected });
  });

  it("does not replace a conflicting object that appears at its publication checkpoint", () => {
    const expected = publicationInput().expectedIdentity;
    const destination = path.join(storeRoot, "objects", "sha256", expected.contentDigest);
    const marker = path.join(destination, "existing-marker");
    const injections = new Map<HarnessPackagePublicationCheckpoint, () => void>([
      [
        "before-object-publication",
        () => {
          fs.mkdirSync(destination, { mode: 0o700 });
          fs.writeFileSync(marker, "existing object\n", { mode: 0o600 });
        },
      ],
    ]);

    expect(() =>
      publish({ onPublicationCheckpoint: (checkpoint) => injections.get(checkpoint)?.() }),
    ).toThrow(HarnessPackageStoreIntegrityError);
    expect(readInstalledHarnessPackage("openclaw", { storeRoot })).toBe(null);
  });

  it("reuses an exact object that appears at its publication checkpoint", () => {
    const expected = publicationInput().expectedIdentity;
    const destination = path.join(storeRoot, "objects", "sha256", expected.contentDigest);
    const raceStage = path.join(fixtureRoot, "race-stage");
    fs.mkdirSync(raceStage, { mode: 0o700 });
    const injections = new Map<HarnessPackagePublicationCheckpoint, () => void>([
      [
        "before-object-publication",
        () => {
          const copied = copyVerifiedPackageTree(
            validateHarnessPackageTree(sourceRoot, { sourceTrust: "reviewed" }),
            { stagingParent: raceStage },
          );
          fs.renameSync(copied.packageRoot, destination);
          copied.removeStagingRoot();
        },
      ],
    ]);

    const installed = publish({
      onPublicationCheckpoint: (checkpoint) => injections.get(checkpoint)?.(),
    });

    expect(installed).toMatchObject({ state: "installed", identity: expected });
    expect(requiredActive()).toMatchObject({ state: "installed", identity: expected });
  });

  it("does not replace a conflicting receipt that appears at its publication checkpoint", () => {
    const expected = publicationInput().expectedIdentity;
    const destination = path.join(
      storeRoot,
      "receipts",
      expected.id,
      "sha256",
      `${expected.contentDigest}.json`,
    );
    const injections = new Map<HarnessPackagePublicationCheckpoint, () => void>([
      [
        "before-receipt-publication",
        () => {
          fs.writeFileSync(destination, "conflicting receipt\n", { mode: 0o600 });
        },
      ],
    ]);

    expect(() =>
      publish({ onPublicationCheckpoint: (checkpoint) => injections.get(checkpoint)?.() }),
    ).toThrow(HarnessPackageStoreIntegrityError);
    expect(readInstalledHarnessPackage("openclaw", { storeRoot })).toBe(null);
  });

  it("reuses an exact receipt that appears at its publication checkpoint", () => {
    const expected = publicationInput().expectedIdentity;
    const destination = path.join(
      storeRoot,
      "receipts",
      expected.id,
      "sha256",
      `${expected.contentDigest}.json`,
    );
    const injections = new Map<HarnessPackagePublicationCheckpoint, () => void>([
      [
        "before-receipt-publication",
        () => {
          const stage = path.join(storeRoot, "staging");
          const stagedName =
            fs.readdirSync(stage).sort().at(-1) ??
            (() => {
              throw new Error("expected one staged receipt");
            })();
          fs.copyFileSync(path.join(stage, stagedName), destination);
          fs.chmodSync(destination, 0o600);
        },
      ],
    ]);

    const installed = publish({
      onPublicationCheckpoint: (checkpoint) => injections.get(checkpoint)?.(),
    });

    expect(installed).toMatchObject({ state: "installed", identity: expected });
    expect(requiredActive()).toMatchObject({ state: "installed", identity: expected });
  });

  it("preserves immutable object and first receipt authority on exact reinstall", () => {
    const first = publish();
    const immutableReceipt = receiptPath(first);
    const immutableObject = objectPath(first);
    const receiptBytes = fs.readFileSync(immutableReceipt);
    const objectBytes = fs.readFileSync(path.join(immutableObject, "runtime/payload.txt"));
    const receiptStat = fs.lstatSync(immutableReceipt, { bigint: true });
    const objectStat = fs.lstatSync(immutableObject, { bigint: true });
    const reinstallInput = publicationInput();

    const second = publishHarnessPackage({
      ...reinstallInput,
      sourceIdentity: SECOND_SOURCE_IDENTITY,
    });

    expect(second.receipt).toEqual(first.receipt);
    expect(second.receipt.installedAt).toBe(first.receipt.installedAt);
    expect(second.receipt.sourceIdentity).toEqual(SOURCE_IDENTITY);
    expect(fs.readFileSync(immutableReceipt)).toEqual(receiptBytes);
    expect(fs.readFileSync(path.join(immutableObject, "runtime/payload.txt"))).toEqual(objectBytes);
    expect(fs.lstatSync(immutableReceipt, { bigint: true }).ino).toBe(receiptStat.ino);
    expect(fs.lstatSync(immutableReceipt, { bigint: true }).mtimeNs).toBe(receiptStat.mtimeNs);
    expect(fs.lstatSync(immutableObject, { bigint: true }).ino).toBe(objectStat.ino);
    expect(fs.lstatSync(immutableObject, { bigint: true }).mtimeNs).toBe(objectStat.mtimeNs);
  });

  it("refuses pointer publication after its captured active directory is replaced", () => {
    const first = publish();
    writePackage("1.1.0", "second payload\n");
    const active = path.dirname(activePointerPath());
    const displaced = path.join(storeRoot, "active-displaced");
    const swaps = new Map<HarnessPackagePublicationCheckpoint, () => void>([
      [
        "before-active-pointer-replacement",
        () => {
          fs.renameSync(active, displaced);
          fs.mkdirSync(active, { mode: 0o700 });
        },
      ],
    ]);

    expect(() =>
      publish({
        onPublicationCheckpoint: (checkpoint) => swaps.get(checkpoint)?.(),
      }),
    ).toThrow(HarnessPackageStoreIntegrityError);
    expect(fs.readdirSync(active)).toEqual([]);
    fs.rmdirSync(active);
    fs.renameSync(displaced, active);
    expect(requiredActive().identity).toEqual(first.identity);
  });

  it("advances the pointer while retaining direct pinned lookup without receipt scanning", () => {
    const first = publish();
    writePackage("1.1.0", "second payload\n");
    const second = publish();
    const openedDirectories: string[] = [];
    const originalOpen = fs.opendirSync.bind(fs);
    vi.spyOn(fs, "opendirSync").mockImplementation(((candidate, options) => {
      openedDirectories.push(candidate.toString());
      return originalOpen(candidate, options);
    }) as typeof fs.opendirSync);

    const pinned = resolvePinnedHarnessPackage(first.identity, { storeRoot });

    expect(requiredActive().identity).toEqual(second.identity);
    expect(pinned.identity).toEqual(first.identity);
    expect(fs.existsSync(objectPath(first))).toBe(true);
    expect(fs.existsSync(receiptPath(first))).toBe(true);
    expect(openedDirectories).not.toContain(path.dirname(receiptPath(first)));
  });

  it("activates immutable receipts backward and forward without changing package history", () => {
    const first = publish();
    const firstReceipt = fs.readFileSync(receiptPath(first));
    writePackage("1.1.0", "second payload\n");
    const second = publish();
    const secondReceipt = fs.readFileSync(receiptPath(second));

    expect(
      activateHarnessPackage("openclaw", first.identity.contentDigest, { storeRoot }).identity,
    ).toEqual(first.identity);
    expect(requiredActive().identity).toEqual(first.identity);
    expect(
      activateHarnessPackage("openclaw", second.identity.contentDigest, { storeRoot }).identity,
    ).toEqual(second.identity);
    expect(requiredActive().identity).toEqual(second.identity);
    expect(fs.readFileSync(receiptPath(first))).toEqual(firstReceipt);
    expect(fs.readFileSync(receiptPath(second))).toEqual(secondReceipt);
  });

  it("leaves the active pointer unchanged when activation is interrupted", () => {
    const first = publish();
    writePackage("1.1.0", "second payload\n");
    const second = publish();

    expect(() =>
      activateHarnessPackage("openclaw", first.identity.contentDigest, {
        storeRoot,
        dependencies: {
          onPointerMutationCheckpoint: () => {
            throw new Error("injected activation interruption");
          },
        },
      }),
    ).toThrow(HarnessPackageStoreIntegrityError);
    expect(requiredActive().identity).toEqual(second.identity);
  });

  it("deactivates selection while retaining the exact object and receipt for rollback", () => {
    const installed = publish();
    const receiptBytes = fs.readFileSync(receiptPath(installed));

    expect(
      deactivateHarnessPackage("openclaw", {
        storeRoot,
        expectedIdentity: installed.identity,
      }),
    ).toEqual({ state: "deactivated", identity: installed.identity });
    expect(readInstalledHarnessPackage("openclaw", { storeRoot })).toBeNull();
    expect(listActiveHarnessPackageIds({ storeRoot })).toEqual([]);
    expect(fs.readFileSync(receiptPath(installed))).toEqual(receiptBytes);
    expect(fs.statSync(objectPath(installed)).isDirectory()).toBe(true);
    expect(resolvePinnedHarnessPackage(installed.identity, { storeRoot }).identity).toEqual(
      installed.identity,
    );

    expect(
      activateHarnessPackage("openclaw", installed.identity.contentDigest, { storeRoot }).identity,
    ).toEqual(installed.identity);
  });

  it("returns null when deactivation has no active pointer", () => {
    expect(deactivateHarnessPackage("openclaw", { storeRoot })).toBeNull();
    const installed = publish();
    expect(deactivateHarnessPackage("openclaw", { storeRoot })).not.toBeNull();
    expect(deactivateHarnessPackage("openclaw", { storeRoot })).toBeNull();
    expect(resolvePinnedHarnessPackage(installed.identity, { storeRoot }).identity).toEqual(
      installed.identity,
    );
  });

  it("does not deactivate a package that changed after user confirmation", () => {
    const confirmed = publish();
    writePackage("1.1.0", "replacement payload\n");
    const replacement = publish();

    expect(() =>
      deactivateHarnessPackage("openclaw", {
        storeRoot,
        expectedIdentity: confirmed.identity,
      }),
    ).toThrow(HarnessPackageStoreIntegrityError);
    expect(requiredActive().identity).toEqual(replacement.identity);
  });

  it("does not unlink an active pointer that changes at the deactivation checkpoint", () => {
    const first = publish();
    writePackage("1.1.0", "second payload\n");
    const second = publish();
    const firstPointer = Buffer.from(
      `${JSON.stringify(
        {
          schemaVersion: 1,
          id: first.identity.id,
          contentDigest: first.identity.contentDigest,
        },
        null,
        2,
      )}\n`,
    );

    expect(() =>
      deactivateHarnessPackage("openclaw", {
        storeRoot,
        expectedIdentity: second.identity,
        dependencies: {
          onPointerMutationCheckpoint: () => {
            fs.writeFileSync(activePointerPath(), firstPointer, { mode: 0o600 });
          },
        },
      }),
    ).toThrow(HarnessPackageStoreIntegrityError);
    expect(requiredActive().identity).toEqual(first.identity);
  });

  it("rejects a missing activation receipt without changing the active pointer", () => {
    const active = publish();

    expect(() => activateHarnessPackage("openclaw", "f".repeat(64), { storeRoot })).toThrow(
      HarnessPackageStoreIntegrityError,
    );
    expect(requiredActive().identity).toEqual(active.identity);
  });

  it("does not overwrite an active pointer that changes before activation publication", () => {
    const first = publish();
    writePackage("1.1.0", "second payload\n");
    const second = publish();
    const secondPointer = fs.readFileSync(activePointerPath());
    writePackage("1.2.0", "third payload\n");
    publish();

    expect(() =>
      activateHarnessPackage("openclaw", first.identity.contentDigest, {
        storeRoot,
        dependencies: {
          onPointerMutationCheckpoint: () => {
            fs.writeFileSync(activePointerPath(), secondPointer, { mode: 0o600 });
          },
        },
      }),
    ).toThrow(HarnessPackageStoreIntegrityError);
    expect(requiredActive().identity).toEqual(second.identity);
  });

  it("rejects a damaged activation object without changing the active pointer", () => {
    const first = publish();
    writePackage("1.1.0", "current payload\n");
    const current = publish();
    fs.writeFileSync(path.join(objectPath(first), "runtime/payload.txt"), "tampered\n", {
      mode: 0o600,
    });

    expect(() =>
      activateHarnessPackage("openclaw", first.identity.contentDigest, { storeRoot }),
    ).toThrow(HarnessPackageStoreIntegrityError);
    expect(requiredActive().identity).toEqual(current.identity);
  });

  it("rejects an active read when its pointer advances during pinned validation", () => {
    const first = publish();
    writePackage("1.1.0", "second payload\n");
    const second = publish();
    const firstPointer = {
      schemaVersion: 1,
      id: first.identity.id,
      contentDigest: first.identity.contentDigest,
    };
    const secondPointer = {
      schemaVersion: 1,
      id: second.identity.id,
      contentDigest: second.identity.contentDigest,
    };
    fs.writeFileSync(activePointerPath(), `${JSON.stringify(firstPointer, null, 2)}\n`, {
      mode: 0o600,
    });
    const originalOpen = fs.opendirSync.bind(fs);
    const actions = new Map([
      [
        objectPath(first),
        () => {
          actions.delete(objectPath(first));
          fs.writeFileSync(activePointerPath(), `${JSON.stringify(secondPointer, null, 2)}\n`, {
            mode: 0o600,
          });
        },
      ],
    ]);
    const openSpy = vi.spyOn(fs, "opendirSync").mockImplementation(((candidate, options) => {
      actions.get(candidate.toString())?.();
      return originalOpen(candidate, options);
    }) as typeof fs.opendirSync);

    expect(() => requiredActive()).toThrow(HarnessPackageStoreIntegrityError);
    openSpy.mockRestore();
    expect(requiredActive().identity).toEqual(second.identity);
  });

  it("resolves pinned content even when the active pointer is damaged", () => {
    const installed = publish();
    fs.writeFileSync(activePointerPath(), "not-json\n", { mode: 0o600 });

    expect(listActiveHarnessPackageIds({ storeRoot })).toEqual(["openclaw"]);
    expect(() => requiredActive()).toThrow(HarnessPackageStoreIntegrityError);
    expect(resolvePinnedHarnessPackage(installed.identity, { storeRoot }).identity).toEqual(
      installed.identity,
    );
  });

  it("rejects a non-canonical receipt even when its JSON values are valid", () => {
    const installed = publish();
    fs.writeFileSync(receiptPath(installed), JSON.stringify(installed.receipt), { mode: 0o600 });

    expect(() => requiredActive()).toThrow(HarnessPackageStoreIntegrityError);
  });

  it.each(["id", "digest"] as const)("rejects pointer and receipt %s disagreement", (field) => {
    const installed = publish();
    const alternateDigest = "f".repeat(64);
    const pointer = {
      schemaVersion: 1,
      id: field === "id" ? "hermes" : "openclaw",
      contentDigest: field === "digest" ? alternateDigest : installed.identity.contentDigest,
    };
    const alternateReceipt = path.join(
      storeRoot,
      "receipts",
      "openclaw",
      "sha256",
      `${alternateDigest}.json`,
    );
    const receiptActions = new Map([
      [
        "digest",
        () => {
          fs.copyFileSync(receiptPath(installed), alternateReceipt);
          fs.chmodSync(alternateReceipt, 0o600);
        },
      ],
    ]);
    receiptActions.get(field)?.();
    fs.writeFileSync(activePointerPath(), `${JSON.stringify(pointer, null, 2)}\n`, { mode: 0o600 });

    expect(() => requiredActive()).toThrow(HarnessPackageStoreIntegrityError);
  });

  it.each(["receipt", "object"] as const)("fails closed when the active %s is missing", (part) => {
    const installed = publish();
    const target = part === "receipt" ? receiptPath(installed) : objectPath(installed);
    fs.rmSync(target, { recursive: true, force: true });

    expect(() => requiredActive()).toThrow(HarnessPackageStoreIntegrityError);
  });

  it.each(["pointer", "receipt"] as const)(
    "rejects a symlinked %s without reading its target",
    (part) => {
      const installed = publish();
      const external = path.join(fixtureRoot, `${part}-external`);
      const target = part === "pointer" ? activePointerPath() : receiptPath(installed);
      fs.writeFileSync(external, "external bytes\n", { mode: 0o600 });
      fs.unlinkSync(target);
      fs.symlinkSync(external, target);

      expect(() => requiredActive()).toThrow(HarnessPackageStoreIntegrityError);
      expect(fs.readFileSync(external, "utf8")).toBe("external bytes\n");
    },
  );

  it("rejects digest drift in an active immutable object", () => {
    const installed = publish();
    fs.writeFileSync(path.join(objectPath(installed), "runtime/payload.txt"), "tampered\n");

    expect(() => requiredActive()).toThrow(HarnessPackageStoreIntegrityError);
  });

  it("uses an injected store root and a gateway-independent default path", () => {
    const fakeHome = path.join(fixtureRoot, "unused-home");
    const first = getHarnessPackageStoreRoot(fakeHome);
    vi.stubEnv("NEMOCLAW_GATEWAY_PORT", "50001");
    const second = getHarnessPackageStoreRoot(fakeHome);

    publish();

    expect(first).toBe(path.join(fakeHome, ".nemoclaw", "harnesses"));
    expect(second).toBe(first);
    expect(fs.existsSync(fakeHome)).toBe(false);
  });

  it.each(["unexpected-name", "symlink", "authority"] as const)(
    "rejects an active-directory %s while retaining canonical damaged IDs",
    (caseName) => {
      publish();
      fs.writeFileSync(activePointerPath(), "damaged\n", { mode: 0o600 });
      expect(listActiveHarnessPackageIds({ storeRoot })).toEqual(["openclaw"]);
      const active = path.dirname(activePointerPath());
      const external = path.join(fixtureRoot, "external-pointer");
      fs.writeFileSync(external, "external\n", { mode: 0o600 });
      const additions = new Map([
        ["unexpected-name", () => fs.writeFileSync(path.join(active, "unexpected.txt"), "x")],
        ["symlink", () => fs.symlinkSync(external, path.join(active, "hermes.json"))],
        ["authority", () => fs.chmodSync(activePointerPath(), 0o644)],
      ]);
      additions.get(caseName)?.();

      expect(() => listActiveHarnessPackageIds({ storeRoot })).toThrow(
        HarnessPackageStoreIntegrityError,
      );
      expect(fs.readFileSync(external, "utf8")).toBe("external\n");
    },
  );

  it(
    "serializes two same-ID installers across processes without mixing identities",
    { timeout: 20_000 },
    async () => {
      const secondSource = path.join(fixtureRoot, "second-source");
      writePackageAt(secondSource, "1.1.0", "second payload\n");
      const ready = path.join(fixtureRoot, "first-ready");
      const release = path.join(fixtureRoot, "release-first");
      const firstChild = spawnInstall({ source: sourceRoot, ready, release });
      activeFirstChild = firstChild;
      const firstResult = childResult(firstChild);
      await Promise.race([
        waitForFile(ready),
        firstResult.then((result) => {
          throw new Error(
            `first installer exited before its publication checkpoint: ${result.output}`,
          );
        }),
      ]);
      const secondChild = spawnInstall({ source: secondSource });
      activeSecondChild = secondChild;
      const secondResult = childResult(secondChild);
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(secondChild.exitCode).toBe(null);
      fs.writeFileSync(release, "release\n");

      const [first, second] = await Promise.all([firstResult, secondResult]);
      expect(first, first.output).toMatchObject({ code: 0 });
      expect(second, second.output).toMatchObject({ code: 0 });
      const firstIdentity = JSON.parse(first.output) as InstalledHarnessPackage["identity"];
      const secondIdentity = JSON.parse(second.output) as InstalledHarnessPackage["identity"];
      expect(resolvePinnedHarnessPackage(firstIdentity, { storeRoot }).identity).toEqual(
        firstIdentity,
      );
      expect(resolvePinnedHarnessPackage(secondIdentity, { storeRoot }).identity).toEqual(
        secondIdentity,
      );
      expect([firstIdentity, secondIdentity]).toContainEqual(requiredActive().identity);
    },
  );
});
