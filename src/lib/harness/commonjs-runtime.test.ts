// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadHarnessCommonJsModule } from "./commonjs-runtime";
import type { HarnessPackage } from "./package-registry";

const temporaryRoots: string[] = [];

function bundledFixture(source: string): HarnessPackage {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-commonjs-runtime-"));
  temporaryRoots.push(rootDir);
  fs.writeFileSync(path.join(rootDir, "runtime.cjs"), source);
  return {
    id: "fixture",
    packageName: "nemoclaw-fixture",
    version: "1.0.0",
    rootDir,
    manifestPath: path.join(rootDir, "manifest.yaml"),
    source: "bundled",
  };
}

afterEach(() => {
  while (temporaryRoots.length > 0) {
    fs.rmSync(temporaryRoots.pop()!, { recursive: true, force: true });
  }
});

describe("harness CommonJS runtime", () => {
  it("executes the package bytes captured by the registry", () => {
    const harnessPackage = bundledFixture(
      "module.exports = { normalize(value) { return value.trim().toLowerCase(); } };\n",
    );

    const loaded = loadHarnessCommonJsModule(harnessPackage, "runtime.cjs", 4096);
    const runtime = loaded.exports as { normalize(value: string): string };

    expect(runtime.normalize("  VALUE ")).toBe("value");
    expect(loaded.contentDigest).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("keeps package runtime modules self-contained", () => {
    const harnessPackage = bundledFixture('module.exports = require("./other.cjs");\n');
    fs.writeFileSync(path.join(harnessPackage.rootDir, "other.cjs"), "module.exports = {};\n");

    expect(() => loadHarnessCommonJsModule(harnessPackage, "runtime.cjs", 4096)).toThrow(
      "Harness package runtime modules must be self-contained: ./other.cjs",
    );
  });
});
