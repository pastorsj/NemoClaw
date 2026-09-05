// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  assertHarnessAdapterArtifactsCurrent,
  buildHarnessAdapterArtifacts,
} from "@nvidia/nemoclaw-harness-contract/build-adapters";

const PACKAGE_ROOT = path.resolve(import.meta.dirname, "../..");

describe("OpenClaw host adapter build", () => {
  it("keeps the checked-in runtime artifact synchronized with typed source", () => {
    expect(() => assertHarnessAdapterArtifactsCurrent(PACKAGE_ROOT)).not.toThrow();

    const artifact = fs.readFileSync(path.join(PACKAGE_ROOT, "host/config-adapter.cts"), "utf8");
    expect(artifact.startsWith("// SPDX-FileCopyrightText:")).toBe(true);
    expect(artifact).toContain("module.exports = configAdapter;");
    expect(artifact).not.toMatch(/\brequire\s*\(/u);
  });

  it("rejects a stale generated artifact", () => {
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-adapter-build-"));
    try {
      fs.mkdirSync(path.join(fixtureRoot, "host/source"), { recursive: true });
      fs.copyFileSync(
        path.join(PACKAGE_ROOT, "host/source/config-adapter.cts"),
        path.join(fixtureRoot, "host/source/config-adapter.cts"),
      );
      fs.mkdirSync(path.join(fixtureRoot, "node_modules"));
      fs.symlinkSync(
        path.join(PACKAGE_ROOT, "node_modules", "typescript"),
        path.join(fixtureRoot, "node_modules", "typescript"),
        "dir",
      );
      fs.mkdirSync(path.join(fixtureRoot, "node_modules", "@nvidia"));
      fs.symlinkSync(
        path.join(PACKAGE_ROOT, "node_modules", "@nvidia", "nemoclaw-harness-contract"),
        path.join(fixtureRoot, "node_modules", "@nvidia", "nemoclaw-harness-contract"),
        "dir",
      );
      fs.writeFileSync(path.join(fixtureRoot, "host/config-adapter.cts"), "stale\n");

      expect(() => buildHarnessAdapterArtifacts(fixtureRoot, true)).toThrow(
        "host/config-adapter.cts is stale",
      );
    } finally {
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });
});
