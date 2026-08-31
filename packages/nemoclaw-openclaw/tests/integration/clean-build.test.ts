// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect, it } from "vitest";

import { testTimeout } from "../../../../test/helpers/timeouts";

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, "../../../..");

it(
  "builds the OpenClaw plugin from source without generated output",
  () => {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-clean-build-"));
    const stagedRepository = path.join(temporaryRoot, "repository");
    const sourcePlugin = path.join(REPOSITORY_ROOT, "packages", "nemoclaw-openclaw", "plugin");
    const stagedPlugin = path.join(stagedRepository, "packages", "nemoclaw-openclaw", "plugin");
    try {
      fs.cpSync(sourcePlugin, stagedPlugin, {
        recursive: true,
        filter: (source) => !["dist", "node_modules"].includes(path.basename(source)),
      });
      fs.symlinkSync(
        path.join(sourcePlugin, "node_modules"),
        path.join(stagedPlugin, "node_modules"),
        process.platform === "win32" ? "junction" : "dir",
      );

      const result = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "build"], {
        cwd: stagedPlugin,
        encoding: "utf8",
        env: process.env,
        timeout: testTimeout(60_000),
      });

      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(fs.statSync(path.join(stagedPlugin, "dist", "index.js")).isFile()).toBe(true);
      expect(
        fs
          .statSync(path.join(stagedPlugin, "dist", "shared", "openshell-policy-boundary.cjs"))
          .isFile(),
      ).toBe(true);
    } finally {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  },
  testTimeout(60_000),
);
