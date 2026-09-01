// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import path from "node:path";

import { describe, expect, it } from "vitest";

const PACKAGE_ROOT = path.resolve(import.meta.dirname, "../..");

describe("Pi package shell entry points", () => {
  it.each(["start.sh", "runtime/generate-config.sh"])(
    "parses %s before the image installs it",
    (relativePath) => {
      const result = spawnSync("bash", ["-n", path.join(PACKAGE_ROOT, relativePath)], {
        cwd: PACKAGE_ROOT,
        encoding: "utf8",
        env: { PATH: process.env.PATH ?? "" },
      });
      expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    },
  );
});
