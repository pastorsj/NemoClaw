// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { materializeHarnessRuntime } from "./materialize-runtime.mts";

function withPackageRoot(run: (packageRoot: string) => void): void {
  const packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-runtime-materialize-"));
  try {
    run(packageRoot);
  } finally {
    fs.rmSync(packageRoot, { force: true, recursive: true });
  }
}

test("materializes and verifies each reviewed shared runtime with its declared mode", () => {
  withPackageRoot((packageRoot) => {
    for (const [artifact, destination, expectedMode] of [
      ["managed-gateway", "runtime/managed-gateway-control.py", 0o755],
      ["messaging-build", "messaging/messaging-build.mts", 0o644],
    ] as const) {
      materializeHarnessRuntime({ artifact, destination, workingDirectory: packageRoot });
      materializeHarnessRuntime({
        artifact,
        destination,
        workingDirectory: packageRoot,
        check: true,
      });
      const outputPath = path.join(packageRoot, destination);
      assert.equal(fs.statSync(outputPath).mode & 0o777, expectedMode);
      fs.chmodSync(outputPath, expectedMode === 0o755 ? 0o644 : 0o755);
      assert.throws(
        () =>
          materializeHarnessRuntime({
            artifact,
            destination,
            workingDirectory: packageRoot,
            check: true,
          }),
        /has a stale mode/u,
      );
    }
  });
});

test("materialized messaging runtime is package-profile driven and contains no stock dispatch", () => {
  withPackageRoot((packageRoot) => {
    const destination = "messaging/messaging-build.mts";
    materializeHarnessRuntime({
      artifact: "messaging-build",
      destination,
      workingDirectory: packageRoot,
    });
    const runtime = fs.readFileSync(path.join(packageRoot, destination), "utf8");
    assert.doesNotMatch(runtime, /BUILT_IN_CHANNEL_MANIFESTS/u);
    assert.doesNotMatch(runtime, /\b(?:openclaw|hermes)\b/iu);

    const messagingRoot = path.join(packageRoot, "messaging");
    fs.writeFileSync(
      path.join(messagingRoot, "profile.json"),
      `${JSON.stringify([
        {
          channelId: "future-channel",
          config: { renders: [], visibility: [] },
          policy: [],
          lifecycle: { hookIds: [], packageInstalls: [] },
        },
      ])}\n`,
    );
    const profilePath = path.join(messagingRoot, "runtime-profile.json");
    fs.writeFileSync(
      profilePath,
      `${JSON.stringify({
        packageId: "future-harness",
        channelsPath: "profile.json",
        build: { configRoot: "~/.future-harness", packageManagers: [] },
      })}\n`,
    );
    const result = spawnSync(
      process.execPath,
      [
        "--experimental-strip-types",
        path.join(packageRoot, destination),
        "--agent",
        "future-harness",
        "--profile",
        profilePath,
        "--phase",
        "managed-image-capability-union",
        "--dry-run",
      ],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      agent: "future-harness",
      phase: "managed-image-capability-union",
      channels: [],
      runtimePlanPath: "",
      doctorEnv: {},
      installSpecs: [],
      pythonPackages: [],
      packageVersion: "",
    });
    const missingProfile = spawnSync(
      process.execPath,
      [
        "--experimental-strip-types",
        path.join(packageRoot, destination),
        "--agent",
        "future-harness",
        "--dry-run",
      ],
      { encoding: "utf8" },
    );
    assert.equal(missingProfile.status, 1);
    assert.match(missingProfile.stderr, /requires --profile/u);
  });
});

test("rejects stale output and destinations outside the package root", () => {
  withPackageRoot((packageRoot) => {
    const destination = "runtime/managed-gateway-control.py";
    materializeHarnessRuntime({
      artifact: "managed-gateway",
      destination,
      workingDirectory: packageRoot,
    });
    fs.appendFileSync(path.join(packageRoot, destination), "# stale\n");
    assert.throws(
      () =>
        materializeHarnessRuntime({
          artifact: "managed-gateway",
          destination,
          workingDirectory: packageRoot,
          check: true,
        }),
      /is stale/u,
    );
    assert.throws(
      () =>
        materializeHarnessRuntime({
          artifact: "managed-gateway",
          destination: "../escape.py",
          workingDirectory: packageRoot,
        }),
      /escapes the package root/u,
    );
  });
});
