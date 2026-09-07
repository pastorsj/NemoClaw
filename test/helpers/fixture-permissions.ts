// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

/** Make a copied package fixture removable even after permission-hardening tests. */
export function makeFixtureDirectoriesWritable(directory: string): void {
  if (!fs.existsSync(directory)) return;
  const metadata = fs.lstatSync(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) return;
  fs.chmodSync(directory, 0o700);
  for (const entry of fs.readdirSync(directory)) {
    makeFixtureDirectoriesWritable(path.join(directory, entry));
  }
}

/** Remove temporary build contexts and hardened fixture trees after a test. */
export function removeFixtureDirectories(directories: readonly (string | null)[]): void {
  for (const directory of directories) {
    if (!directory) continue;
    if (!path.basename(directory).startsWith("nemoclaw-build-")) {
      makeFixtureDirectoriesWritable(directory);
    }
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
