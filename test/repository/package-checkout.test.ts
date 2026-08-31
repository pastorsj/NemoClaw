// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  prepareCheckoutRootRemoval,
  runPackageCheckoutRehearsal,
} from "../../scripts/packages/checkout.mts";

describe("package checkout cleanup", () => {
  it("removes generated read-only artifacts after a package-only rehearsal", () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-package-checkout-cleanup-"));
    const candidateRoot = path.join(parent, "candidate");
    fs.mkdirSync(candidateRoot);
    fs.writeFileSync(
      path.join(candidateRoot, "package.json"),
      `${JSON.stringify({
        name: "@nvidia/nemoclaw-example",
        nemoclaw: { harnessManifest: "manifest.yaml" },
      })}\n`,
    );
    fs.writeFileSync(path.join(candidateRoot, "package-lock.json"), "{}\n");
    fs.writeFileSync(path.join(candidateRoot, "manifest.yaml"), "name: example\n");
    const commandPurposes: string[] = [];
    const createGeneratedArtifactsByPurpose: Record<string, (workingDirectory: string) => void> = {
      "install candidate package dependencies": (workingDirectory) => {
        const rehearsalRoot = path.dirname(workingDirectory);
        const artifactRoot = path.join(
          rehearsalRoot,
          "nemoclaw",
          "dist",
          "harnesses",
          "nemoclaw-example",
          "runtime",
        );
        fs.mkdirSync(artifactRoot, { recursive: true });
        fs.writeFileSync(path.join(artifactRoot, "start.sh"), "#!/bin/sh\n", {
          mode: 0o444,
        });
        fs.chmodSync(artifactRoot, 0o555);
        fs.chmodSync(path.dirname(artifactRoot), 0o555);
      },
    };

    try {
      const result = runPackageCheckoutRehearsal(
        {
          mode: "package-only",
          packageId: "example",
          candidatePackageDir: candidateRoot,
          temporaryParentDir: parent,
          parentEnvironment: { PATH: process.env.PATH },
        },
        {
          runCommand: (command) => {
            commandPurposes.push(command.purpose);
            createGeneratedArtifactsByPurpose[command.purpose]?.(command.cwd);
            return { stdout: "" };
          },
        },
      );

      expect(result).toEqual({ mode: "package-only", packageId: "example" });
      expect(commandPurposes).toEqual([
        "install candidate package dependencies",
        "run candidate package-only tests",
      ]);
      expect(fs.readdirSync(parent).filter((entry) => entry.startsWith("nc-"))).toEqual([]);
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });

  it("does not follow a redirected generated artifact path", () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-package-checkout-symlink-"));
    const rehearsalRoot = path.join(parent, "checkout");
    const distRoot = path.join(rehearsalRoot, "nemoclaw", "dist");
    const outsideRoot = path.join(parent, "outside");
    fs.mkdirSync(distRoot, { recursive: true });
    fs.mkdirSync(outsideRoot);
    const outsideFile = path.join(outsideRoot, "keep.txt");
    fs.writeFileSync(outsideFile, "keep\n", { mode: 0o444 });
    fs.chmodSync(outsideRoot, 0o555);
    fs.symlinkSync(outsideRoot, path.join(distRoot, "harnesses"));

    try {
      prepareCheckoutRootRemoval(rehearsalRoot);

      expect(fs.statSync(outsideRoot).mode & 0o777).toBe(0o555);
      expect(fs.readFileSync(outsideFile, "utf8")).toBe("keep\n");
      fs.rmSync(rehearsalRoot, { recursive: true, force: true });
      expect(fs.readFileSync(outsideFile, "utf8")).toBe("keep\n");
    } finally {
      fs.chmodSync(outsideRoot, 0o700);
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });
});
