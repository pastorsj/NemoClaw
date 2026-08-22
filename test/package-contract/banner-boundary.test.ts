// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

const repoRoot = path.join(import.meta.dirname, "..", "..");
const url = (...segments: string[]) => pathToFileURL(path.join(repoRoot, ...segments)).href;

describe("banner boundary package contract", () => {
  it("resolves each built wrapper to its reviewed boundary artifact", () => {
    // Native subprocess: only native resolution bypasses the Vitest source alias
    // (which maps *banner-boundary.cjs to .cts) to compare the real shipped dist.
    const script =
      `const cli = await import(${JSON.stringify(url("dist/lib/cli/banner.js"))});` +
      `const plugin = await import(${JSON.stringify(url("packages/nemoclaw-openclaw/plugin/dist/banner.js"))});` +
      `const core = await import(${JSON.stringify(url("dist/lib/shared/banner-boundary.cjs"))});` +
      `const packaged = await import(${JSON.stringify(url("packages/nemoclaw-openclaw/plugin/dist/shared/banner-boundary.cjs"))});` +
      `const cliRenderBox = cli.renderBox ?? cli.default.renderBox;` +
      `process.stdout.write(JSON.stringify([cliRenderBox === core.renderBox, plugin.renderBox === packaged.renderBox, cliRenderBox(["abcdef"], { columns: 5 }), plugin.renderBox(["abcdef"], { columns: 5 })]));`;
    const output = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 30_000,
    });
    const box = ["  ┌─┐", "  │ │", "  └─┘"];
    expect(JSON.parse(output)).toEqual([true, true, box, box]);
  });

  it("ships the core boundary and the package's compiled input", () => {
    const coreSharedDir = path.join(repoRoot, "dist", "lib", "shared");
    const packageSharedDir = path.join(
      repoRoot,
      "packages",
      "nemoclaw-openclaw",
      "plugin",
      "dist",
      "shared",
    );
    expect(fs.existsSync(path.join(coreSharedDir, "banner-boundary.cjs"))).toBe(true);
    expect(fs.existsSync(path.join(coreSharedDir, "banner-boundary.d.cts"))).toBe(true);
    expect(fs.existsSync(path.join(coreSharedDir, "banner-boundary.js"))).toBe(false);
    expect(fs.existsSync(path.join(packageSharedDir, "banner-boundary.cjs"))).toBe(true);
    expect(fs.existsSync(path.join(packageSharedDir, "banner-boundary.d.cts"))).toBe(true);
    expect(fs.existsSync(path.join(packageSharedDir, "banner-boundary.js"))).toBe(false);
    expect(fs.existsSync(path.join(repoRoot, "src", "lib", "shared", "banner-boundary.cts"))).toBe(
      true,
    );
    expect(
      fs.existsSync(
        path.join(
          repoRoot,
          "packages",
          "nemoclaw-openclaw",
          "plugin",
          "src",
          "shared",
          "banner-boundary.cts",
        ),
      ),
    ).toBe(false);
  });
});
