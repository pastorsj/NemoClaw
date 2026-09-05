// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

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
