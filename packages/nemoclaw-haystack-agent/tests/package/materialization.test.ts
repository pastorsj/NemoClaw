// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { materializeHarnessPackageArtifact } from "@nvidia/nemoclaw-harness-contract/build-package";
import { expect, it } from "vitest";

const PACKAGE_ROOT = path.resolve(import.meta.dirname, "../..");

it("materializes the Haystack publish set through the public harness contract", () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-haystack-package-"));
  const artifactRoot = path.join(temporaryRoot, "artifact");
  try {
    expect(materializeHarnessPackageArtifact(PACKAGE_ROOT, artifactRoot)).toMatchObject({
      harnessId: "haystack-agent",
      displayName: "Haystack Agent (experimental)",
      packageVersion: "0.1.0",
      minimumNemoClawVersion: "0.0.113",
      maximumNemoClawVersionExclusive: "0.2.0",
      readOnly: true,
    });
    expect(
      JSON.parse(fs.readFileSync(path.join(artifactRoot, "nemoclaw-package.json"), "utf8")),
    ).toEqual({
      schemaVersion: 1,
      kind: "agent-runtime",
      id: "haystack-agent",
      displayName: "Haystack Agent (experimental)",
      packageVersion: "0.1.0",
      minimumNemoClawVersion: "0.0.113",
      maximumNemoClawVersionExclusive: "0.2.0",
      manifest: "manifest.yaml",
    });
    expect(
      fs.existsSync(path.join(artifactRoot, "fabric/haystack-agent.fabric-adapter.json")),
    ).toBe(true);
    expect(fs.existsSync(path.join(artifactRoot, "host/startup-adapter.cts"))).toBe(true);
    expect(fs.existsSync(path.join(artifactRoot, "tests"))).toBe(false);
    expect(fs.statSync(artifactRoot).mode & 0o777).toBe(0o555);
    expect(fs.statSync(path.join(artifactRoot, "start.sh")).mode & 0o111).not.toBe(0);
  } finally {
    if (fs.existsSync(artifactRoot)) execFileSync("chmod", ["-R", "u+w", artifactRoot]);
    fs.rmSync(temporaryRoot, { force: true, recursive: true });
  }
});
