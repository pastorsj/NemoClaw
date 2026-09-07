// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { installHarnessPackage as installHarnessPackageIntoStore } from "../../../src/lib/agent-runtime/package/install.ts";
import {
  TEST_CONFIG_ADAPTER_SOURCE,
  TEST_MESSAGING_ADAPTER_SOURCE,
  TEST_STARTUP_ADAPTER_SOURCE,
} from "../../helpers/adapter-fixtures.ts";
import type { HarnessPackageIdentity } from "../fixtures/harness-package.ts";
import {
  deriveHarnessLifecycleVersion,
  HARNESS_LIFECYCLE_REVISION_MARKER_PATH,
  prepareHarnessPackageLifecycle,
  prepareHarnessPackageUpgrade,
  requireHarnessPackageActivation,
  requireHarnessPackageDeactivation,
  requireHarnessPackageUpgrade,
} from "../fixtures/harness-lifecycle.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";

const temporaryDirectories: string[] = [];
const PACKAGE_STORE_TEST_ROOT = path.join(
  process.cwd(),
  "node_modules/.cache/nemoclaw-harness-lifecycle-tests",
);
fs.mkdirSync(PACKAGE_STORE_TEST_ROOT, { recursive: true, mode: 0o700 });
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

function createPackageArtifact(packageVersion = "1.2.3", temporaryRoot = os.tmpdir()): string {
  const parent = fs.mkdtempSync(path.join(temporaryRoot, "nemoclaw-harness-lifecycle-"));
  temporaryDirectories.push(parent);
  const packageRoot = path.join(parent, "source");
  fs.mkdirSync(path.join(packageRoot, "host"), { recursive: true });
  fs.mkdirSync(path.join(packageRoot, "runtime"), { recursive: true });
  fs.writeFileSync(
    path.join(packageRoot, "host", "config-adapter.cts"),
    TEST_CONFIG_ADAPTER_SOURCE,
  );
  fs.writeFileSync(
    path.join(packageRoot, "host", "messaging-adapter.cts"),
    TEST_MESSAGING_ADAPTER_SOURCE,
  );
  fs.writeFileSync(
    path.join(packageRoot, "host", "startup-adapter.cts"),
    TEST_STARTUP_ADAPTER_SOURCE,
  );
  fs.writeFileSync(
    path.join(packageRoot, "nemoclaw-package.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      kind: "agent-runtime",
      id: "future-harness",
      displayName: "Future Harness",
      packageVersion,
      minimumNemoClawVersion: "0.0.113",
      maximumNemoClawVersionExclusive: "0.0.121",
      manifest: "manifest.yaml",
    })}\n`,
  );
  fs.writeFileSync(
    path.join(packageRoot, "manifest.yaml"),
    [
      "name: future-harness",
      "display_name: Future Harness",
      "description: Generic lifecycle fixture",
      "runtime:",
      "  kind: terminal",
      "  interactive_command: sh",
      "config:",
      "  dir: /sandbox/.future-harness",
      "  config_file: config.json",
      "  format: json",
      "inference:",
      "  config_update:",
      "    support: unsupported",
      "    reason: This synthetic package has fixed inference configuration.",
      "messaging:",
      "  support: disabled",
      "policy:",
      "  owned_presets: []",
      "  automatic_presets: []",
      "  baseline_exclusion_impacts: {}",
      "state_lifecycle:",
      "  backup_quiescence:",
      "    kind: not-required",
      "  snapshot_restore: []",
      "  rebuild:",
      "    managed_extensions:",
      "      support: disabled",
      "      reason: Test package has no managed extensions.",
      "    scheduled_work:",
      "      support: disabled",
      "      reason: This synthetic package does not run scheduled work.",
      "    post_restore:",
      "      kind: not-required",
      "",
    ].join("\n"),
  );
  fs.writeFileSync(path.join(packageRoot, "runtime", "payload.txt"), "original bytes\n");
  fs.writeFileSync(
    path.join(packageRoot, "Dockerfile"),
    "FROM scratch\nCOPY packages/nemoclaw-future-harness/start.sh /usr/local/bin/start\n",
  );
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
      revisionMarker: "upgrade:1.2.4-e2e.lifecycle",
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
    expect(fs.readFileSync(path.join(destinationRoot, "e2e-lifecycle-revision.txt"), "utf8")).toBe(
      "upgrade:1.2.4-e2e.lifecycle\n",
    );
    expect(fs.readFileSync(path.join(destinationRoot, "Dockerfile"), "utf8")).toContain(
      `COPY packages/nemoclaw-future-harness/e2e-lifecycle-revision.txt ${HARNESS_LIFECYCLE_REVISION_MARKER_PATH}`,
    );
    expect(fs.statSync(path.join(destinationRoot, "start.sh")).mode & 0o777).toBe(sourceStartMode);
    expect(fs.statSync(path.join(destinationRoot, "nemoclaw-package.json")).mode & 0o777).toBe(
      sourceMetadataMode,
    );
  });

  it("prepares explicit package-visible markers for both pinned lifecycle revisions", () => {
    const sourceRoot = createPackageArtifact();
    const destinationRoot = path.join(path.dirname(sourceRoot), "lifecycle");

    const prepared = prepareHarnessPackageLifecycle(sourceRoot, destinationRoot, "future-harness");

    expect(prepared.source).toMatchObject({
      packageVersion: "1.2.3",
      revisionMarker: "source:1.2.3",
      sourcePackageVersion: "1.2.3",
    });
    expect(prepared.upgrade).toMatchObject({
      packageVersion: "1.2.4-e2e.lifecycle",
      revisionMarker: "upgrade:1.2.4-e2e.lifecycle",
      sourcePackageVersion: "1.2.3",
    });
    expect(
      fs.readFileSync(path.join(prepared.source.packageRoot, "e2e-lifecycle-revision.txt"), "utf8"),
    ).toBe("source:1.2.3\n");
    expect(
      fs.readFileSync(
        path.join(prepared.upgrade.packageRoot, "e2e-lifecycle-revision.txt"),
        "utf8",
      ),
    ).toBe("upgrade:1.2.4-e2e.lifecycle\n");
  });

  it("installs the marked source and upgrade sequentially into one immutable store", () => {
    const sourceRoot = createPackageArtifact("1.2.3", PACKAGE_STORE_TEST_ROOT);
    const parent = path.dirname(sourceRoot);
    const storeRoot = path.join(parent, "store");
    fs.mkdirSync(storeRoot, { mode: 0o700 });
    const prepared = prepareHarnessPackageLifecycle(
      sourceRoot,
      path.join(parent, "lifecycle"),
      "future-harness",
    );
    const options = {
      storeRoot,
      getBuildIdentity: () => ({
        nemoclawVersion: "0.0.113",
        sourceRevision: "a".repeat(40),
      }),
    } as const;

    const source = installHarnessPackageIntoStore(
      {
        packageRoot: prepared.source.packageRoot,
        expectedId: "future-harness",
        sourceIdentity: { kind: "local" },
      },
      options,
    );
    const upgrade = installHarnessPackageIntoStore(
      {
        packageRoot: prepared.upgrade.packageRoot,
        expectedId: "future-harness",
        sourceIdentity: { kind: "local" },
      },
      options,
    );

    expect(source.identity).toMatchObject({
      id: "future-harness",
      packageVersion: "1.2.3",
    });
    expect(upgrade.identity).toMatchObject({
      id: "future-harness",
      packageVersion: "1.2.4-e2e.lifecycle",
    });
    expect(upgrade.identity.contentDigest).not.toBe(source.identity.contentDigest);
    expect(
      fs.readFileSync(path.join(source.packageRoot, "e2e-lifecycle-revision.txt"), "utf8"),
    ).toBe("source:1.2.3\n");
    expect(
      fs.readFileSync(path.join(upgrade.packageRoot, "e2e-lifecycle-revision.txt"), "utf8"),
    ).toBe("upgrade:1.2.4-e2e.lifecycle\n");
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
