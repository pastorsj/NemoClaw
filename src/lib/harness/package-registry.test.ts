// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  installBundledHarness,
  listHarnessPackages,
  resolveHarnessPackage,
} from "./package-registry";

const temporaryHomes: string[] = [];

function temporaryHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-harness-registry-"));
  temporaryHomes.push(home);
  return home;
}

function installedRoot(home: string): string {
  return path.join(home, ".nemoclaw", "harnesses");
}

function writeInstalledPackage(
  home: string,
  id: string,
  options: {
    directoryId?: string;
    manifestId?: string;
    packageName?: string;
    nemoclaw?: Record<string, unknown>;
  } = {},
): string {
  const directoryId = options.directoryId ?? id;
  const root = path.join(installedRoot(home), `nemoclaw-${directoryId}`);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({
      name: options.packageName ?? `@nvidia/nemoclaw-${id}`,
      version: "1.2.3",
      nemoclaw: options.nemoclaw ?? { harnessManifest: "manifest.yaml" },
    }),
  );
  fs.writeFileSync(path.join(root, "manifest.yaml"), `name: ${options.manifestId ?? id}\n`);
  return root;
}

afterEach(() => {
  while (temporaryHomes.length > 0) {
    fs.rmSync(temporaryHomes.pop()!, { recursive: true, force: true });
  }
});

describe("harness package registry", () => {
  it("discovers the three data-only bundled harness packages", () => {
    const entries = listHarnessPackages({ HOME: temporaryHome() });

    expect(entries.map((entry) => entry.id)).toEqual([
      "hermes",
      "langchain-deepagents-code",
      "openclaw",
    ]);
    expect(entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "openclaw",
          packageName: "@nvidia/nemoclaw-openclaw",
          source: "bundled",
          version: "0.1.0",
        }),
      ]),
    );
    expect(entries.every((entry) => fs.statSync(entry.manifestPath).isFile())).toBe(true);
  });

  it("discovers an installed data package without loading package code", () => {
    const home = temporaryHome();
    const root = writeInstalledPackage(home, "fixture-agent", {
      nemoclaw: { harnessManifest: "metadata/manifest.yaml" },
    });
    fs.mkdirSync(path.join(root, "metadata"));
    fs.renameSync(path.join(root, "manifest.yaml"), path.join(root, "metadata", "manifest.yaml"));
    fs.writeFileSync(
      path.join(root, "index.js"),
      "throw new Error('must not load package code');\n",
    );

    expect(resolveHarnessPackage("fixture-agent", { HOME: home })).toEqual(
      expect.objectContaining({
        id: "fixture-agent",
        rootDir: root,
        manifestPath: path.join(root, "metadata", "manifest.yaml"),
        source: "installed",
      }),
    );
  });

  it("rejects package metadata that adds a host extension point", () => {
    const home = temporaryHome();
    writeInstalledPackage(home, "host-hook", {
      nemoclaw: { harnessManifest: "manifest.yaml", hostModule: "index.js" },
    });

    expect(() => listHarnessPackages({ HOME: home })).toThrow(
      "nemoclaw metadata may declare only harnessManifest",
    );
  });

  it("rejects directory, package, and manifest identity mismatches", () => {
    const home = temporaryHome();
    writeInstalledPackage(home, "declared-agent", { directoryId: "wrong-directory" });

    expect(() => listHarnessPackages({ HOME: home })).toThrow("identity mismatch");
  });

  it("rejects symlinked installed packages", () => {
    const home = temporaryHome();
    const outside = path.join(home, "outside-package");
    fs.mkdirSync(outside);
    fs.mkdirSync(installedRoot(home), { recursive: true });
    fs.symlinkSync(outside, path.join(installedRoot(home), "nemoclaw-symlinked"));

    expect(() => listHarnessPackages({ HOME: home })).toThrow(
      "must be a regular directory, not a symlink",
    );
  });

  it("rejects symlinks inside an installed package", () => {
    const home = temporaryHome();
    const root = writeInstalledPackage(home, "linked-file");
    fs.symlinkSync(path.join(root, "manifest.yaml"), path.join(root, "linked-manifest.yaml"));

    expect(() => listHarnessPackages({ HOME: home })).toThrow(
      "Harness packages may not contain symbolic links",
    );
  });

  it("rejects a divergent installed package with a bundled identity", () => {
    const home = temporaryHome();
    writeInstalledPackage(home, "openclaw");

    expect(() => listHarnessPackages({ HOME: home })).toThrow(
      "Duplicate harness id 'openclaw' has different bundled and installed content",
    );
  });

  it("atomically installs a bundled package and treats an identical reinstall as success", () => {
    const home = temporaryHome();
    const environment = { HOME: home };

    const first = installBundledHarness("openclaw", environment);
    const second = installBundledHarness("openclaw", environment);

    expect(first).toEqual(
      expect.objectContaining({ id: "openclaw", source: "installed", version: "0.1.0" }),
    );
    expect(second).toEqual(first);
    expect(fs.existsSync(path.join(first.rootDir, "manifest.yaml"))).toBe(true);
    expect(
      fs.readdirSync(installedRoot(home)).filter((name) => name.startsWith(".install-")),
    ).toEqual([]);
    expect(resolveHarnessPackage("openclaw", environment)?.source).toBe("installed");
  });

  it("does not overwrite a changed installed package", () => {
    const home = temporaryHome();
    const environment = { HOME: home };
    const installed = installBundledHarness("hermes", environment);
    fs.writeFileSync(path.join(installed.rootDir, "local-change.txt"), "preserve me\n");

    expect(() => installBundledHarness("hermes", environment)).toThrow(
      "differs from the bundled package",
    );
    expect(fs.readFileSync(path.join(installed.rootDir, "local-change.txt"), "utf8")).toBe(
      "preserve me\n",
    );
  });

  it("returns null for an unknown harness and rejects installing it", () => {
    const environment = { HOME: temporaryHome() };

    expect(resolveHarnessPackage("missing", environment)).toBeNull();
    expect(() => installBundledHarness("missing", environment)).toThrow(
      "Bundled harness 'missing' was not found",
    );
  });
});
