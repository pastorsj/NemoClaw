// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { installHarnessPackage } from "../../../../src/lib/agent-runtime/package/install";
import type { BundledHarnessPackageSourceIdentity } from "../../../../src/lib/agent-runtime/package/receipt";
import {
  getHarnessPackageStoreRoot,
  type InstalledHarnessPackage,
} from "../../../../src/lib/agent-runtime/package/store";
import { materializeBundledHarnesses } from "../../../../scripts/build-harnesses.mts";

const SOURCE_IDENTITY: BundledHarnessPackageSourceIdentity = Object.freeze({
  kind: "bundled",
  nemoclawBuildIdentity: Object.freeze({
    nemoclawVersion: "0.0.113",
    sourceRevision: "d".repeat(40),
  }),
});

function makeDirectoriesWritable(root: string): void {
  if (!fs.existsSync(root)) return;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      makeDirectoriesWritable(path.join(root, entry.name));
    }
  }
  fs.chmodSync(root, 0o700);
}

/** Build and install the reviewed Hermes artifact through NemoClaw's generic package store. */
export function installHermesPackage(home: string): InstalledHarnessPackage {
  const temporary = fs.mkdtempSync(
    path.join(fs.realpathSync.native(os.tmpdir()), "nemoclaw-hermes-artifact-"),
  );
  const outputRoot = path.join(temporary, "harnesses");
  try {
    const artifact = materializeBundledHarnesses(outputRoot).find(({ id }) => id === "hermes");
    if (!artifact) throw new Error("Hermes package artifact was not materialized");
    return installHarnessPackage(
      { packageRoot: artifact.packageRoot, sourceIdentity: SOURCE_IDENTITY },
      { storeRoot: getHarnessPackageStoreRoot(home) },
    );
  } finally {
    makeDirectoriesWritable(outputRoot);
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}
