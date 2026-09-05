// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { HarnessPackageBuildError, materializeHarnessPackageArtifact } from "./build-package.mts";
import { HarnessPackageConformanceError } from "./validate-package.mts";

const CONTRACT_ROOT = path.dirname(fileURLToPath(import.meta.url));
const REQUIRED_FILES = [
  "Dockerfile.base",
  "Dockerfile",
  "manifest.yaml",
  "policy-additions.yaml",
  "start.sh",
] as const;

interface PackageFixture {
  readonly root: string;
  readonly packageRoot: string;
  readonly outputRoot: string;
  readonly scriptMarker: string;
}

function writeFile(root: string, relativePath: string, contents: string, mode = 0o644): void {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents, { mode });
}

function createPackageFixture(additionalFiles: readonly string[] = []): PackageFixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-package-build-"));
  const packageRoot = path.join(root, "nemoclaw-future-shell");
  const outputRoot = path.join(root, "artifact");
  const scriptMarker = path.join(root, "package-script-ran");
  fs.mkdirSync(packageRoot);
  writeFile(
    packageRoot,
    "package.json",
    `${JSON.stringify(
      {
        name: "@example/nemoclaw-future-shell",
        version: "4.5.6",
        scripts: { prepack: `node -e "require('fs').writeFileSync('${scriptMarker}', 'ran')"` },
        files: [...REQUIRED_FILES, "host/*-adapter.cts", ...additionalFiles],
        nemoclaw: {
          harnessManifest: "manifest.yaml",
          minimumNemoClawVersion: "0.0.113",
        },
      },
      null,
      2,
    )}\n`,
  );
  writeFile(packageRoot, "Dockerfile.base", "FROM scratch\n");
  writeFile(packageRoot, "Dockerfile", "FROM scratch\n");
  writeFile(
    packageRoot,
    "manifest.yaml",
    [
      "name: future-shell",
      'display_name: "Future Shell"',
      "runtime:",
      "  kind: terminal",
      "  prompt_transport: stdin",
      "mcp:",
      "  support: disabled",
      "",
    ].join("\n"),
  );
  writeFile(packageRoot, "policy-additions.yaml", "network_policies: []\n");
  writeFile(packageRoot, "start.sh", "#!/bin/sh\nexec sleep infinity\n", 0o755);
  writeFile(
    packageRoot,
    "host/config-adapter.cts",
    '"use strict";\nmodule.exports = Object.freeze({});\n',
  );
  writeFile(packageRoot, "tests/should-not-publish.txt", "authoring only\n");
  return Object.freeze({ root, packageRoot, outputRoot, scriptMarker });
}

function makeTreeWritable(root: string): void {
  if (!fs.existsSync(root)) return;
  const stats = fs.lstatSync(root);
  if (stats.isSymbolicLink() || !stats.isDirectory()) return;
  fs.chmodSync(root, 0o700);
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      makeTreeWritable(path.join(root, entry.name));
    }
  }
}

function removeFixture(fixture: PackageFixture): void {
  makeTreeWritable(fixture.outputRoot);
  fs.rmSync(fixture.root, { recursive: true, force: true });
}

function fileMode(target: string): number {
  return fs.lstatSync(target).mode & 0o777;
}

test("materializes a synthetic publish set as one read-only NemoClaw artifact", () => {
  const fixture = createPackageFixture();
  try {
    const result = materializeHarnessPackageArtifact(fixture.packageRoot, fixture.outputRoot);
    assert.deepEqual(result, {
      harnessId: "future-shell",
      displayName: "Future Shell",
      packageVersion: "4.5.6",
      minimumNemoClawVersion: "0.0.113",
      manifestPath: "manifest.yaml",
      fileCount: 8,
      readOnly: true,
    });
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(fixture.outputRoot, "nemoclaw-package.json"), "utf8")),
      {
        schemaVersion: 1,
        kind: "agent-runtime",
        id: "future-shell",
        displayName: "Future Shell",
        packageVersion: "4.5.6",
        minimumNemoClawVersion: "0.0.113",
        manifest: "manifest.yaml",
      },
    );
    assert.equal(
      fs.readFileSync(path.join(fixture.outputRoot, "manifest.yaml"), "utf8"),
      fs.readFileSync(path.join(fixture.packageRoot, "manifest.yaml"), "utf8"),
    );
    assert.equal(fs.existsSync(path.join(fixture.outputRoot, "tests")), false);
    assert.equal(fs.existsSync(fixture.scriptMarker), false);
    assert.equal(fileMode(fixture.outputRoot), 0o555);
    assert.equal(fileMode(path.join(fixture.outputRoot, "host")), 0o555);
    assert.equal(fileMode(path.join(fixture.outputRoot, "start.sh")), 0o555);
    assert.equal(fileMode(path.join(fixture.outputRoot, "manifest.yaml")), 0o444);
    assert.equal(fileMode(path.join(fixture.outputRoot, "nemoclaw-package.json")), 0o444);
  } finally {
    removeFixture(fixture);
  }
});

test("the package builder binary writes one absent output and reports JSON", () => {
  const fixture = createPackageFixture();
  try {
    const result = spawnSync(
      process.execPath,
      [
        path.join(CONTRACT_ROOT, "build-package.mts"),
        "--json",
        fixture.packageRoot,
        fixture.outputRoot,
      ],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      harnessId: "future-shell",
      displayName: "Future Shell",
      packageVersion: "4.5.6",
      minimumNemoClawVersion: "0.0.113",
      manifestPath: "manifest.yaml",
      fileCount: 8,
      readOnly: true,
    });
    assert.equal(fs.existsSync(path.join(fixture.outputRoot, "nemoclaw-package.json")), true);
  } finally {
    removeFixture(fixture);
  }
});

test("refuses an existing output without changing its files", async (t) => {
  await t.test("an existing directory", () => {
    const fixture = createPackageFixture();
    try {
      fs.mkdirSync(fixture.outputRoot);
      writeFile(fixture.outputRoot, "sentinel.txt", "keep\n");
      assert.throws(
        () => materializeHarnessPackageArtifact(fixture.packageRoot, fixture.outputRoot),
        (error) =>
          error instanceof HarnessPackageBuildError && error.diagnostic.code === "output-exists",
      );
      assert.equal(
        fs.readFileSync(path.join(fixture.outputRoot, "sentinel.txt"), "utf8"),
        "keep\n",
      );
    } finally {
      removeFixture(fixture);
    }
  });
  await t.test("a dangling symbolic link", () => {
    const fixture = createPackageFixture();
    try {
      fs.symlinkSync("missing-target", fixture.outputRoot);
      assert.throws(
        () => materializeHarnessPackageArtifact(fixture.packageRoot, fixture.outputRoot),
        (error) =>
          error instanceof HarnessPackageBuildError && error.diagnostic.code === "output-exists",
      );
      assert.equal(fs.readlinkSync(fixture.outputRoot), "missing-target");
    } finally {
      removeFixture(fixture);
    }
  });
});

test("leaves no output when package conformance fails", () => {
  const fixture = createPackageFixture();
  try {
    fs.chmodSync(path.join(fixture.packageRoot, "start.sh"), 0o644);
    assert.throws(
      () => materializeHarnessPackageArtifact(fixture.packageRoot, fixture.outputRoot),
      HarnessPackageConformanceError,
    );
    assert.equal(fs.existsSync(fixture.outputRoot), false);
  } finally {
    removeFixture(fixture);
  }
});

test("rejects an output nested inside the package before validation or writes", () => {
  const fixture = createPackageFixture();
  const nestedOutput = path.join(fixture.packageRoot, "artifact");
  try {
    assert.throws(
      () => materializeHarnessPackageArtifact(fixture.packageRoot, nestedOutput),
      (error) =>
        error instanceof HarnessPackageBuildError && error.diagnostic.code === "output-path",
    );
    assert.equal(fs.existsSync(nestedOutput), false);
  } finally {
    removeFixture(fixture);
  }
});

test("rejects a package that attempts to publish its own NemoClaw envelope", () => {
  const fixture = createPackageFixture(["nemoclaw-package.json"]);
  try {
    writeFile(fixture.packageRoot, "nemoclaw-package.json", '{"id":"spoofed"}\n');
    assert.throws(
      () => materializeHarnessPackageArtifact(fixture.packageRoot, fixture.outputRoot),
      (error) =>
        error instanceof HarnessPackageConformanceError &&
        error.diagnostics[0]?.code === "archive-authoring-path" &&
        error.diagnostics[0]?.path === "nemoclaw-package.json",
    );
    assert.equal(fs.existsSync(fixture.outputRoot), false);
  } finally {
    removeFixture(fixture);
  }
});

test("rejects a linked runtime file without creating the output", () => {
  const fixture = createPackageFixture();
  try {
    fs.rmSync(path.join(fixture.packageRoot, "Dockerfile"));
    fs.symlinkSync("Dockerfile.base", path.join(fixture.packageRoot, "Dockerfile"));
    assert.throws(
      () => materializeHarnessPackageArtifact(fixture.packageRoot, fixture.outputRoot),
      HarnessPackageConformanceError,
    );
    assert.equal(fs.existsSync(fixture.outputRoot), false);
  } finally {
    removeFixture(fixture);
  }
});

test("the contract archive contains executable builder binaries but no contract tests", () => {
  const result = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts", "."], {
    cwd: CONTRACT_ROOT,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const packed = JSON.parse(result.stdout) as Array<{
    readonly files?: ReadonlyArray<{ readonly path?: unknown; readonly mode?: unknown }>;
  }>;
  const files = packed[0]?.files ?? [];
  const modes = new Map(files.map((file) => [file.path, file.mode]));
  assert.equal(modes.get("build-adapters.mts"), 0o755);
  assert.equal(modes.get("validate-package.mts"), 0o755);
  assert.equal(modes.get("build-package.mts"), 0o755);
  assert.equal(modes.has("README.md"), true);
  assert.equal(
    files.some((file) => String(file.path).endsWith(".test.mts")),
    false,
  );
});

test("rejects unsupported builder options without reading package files", () => {
  const result = spawnSync(
    process.execPath,
    [path.join(CONTRACT_ROOT, "build-package.mts"), "--replace", ".", "artifact"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
  assert.equal(
    result.stderr,
    "Usage: nemoclaw-build-package [--json] <package-root> <output-directory>\n",
  );
});
