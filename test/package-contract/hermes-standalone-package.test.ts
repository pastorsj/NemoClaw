// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

const HERMES_PACKAGE_ROOT = path.join(
  import.meta.dirname,
  "..",
  "..",
  "packages",
  "nemoclaw-hermes",
);

describe("standalone Hermes package", () => {
  it("loads its control contract without an OpenClaw sibling", { timeout: 120_000 }, () => {
    const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-package-"));
    try {
      execFileSync(
        "npm",
        ["pack", "--ignore-scripts", "--silent", "--pack-destination", outputDirectory],
        { cwd: HERMES_PACKAGE_ROOT, encoding: "utf8" },
      );
      const archives = fs.readdirSync(outputDirectory).filter((entry) => entry.endsWith(".tgz"));
      expect(archives).toHaveLength(1);
      execFileSync("tar", [
        "-xzf",
        path.join(outputDirectory, archives[0]!),
        "-C",
        outputDirectory,
      ]);

      const installedRoot = path.join(outputDirectory, "package");
      const hostRoot = path.join(installedRoot, "host");
      expect(
        ["tool-matrix.json", "refresh-credentials.ts", "tool-broker.ts", "tool-contract.ts"].map(
          (fileName) => fs.statSync(path.join(hostRoot, fileName)).isFile(),
        ),
      ).toEqual([true, true, true, true]);
      expect(fs.existsSync(path.join(outputDirectory, "nemoclaw-openclaw"))).toBe(false);

      const contractPath = path.join(hostRoot, "tool-contract.ts");
      const validation = JSON.parse(
        execFileSync(
          process.execPath,
          [
            "--experimental-strip-types",
            "--no-warnings",
            "--eval",
            `const contract = require(process.argv[1]); process.stdout.write(JSON.stringify([
              contract.isValidName("packaged-hermes"),
              contract.isValidName("a${"b".repeat(18)}"),
              contract.isValidName("a${"b".repeat(19)}"),
              contract.isValidName("a--b"),
              contract.isValidProviderName("Provider_1.prod"),
              contract.isValidProviderName("1provider"),
            ]));`,
            contractPath,
          ],
          { cwd: installedRoot, encoding: "utf8" },
        ),
      ) as boolean[];
      expect(validation).toEqual([true, true, false, false, true, false]);
    } finally {
      fs.rmSync(outputDirectory, { recursive: true, force: true });
    }
  });
});
