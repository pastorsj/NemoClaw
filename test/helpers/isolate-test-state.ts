// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { afterAll } from "vitest";

const tempRoot = process.env.TMPDIR;
if (!tempRoot || !path.isAbsolute(tempRoot)) {
  throw new Error("Vitest state isolation requires the shared absolute temporary root");
}
const canonicalTempRoot = fs.realpathSync(tempRoot);

const previousStateDir = process.env.NEMOCLAW_TEST_STATE_DIR;
const previousBaseHome = process.env.NEMOCLAW_TEST_BASE_HOME;
const previousHome = process.env.HOME;
process.env.HOME = fs.mkdtempSync(path.join(canonicalTempRoot, `home-${process.pid}-`), {
  encoding: "utf8",
});
fs.chmodSync(process.env.HOME, 0o700);
process.env.NEMOCLAW_TEST_BASE_HOME = process.env.HOME;
process.env.NEMOCLAW_TEST_STATE_DIR = fs.mkdtempSync(
  path.join(canonicalTempRoot, `state-${process.pid}-`),
  {
    encoding: "utf8",
  },
);
fs.chmodSync(process.env.NEMOCLAW_TEST_STATE_DIR, 0o700);

afterAll(() => {
  if (previousHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = previousHome;
  }
  if (previousBaseHome === undefined) {
    delete process.env.NEMOCLAW_TEST_BASE_HOME;
  } else {
    process.env.NEMOCLAW_TEST_BASE_HOME = previousBaseHome;
  }
  if (previousStateDir === undefined) {
    delete process.env.NEMOCLAW_TEST_STATE_DIR;
  } else {
    process.env.NEMOCLAW_TEST_STATE_DIR = previousStateDir;
  }
});
