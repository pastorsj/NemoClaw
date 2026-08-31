// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll } from "vitest";

// Hermes fixtures exercise permission guards that expect the conventional CI
// file-creation baseline. Restore the caller's umask after each test file so
// this package-owned setup does not leak process state into later suites.
const originalUmask = process.umask(0o022);
const originalHome = process.env.HOME;
const isolatedHome = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "hermes-home-"));
fs.chmodSync(isolatedHome, 0o700);
process.env.HOME = isolatedHome;

afterAll(() => {
  process.umask(originalUmask);
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
  fs.rmSync(isolatedHome, { force: true, recursive: true });
});
