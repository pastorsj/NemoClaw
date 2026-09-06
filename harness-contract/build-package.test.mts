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
          maximumNemoClawVersionExclusive: "0.0.121",
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
      "  headless_command: future-shell --prompt",
      "config:",
      "  dir: /sandbox/.future-shell",
      "  config_file: config.json",
      "  format: json",
      "inference:",
      "  config_update:",
      "    support: unsupported",
      "    reason: This synthetic package has fixed inference configuration.",
      "state_lifecycle:",
      "  backup_quiescence:",
      "    kind: not-required",
      "  snapshot_restore: []",
      "  rebuild:",
      "    image_plugin_provenance: not-required",
      "    scheduled_work:",
      "      support: disabled",
      "      reason: This package does not run scheduled work.",
      "    post_restore:",
      "      kind: not-required",
      "mcp:",
      "  support: disabled",
      "messaging:",
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
  writeFile(
    packageRoot,
    "host/messaging-adapter.cts",
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
      maximumNemoClawVersionExclusive: "0.0.121",
      manifestPath: "manifest.yaml",
      fileCount: 9,
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
        maximumNemoClawVersionExclusive: "0.0.121",
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
      maximumNemoClawVersionExclusive: "0.0.121",
      manifestPath: "manifest.yaml",
      fileCount: 9,
      readOnly: true,
    });
    assert.equal(fs.existsSync(path.join(fixture.outputRoot, "nemoclaw-package.json")), true);
  } finally {
    removeFixture(fixture);
  }
});

test("the package builder CLI creates one requested parent without weakening the API", () => {
  const fixture = createPackageFixture();
  const outputRoot = path.join(fixture.root, "dist", "future-shell");
  try {
    assert.throws(
      () => materializeHarnessPackageArtifact(fixture.packageRoot, outputRoot),
      (error) =>
        error instanceof HarnessPackageBuildError && error.diagnostic.code === "output-path",
    );
    assert.equal(fs.existsSync(path.dirname(outputRoot)), false);

    const nestedOutputRoot = path.join(fixture.root, "nested", "dist", "future-shell");
    const nested = spawnSync(
      process.execPath,
      [
        path.join(CONTRACT_ROOT, "build-package.mts"),
        "--create-output-parent",
        fixture.packageRoot,
        nestedOutputRoot,
      ],
      { encoding: "utf8" },
    );
    assert.equal(nested.status, 1);
    assert.match(nested.stderr, /could not be created safely/u);
    assert.equal(fs.existsSync(path.join(fixture.root, "nested")), false);

    const first = spawnSync(
      process.execPath,
      [
        path.join(CONTRACT_ROOT, "build-package.mts"),
        "--create-output-parent",
        fixture.packageRoot,
        outputRoot,
      ],
      { encoding: "utf8" },
    );
    assert.equal(first.status, 0, first.stderr);
    const envelope = fs.readFileSync(path.join(outputRoot, "nemoclaw-package.json"), "utf8");

    const second = spawnSync(
      process.execPath,
      [
        path.join(CONTRACT_ROOT, "build-package.mts"),
        "--create-output-parent",
        fixture.packageRoot,
        outputRoot,
      ],
      { encoding: "utf8" },
    );
    assert.equal(second.status, 1);
    assert.match(second.stderr, /must not already exist/u);
    assert.equal(fs.readFileSync(path.join(outputRoot, "nemoclaw-package.json"), "utf8"), envelope);
  } finally {
    makeTreeWritable(outputRoot);
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

test("rejects same-size source bytes replaced after validation", (t) => {
  const fixture = createPackageFixture();
  const originalMkdirSync = fs.mkdirSync.bind(fs);
  let replaced = false;
  t.mock.method(
    fs,
    "mkdirSync",
    (target: fs.PathLike, options?: fs.MakeDirectoryOptions | number) => {
      const result = Reflect.apply(originalMkdirSync, fs, [target, options]) as string | undefined;
      if (!replaced && path.resolve(target.toString()) === fixture.outputRoot) {
        replaced = true;
        fs.writeFileSync(path.join(fixture.packageRoot, "Dockerfile"), "EVIL scratch\n");
      }
      return result;
    },
  );
  try {
    assert.throws(
      () => materializeHarnessPackageArtifact(fixture.packageRoot, fixture.outputRoot),
      (error) =>
        error instanceof HarnessPackageBuildError && error.diagnostic.code === "source-changed",
    );
    assert.equal(replaced, true);
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

test("the prepared contract archive contains executable builder binaries but no contract tests", () => {
  const result = spawnSync("npm", ["pack", "--dry-run", "--json", "--silent", "."], {
    cwd: CONTRACT_ROOT,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const packed = JSON.parse(result.stdout) as Array<{
    readonly files?: ReadonlyArray<{ readonly path?: unknown; readonly mode?: unknown }>;
  }>;
  const files = packed[0]?.files ?? [];
  const modes = new Map(files.map((file) => [file.path, file.mode]));
  assert.equal(modes.get("dist/build-adapters.mjs"), 0o755);
  assert.equal(modes.get("dist/validate-package.mjs"), 0o755);
  assert.equal(modes.get("dist/build-package.mjs"), 0o755);
  assert.equal(modes.get("dist/materialize-runtime.mjs"), 0o755);
  assert.equal(modes.get("runtime/gateway-runtime.py"), 0o755);
  assert.equal(modes.get("runtime/messaging-build.mts"), 0o755);
  assert.equal(modes.has("README.md"), true);
  assert.equal(modes.has("build-adapters.d.mts"), true);
  assert.equal(modes.has("build-package.d.mts"), true);
  assert.equal(
    files.some(
      (file) =>
        String(file.path).endsWith(".mts") &&
        !String(file.path).endsWith(".d.mts") &&
        file.path !== "runtime/messaging-build.mts",
    ),
    false,
  );
  assert.equal(
    files.some((file) => String(file.path).includes(".test.")),
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
    "Usage: nemoclaw-build-package [--json] [--create-output-parent] <package-root> <output-directory>\n",
  );
});
