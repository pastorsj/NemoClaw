// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { assertHarnessAdapterArtifactsCurrent } from "@nvidia/nemoclaw-harness-contract/build-adapters";

const PACKAGE_ROOT = path.resolve(import.meta.dirname, "../..");

function packedPaths(): string[] {
  const report = JSON.parse(
    execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
      cwd: PACKAGE_ROOT,
      encoding: "utf8",
    }),
  ) as Array<{ files?: Array<{ path?: string }> }>;
  return (report[0]?.files ?? []).flatMap((entry) =>
    typeof entry.path === "string" ? [entry.path] : [],
  );
}

describe("Hermes host adapter build", () => {
  it("keeps the checked-in runtime artifact synchronized with typed source", () => {
    expect(() => assertHarnessAdapterArtifactsCurrent(PACKAGE_ROOT)).not.toThrow();

    const artifact = fs.readFileSync(path.join(PACKAGE_ROOT, "host/config-adapter.cts"), "utf8");
    expect(artifact.startsWith("// SPDX-FileCopyrightText:")).toBe(true);
    expect(artifact).toContain("module.exports = configAdapter;");
    expect(artifact).not.toMatch(/\brequire\s*\(/u);
  });

  it("publishes the runtime artifact without its authoring source", () => {
    const paths = packedPaths();
    expect(paths).toContain("host/config-adapter.cts");
    expect(paths.some((candidate) => candidate.startsWith("host/source/"))).toBe(false);
  });
});
