// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { materializeHarnessPackageArtifact } from "@nvidia/nemoclaw-harness-contract/build-package";

import { makeAgent } from "../../../test/helpers/base-image-test-harness";
import { removeFixtureDirectories } from "../../../test/helpers/fixture-permissions";
import { testTimeout } from "../../../test/helpers/timeouts";
import { installHarnessPackage } from "../agent-runtime/package/install";
import { stageAgentComposedBuildContext } from "./base-image";

const PI_PACKAGE_ROOT = path.resolve(import.meta.dirname, "../../../packages/nemoclaw-pi");

describe("receipt-backed image staging", { timeout: testTimeout(60_000) }, () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.runIf(process.platform !== "win32")(
    "keeps receipt verification private when the system temp parent has a sticky bit",
    () => {
      const root = fs.mkdtempSync(path.join(process.cwd(), ".nemoclaw-receipt-staging-test-"));
      fs.chmodSync(root, 0o700);
      const artifactRoot = path.join(root, "artifact");
      const storeRoot = path.join(root, "store");
      const stickyTempRoot = path.join(root, "sticky-temp");
      fs.mkdirSync(stickyTempRoot, { mode: 0o1777 });
      fs.chmodSync(stickyTempRoot, 0o1777);
      let buildContext: string | null = null;
      try {
        materializeHarnessPackageArtifact(PI_PACKAGE_ROOT, artifactRoot);
        const installed = installHarnessPackage(
          {
            packageRoot: artifactRoot,
            sourceIdentity: {
              kind: "bundled",
              nemoclawBuildIdentity: {
                nemoclawVersion: "0.0.113",
                sourceRevision: "e".repeat(40),
              },
            },
          },
          { storeRoot },
        );
        const packageDirectory = path.dirname(installed.packageManifest.manifestPath);
        vi.stubEnv("TMPDIR", stickyTempRoot);
        expect(fs.statSync(os.tmpdir()).mode & 0o7777).toBe(0o1777);

        const staged = stageAgentComposedBuildContext(
          makeAgent({
            name: "pi",
            displayName: "Pi",
            packageRoot: installed.packageRoot,
            agentDir: packageDirectory,
            manifestPath: installed.packageManifest.manifestPath,
            dockerfilePath: path.join(packageDirectory, "Dockerfile"),
            dockerfileBasePath: null,
          }),
          path.join(packageDirectory, "Dockerfile"),
          "Dockerfile",
          { harnessPackage: installed.identity, harnessPackageStoreRoot: storeRoot },
        );
        buildContext = staged.buildCtx;

        expect(path.dirname(staged.buildCtx)).toBe(fs.realpathSync(stickyTempRoot));
        expect(staged.verifyBuildCtx()).toBe(true);
        expect(fs.readdirSync(path.join(storeRoot, "staging"))).toEqual([]);
      } finally {
        removeFixtureDirectories([buildContext, root]);
      }
    },
    testTimeout(60_000),
  );
});
