// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildHarnessAdapterArtifacts } from "./build-adapters.mts";

const PACKAGE_ROOT = path.dirname(fileURLToPath(import.meta.url));

test("the npm binary rejects a stale generated adapter", () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-adapter-bin-"));
  try {
    fs.mkdirSync(path.join(fixtureRoot, "host/source"), { recursive: true });
    fs.mkdirSync(path.join(fixtureRoot, "node_modules/.bin"), { recursive: true });
    fs.symlinkSync(
      path.join(PACKAGE_ROOT, "build-adapters.mts"),
      path.join(fixtureRoot, "node_modules/.bin/nemoclaw-build-adapters"),
    );
    fs.symlinkSync(
      path.join(path.dirname(PACKAGE_ROOT), "node_modules/typescript"),
      path.join(fixtureRoot, "node_modules/typescript"),
      "dir",
    );
    fs.writeFileSync(
      path.join(fixtureRoot, "package.json"),
      JSON.stringify({
        private: true,
        scripts: {
          build: "nemoclaw-build-adapters .",
          check: "nemoclaw-build-adapters . --check",
        },
      }),
    );
    fs.writeFileSync(
      path.join(fixtureRoot, "host/source/config-adapter.cts"),
      [
        "// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.",
        "// SPDX-License-Identifier: Apache-2.0",
        "",
        "const adapter = {};",
        "export = adapter;",
        "",
      ].join("\n"),
    );
    fs.writeFileSync(path.join(fixtureRoot, "host/config-adapter.cts"), "stale\n");

    const stale = spawnSync("npm", ["run", "check"], {
      cwd: fixtureRoot,
      encoding: "utf8",
    });
    assert.notEqual(stale.status, 0);
    assert.match(`${stale.stdout}\n${stale.stderr}`, /host\/config-adapter\.cts is stale/u);

    const build = spawnSync("npm", ["run", "build"], {
      cwd: fixtureRoot,
      encoding: "utf8",
    });
    assert.equal(build.status, 0, `${build.stdout}\n${build.stderr}`);

    const current = spawnSync("npm", ["run", "check"], {
      cwd: fixtureRoot,
      encoding: "utf8",
    });
    assert.equal(current.status, 0, `${current.stdout}\n${current.stderr}`);
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("adapter command strings may mention require without importing host code", () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-adapter-string-"));
  try {
    fs.mkdirSync(path.join(fixtureRoot, "host/source"), { recursive: true });
    fs.mkdirSync(path.join(fixtureRoot, "node_modules"), { recursive: true });
    fs.symlinkSync(
      path.join(PACKAGE_ROOT, "../node_modules/typescript"),
      path.join(fixtureRoot, "node_modules/typescript"),
      "dir",
    );
    fs.writeFileSync(
      path.join(fixtureRoot, "host/source/config-adapter.cts"),
      [
        "// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.",
        "// SPDX-License-Identifier: Apache-2.0",
        "",
        "const adapter = { runner: 'require(\\\"node:child_process\\\")' };",
        "export = adapter;",
        "",
      ].join("\n"),
    );

    assert.doesNotThrow(() => buildHarnessAdapterArtifacts(fixtureRoot));
    const artifact = fs.readFileSync(path.join(fixtureRoot, "host/config-adapter.cts"), "utf8");
    assert.ok(artifact.includes("require("));
    assert.ok(artifact.includes("node:child_process"));
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("adapter artifacts still reject runtime imports", () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-adapter-import-"));
  try {
    fs.mkdirSync(path.join(fixtureRoot, "host/source"), { recursive: true });
    fs.mkdirSync(path.join(fixtureRoot, "node_modules"), { recursive: true });
    fs.symlinkSync(
      path.join(PACKAGE_ROOT, "../node_modules/typescript"),
      path.join(fixtureRoot, "node_modules/typescript"),
      "dir",
    );
    fs.writeFileSync(
      path.join(fixtureRoot, "host/source/config-adapter.cts"),
      [
        "// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.",
        "// SPDX-License-Identifier: Apache-2.0",
        "",
        "declare function require(id: string): unknown;",
        'const adapter = { dependency: require("runtime-dependency") };',
        "export = adapter;",
        "",
      ].join("\n"),
    );

    assert.throws(
      () => buildHarnessAdapterArtifacts(fixtureRoot),
      /did not compile to one self-contained CommonJS module/u,
    );
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
