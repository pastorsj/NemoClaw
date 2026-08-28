// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { installHarnessPackage } from "./package-install";
import {
  HarnessPackageStoreIntegrityError,
  readInstalledHarnessPackage,
  resolvePinnedHarnessPackage,
  type InstalledHarnessPackage,
} from "./package-store";
import type { BundledHarnessPackageSourceIdentity } from "./package-receipt";
import type { HarnessPackageIdentity } from "./package-types";

const FIRST_SOURCE_IDENTITY: BundledHarnessPackageSourceIdentity = {
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

let fixtureRoot = path.join(process.cwd(), ".nemoclaw-install-test-unused");
let sourceRoot = path.join(fixtureRoot, "source");
let storeRoot = path.join(fixtureRoot, "store");

function packageEnvelope(packageVersion: string): Record<string, unknown> {
  return {
    schemaVersion: 1,
    kind: "agent-runtime",
    id: "openclaw",
    displayName: "OpenClaw",
    packageVersion,
    contractVersion: 1,
    manifest: "agents/openclaw/manifest.yaml",
  };
}

function writeFixtureFile(relativePath: string, contents: string, mode = 0o600): void {
  const target = path.join(sourceRoot, ...relativePath.split("/"));
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.writeFileSync(target, contents, { mode });
  fs.chmodSync(target, mode);
}

function writePackage(packageVersion = "1.0.0", payload = "first payload\n"): void {
  fs.mkdirSync(sourceRoot, { recursive: true, mode: 0o700 });
  fs.chmodSync(sourceRoot, 0o700);
  writeFixtureFile("nemoclaw-package.json", `${JSON.stringify(packageEnvelope(packageVersion))}\n`);
  writeFixtureFile(
    "agents/openclaw/manifest.yaml",
    "name: openclaw\ndisplay_name: OpenClaw\ndescription: Reviewed runtime adapter\n",
  );
  writeFixtureFile("runtime/payload.txt", payload);
}

function install(sourceIdentity: BundledHarnessPackageSourceIdentity = FIRST_SOURCE_IDENTITY) {
  return installHarnessPackage({ packageRoot: sourceRoot, sourceIdentity }, { storeRoot });
}

function receiptPath(identity: HarnessPackageIdentity): string {
  return path.join(storeRoot, "receipts", identity.id, "sha256", `${identity.contentDigest}.json`);
}

function objectPath(identity: HarnessPackageIdentity): string {
  return path.join(storeRoot, "objects", "sha256", identity.contentDigest);
}

function failPublication(): never {
  throw new Error("injected active-pointer publication failure");
}

function failMissingPackage(): never {
  throw new Error("expected an installed harness package");
}

function readActivePackage(): InstalledHarnessPackage {
  return readInstalledHarnessPackage("openclaw", { storeRoot }) ?? failMissingPackage();
}

beforeEach(() => {
  fixtureRoot = fs.mkdtempSync(path.join(INSTALL_TEST_PARENT, "fixture-"));
  fs.chmodSync(fixtureRoot, 0o700);
  sourceRoot = path.join(fixtureRoot, "source");
  storeRoot = path.join(fixtureRoot, "store");
  fs.mkdirSync(storeRoot, { mode: 0o700 });
  writePackage();
});

afterEach(() => {
  fs.rmSync(fixtureRoot, { force: true, recursive: true });
});

describe("installHarnessPackage", () => {
  it("returns one receipt-bound package with only installed lifecycle state", () => {
    const result = install();

    expect(result.state).toBe("installed");
    expect(result.identity).toEqual(result.receipt.identity);
    expect(result.packageManifest.envelope.id).toBe("openclaw");
    expect(result.packageRoot).toBe(objectPath(result.identity));
    expect(result).not.toHaveProperty("available");
    expect(result).not.toHaveProperty("selected");
    expect(result).not.toHaveProperty("qualified");
    expect(result).not.toHaveProperty("supported");
  });

  it("reuses immutable object and receipt bytes during an exact reinstall", () => {
    const first = install();
    const immutableReceipt = receiptPath(first.identity);
    const immutableObject = objectPath(first.identity);
    const receiptBytes = fs.readFileSync(immutableReceipt);
    const receiptStat = fs.lstatSync(immutableReceipt, { bigint: true });
    const objectStat = fs.lstatSync(immutableObject, { bigint: true });

    const second = install(SECOND_SOURCE_IDENTITY);

    expect(second.identity).toEqual(first.identity);
    expect(second.receipt).toEqual(first.receipt);
    expect(second.receipt.sourceIdentity).toEqual(FIRST_SOURCE_IDENTITY);
    expect(fs.readFileSync(immutableReceipt)).toEqual(receiptBytes);
    expect(fs.lstatSync(immutableReceipt, { bigint: true }).ino).toBe(receiptStat.ino);
    expect(fs.lstatSync(immutableReceipt, { bigint: true }).mtimeNs).toBe(receiptStat.mtimeNs);
    expect(fs.lstatSync(immutableObject, { bigint: true }).ino).toBe(objectStat.ino);
    expect(fs.lstatSync(immutableObject, { bigint: true }).mtimeNs).toBe(objectStat.mtimeNs);
  });

  it("rejects changed bytes that retain the same package version", () => {
    const first = install();
    writePackage("1.0.0", "changed payload\n");

    expect(() => install()).toThrow(/digest|version|identity/u);
    expect(readActivePackage().identity).toEqual(first.identity);
  });

  it("advances to a new version while retaining the prior pinned package", () => {
    const first = install();
    writePackage("1.1.0", "changed payload\n");

    const second = install();

    expect(second.identity.packageVersion).toBe("1.1.0");
    expect(second.identity.contentDigest).not.toBe(first.identity.contentDigest);
    expect(readActivePackage().identity).toEqual(second.identity);
    expect(resolvePinnedHarnessPackage(first.identity, { storeRoot }).identity).toEqual(
      first.identity,
    );
  });

  it("leaves the prior package active when pointer publication fails", () => {
    const first = install();
    writePackage("1.1.0", "changed payload\n");

    expect(() =>
      installHarnessPackage(
        { packageRoot: sourceRoot, sourceIdentity: SECOND_SOURCE_IDENTITY },
        {
          storeRoot,
          dependencies: {
            onPublicationCheckpoint: (checkpoint) =>
              checkpoint === "before-active-pointer-replacement" ? failPublication() : undefined,
          },
        },
      ),
    ).toThrow(HarnessPackageStoreIntegrityError);
    expect(readActivePackage().identity).toEqual(first.identity);

    const recovered = install(SECOND_SOURCE_IDENTITY);
    expect(recovered.identity.packageVersion).toBe("1.1.0");
  });

  it("rejects malformed source identity before creating package-store state", () => {
    const sourceIdentity = {
      ...FIRST_SOURCE_IDENTITY,
      token: "must-not-persist",
    } as unknown as BundledHarnessPackageSourceIdentity;

    expect(() => install(sourceIdentity)).toThrow("source identity fields do not match");
    expect(fs.readdirSync(storeRoot)).toEqual([]);
  });

  it("rejects an invalid manifest before creating package-store state", () => {
    writeFixtureFile("agents/openclaw/manifest.yaml", "name: hermes\n");

    expect(() => install()).toThrow("manifest name must match the package id");
    expect(fs.readdirSync(storeRoot)).toEqual([]);
  });

  it("rejects package authoring content before creating package-store state", () => {
    writeFixtureFile("tests/host-install.test.ts", "throw new Error('must not run');\n");

    expect(() => install()).toThrow("contains authoring content");
    expect(fs.readdirSync(storeRoot)).toEqual([]);
  });

  it("copies executable and authoring sentinels without running package-owned code", () => {
    const marker = path.join(fixtureRoot, "package-code-ran");
    const markerCommand = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`;
    writeFixtureFile(
      "package.json",
      `${JSON.stringify({ scripts: { install: `node -e ${JSON.stringify(markerCommand)}` } })}\n`,
    );
    writeFixtureFile("install.sh", `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`, 0o700);
    writeFixtureFile(
      "authoring-check.py",
      `from pathlib import Path\nPath(${JSON.stringify(marker)}).write_text('ran')\n`,
      0o700,
    );

    const result = install();

    expect(result.state).toBe("installed");
    expect(fs.existsSync(marker)).toBe(false);
    expect(fs.existsSync(path.join(result.packageRoot, "package.json"))).toBe(true);
    expect(fs.existsSync(path.join(result.packageRoot, "install.sh"))).toBe(true);
    expect(fs.existsSync(path.join(result.packageRoot, "authoring-check.py"))).toBe(true);
  });
});
