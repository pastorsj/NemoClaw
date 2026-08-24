// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { testTimeoutOptions } from "../../../test/helpers/timeouts";

import {
  captureHarnessPackageSnapshot,
  captureHarnessPackageText,
  captureHarnessPackageTextDirectory,
  captureHarnessPackageTexts,
  harnessPackageContentDigest,
  installBundledHarness,
  listHarnessPackageIds,
  listHarnessPackages,
  refreshInstalledBundledHarnesses,
  resolveHarnessPackage,
  verifyHarnessPackageInstallReceipt,
  withCapturedHarnessPackageTextFile,
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
  writeInstallReceipt(root, packageDigest(root));
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

describe("harness package registry", testTimeoutOptions(30_000), () => {
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
    writeInstallReceipt(root, packageDigest(root));

    expect(resolveHarnessPackage("fixture-agent", { HOME: home })).toEqual(
      expect.objectContaining({
        id: "fixture-agent",
        rootDir: root,
        manifestPath: path.join(root, "manifest.yaml"),
        source: "installed",
      }),
    );
  });

  it("resolves one installed harness without validating an unrelated changed harness", () => {
    const home = temporaryHome();
    const openClawRoot = writeInstalledPackage(home, "openclaw");
    const dcodeRoot = writeInstalledPackage(home, "langchain-deepagents-code");
    fs.writeFileSync(path.join(dcodeRoot, "local-change.txt"), "changed after installation\n");

    expect(resolveHarnessPackage("openclaw", { HOME: home })).toEqual(
      expect.objectContaining({ id: "openclaw", rootDir: openClawRoot, source: "installed" }),
    );
    expect(listHarnessPackageIds({ HOME: home })).toEqual([
      "hermes",
      "langchain-deepagents-code",
      "openclaw",
    ]);
    expect(() => listHarnessPackages({ HOME: home })).toThrow(
      "installation receipt does not match package content",
    );
    expect(() => resolveHarnessPackage("langchain-deepagents-code", { HOME: home })).toThrow(
      "installation receipt does not match package content",
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

  it("rejects a credential-shaped path before selecting an installed package", () => {
    const home = temporaryHome();
    const root = writeInstalledPackage(home, "credential-file");
    fs.writeFileSync(path.join(root, ".env"), "TOKEN=not-a-real-secret\n");
    writeInstallReceipt(root, packageDigest(root));

    expect(() => listHarnessPackages({ HOME: home })).toThrow(
      "contains a forbidden build-context path",
    );
  });

  it("rejects an oversized package file before allocating its declared size", () => {
    const home = temporaryHome();
    const root = writeInstalledPackage(home, "oversized-file");
    const oversized = path.join(root, "oversized.bin");
    const descriptor = fs.openSync(oversized, "w", 0o644);
    try {
      fs.ftruncateSync(descriptor, 64 * 1024 * 1024 + 1);
    } finally {
      fs.closeSync(descriptor);
    }
    writeInstallReceipt(root, "a".repeat(64));

    expect(() => listHarnessPackages({ HOME: home })).toThrow(
      "Harness package file exceeds the size limit",
    );
  });

  it.runIf(typeof process.geteuid === "function")(
    "rejects a group-writable installed package path",
    () => {
      const home = temporaryHome();
      const root = writeInstalledPackage(home, "writable-package");
      fs.chmodSync(path.join(root, "Dockerfile"), 0o664);

      expect(() => listHarnessPackages({ HOME: home })).toThrow(
        "must be owned by the current user and not group or world writable",
      );
    },
  );

  it("rejects a file added while package content is hashed", () => {
    const home = temporaryHome();
    const root = writeInstalledPackage(home, "changing-tree");
    const originalReaddirSync = fs.readdirSync.bind(fs);
    const readdir = vi
      .spyOn(fs, "readdirSync")
      .mockImplementationOnce(((directory, options) => {
        const entries = originalReaddirSync(directory, options as { withFileTypes: true });
        fs.writeFileSync(path.join(root, "late-file.txt"), "late\n");
        return entries;
      }) as typeof fs.readdirSync)
      .mockImplementation(originalReaddirSync as typeof fs.readdirSync);

    try {
      expect(() => harnessPackageContentDigest(root)).toThrow(
        "Harness package tree changed while it was read",
      );
    } finally {
      readdir.mockRestore();
    }
  });

  it("rejects a file edited while package content is hashed", () => {
    const home = temporaryHome();
    const root = writeInstalledPackage(home, "changing-file");
    const dockerfile = path.join(root, "Dockerfile");
    const originalReadSync = fs.readSync.bind(fs);
    const read = vi
      .spyOn(fs, "readSync")
      .mockImplementationOnce(((descriptor, buffer, offset, length, position) => {
        fs.appendFileSync(dockerfile, "# late edit\n");
        return originalReadSync(descriptor, buffer, offset, length, position);
      }) as typeof fs.readSync)
      .mockImplementation(originalReadSync as typeof fs.readSync);

    try {
      expect(() => harnessPackageContentDigest(root)).toThrow(
        /changed while read|changed while reading/,
      );
    } finally {
      read.mockRestore();
    }
  });

  it("rejects a manifest path swapped and restored during snapshot capture", () => {
    const home = temporaryHome();
    const root = writeInstalledPackage(home, "manifest-swap");
    const harnessPackage = resolveHarnessPackage("manifest-swap", { HOME: home });
    expect(harnessPackage).not.toBeNull();
    const manifestPath = path.join(root, "manifest.yaml");
    const displacedPath = path.join(root, "manifest.displaced.yaml");
    const openSync = fs.openSync.bind(fs);
    const readSync = fs.readSync.bind(fs);
    let manifestDescriptor: number | null = null;
    const open = vi.spyOn(fs, "openSync").mockImplementation((candidate, flags, mode) => {
      const descriptor = openSync(candidate, flags, mode);
      manifestDescriptor =
        path.resolve(candidate.toString()) === path.resolve(manifestPath)
          ? descriptor
          : manifestDescriptor;
      return descriptor;
    });
    const read = vi.spyOn(fs, "readSync").mockImplementation(((
      descriptor,
      buffer,
      offset,
      length,
      position,
    ) => {
      const readSwappedManifest = () => {
        manifestDescriptor = null;
        fs.renameSync(manifestPath, displacedPath);
        fs.writeFileSync(manifestPath, "name: substituted\n");
        const bytesRead = readSync(descriptor, buffer, offset, length, position);
        fs.rmSync(manifestPath);
        fs.renameSync(displacedPath, manifestPath);
        return bytesRead;
      };
      return descriptor === manifestDescriptor
        ? readSwappedManifest()
        : readSync(descriptor, buffer, offset, length, position);
    }) as typeof fs.readSync);

    try {
      expect(() => captureHarnessPackageSnapshot(harnessPackage!)).toThrow(
        /changed during validation|changed while reading/u,
      );
    } finally {
      read.mockRestore();
      open.mockRestore();
      const restoreDisplacedManifest = () => {
        fs.rmSync(manifestPath, { force: true });
        fs.renameSync(displacedPath, manifestPath);
      };
      const keepRestoredManifest = () => undefined;
      (fs.existsSync(displacedPath) ? restoreDisplacedManifest : keepRestoredManifest)();
    }
  });

  it("captures package text from the same receipt-verified traversal", () => {
    const home = temporaryHome();
    const root = writeInstalledPackage(home, "captured-text");
    fs.mkdirSync(path.join(root, "config"));
    fs.writeFileSync(path.join(root, "config", "one.txt"), "one\n");
    fs.writeFileSync(path.join(root, "config", "two.txt"), "two\n");
    writeInstallReceipt(root, packageDigest(root));
    const harnessPackage = resolveHarnessPackage("captured-text", { HOME: home });

    const snapshot = captureHarnessPackageTexts(harnessPackage!, [
      { relativePath: "config/one.txt", maxBytes: 32 },
      { relativePath: "config/two.txt", maxBytes: 32 },
      { relativePath: "config/missing.txt", maxBytes: 32 },
    ]);

    expect(snapshot.sources.get("config/one.txt")).toBe("one\n");
    expect(snapshot.sources.get("config/two.txt")).toBe("two\n");
    expect(snapshot.sources.get("config/missing.txt")).toBeNull();
    expect(snapshot.contentDigest).toBe(packageDigest(root));
  });

  it("captures matching direct children from a package directory", () => {
    const home = temporaryHome();
    const root = writeInstalledPackage(home, "captured-directory");
    fs.mkdirSync(path.join(root, "policies", "presets", "nested"), { recursive: true });
    fs.writeFileSync(path.join(root, "policies", "presets", "one.yaml"), "name: one\n");
    fs.writeFileSync(path.join(root, "policies", "presets", "two.yaml"), "name: two\n");
    fs.writeFileSync(path.join(root, "policies", "presets", "ignored.yml"), "name: ignored\n");
    fs.writeFileSync(
      path.join(root, "policies", "presets", "nested", "ignored.yaml"),
      "name: nested\n",
    );
    writeInstallReceipt(root, packageDigest(root));
    const harnessPackage = resolveHarnessPackage("captured-directory", { HOME: home });

    const snapshot = captureHarnessPackageTextDirectory(
      harnessPackage!,
      "policies/presets",
      ".yaml",
      4096,
    );

    expect([...snapshot.sources.entries()]).toEqual([
      ["policies/presets/one.yaml", "name: one\n"],
      ["policies/presets/two.yaml", "name: two\n"],
    ]);
    expect(snapshot.contentDigest).toBe(packageDigest(root));
  });

  it("rejects changed package text before returning it to a consumer", () => {
    const home = temporaryHome();
    const root = writeInstalledPackage(home, "changed-text");
    fs.writeFileSync(path.join(root, "runtime.cjs"), "module.exports = { safe: true };\n");
    writeInstallReceipt(root, packageDigest(root));
    const harnessPackage = resolveHarnessPackage("changed-text", { HOME: home });
    fs.writeFileSync(path.join(root, "runtime.cjs"), "module.exports = { safe: false };\n");

    expect(() => captureHarnessPackageText(harnessPackage!, "runtime.cjs", 4096)).toThrow(
      "installation receipt does not match package content",
    );
  });

  it("materializes only captured package bytes for a synchronous file consumer", () => {
    const home = temporaryHome();
    const root = writeInstalledPackage(home, "captured-file");
    fs.mkdirSync(path.join(root, "provider-profiles"));
    fs.writeFileSync(path.join(root, "provider-profiles", "search.yaml"), "version: 1\n");
    writeInstallReceipt(root, packageDigest(root));
    const harnessPackage = resolveHarnessPackage("captured-file", { HOME: home });
    let temporaryFile = "";

    const result = withCapturedHarnessPackageTextFile(
      harnessPackage!,
      "provider-profiles/search.yaml",
      4096,
      (filePath) => {
        temporaryFile = filePath;
        expect(filePath).not.toContain(root);
        expect(fs.readFileSync(filePath, "utf8")).toBe("version: 1\n");
        return "imported";
      },
    );

    expect(result).toBe("imported");
    expect(fs.existsSync(temporaryFile)).toBe(false);
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

  it("rejects an installed package without an installation receipt", () => {
    const home = temporaryHome();
    const root = writeInstalledPackage(home, "openclaw");
    fs.rmSync(path.join(root, ".nemoclaw-install.json"));

    expect(() => listHarnessPackages({ HOME: home })).toThrow(
      "Harness installation receipt is missing",
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

  it("masks shared writes during package copy and restores the host umask", () => {
    const home = temporaryHome();
    const environment = { HOME: home };
    const copySync = fs.cpSync.bind(fs);
    const copyUmasks: number[] = [];
    const copy = vi.spyOn(fs, "cpSync").mockImplementation((source, destination, options) => {
      copyUmasks.push(process.umask());
      return copySync(source, destination, options);
    });
    const previousUmask = process.umask(0o002);
    let installedRoot = "";
    let umaskAfterInstall = -1;

    try {
      installedRoot = installBundledHarness("openclaw", environment).rootDir;
      umaskAfterInstall = process.umask();
    } finally {
      process.umask(previousUmask);
      copy.mockRestore();
    }

    expect(copyUmasks).toEqual([0o022]);
    expect(umaskAfterInstall).toBe(0o002);
    expect(fs.lstatSync(installedRoot).mode & 0o777).toBe(0o700);
    expect(fs.lstatSync(path.join(installedRoot, "checks")).mode & 0o022).toBe(0);
    expect(fs.lstatSync(path.join(installedRoot, "start.sh")).mode & 0o111).not.toBe(0);
    expect(
      captureHarnessPackageTextDirectory(
        resolveHarnessPackage("openclaw", environment)!,
        "checks",
        ".json",
        256 * 1024,
      ).sources.size,
    ).toBeGreaterThan(0);
  });

  it("does not publish a copied package path that remains group-writable", () => {
    const home = temporaryHome();
    const environment = { HOME: home };
    const copySync = fs.cpSync.bind(fs);
    const copy = vi.spyOn(fs, "cpSync").mockImplementation((source, destination, options) => {
      copySync(source, destination, options);
      fs.chmodSync(path.join(destination.toString(), "checks", "base-inputs.json"), 0o664);
    });

    try {
      expect(() => installBundledHarness("openclaw", environment)).toThrow(
        "not group or world writable",
      );
    } finally {
      copy.mockRestore();
    }

    expect(fs.existsSync(path.join(installedRoot(home), "nemoclaw-openclaw"))).toBe(false);
    expect(
      fs.readdirSync(installedRoot(home)).some((name) => name.startsWith(".install-openclaw-")),
    ).toBe(false);
  });

  it("atomically refreshes an identical package installed with shared writes", () => {
    const home = temporaryHome();
    const environment = { HOME: home };
    const first = installBundledHarness("openclaw", environment);
    const firstInode = fs.lstatSync(first.rootDir).ino;
    const writableFile = path.join(first.rootDir, "checks", "base-inputs.json");
    fs.chmodSync(writableFile, 0o664);

    const refreshed = installBundledHarness("openclaw", environment);

    expect(fs.lstatSync(refreshed.rootDir).ino).not.toBe(firstInode);
    expect(fs.lstatSync(writableFile).mode & 0o022).toBe(0);
    expect(verifyHarnessPackageInstallReceipt(refreshed.rootDir)).toBe(
      packageDigest(refreshed.rootDir),
    );
  });

  it("preserves an unknown target that replaces a newly published package", () => {
    const home = temporaryHome();
    const environment = { HOME: home };
    const target = path.join(installedRoot(home), "nemoclaw-openclaw");
    const displacedPublished = path.join(home, "new-displaced-published-package");
    const sentinelSource = path.join(home, "new-outside-sentinel");
    fs.mkdirSync(sentinelSource);
    fs.writeFileSync(path.join(sentinelSource, "preserve.txt"), "do not delete\n");
    const renameSync = fs.renameSync.bind(fs);
    let substituted = false;
    const rename = vi.spyOn(fs, "renameSync").mockImplementation((source, destination) => {
      renameSync(source, destination);
      switch (
        !substituted &&
        path.resolve(destination.toString()) === path.resolve(target) &&
        path.basename(path.dirname(path.resolve(source.toString()))).startsWith(".install-")
      ) {
        case true:
          substituted = true;
          renameSync(target, displacedPublished);
          renameSync(sentinelSource, target);
          break;
      }
    });

    try {
      expect(() => installBundledHarness("openclaw", environment)).toThrow(
        "could not be installed or safely removed",
      );
    } finally {
      rename.mockRestore();
    }

    expect(fs.readFileSync(path.join(target, "preserve.txt"), "utf8")).toBe("do not delete\n");
    expect(
      fs.readdirSync(installedRoot(home)).some((name) => name.startsWith(".install-openclaw-")),
    ).toBe(false);
  });

  it("republishes an identical package instead of writing its receipt in place", () => {
    const home = temporaryHome();
    const environment = { HOME: home };
    const installed = installBundledHarness("openclaw", environment);
    fs.rmSync(path.join(installed.rootDir, ".nemoclaw-install.json"));
    const writeFileSync = fs.writeFileSync.bind(fs);
    const receiptWrites: string[] = [];
    const write = vi.spyOn(fs, "writeFileSync").mockImplementation(((file, data, options) => {
      switch (path.basename(file.toString()).startsWith(".nemoclaw-install-")) {
        case true:
          receiptWrites.push(path.resolve(file.toString()));
          break;
      }
      return writeFileSync(file, data, options as never);
    }) as typeof fs.writeFileSync);

    try {
      installBundledHarness("openclaw", environment);
    } finally {
      write.mockRestore();
    }

    expect(receiptWrites).toHaveLength(1);
    expect(path.dirname(receiptWrites[0])).not.toBe(path.resolve(installed.rootDir));
    expect(path.basename(path.dirname(path.dirname(receiptWrites[0])))).toMatch(
      /^\.install-openclaw-/u,
    );
    expect(verifyHarnessPackageInstallReceipt(installed.rootDir)).toBe(
      packageDigest(installed.rootDir),
    );
  });

  it("rejects an installation root replaced with a symlink before it is opened", () => {
    const home = temporaryHome();
    const environment = { HOME: home };
    const stateRoot = path.resolve(home, ".nemoclaw");
    const harnessRoot = installedRoot(home);
    const movedHarnessRoot = path.join(home, "moved-harness-root");
    const outside = path.join(home, "outside-root");
    fs.mkdirSync(outside, { mode: 0o755 });
    fs.chmodSync(outside, 0o755);
    const openSync = fs.openSync.bind(fs);
    const open = vi.spyOn(fs, "openSync").mockImplementation((candidate, flags, mode) => {
      const descriptor = openSync(candidate, flags, mode);
      switch (path.resolve(candidate.toString()) === stateRoot) {
        case true:
          fs.renameSync(harnessRoot, movedHarnessRoot);
          fs.symlinkSync(outside, harnessRoot);
          break;
      }
      return descriptor;
    });

    try {
      expect(() => installBundledHarness("openclaw", environment)).toThrow(
        "Harness installation path must be a regular directory",
      );
    } finally {
      open.mockRestore();
    }

    expect(fs.lstatSync(harnessRoot).isSymbolicLink()).toBe(true);
    expect(fs.statSync(outside).mode & 0o777).toBe(0o755);
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it("rejects a staging directory replaced with a symlink before it is secured", () => {
    const home = temporaryHome();
    const environment = { HOME: home };
    const outside = path.join(home, "outside-staging-root");
    fs.mkdirSync(outside, { mode: 0o755 });
    fs.chmodSync(outside, 0o755);
    const mkdtempSync = fs.mkdtempSync.bind(fs);
    const mkdtemp = vi.spyOn(fs, "mkdtempSync").mockImplementationOnce((prefix, options) => {
      const created = mkdtempSync(prefix, options as never) as string;
      fs.renameSync(created, `${created}.moved`);
      fs.symlinkSync(outside, created);
      return created;
    });

    try {
      expect(() => installBundledHarness("openclaw", environment)).toThrow(
        "Harness installation path must be a regular directory",
      );
    } finally {
      mkdtemp.mockRestore();
    }

    expect(fs.statSync(outside).mode & 0o777).toBe(0o755);
    expect(fs.readdirSync(outside)).toEqual([]);
    expect(fs.existsSync(path.join(installedRoot(home), "nemoclaw-openclaw"))).toBe(false);
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

  it("replaces a clean receipt-managed package that predates the current contract", () => {
    const home = temporaryHome();
    const environment = { HOME: home };
    const previous = writeInstalledPackage(home, "hermes", { version: "0.0.1" });
    fs.rmSync(path.join(previous, "policy-additions.yaml"));
    writeInstallReceipt(previous, packageDigest(previous));

    const updated = installBundledHarness("hermes", environment);

    expect(updated).toEqual(expect.objectContaining({ source: "installed", version: "0.1.0" }));
    expect(fs.existsSync(path.join(updated.rootDir, "policy-additions.yaml"))).toBe(true);
  });

  it("refreshes a clean receipt-managed package that predates the current contract", () => {
    const home = temporaryHome();
    const environment = { HOME: home };
    const previous = writeInstalledPackage(home, "hermes", { version: "0.0.1" });
    fs.rmSync(path.join(previous, "policy-additions.yaml"));
    writeInstallReceipt(previous, packageDigest(previous));

    const refreshed = refreshInstalledBundledHarnesses(environment);

    expect(refreshed).toEqual([
      expect.objectContaining({ id: "hermes", source: "installed", version: "0.1.0" }),
    ]);
    expect(fs.existsSync(path.join(previous, "policy-additions.yaml"))).toBe(true);
  });

  it("rejects a receipt-managed installed package whose root is a symlink", () => {
    const home = temporaryHome();
    const environment = { HOME: home };
    const outside = writeInstalledPackage(home, "outside", { manifestId: "openclaw" });
    writeInstallReceipt(outside, packageDigest(outside));
    fs.mkdirSync(installedRoot(home), { recursive: true });
    const target = path.join(installedRoot(home), "nemoclaw-openclaw");
    fs.symlinkSync(outside, target);

    expect(() => installBundledHarness("openclaw", environment)).toThrow(
      "must be a regular directory, not a symlink",
    );
  });

  it("does not replace a legacy receipt-managed package with local changes", () => {
    const home = temporaryHome();
    const environment = { HOME: home };
    const previous = writeInstalledPackage(home, "hermes", { version: "0.0.1" });
    fs.rmSync(path.join(previous, "policy-additions.yaml"));
    writeInstallReceipt(previous, packageDigest(previous));
    fs.writeFileSync(path.join(previous, "local-change.txt"), "preserve me\n");

    expect(() => installBundledHarness("hermes", environment)).toThrow(
      "differs from the bundled package and has local changes",
    );
    expect(fs.readFileSync(path.join(previous, "local-change.txt"), "utf8")).toBe("preserve me\n");
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

  it("restores the previous package when authority validation fails after moving it", () => {
    const home = temporaryHome();
    const environment = { HOME: home };
    const previous = writeInstalledPackage(home, "openclaw", { version: "0.0.1" });
    writeInstallReceipt(previous, packageDigest(previous));
    const target = path.resolve(previous);
    const stateRoot = path.resolve(home, ".nemoclaw");
    const renameSync = fs.renameSync.bind(fs);
    const lstatSync = fs.lstatSync.bind(fs);
    let rejectNextStateRootRead = false;
    const lstat = vi.spyOn(fs, "lstatSync").mockImplementation(((candidate, options) => {
      switch (rejectNextStateRootRead && path.resolve(candidate.toString()) === stateRoot) {
        case true: {
          rejectNextStateRootRead = false;
          const error = new Error("injected authority read failure") as NodeJS.ErrnoException;
          error.code = "ENOENT";
          throw error;
        }
        default:
          return lstatSync(candidate, options as never);
      }
    }) as typeof fs.lstatSync);
    const rename = vi.spyOn(fs, "renameSync").mockImplementation((source, destination) => {
      renameSync(source, destination);
      switch (
        path.resolve(source.toString()) === target &&
        path
          .basename(path.dirname(path.resolve(destination.toString())))
          .startsWith(".previous-openclaw-")
      ) {
        case true:
          rejectNextStateRootRead = true;
          break;
      }
    });

    try {
      expect(() => installBundledHarness("openclaw", environment)).toThrow(
        "Harness installation directory changed",
      );
    } finally {
      rename.mockRestore();
      lstat.mockRestore();
    }

    expect(JSON.parse(fs.readFileSync(path.join(target, "package.json"), "utf8"))).toEqual(
      expect.objectContaining({ version: "0.0.1" }),
    );
    expect(
      fs
        .readdirSync(installedRoot(home))
        .filter((name) => name.startsWith(".install-") || name.startsWith(".previous-")),
    ).toEqual([]);
  });

  it("restores the previous package when authority validation fails after publishing", () => {
    const home = temporaryHome();
    const environment = { HOME: home };
    const previous = writeInstalledPackage(home, "openclaw", { version: "0.0.1" });
    writeInstallReceipt(previous, packageDigest(previous));
    const target = path.resolve(previous);
    const stateRoot = path.resolve(home, ".nemoclaw");
    const renameSync = fs.renameSync.bind(fs);
    const lstatSync = fs.lstatSync.bind(fs);
    let rejectNextStateRootRead = false;
    const lstat = vi.spyOn(fs, "lstatSync").mockImplementation(((candidate, options) => {
      switch (rejectNextStateRootRead && path.resolve(candidate.toString()) === stateRoot) {
        case true: {
          rejectNextStateRootRead = false;
          const error = new Error("injected authority read failure") as NodeJS.ErrnoException;
          error.code = "ENOENT";
          throw error;
        }
        default:
          return lstatSync(candidate, options as never);
      }
    }) as typeof fs.lstatSync);
    const rename = vi.spyOn(fs, "renameSync").mockImplementation((source, destination) => {
      renameSync(source, destination);
      switch (
        path.resolve(destination.toString()) === target &&
        path
          .basename(path.dirname(path.resolve(source.toString())))
          .startsWith(".install-openclaw-")
      ) {
        case true:
          rejectNextStateRootRead = true;
          break;
      }
    });

    try {
      expect(() => installBundledHarness("openclaw", environment)).toThrow(
        "Harness installation directory changed",
      );
    } finally {
      rename.mockRestore();
      lstat.mockRestore();
    }

    expect(JSON.parse(fs.readFileSync(path.join(target, "package.json"), "utf8"))).toEqual(
      expect.objectContaining({ version: "0.0.1" }),
    );
    expect(
      fs
        .readdirSync(installedRoot(home))
        .filter((name) => name.startsWith(".install-") || name.startsWith(".previous-")),
    ).toEqual([]);
  });

  it("preserves an unknown target that replaces the published package during rollback", () => {
    const home = temporaryHome();
    const environment = { HOME: home };
    const previous = writeInstalledPackage(home, "openclaw", { version: "0.0.1" });
    writeInstallReceipt(previous, packageDigest(previous));
    const target = path.resolve(previous);
    const displacedPublished = path.join(home, "displaced-published-package");
    const sentinelSource = path.join(home, "outside-sentinel");
    const sentinelFile = path.join(sentinelSource, "preserve.txt");
    fs.mkdirSync(sentinelSource);
    fs.writeFileSync(sentinelFile, "do not delete\n");
    const renameSync = fs.renameSync.bind(fs);
    let substituted = false;
    const rename = vi.spyOn(fs, "renameSync").mockImplementation((source, destination) => {
      renameSync(source, destination);
      switch (
        !substituted &&
        path.resolve(destination.toString()) === target &&
        path.basename(path.dirname(path.resolve(source.toString()))).startsWith(".install-")
      ) {
        case true:
          substituted = true;
          renameSync(target, displacedPublished);
          renameSync(sentinelSource, target);
          break;
      }
    });

    try {
      expect(() => installBundledHarness("openclaw", environment)).toThrow(
        "the previous package remains at",
      );
    } finally {
      rename.mockRestore();
    }

    expect(fs.readFileSync(path.join(target, "preserve.txt"), "utf8")).toBe("do not delete\n");
    const previousDirectory = fs
      .readdirSync(installedRoot(home))
      .find((name) => name.startsWith(".previous-openclaw-"));
    expect(previousDirectory).toBeDefined();
    expect(
      JSON.parse(
        fs.readFileSync(
          path.join(installedRoot(home), previousDirectory!, "nemoclaw-openclaw", "package.json"),
          "utf8",
        ),
      ),
    ).toEqual(expect.objectContaining({ version: "0.0.1" }));
  });

  it("keeps the previous package when the published target changes before cleanup", () => {
    const home = temporaryHome();
    const environment = { HOME: home };
    const previous = writeInstalledPackage(home, "openclaw", { version: "0.0.1" });
    writeInstallReceipt(previous, packageDigest(previous));
    const target = path.resolve(previous);
    const receipt = path.join(target, ".nemoclaw-install.json");
    const displacedPublished = path.join(home, "late-displaced-published-package");
    const sentinelSource = path.join(home, "late-outside-sentinel");
    fs.mkdirSync(sentinelSource);
    fs.writeFileSync(path.join(sentinelSource, "preserve.txt"), "do not delete\n");
    const renameSync = fs.renameSync.bind(fs);
    const openSync = fs.openSync.bind(fs);
    const closeSync = fs.closeSync.bind(fs);
    let published = false;
    let publishedReceiptDescriptor: number | null = null;
    const rename = vi.spyOn(fs, "renameSync").mockImplementation((source, destination) => {
      renameSync(source, destination);
      switch (
        path.resolve(destination.toString()) === target &&
        path.basename(path.dirname(path.resolve(source.toString()))).startsWith(".install-")
      ) {
        case true:
          published = true;
          break;
      }
    });
    const open = vi.spyOn(fs, "openSync").mockImplementation((candidate, flags, mode) => {
      const descriptor = openSync(candidate, flags, mode);
      switch (published && path.resolve(candidate.toString()) === receipt) {
        case true:
          publishedReceiptDescriptor = descriptor;
          break;
      }
      return descriptor;
    });
    const close = vi.spyOn(fs, "closeSync").mockImplementation((descriptor) => {
      closeSync(descriptor);
      switch (descriptor === publishedReceiptDescriptor) {
        case true:
          publishedReceiptDescriptor = null;
          published = false;
          renameSync(target, displacedPublished);
          renameSync(sentinelSource, target);
          break;
      }
    });

    try {
      expect(() => installBundledHarness("openclaw", environment)).toThrow(
        "changed before update cleanup",
      );
    } finally {
      close.mockRestore();
      open.mockRestore();
      rename.mockRestore();
    }

    expect(fs.readFileSync(path.join(target, "preserve.txt"), "utf8")).toBe("do not delete\n");
    expect(
      fs.readdirSync(installedRoot(home)).some((name) => name.startsWith(".previous-openclaw-")),
    ).toBe(true);
  });

  it("keeps the previous package when its backup directory is replaced", () => {
    const home = temporaryHome();
    const environment = { HOME: home };
    const previous = writeInstalledPackage(home, "openclaw", { version: "0.0.1" });
    writeInstallReceipt(previous, packageDigest(previous));
    const outside = path.join(home, "outside-previous-root");
    fs.mkdirSync(outside, { mode: 0o755 });
    fs.chmodSync(outside, 0o755);
    const openSync = fs.openSync.bind(fs);
    const closeSync = fs.closeSync.bind(fs);
    let previousDescriptor: number | null = null;
    let previousDirectory = "";
    const open = vi.spyOn(fs, "openSync").mockImplementation((candidate, flags, mode) => {
      const descriptor = openSync(candidate, flags, mode);
      switch (path.basename(candidate.toString()).startsWith(".previous-openclaw-")) {
        case true:
          previousDescriptor = descriptor;
          previousDirectory = candidate.toString();
          break;
      }
      return descriptor;
    });
    const close = vi.spyOn(fs, "closeSync").mockImplementation((descriptor) => {
      closeSync(descriptor);
      switch (descriptor === previousDescriptor) {
        case true:
          previousDescriptor = null;
          fs.renameSync(previousDirectory, `${previousDirectory}.moved`);
          fs.symlinkSync(outside, previousDirectory);
          break;
      }
    });

    try {
      expect(() => installBundledHarness("openclaw", environment)).toThrow(
        "Harness installation directory changed",
      );
    } finally {
      close.mockRestore();
      open.mockRestore();
    }

    expect(JSON.parse(fs.readFileSync(path.join(previous, "package.json"), "utf8"))).toEqual(
      expect.objectContaining({ version: "0.0.1" }),
    );
    expect(fs.statSync(outside).mode & 0o777).toBe(0o755);
    expect(fs.readdirSync(outside)).toEqual([]);
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

  it("rejects a changed installed package without overwriting it", () => {
    const home = temporaryHome();
    const environment = { HOME: home };
    const installed = installBundledHarness("hermes", environment);
    fs.writeFileSync(path.join(installed.rootDir, "local-change.txt"), "preserve me\n");

    expect(() => resolveHarnessPackage("hermes", environment)).toThrow(
      "installation receipt does not match package content",
    );

    expect(() => installBundledHarness("hermes", environment)).toThrow(
      "differs from the bundled package and has local changes",
    );
    expect(fs.readFileSync(path.join(installed.rootDir, "local-change.txt"), "utf8")).toBe(
      "preserve me\n",
    );
  });

  it("does not replace a receipt-managed package with the wrong identity", () => {
    const home = temporaryHome();
    const environment = { HOME: home };
    const previous = writeInstalledPackage(home, "other", {
      directoryId: "openclaw",
      version: "0.0.1",
    });
    writeInstallReceipt(previous, packageDigest(previous));

    expect(() => installBundledHarness("openclaw", environment)).toThrow("identity mismatch");
    expect(JSON.parse(fs.readFileSync(path.join(previous, "package.json"), "utf8"))).toEqual(
      expect.objectContaining({ version: "0.0.1" }),
    );
  });

  it("refreshes every clean installed package still bundled by NemoClaw", () => {
    const home = temporaryHome();
    const environment = { HOME: home };
    const oldOpenClaw = writeInstalledPackage(home, "openclaw", { version: "0.0.1" });
    const oldHermes = writeInstalledPackage(home, "hermes", { version: "0.0.1" });
    writeInstallReceipt(oldOpenClaw, packageDigest(oldOpenClaw));
    writeInstallReceipt(oldHermes, packageDigest(oldHermes));
    const external = writeInstalledPackage(home, "external-harness");

    const refreshed = refreshInstalledBundledHarnesses(environment);

    expect(refreshed.map((entry) => entry.id)).toEqual(["hermes", "openclaw"]);
    expect(refreshed.every((entry) => entry.version === "0.1.0")).toBe(true);
    expect(fs.existsSync(external)).toBe(true);
    expect(resolveHarnessPackage("external-harness", environment)?.source).toBe("installed");
  });

  it("excludes the selected package from an installer refresh", () => {
    const home = temporaryHome();
    const environment = { HOME: home };
    installBundledHarness("openclaw", environment);

    expect(refreshInstalledBundledHarnesses(environment, "openclaw")).toEqual([]);
  });

  it("rejects all refreshes before replacing any package with a later local change", () => {
    const home = temporaryHome();
    const environment = { HOME: home };
    const oldHermes = writeInstalledPackage(home, "hermes", { version: "0.0.1" });
    const oldOpenClaw = writeInstalledPackage(home, "openclaw", { version: "0.0.1" });
    writeInstallReceipt(oldHermes, packageDigest(oldHermes));
    writeInstallReceipt(oldOpenClaw, packageDigest(oldOpenClaw));
    fs.writeFileSync(path.join(oldOpenClaw, "local-change.txt"), "preserve me\n");

    expect(() => refreshInstalledBundledHarnesses(environment)).toThrow("local changes");
    expect(JSON.parse(fs.readFileSync(path.join(oldHermes, "package.json"), "utf8"))).toEqual(
      expect.objectContaining({ version: "0.0.1" }),
    );
  });

  it("refuses to refresh a receipt-managed package with local changes", () => {
    const home = temporaryHome();
    const environment = { HOME: home };
    const installed = installBundledHarness("hermes", environment);
    fs.writeFileSync(path.join(installed.rootDir, "local-change.txt"), "preserve me\n");

    expect(() => refreshInstalledBundledHarnesses(environment)).toThrow(
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
