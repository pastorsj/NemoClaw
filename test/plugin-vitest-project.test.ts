// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";

import { describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const rootRequire = createRequire(path.join(repositoryRoot, "package.json"));
const pluginRoot = path.join(repositoryRoot, "packages", "nemoclaw-openclaw", "plugin");
const pluginRequire = createRequire(path.join(pluginRoot, "package.json"));
const pluginTypeScript = pluginRequire.resolve("typescript/bin/tsc");

function installedVersion(requireFromPackage: NodeJS.Require, packageName: string): string {
  return (requireFromPackage(`${packageName}/package.json`) as { version: string }).version;
}

function listedTypeScriptFiles(configPath: string): string[] {
  return execFileSync(
    process.execPath,
    [pluginTypeScript, "--noEmit", "-p", configPath, "--listFilesOnly"],
    { cwd: repositoryRoot, encoding: "utf8" },
  )
    .trim()
    .split("\n")
    .map((file) => path.normalize(file));
}

describe("plugin Vitest project contract", () => {
  it.each(["vitest", "vite"] as const)(
    "keeps standalone plugin dependencies on the root Vitest toolchain [case %#]",
    (packageName) => {
      expect(installedVersion(pluginRequire, packageName), packageName).toBe(
        installedVersion(rootRequire, packageName),
      );
    },
  );

  it("typechecks plugin production and test sources without emitting tests", () => {
    const productionFiles = listedTypeScriptFiles(
      "packages/nemoclaw-openclaw/plugin/tsconfig.json",
    );
    const testFiles = listedTypeScriptFiles(
      "packages/nemoclaw-openclaw/plugin/tsconfig.test.json",
    );
    const typecheckOutput = execFileSync(
      "npm",
      ["--prefix", "packages/nemoclaw-openclaw/plugin", "run", "typecheck"],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
      },
    );

    expect(productionFiles.some((file) => file.endsWith(".test.ts"))).toBe(false);
    expect(testFiles).toContain(path.join(pluginRoot, "src", "register.test.ts"));
    expect(testFiles).toContain(path.join(pluginRoot, "vitest.config.ts"));
    expect(testFiles).toContain(path.join(pluginRoot, "vitest.project.ts"));
    expect(typecheckOutput).toContain("tsc --noEmit -p tsconfig.test.json");
  });
});
