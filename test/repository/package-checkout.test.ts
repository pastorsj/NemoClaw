// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  type CheckoutCommand,
  type CheckoutCommandResult,
  prepareCheckoutRootRemoval,
  readInstalledHarnessDigest,
  runPackageCheckoutRehearsal,
} from "../../scripts/packages/checkout.mts";
import {
  ensureHarnessPackageStore,
  harnessPackageStorePaths,
} from "../../src/lib/agent-runtime/package/store-files";

describe("package checkout cleanup", () => {
  it("uses a canonical private home when the temporary parent has a symlinked ancestor", () => {
    const parent = fs.mkdtempSync(
      path.join(fs.realpathSync.native(os.tmpdir()), "nemoclaw-package-checkout-parent-"),
    );
    const candidateRoot = path.join(parent, "candidate");
    const actualParent = path.join(parent, "actual", "temporary");
    const linkedAncestor = path.join(parent, "linked");
    const selectedParent = path.join(linkedAncestor, "temporary");
    fs.mkdirSync(candidateRoot);
    fs.mkdirSync(actualParent, { recursive: true, mode: 0o700 });
    fs.symlinkSync(
      path.join(parent, "actual"),
      linkedAncestor,
      process.platform === "win32" ? "junction" : "dir",
    );
    fs.writeFileSync(
      path.join(candidateRoot, "package.json"),
      `${JSON.stringify({
        name: "@nvidia/nemoclaw-example",
        nemoclaw: { harnessManifest: "manifest.yaml" },
      })}\n`,
    );
    fs.writeFileSync(path.join(candidateRoot, "package-lock.json"), "{}\n");
    fs.writeFileSync(path.join(candidateRoot, "manifest.yaml"), "name: example\n");
    const observedHomes: string[] = [];

    try {
      runPackageCheckoutRehearsal(
        {
          mode: "package-only",
          packageId: "example",
          candidatePackageDir: candidateRoot,
          temporaryParentDir: selectedParent,
          parentEnvironment: { PATH: process.env.PATH },
        },
        {
          runCommand: (command) => {
            const commandHome = command.env.HOME ?? "";
            expect(commandHome).not.toBe("");
            expect(path.resolve(commandHome)).toBe(fs.realpathSync.native(commandHome));
            observedHomes.push(commandHome);
            ensureHarnessPackageStore(
              harnessPackageStorePaths(path.join(commandHome, ".nemoclaw", "harnesses"), "example"),
            );
            return { stdout: "" };
          },
        },
      );

      expect(observedHomes).toHaveLength(2);
      expect(
        observedHomes.every((home) =>
          home.startsWith(`${fs.realpathSync.native(selectedParent)}${path.sep}`),
        ),
      ).toBe(true);
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });

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

describe("package checkout installed digest", () => {
  const digest = "a".repeat(64);
  const installedRow = {
    id: "example",
    displayName: "Example",
    health: "healthy",
    identity: {
      kind: "agent-runtime",
      id: "example",
      packageVersion: "0.1.0",
      contentDigest: digest,
    },
  };

  it("reads the receipt-verified digest from public harness inventory", () => {
    expect(
      readInstalledHarnessDigest(
        JSON.stringify({ schemaVersion: 1, installed: [installedRow], available: [] }),
        "example",
      ),
    ).toBe(digest);
  });

  it.each([
    ["a damaged row", { ...installedRow, health: "damaged", identity: null }],
    [
      "a malformed digest",
      { ...installedRow, identity: { ...installedRow.identity, contentDigest: "not-a-digest" } },
    ],
  ])("rejects %s", (_label, row) => {
    expect(() =>
      readInstalledHarnessDigest(
        JSON.stringify({ schemaVersion: 1, installed: [row], available: [] }),
        "example",
      ),
    ).toThrow("Candidate package inventory is invalid");
  });

  it("uses public inventory JSON to finish a composed rehearsal", () => {
    const parent = fs.mkdtempSync(
      path.join(fs.realpathSync.native(os.tmpdir()), "nemoclaw-package-checkout-composed-"),
    );
    const candidateRoot = path.join(parent, "candidate");
    const coreCheckout = path.join(parent, "core");
    const coreCommit = "b".repeat(40);
    fs.mkdirSync(candidateRoot);
    fs.mkdirSync(coreCheckout);
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
    const commandHandlers: Record<string, (command: CheckoutCommand) => CheckoutCommandResult> = {
      "read exact NemoClaw revision": () => ({ stdout: `${coreCommit}\n` }),
      "extract exact NemoClaw revision": (command) => {
        const coreRoot = command.args.at(-1) ?? "";
        expect(coreRoot).not.toBe("");
        fs.writeFileSync(path.join(coreRoot, "package-lock.json"), "{}\n");
        return { stdout: "" };
      },
      "list installed harnesses": () => ({
        stdout: "Installed\n  example | Example\n\nAvailable\n",
      }),
      "read installed harness digest": () => ({
        stdout: JSON.stringify({
          schemaVersion: 1,
          installed: [installedRow],
          available: [],
        }),
      }),
    };

    try {
      const result = runPackageCheckoutRehearsal(
        {
          mode: "composed",
          packageId: "example",
          candidatePackageDir: candidateRoot,
          coreCheckoutDir: coreCheckout,
          coreCommit,
          temporaryParentDir: parent,
          parentEnvironment: { PATH: process.env.PATH },
        },
        {
          runCommand: (command) => {
            commandPurposes.push(command.purpose);
            return commandHandlers[command.purpose]?.(command) ?? { stdout: "" };
          },
        },
      );

      expect(result).toEqual({
        mode: "composed",
        packageId: "example",
        coreCommit,
        installedDigest: digest,
      });
      expect(commandPurposes.slice(-3)).toEqual([
        "install candidate harness",
        "list installed harnesses",
        "read installed harness digest",
      ]);
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });
});
