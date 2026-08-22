// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

const repoRoot = path.join(import.meta.dirname, "..", "..");
const url = (...segments: string[]) => pathToFileURL(path.join(repoRoot, ...segments)).href;

describe("credential filter package boundary", () => {
  it("resolves each package wrapper to its reviewed boundary artifact (#8291)", () => {
    // Native resolution bypasses the Vitest source alias so this checks the
    // generated files that the published CLI and plugin load.
    const script =
      `const cli = await import(${JSON.stringify(url("dist/lib/security/credential-filter.js"))});` +
      `const plugin = await import(${JSON.stringify(url("packages/nemoclaw-openclaw/plugin/dist/security/credential-filter.js"))});` +
      `const patterns = await import(${JSON.stringify(url("dist/lib/security/secret-patterns.js"))});` +
      `const coreBoundary = await import(${JSON.stringify(
        url("dist/lib/shared/credential-filter-boundary.cjs"),
      )});` +
      `const packageBoundary = await import(${JSON.stringify(
        url("packages/nemoclaw-openclaw/plugin/dist/shared/credential-filter-boundary.cjs"),
      )});` +
      `const fixture = {headers:{Authorization:"Bearer opaque-package-contract-secret"},args:["--api-key","opaque-value"],model:"keep-me"};` +
      `process.stdout.write(JSON.stringify([cli.stripCredentials === coreBoundary.stripCredentials, plugin.stripCredentials === packageBoundary.stripCredentials, cli.sanitizeEnvFileContent === coreBoundary.sanitizeEnvFileContent, plugin.sanitizeEnvFileContent === packageBoundary.sanitizeEnvFileContent, patterns.SECRET_PATTERNS === coreBoundary.SECRET_PATTERNS, cli.stripCredentials(fixture), plugin.stripCredentials(fixture)]));`;
    const output = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 30_000,
    });
    const placeholder = "[STRIPPED_BY_MIGRATION]";
    const expected = {
      headers: { Authorization: placeholder },
      args: ["--api-key", placeholder],
      model: "keep-me",
    };
    expect(JSON.parse(output)).toEqual([true, true, true, true, true, expected, expected]);
  });

  it("includes the CommonJS module and declaration in both builds (#8291)", () => {
    const coreSharedDirectory = path.join(repoRoot, "dist", "lib", "shared");
    const packageSharedDirectory = path.join(
      repoRoot,
      "packages",
      "nemoclaw-openclaw",
      "plugin",
      "dist",
      "shared",
    );
    expect(fs.existsSync(path.join(coreSharedDirectory, "credential-filter-boundary.cjs"))).toBe(
      true,
    );
    expect(fs.existsSync(path.join(coreSharedDirectory, "credential-filter-boundary.d.cts"))).toBe(
      true,
    );
    expect(fs.existsSync(path.join(coreSharedDirectory, "credential-filter-boundary.js"))).toBe(
      false,
    );
    expect(fs.existsSync(path.join(packageSharedDirectory, "credential-filter-boundary.cjs"))).toBe(
      true,
    );
    expect(
      fs.existsSync(path.join(packageSharedDirectory, "credential-filter-boundary.d.cts")),
    ).toBe(true);
    expect(fs.existsSync(path.join(packageSharedDirectory, "credential-filter-boundary.js"))).toBe(
      false,
    );
  });
});
