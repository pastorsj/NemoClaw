// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { HarnessPackageIdentity } from "../fixtures/harness-package.ts";
import {
  deriveHarnessLifecycleVersion,
  prepareHarnessPackageUpgrade,
  requireHarnessPackageActivation,
  requireHarnessPackageDeactivation,
  requireHarnessPackageUpgrade,
} from "../fixtures/harness-lifecycle.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";

const temporaryDirectories: string[] = [];
const INITIAL_IDENTITY: HarnessPackageIdentity = Object.freeze({
  kind: "agent-runtime",
  id: "future-harness",
  packageVersion: "1.2.3",
  contentDigest: "a".repeat(64),
});
const UPGRADE_IDENTITY: HarnessPackageIdentity = Object.freeze({
  ...INITIAL_IDENTITY,
  packageVersion: "1.2.4-e2e.lifecycle",
  contentDigest: "b".repeat(64),
});

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

function createPackageArtifact(packageVersion = "1.2.3"): string {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-harness-lifecycle-"));
  temporaryDirectories.push(parent);
  const packageRoot = path.join(parent, "source");
  fs.mkdirSync(path.join(packageRoot, "runtime"), { recursive: true });
  fs.writeFileSync(
    path.join(packageRoot, "nemoclaw-package.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      kind: "agent-runtime",
      id: "future-harness",
      displayName: "Future Harness",
      packageVersion,
      manifest: "manifest.yaml",
    })}\n`,
  );
  fs.writeFileSync(path.join(packageRoot, "runtime", "payload.txt"), "original bytes\n");
  fs.writeFileSync(path.join(packageRoot, "start.sh"), "#!/usr/bin/env bash\nexit 0\n", {
    mode: 0o755,
  });
  return packageRoot;
}

function shellResult(value: unknown, overrides: Partial<ShellProbeResult> = {}): ShellProbeResult {
  return {
    command: [],
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: JSON.stringify(value),
    stderr: "",
    artifacts: { stdout: "stdout", stderr: "stderr", result: "result" },
    ...overrides,
  };
}

describe("harness package lifecycle E2E support", () => {
  it.each([
    ["1.2.3", "1.2.4-e2e.lifecycle"],
    ["1.2.3-rc.1", "1.2.4-e2e.lifecycle"],
    ["1.2.3+build.9", "1.2.4-e2e.lifecycle"],
  ])("derives the test-only upgrade version %s as %s", (source, expected) => {
    expect(deriveHarnessLifecycleVersion(source)).toBe(expected);
  });

  it("copies a built artifact while preserving source bytes and file modes", () => {
    const sourceRoot = createPackageArtifact();
    const destinationRoot = path.join(path.dirname(sourceRoot), "upgrade");
    const sourceMetadataPath = path.join(sourceRoot, "nemoclaw-package.json");
    fs.chmodSync(sourceMetadataPath, 0o444);
    const sourceMetadata = fs.readFileSync(sourceMetadataPath);
    const sourceMetadataMode = fs.statSync(sourceMetadataPath).mode & 0o777;
    const sourceStartMode = fs.statSync(path.join(sourceRoot, "start.sh")).mode & 0o777;

    const prepared = prepareHarnessPackageUpgrade(sourceRoot, destinationRoot, "future-harness");

    expect(prepared).toEqual({
      packageRoot: destinationRoot,
      packageVersion: "1.2.4-e2e.lifecycle",
      sourcePackageVersion: "1.2.3",
    });
    expect(fs.readFileSync(sourceMetadataPath)).toEqual(sourceMetadata);
    expect(fs.statSync(sourceMetadataPath).mode & 0o777).toBe(sourceMetadataMode);
    expect(
      JSON.parse(fs.readFileSync(path.join(destinationRoot, "nemoclaw-package.json"), "utf8")),
    ).toMatchObject({ id: "future-harness", packageVersion: "1.2.4-e2e.lifecycle" });
    expect(fs.readFileSync(path.join(destinationRoot, "runtime", "payload.txt"), "utf8")).toBe(
      "original bytes\n",
    );
    expect(fs.statSync(path.join(destinationRoot, "start.sh")).mode & 0o777).toBe(sourceStartMode);
    expect(fs.statSync(path.join(destinationRoot, "nemoclaw-package.json")).mode & 0o777).toBe(
      sourceMetadataMode,
    );
  });

  it.skipIf(process.platform === "win32")(
    "preserves an artifact symlink for the public package validator to reject",
    () => {
      const sourceRoot = createPackageArtifact();
      const destinationRoot = path.join(path.dirname(sourceRoot), "upgrade");
      fs.symlinkSync("payload.txt", path.join(sourceRoot, "runtime", "linked.txt"));

      prepareHarnessPackageUpgrade(sourceRoot, destinationRoot, "future-harness");

      expect(
        fs.lstatSync(path.join(destinationRoot, "runtime", "linked.txt")).isSymbolicLink(),
      ).toBe(true);
    },
  );

  it("rejects an identity mismatch before it creates the destination", () => {
    const sourceRoot = createPackageArtifact();
    const destinationRoot = path.join(path.dirname(sourceRoot), "upgrade");

    expect(() =>
      prepareHarnessPackageUpgrade(sourceRoot, destinationRoot, "different-harness"),
    ).toThrow(/metadata identity/u);
    expect(fs.existsSync(destinationRoot)).toBe(false);
  });

  it("accepts distinct same-package install, activation, and deactivation receipts", () => {
    expect(requireHarnessPackageUpgrade(INITIAL_IDENTITY, UPGRADE_IDENTITY)).toEqual(
      UPGRADE_IDENTITY,
    );
    expect(
      requireHarnessPackageActivation(
        shellResult({ schemaVersion: 1, state: "active", identity: INITIAL_IDENTITY }),
        INITIAL_IDENTITY,
      ),
    ).toEqual(INITIAL_IDENTITY);
    expect(
      requireHarnessPackageDeactivation(
        shellResult({ schemaVersion: 1, state: "deactivated", identity: INITIAL_IDENTITY }),
        INITIAL_IDENTITY,
      ),
    ).toEqual(INITIAL_IDENTITY);
  });

  it.each([
    shellResult({ schemaVersion: 1, state: "active", identity: UPGRADE_IDENTITY }),
    shellResult({ schemaVersion: 1, state: "deactivated", identity: UPGRADE_IDENTITY }),
    shellResult({ schemaVersion: 1, state: "active", identity: INITIAL_IDENTITY }, { exitCode: 1 }),
  ])("rejects a lifecycle result that does not match the expected receipt", (result) => {
    expect(() => requireHarnessPackageActivation(result, INITIAL_IDENTITY)).toThrow();
  });
});
