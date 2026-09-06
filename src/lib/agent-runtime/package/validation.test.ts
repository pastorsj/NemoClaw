// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { validateHarnessPackage } from "./validation";

const TEST_PARENT = path.join(
  process.cwd(),
  "node_modules/.cache/nemoclaw-package-validation-tests",
);
fs.mkdirSync(TEST_PARENT, { recursive: true, mode: 0o700 });
fs.chmodSync(TEST_PARENT, 0o700);

let fixtureRoot = path.join(TEST_PARENT, "unused");
let artifactDirectory = path.join(fixtureRoot, "artifact");

function writeArtifactFile(relativePath: string, contents: string, mode = 0o600): void {
  const target = path.join(artifactDirectory, ...relativePath.split("/"));
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.writeFileSync(target, contents, { mode });
  fs.chmodSync(target, mode);
}

function writeValidArtifact(): void {
  fs.mkdirSync(artifactDirectory, { recursive: true, mode: 0o700 });
  fs.chmodSync(artifactDirectory, 0o700);
  writeArtifactFile(
    "nemoclaw-package.json",
    `${JSON.stringify({
      schemaVersion: 1,
      kind: "agent-runtime",
      id: "example-runtime",
      displayName: "Example Runtime",
      packageVersion: "1.2.3",
      minimumNemoClawVersion: "0.0.113",
      maximumNemoClawVersionExclusive: "0.0.121",
      manifest: "agents/example-runtime/manifest.yaml",
    })}\n`,
  );
  writeArtifactFile(
    "agents/example-runtime/manifest.yaml",
    [
      "name: example-runtime",
      "display_name: Example Runtime",
      "description: Synthetic terminal runtime",
      "runtime:",
      "  kind: terminal",
      "  interactive_command: example-runtime",
      "config:",
      "  dir: /sandbox/.example-runtime",
      "  config_file: config.json",
      "  format: json",
      "inference:",
      "  config_update:",
      "    support: unsupported",
      "    reason: This synthetic package has fixed inference configuration.",
      "messaging:",
      "  support: disabled",
      "state_lifecycle:",
      "  backup_quiescence:",
      "    kind: not-required",
      "  snapshot_restore: []",
      "  rebuild:",
      "    image_plugin_provenance: not-required",
      "    scheduled_work:",
      "      support: disabled",
      "      reason: This package does not run scheduled work.",
      "    post_restore:",
      "      kind: not-required",
      "",
    ].join("\n"),
  );
  writeArtifactFile("runtime/payload.txt", "first payload\n");
}

function snapshotArtifact(directory: string): unknown[] {
  const entries: unknown[] = [];
  const visit = (current: string, relativeDirectory: string): void => {
    for (const name of fs.readdirSync(current).sort()) {
      const absolutePath = path.join(current, name);
      const relativePath = relativeDirectory ? `${relativeDirectory}/${name}` : name;
      const stats = fs.lstatSync(absolutePath);
      entries.push(
        stats.isDirectory()
          ? { relativePath, type: "directory", mode: stats.mode & 0o777 }
          : {
              relativePath,
              type: "file",
              mode: stats.mode & 0o777,
              contents: fs.readFileSync(absolutePath).toString("base64"),
            },
      );
      stats.isDirectory() ? visit(absolutePath, relativePath) : undefined;
    }
  };
  visit(directory, "");
  return entries;
}

beforeEach(() => {
  fixtureRoot = fs.mkdtempSync(path.join(TEST_PARENT, "fixture-"));
  fs.chmodSync(fixtureRoot, 0o700);
  artifactDirectory = path.join(fixtureRoot, "artifact");
  writeValidArtifact();
});

afterEach(() => {
  fs.rmSync(fixtureRoot, { force: true, recursive: true });
});

describe("validateHarnessPackage", () => {
  it("returns a path-free report without changing the artifact or running its code", () => {
    const executionMarker = path.join(fixtureRoot, "package-code-ran");
    writeArtifactFile(
      "package.json",
      `${JSON.stringify({ scripts: { install: `touch ${executionMarker}` } })}\n`,
    );
    writeArtifactFile(
      "runtime/entry.mjs",
      `throw new Error(${JSON.stringify(executionMarker)});\n`,
    );
    writeArtifactFile("runtime/install.sh", `#!/bin/sh\ntouch ${executionMarker}\n`, 0o700);
    const before = snapshotArtifact(artifactDirectory);

    const report = validateHarnessPackage(artifactDirectory);

    expect(report).toEqual({
      schemaVersion: 1,
      valid: true,
      identity: {
        kind: "agent-runtime",
        id: "example-runtime",
        packageVersion: "1.2.3",
        contentDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
      },
      displayName: "Example Runtime",
      manifest: "agents/example-runtime/manifest.yaml",
      runtimeKind: "terminal",
      entryCount: 9,
      totalBytes: expect.any(Number),
    });
    expect(Object.isFrozen(report)).toBe(true);
    expect(JSON.stringify(report)).not.toContain(fixtureRoot);
    expect(snapshotArtifact(artifactDirectory)).toEqual(before);
    expect(fs.existsSync(executionMarker)).toBe(false);
  });

  it("changes the content identity when artifact bytes change", () => {
    const first = validateHarnessPackage(artifactDirectory);
    writeArtifactFile("runtime/payload.txt", "second payload\n");

    const second = validateHarnessPackage(artifactDirectory);

    expect(second.identity.packageVersion).toBe(first.identity.packageVersion);
    expect(second.identity.contentDigest).not.toBe(first.identity.contentDigest);
    expect(second.entryCount).toBe(first.entryCount);
  });

  it("rejects a manifest that cannot build a data-only agent definition", () => {
    writeArtifactFile(
      "agents/example-runtime/manifest.yaml",
      [
        "name: example-runtime",
        "runtime:",
        "  kind: terminal",
        "config:",
        "  dir: /sandbox/.example-runtime",
        "  config_file: config.json",
        "  format: json",
        "inference:",
        "  config_update:",
        "    support: unsupported",
        "    reason: This synthetic package has fixed inference configuration.",
        "messaging:",
        "  support: disabled",
        "state_lifecycle:",
        "  backup_quiescence:",
        "    kind: not-required",
        "  snapshot_restore: []",
        "  rebuild:",
        "    image_plugin_provenance: not-required",
        "    scheduled_work:",
        "      support: disabled",
        "      reason: This package does not run scheduled work.",
        "    post_restore:",
        "      kind: not-required",
        "",
      ].join("\n"),
    );

    expect(() => validateHarnessPackage(artifactDirectory)).toThrow(
      "must define interactive_command or headless_command",
    );
  });

  it("rejects source-only authoring content from a built artifact", () => {
    writeArtifactFile("tests/runtime.test.ts", "throw new Error('must not run');\n");

    expect(() => validateHarnessPackage(artifactDirectory)).toThrow("contains authoring content");
  });
});
