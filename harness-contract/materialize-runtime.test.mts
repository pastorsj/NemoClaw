// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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

test("materializes and verifies each reviewed shared runtime", () => {
  withPackageRoot((packageRoot) => {
    for (const [artifact, destination] of [
      ["managed-gateway", "runtime/managed-gateway-control.py"],
      ["messaging-build", "messaging/messaging-build.mts"],
    ] as const) {
      materializeHarnessRuntime({ artifact, destination, workingDirectory: packageRoot });
      materializeHarnessRuntime({
        artifact,
        destination,
        workingDirectory: packageRoot,
        check: true,
      });
      assert.ok((fs.statSync(path.join(packageRoot, destination)).mode & 0o111) !== 0);
    }
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
