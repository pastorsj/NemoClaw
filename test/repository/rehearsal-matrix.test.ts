// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import type {
  PackageCheckoutOptions,
  PackageCheckoutResult,
} from "../../scripts/packages/checkout.mts";
import {
  buildPackageRehearsalMatrix,
  discoverPackageRehearsalTargets,
  formatPackageRehearsalPlan,
  readPackageRehearsalMatrixCliOptions,
  runPackageRehearsalMatrix,
} from "../../scripts/packages/rehearsal-matrix.mts";
import { describe, expect, test } from "../helpers/owned-test-resources";

const CORE_COMMIT = "a".repeat(40);
const REPOSITORY_ROOT = path.resolve(import.meta.dirname, "../..");

function writePackage(packagesRoot: string, directoryName: string, packageName: string): string {
  const packageRoot = path.join(packagesRoot, directoryName);
  fs.mkdirSync(packageRoot, { recursive: true });
  fs.writeFileSync(
    path.join(packageRoot, "package.json"),
    `${JSON.stringify({
      name: packageName,
      nemoclaw: { harnessManifest: "manifest.yaml" },
    })}\n`,
  );
  fs.writeFileSync(path.join(packageRoot, "manifest.yaml"), "name: fixture\n");
  return packageRoot;
}

function writeNonHarnessPackage(
  packagesRoot: string,
  directoryName: string,
  packageName: string,
): string {
  const packageRoot = path.join(packagesRoot, directoryName);
  fs.mkdirSync(packageRoot, { recursive: true });
  fs.writeFileSync(
    path.join(packageRoot, "package.json"),
    `${JSON.stringify({ name: packageName })}\n`,
  );
  return packageRoot;
}

describe("agent runtime package rehearsal matrix", () => {
  test("discovers current packages without encoding their IDs in the runner or its test", () => {
    const packageIds = discoverPackageRehearsalTargets().map(({ packageId }) => packageId);

    expect(packageIds.length).toBeGreaterThan(0);
    expect(packageIds).toEqual([...packageIds].sort((left, right) => left.localeCompare(right)));
    expect(new Set(packageIds).size).toBe(packageIds.length);
  });

  test("plans package-only before composed rehearsals in package ID order", ({ resources }) => {
    const packagesRoot = resources.temporaryDirectory("nemoclaw-rehearsal-matrix-");
    const zetaRoot = writePackage(packagesRoot, "zeta-directory", "@example/nemoclaw-zeta");
    const alphaRoot = writePackage(packagesRoot, "alpha-directory", "@example/nemoclaw-alpha");
    writeNonHarnessPackage(packagesRoot, "shared-runner", "@example/shared-runner");

    const plans = buildPackageRehearsalMatrix({
      packagesRoot,
      coreCheckoutDir: REPOSITORY_ROOT,
      coreCommit: CORE_COMMIT,
    });

    expect(plans).toEqual([
      {
        mode: "package-only",
        packageId: "alpha",
        candidatePackageDir: alphaRoot,
      },
      {
        mode: "package-only",
        packageId: "zeta",
        candidatePackageDir: zetaRoot,
      },
      {
        mode: "composed",
        packageId: "alpha",
        candidatePackageDir: alphaRoot,
        coreCheckoutDir: REPOSITORY_ROOT,
        coreCommit: CORE_COMMIT,
      },
      {
        mode: "composed",
        packageId: "zeta",
        candidatePackageDir: zetaRoot,
        coreCheckoutDir: REPOSITORY_ROOT,
        coreCommit: CORE_COMMIT,
      },
    ]);
  });

  test("runs one discovered package through both checkout boundaries", ({ resources }) => {
    const packagesRoot = resources.temporaryDirectory("nemoclaw-rehearsal-run-");
    const candidatePackageDir = writePackage(
      packagesRoot,
      "future-directory",
      "@example/nemoclaw-future",
    );
    const calls: PackageCheckoutOptions[] = [];
    const lines: string[] = [];

    const results = runPackageRehearsalMatrix(
      {
        packagesRoot,
        coreCheckoutDir: REPOSITORY_ROOT,
        coreCommit: CORE_COMMIT,
        allowPackageCode: true,
      },
      {
        runRehearsal: (options): PackageCheckoutResult => {
          calls.push(options);
          return {
            mode: options.mode,
            packageId: options.packageId,
            ...(options.mode === "composed"
              ? { coreCommit: options.coreCommit, installedDigest: "b".repeat(64) }
              : {}),
          };
        },
        writeLine: (line) => lines.push(line),
      },
    );

    expect(calls).toEqual([
      {
        mode: "package-only",
        packageId: "future",
        candidatePackageDir,
        allowPackageCode: true,
      },
      {
        mode: "composed",
        packageId: "future",
        candidatePackageDir,
        allowPackageCode: true,
        coreCheckoutDir: REPOSITORY_ROOT,
        coreCommit: CORE_COMMIT,
      },
    ]);
    expect(results).toHaveLength(2);
    expect(lines).toEqual([
      "Running package-only rehearsal for future",
      "package-only rehearsal passed for future.",
      "Running composed rehearsal for future",
      `composed rehearsal passed for future against NemoClaw ${CORE_COMMIT}. Installed digest: ${"b".repeat(64)}.`,
    ]);
  });

  test("formats a bounded plan without running a rehearsal", ({ resources }) => {
    const packagesRoot = resources.temporaryDirectory("nemoclaw-rehearsal-plan-");
    const candidatePackageDir = writePackage(
      packagesRoot,
      "future-directory",
      "@example/nemoclaw-future",
    );
    const plans = buildPackageRehearsalMatrix({
      packagesRoot,
      coreCheckoutDir: REPOSITORY_ROOT,
      coreCommit: CORE_COMMIT,
    });

    expect(formatPackageRehearsalPlan(plans)).toBe(
      [
        `package-only\tfuture\t${candidatePackageDir}\t-`,
        `composed\tfuture\t${candidatePackageDir}\t${CORE_COMMIT}`,
      ].join("\n"),
    );
  });

  test("refuses matrix execution before invoking a rehearsal without explicit acknowledgement", ({
    resources,
  }) => {
    const packagesRoot = resources.temporaryDirectory("nemoclaw-rehearsal-refusal-");
    writePackage(packagesRoot, "future-directory", "@example/nemoclaw-future");
    const calls: PackageCheckoutOptions[] = [];

    expect(() =>
      runPackageRehearsalMatrix(
        { packagesRoot, coreCheckoutDir: REPOSITORY_ROOT, coreCommit: CORE_COMMIT },
        {
          runRehearsal: (options) => {
            calls.push(options);
            return { mode: options.mode, packageId: options.packageId };
          },
        },
      ),
    ).toThrow(/executes trusted candidate package code .* not an untrusted-package sandbox/u);
    expect(calls).toEqual([]);
  });

  test("requires a pinned revision and rejects malformed package metadata", ({ resources }) => {
    expect(() =>
      buildPackageRehearsalMatrix({
        coreCheckoutDir: REPOSITORY_ROOT,
        coreCommit: "main",
      }),
    ).toThrow("requires an exact 40-character commit SHA");

    const packagesRoot = resources.temporaryDirectory("nemoclaw-rehearsal-invalid-");
    writePackage(packagesRoot, "future-directory", "@example/future");
    expect(() => discoverPackageRehearsalTargets(packagesRoot)).toThrow(
      "Harness package name must identify nemoclaw-<id>",
    );
  });

  test("parses the aggregate command without selecting a package ID", () => {
    expect(
      readPackageRehearsalMatrixCliOptions(["--nemoclaw-commit", CORE_COMMIT, "--plan"]),
    ).toMatchObject({
      coreCheckoutDir: REPOSITORY_ROOT,
      coreCommit: CORE_COMMIT,
      planOnly: true,
      allowPackageCode: false,
    });
    expect(
      readPackageRehearsalMatrixCliOptions([
        "--nemoclaw-commit",
        CORE_COMMIT,
        "--allow-package-code",
      ]).allowPackageCode,
    ).toBe(true);
    expect(() => readPackageRehearsalMatrixCliOptions([])).toThrow("Usage:");
  });
});
