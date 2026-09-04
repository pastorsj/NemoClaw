// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { SpawnSyncOptions } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { vi } from "vitest";

import {
  discoverHarnessPackageTests,
  parsePackageTestMode,
  runHarnessPackageTests,
} from "../../scripts/packages/run-tests.mts";
import { describe, expect, test } from "../helpers/owned-test-resources";

function writePackage(
  packagesRoot: string,
  directoryName: string,
  metadata: Record<string, unknown>,
): string {
  const packageRoot = path.join(packagesRoot, directoryName);
  fs.mkdirSync(packageRoot, { recursive: true });
  fs.writeFileSync(path.join(packageRoot, "package.json"), `${JSON.stringify(metadata)}\n`);
  return packageRoot;
}

function harnessMetadata(name: string): Record<string, unknown> {
  return {
    name,
    scripts: {
      test: "vitest run",
      "test:spec": "vitest run --reporter=tree",
    },
    nemoclaw: { harnessManifest: "manifest.yaml" },
  };
}

describe("harness package test runner", () => {
  test("discovers future harness packages from metadata in directory order", ({ resources }) => {
    const packagesRoot = resources.temporaryDirectory("nemoclaw-package-tests-");
    const haystackRoot = writePackage(
      packagesRoot,
      "nemoclaw-haystack",
      harnessMetadata("@nvidia/nemoclaw-haystack"),
    );
    const deepseekRoot = writePackage(
      packagesRoot,
      "nemoclaw-deepseek",
      harnessMetadata("@nvidia/nemoclaw-deepseek"),
    );
    writePackage(packagesRoot, "nemoclaw-fabric", {
      name: "@nvidia/nemoclaw-fabric",
      scripts: { test: "python -m unittest" },
    });

    expect(discoverHarnessPackageTests("test", packagesRoot)).toEqual([
      {
        packageName: "@nvidia/nemoclaw-deepseek",
        packageRoot: deepseekRoot,
        scriptName: "test",
      },
      {
        packageName: "@nvidia/nemoclaw-haystack",
        packageRoot: haystackRoot,
        scriptName: "test",
      },
    ]);
  });

  test("selects the package specification script for specification output", ({ resources }) => {
    const packagesRoot = resources.temporaryDirectory("nemoclaw-package-spec-");
    const packageRoot = writePackage(
      packagesRoot,
      "nemoclaw-example",
      harnessMetadata("@nvidia/nemoclaw-example"),
    );

    expect(discoverHarnessPackageTests("spec", packagesRoot)).toEqual([
      {
        packageName: "@nvidia/nemoclaw-example",
        packageRoot,
        scriptName: "test:spec",
      },
    ]);
  });

  test("runs package scripts sequentially with package working directories", ({ resources }) => {
    const packagesRoot = resources.temporaryDirectory("nemoclaw-package-run-");
    const firstRoot = writePackage(
      packagesRoot,
      "a-package",
      harnessMetadata("@nvidia/nemoclaw-a"),
    );
    const secondRoot = writePackage(
      packagesRoot,
      "b-package",
      harnessMetadata("@nvidia/nemoclaw-b"),
    );
    const calls: Array<{ args: readonly string[]; command: string; cwd: string | undefined }> = [];
    const lines: string[] = [];

    runHarnessPackageTests("test", {
      packagesRoot,
      platform: "linux",
      spawn: (command, args, options) => {
        calls.push({ command, args, cwd: options.cwd?.toString() });
        return { status: 0 };
      },
      writeLine: (line) => lines.push(line),
    });

    expect(calls).toEqual([
      { command: "npm", args: ["run", "test"], cwd: firstRoot },
      { command: "npm", args: ["run", "test"], cwd: secondRoot },
    ]);
    expect(lines).toEqual([
      "Running @nvidia/nemoclaw-a: npm run test",
      "Running @nvidia/nemoclaw-b: npm run test",
    ]);
  });

  test("uses the npm command shim on Windows", ({ resources }) => {
    const packagesRoot = resources.temporaryDirectory("nemoclaw-package-windows-");
    writePackage(packagesRoot, "nemoclaw-example", harnessMetadata("nemoclaw-example"));
    const spawn = vi.fn(
      (_command: string, _args: readonly string[], _options: SpawnSyncOptions) => ({ status: 0 }),
    );

    runHarnessPackageTests("test", {
      packagesRoot,
      platform: "win32",
      spawn,
      writeLine: () => undefined,
    });

    expect(spawn).toHaveBeenCalledWith(
      "npm.cmd",
      ["run", "test"],
      expect.objectContaining({ stdio: "inherit" }),
    );
  });

  test("rejects a selected package that lacks the requested script", ({ resources }) => {
    const packagesRoot = resources.temporaryDirectory("nemoclaw-package-missing-script-");
    writePackage(packagesRoot, "nemoclaw-example", {
      ...harnessMetadata("nemoclaw-example"),
      scripts: { test: "vitest run" },
    });

    expect(() => discoverHarnessPackageTests("spec", packagesRoot)).toThrow(
      "Harness package 'nemoclaw-example' must declare scripts.test:spec",
    );
  });

  test("stops after the first package failure", ({ resources }) => {
    const packagesRoot = resources.temporaryDirectory("nemoclaw-package-failure-");
    writePackage(packagesRoot, "a-package", harnessMetadata("nemoclaw-a"));
    writePackage(packagesRoot, "b-package", harnessMetadata("nemoclaw-b"));
    const spawn = vi
      .fn((_command: string, _args: readonly string[], _options: SpawnSyncOptions) => ({
        status: 7,
      }))
      .mockReturnValueOnce({ status: 7 });

    expect(() =>
      runHarnessPackageTests("test", {
        packagesRoot,
        spawn,
        writeLine: () => undefined,
      }),
    ).toThrow("nemoclaw-a: npm run test failed (exit code 7)");
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  test("rejects an invalid package marker", ({ resources }) => {
    const packagesRoot = resources.temporaryDirectory("nemoclaw-package-marker-");
    writePackage(packagesRoot, "nemoclaw-example", {
      name: "nemoclaw-example",
      scripts: { test: "vitest run" },
      nemoclaw: { harnessManifest: true },
    });

    expect(() => discoverHarnessPackageTests("test", packagesRoot)).toThrow(
      "nemoclaw.harnessManifest must equal 'manifest.yaml'",
    );
  });

  test("rejects a package marker that differs from the build contract", ({ resources }) => {
    const packagesRoot = resources.temporaryDirectory("nemoclaw-package-marker-path-");
    writePackage(packagesRoot, "nemoclaw-example", {
      ...harnessMetadata("nemoclaw-example"),
      nemoclaw: { harnessManifest: "runtime.yaml" },
    });

    expect(() => discoverHarnessPackageTests("test", packagesRoot)).toThrow(
      "nemoclaw.harnessManifest must equal 'manifest.yaml'",
    );
  });

  test("requires one test mode argument", () => {
    expect(parsePackageTestMode(["test"])).toBe("test");
    expect(parsePackageTestMode(["spec"])).toBe("spec");
    expect(() => parsePackageTestMode([])).toThrow(
      "Usage: tsx scripts/packages/run-tests.mts <test|spec>",
    );
  });
});
