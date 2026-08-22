// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

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
    version?: string;
  } = {},
): string {
  const directoryId = options.directoryId ?? id;
  const root = path.join(installedRoot(home), `nemoclaw-${directoryId}`);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({
      name: options.packageName ?? `@nvidia/nemoclaw-${id}`,
      version: options.version ?? "1.2.3",
      nemoclaw: options.nemoclaw ?? { harnessManifest: "manifest.yaml" },
    }),
  );
  fs.writeFileSync(path.join(root, "manifest.yaml"), `name: ${options.manifestId ?? id}\n`);
  fs.writeFileSync(path.join(root, "Dockerfile"), "FROM scratch\n");
  fs.writeFileSync(path.join(root, "Dockerfile.base"), "FROM scratch\n");
  fs.writeFileSync(path.join(root, "start.sh"), "#!/usr/bin/env bash\n", { mode: 0o755 });
  fs.writeFileSync(path.join(root, "policy-additions.yaml"), "version: 1\n");
  return root;
}

function packageDigest(root: string): string {
  const hash = crypto.createHash("sha256");
  const ignoredEntries = new Set([
    ".git",
    ".DS_Store",
    "node_modules",
    "__pycache__",
    ".nemoclaw-install.json",
  ]);
  const walk = (directory: string, prefix: string): void => {
    for (const entry of fs
      .readdirSync(directory, { withFileTypes: true })
      .filter((candidate) => !ignoredEntries.has(candidate.name))
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolutePath = path.join(directory, entry.name);
      const metadata = fs.lstatSync(absolutePath);
      const executable = (metadata.mode & 0o111) === 0 ? "0" : "1";
      switch (metadata.isDirectory()) {
        case true:
          hash.update(`d\0${relativePath}\0${executable}\0`);
          walk(absolutePath, relativePath);
          break;
        default:
          hash.update(`f\0${relativePath}\0${executable}\0${String(metadata.size)}\0`);
          hash.update(fs.readFileSync(absolutePath));
          hash.update("\0");
      }
    }
  };
  walk(root, "");
  return hash.digest("hex");
}

function writeInstallReceipt(root: string, installedDigest: string): void {
  fs.writeFileSync(
    path.join(root, ".nemoclaw-install.json"),
    `${JSON.stringify({ installedDigest })}\n`,
  );
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
    const root = writeInstalledPackage(home, "fixture-agent");
    fs.writeFileSync(
      path.join(root, "index.js"),
      "throw new Error('must not load package code');\n",
    );

    expect(resolveHarnessPackage("fixture-agent", { HOME: home })).toEqual(
      expect.objectContaining({
        id: "fixture-agent",
        rootDir: root,
        manifestPath: path.join(root, "manifest.yaml"),
        source: "installed",
      }),
    );
  });

  it("requires the manifest at the package root", () => {
    const home = temporaryHome();
    writeInstalledPackage(home, "nested-manifest", {
      nemoclaw: { harnessManifest: "metadata/manifest.yaml" },
    });

    expect(() => listHarnessPackages({ HOME: home })).toThrow(
      "nemoclaw.harnessManifest must be 'manifest.yaml'",
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

  it("refuses a package metadata file swapped to a symlink before it is opened", () => {
    const home = temporaryHome();
    const root = writeInstalledPackage(home, "metadata-swap");
    const metadataPath = path.join(root, "package.json");
    const outsideMetadata = path.join(home, "outside-package.json");
    fs.writeFileSync(outsideMetadata, fs.readFileSync(metadataPath));
    const openSync = fs.openSync.bind(fs);
    const open = vi
      .spyOn(fs, "openSync")
      .mockImplementationOnce((target, flags, mode) => {
        expect(path.resolve(target.toString())).toBe(path.resolve(metadataPath));
        fs.rmSync(metadataPath);
        fs.symlinkSync(outsideMetadata, metadataPath);
        return openSync(target, flags, mode);
      })
      .mockImplementation(openSync);

    try {
      expect(() => listHarnessPackages({ HOME: home })).toThrow(
        "Harness package metadata is unavailable",
      );
    } finally {
      open.mockRestore();
    }
  });

  it.each(["Dockerfile", "Dockerfile.base", "start.sh", "policy-additions.yaml"])(
    "rejects an installed package without required file %s",
    (fileName) => {
      const home = temporaryHome();
      const root = writeInstalledPackage(home, "missing-artifact");
      fs.rmSync(path.join(root, fileName));

      expect(() => listHarnessPackages({ HOME: home })).toThrow(
        `missing required file '${fileName}'`,
      );
    },
  );

  it("requires an executable harness start script", () => {
    const home = temporaryHome();
    const root = writeInstalledPackage(home, "non-executable-start");
    fs.chmodSync(path.join(root, "start.sh"), 0o644);

    expect(() => listHarnessPackages({ HOME: home })).toThrow("start.sh must be executable");
  });

  it("rejects a divergent installed package with a bundled identity", () => {
    const home = temporaryHome();
    writeInstalledPackage(home, "openclaw");

    expect(() => listHarnessPackages({ HOME: home })).toThrow(
      "Duplicate harness id 'openclaw' has different bundled and installed content",
    );
  });

  it("atomically installs a bundled package with its content receipt", () => {
    const home = temporaryHome();
    const environment = { HOME: home };

    const first = installBundledHarness("openclaw", environment);

    expect(first).toEqual(
      expect.objectContaining({ id: "openclaw", source: "installed", version: "0.1.0" }),
    );
    expect(fs.existsSync(path.join(first.rootDir, "manifest.yaml"))).toBe(true);
    expect(fs.existsSync(path.join(first.rootDir, ".nemoclaw-install.json"))).toBe(true);
    expect(
      fs.readdirSync(installedRoot(home)).filter((name) => name.startsWith(".install-")),
    ).toEqual([]);
    expect(resolveHarnessPackage("openclaw", environment)?.source).toBe("installed");
  });

  it("treats an identical bundled reinstall as success", () => {
    const home = temporaryHome();
    const environment = { HOME: home };
    const first = installBundledHarness("openclaw", environment);

    const second = installBundledHarness("openclaw", environment);

    expect(second).toEqual(first);
    expect(resolveHarnessPackage("openclaw", environment)?.source).toBe("installed");
  });

  it("replaces a clean installed package when its bundled package changes", () => {
    const home = temporaryHome();
    const environment = { HOME: home };
    const previous = writeInstalledPackage(home, "openclaw", { version: "0.0.1" });
    writeInstallReceipt(previous, packageDigest(previous));

    expect(resolveHarnessPackage("openclaw", environment)).toEqual(
      expect.objectContaining({ source: "installed", version: "0.0.1" }),
    );

    const updated = installBundledHarness("openclaw", environment);

    expect(updated).toEqual(expect.objectContaining({ source: "installed", version: "0.1.0" }));
    expect(fs.existsSync(path.join(updated.rootDir, ".nemoclaw-install.json"))).toBe(true);
    expect(
      fs
        .readdirSync(installedRoot(home))
        .filter((name) => name.startsWith(".install-") || name.startsWith(".previous-")),
    ).toEqual([]);
  });

  it("preserves the previous package outside staging when update and restore both fail", () => {
    const home = temporaryHome();
    const environment = { HOME: home };
    const previous = writeInstalledPackage(home, "openclaw", { version: "0.0.1" });
    writeInstallReceipt(previous, packageDigest(previous));
    const target = path.resolve(previous);
    const renameSync = fs.renameSync.bind(fs);
    const rename = vi.spyOn(fs, "renameSync").mockImplementation((source, destination) => {
      switch (path.resolve(destination.toString())) {
        case target:
          throw new Error("injected target rename failure");
        default:
          renameSync(source, destination);
      }
    });

    try {
      expect(() => installBundledHarness("openclaw", environment)).toThrow(
        "the previous package remains at",
      );
    } finally {
      rename.mockRestore();
    }

    const harnessRoot = installedRoot(home);
    const previousDirectory = fs
      .readdirSync(harnessRoot)
      .find((name) => name.startsWith(".previous-openclaw-"));
    expect(previousDirectory).toBeDefined();
    expect(
      JSON.parse(
        fs.readFileSync(
          path.join(harnessRoot, previousDirectory!, "nemoclaw-openclaw", "package.json"),
          "utf8",
        ),
      ),
    ).toEqual(expect.objectContaining({ version: "0.0.1" }));
    expect(fs.readdirSync(harnessRoot).some((name) => name.startsWith(".install-"))).toBe(false);
  });

  it("restores the previous package when validation fails after publishing an update", () => {
    const home = temporaryHome();
    const environment = { HOME: home };
    const previous = writeInstalledPackage(home, "openclaw", { version: "0.0.1" });
    writeInstallReceipt(previous, packageDigest(previous));
    const target = path.resolve(previous);
    const renameSync = fs.renameSync.bind(fs);
    const rename = vi.spyOn(fs, "renameSync").mockImplementation((source, destination) => {
      renameSync(source, destination);
      switch (
        path.resolve(destination.toString()) === target &&
        path.basename(path.dirname(path.resolve(source.toString()))).startsWith(".install-")
      ) {
        case true:
          fs.rmSync(path.join(target, "Dockerfile"));
          break;
      }
    });

    try {
      expect(() => installBundledHarness("openclaw", environment)).toThrow(
        "missing required file 'Dockerfile'",
      );
    } finally {
      rename.mockRestore();
    }

    expect(JSON.parse(fs.readFileSync(path.join(target, "package.json"), "utf8"))).toEqual(
      expect.objectContaining({ version: "0.0.1" }),
    );
    expect(resolveHarnessPackage("openclaw", environment)).toEqual(
      expect.objectContaining({ source: "installed", version: "0.0.1" }),
    );
    expect(
      fs
        .readdirSync(installedRoot(home))
        .filter((name) => name.startsWith(".install-") || name.startsWith(".previous-")),
    ).toEqual([]);
  });

  it("does not overwrite a changed installed package", () => {
    const home = temporaryHome();
    const environment = { HOME: home };
    const installed = installBundledHarness("hermes", environment);
    fs.writeFileSync(path.join(installed.rootDir, "local-change.txt"), "preserve me\n");

    expect(resolveHarnessPackage("hermes", environment)?.source).toBe("installed");

    expect(() => installBundledHarness("hermes", environment)).toThrow(
      "differs from the bundled package and has local changes",
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
