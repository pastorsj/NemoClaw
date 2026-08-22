// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect, it, vi } from "vitest";

import { makeAgent } from "../../../test/helpers/base-image-test-harness";
import { testTimeoutOptions } from "../../../test/helpers/timeouts";
import { harnessPackageContentDigest } from "../harness/package-registry";
import { withAgentBasePackageBuildContext } from "./base-image";

const BUNDLED_OPENCLAW_PACKAGE = path.resolve(
  import.meta.dirname,
  "../../../packages/nemoclaw-openclaw",
);
const PACKAGE_FIXTURE_COPY_OPTIONS = {
  recursive: true,
  filter: (sourcePath: string) =>
    ![".DS_Store", ".git", "__pycache__", "node_modules"].includes(path.basename(sourcePath)),
} as const;

function bypassRepositoryBuildContextCopy() {
  const originalCpSync = fs.cpSync;
  return vi
    .spyOn(fs, "cpSync")
    .mockImplementationOnce((_source, destination) => {
      fs.mkdirSync(destination.toString(), { recursive: true });
    })
    .mockImplementation(originalCpSync);
}

it(
  "uses changed installed OpenClaw package bytes for the default base build context",
  testTimeoutOptions(30_000),
  () => {
    const temporaryRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "nemoclaw-openclaw-base-package-context-"),
    );
    const installedPackage = path.join(temporaryRoot, "nemoclaw-openclaw");
    fs.cpSync(BUNDLED_OPENCLAW_PACKAGE, installedPackage, PACKAGE_FIXTURE_COPY_OPTIONS);
    fs.appendFileSync(
      path.join(installedPackage, "Dockerfile.base"),
      "\n# installed package base\n",
    );
    const agent = makeAgent({
      name: "openclaw",
      displayName: "OpenClaw",
      agentDir: installedPackage,
      manifestPath: path.join(installedPackage, "manifest.yaml"),
      dockerfilePath: path.join(installedPackage, "Dockerfile"),
      dockerfileBasePath: path.join(installedPackage, "Dockerfile.base"),
      packageContentDigest: harnessPackageContentDigest(installedPackage),
    });
    let stagedContext = "";
    const copySpy = bypassRepositoryBuildContextCopy();

    try {
      withAgentBasePackageBuildContext(agent, (context) => {
        stagedContext = context.buildContextDir ?? "";
        expect(context).toEqual(
          expect.objectContaining({
            additionalInputFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/u),
            buildContextDir: expect.any(String),
            requireLocalBuild: true,
          }),
        );
        expect(fs.readFileSync(context.dockerfilePath, "utf8")).toContain(
          "# installed package base",
        );
        expect(context.additionalInputFingerprint).toBe(
          harnessPackageContentDigest(path.dirname(context.dockerfilePath)),
        );
      });
      expect(fs.existsSync(stagedContext)).toBe(false);
    } finally {
      copySpy.mockRestore();
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  },
);

it(
  "rejects an installed package that changes while its base context is staged",
  testTimeoutOptions(30_000),
  () => {
    const temporaryRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "nemoclaw-openclaw-base-package-swap-"),
    );
    const installedPackage = path.join(temporaryRoot, "nemoclaw-openclaw");
    fs.cpSync(BUNDLED_OPENCLAW_PACKAGE, installedPackage, PACKAGE_FIXTURE_COPY_OPTIONS);
    const selectedBaseDockerfile = path.join(installedPackage, "Dockerfile.base");
    fs.appendFileSync(selectedBaseDockerfile, "\n# installed package base\n");
    const agent = makeAgent({
      name: "openclaw",
      displayName: "OpenClaw",
      agentDir: installedPackage,
      manifestPath: path.join(installedPackage, "manifest.yaml"),
      dockerfilePath: path.join(installedPackage, "Dockerfile"),
      dockerfileBasePath: selectedBaseDockerfile,
      packageContentDigest: harnessPackageContentDigest(installedPackage),
    });
    const originalCpSync = fs.cpSync;
    const copySpy = vi
      .spyOn(fs, "cpSync")
      .mockImplementationOnce((_source, destination) => {
        fs.mkdirSync(destination.toString(), { recursive: true });
      })
      .mockImplementationOnce(((source, destination, options) => {
        expect(path.resolve(String(source))).toBe(installedPackage);
        fs.appendFileSync(selectedBaseDockerfile, "\n# changed during staging\n");
        return originalCpSync(source, destination, options);
      }) as typeof fs.cpSync)
      .mockImplementation(originalCpSync);

    try {
      expect(() => withAgentBasePackageBuildContext(agent, () => undefined)).toThrow(
        "Selected harness package changed while it was being staged",
      );
      expect(copySpy).toHaveBeenCalledTimes(2);
    } finally {
      copySpy.mockRestore();
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  },
);

it(
  "uses an already staged package snapshot after the installed source changes",
  testTimeoutOptions(30_000),
  () => {
    const temporaryRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "nemoclaw-openclaw-base-package-snapshot-"),
    );
    const installedPackage = path.join(temporaryRoot, "installed", "nemoclaw-openclaw");
    const packageSnapshot = path.join(temporaryRoot, "snapshot", "nemoclaw-openclaw");
    fs.mkdirSync(path.dirname(installedPackage), { recursive: true });
    fs.mkdirSync(path.dirname(packageSnapshot), { recursive: true });
    fs.cpSync(BUNDLED_OPENCLAW_PACKAGE, installedPackage, PACKAGE_FIXTURE_COPY_OPTIONS);
    fs.appendFileSync(path.join(installedPackage, "Dockerfile.base"), "\n# selected v1\n");
    fs.cpSync(installedPackage, packageSnapshot, PACKAGE_FIXTURE_COPY_OPTIONS);
    const agent = makeAgent({
      name: "openclaw",
      displayName: "OpenClaw",
      agentDir: installedPackage,
      manifestPath: path.join(installedPackage, "manifest.yaml"),
      dockerfilePath: path.join(installedPackage, "Dockerfile"),
      dockerfileBasePath: path.join(installedPackage, "Dockerfile.base"),
      packageContentDigest: harnessPackageContentDigest(packageSnapshot),
    });
    fs.appendFileSync(path.join(installedPackage, "Dockerfile.base"), "\n# selected v2\n");
    const copySpy = bypassRepositoryBuildContextCopy();

    try {
      expect(() => withAgentBasePackageBuildContext(agent, () => undefined)).toThrow(
        "no longer matches its manifest",
      );
      withAgentBasePackageBuildContext(
        agent,
        (context) => {
          const stagedBase = fs.readFileSync(context.dockerfilePath, "utf8");
          expect(stagedBase).toContain("# selected v1");
          expect(stagedBase).not.toContain("# selected v2");
          expect(context.requireLocalBuild).toBe(true);
          expect(context.additionalInputFingerprint).toBe(
            harnessPackageContentDigest(packageSnapshot),
          );
        },
        { packageSnapshotDir: packageSnapshot },
      );
    } finally {
      copySpy.mockRestore();
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  },
);
