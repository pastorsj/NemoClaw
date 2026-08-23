// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { realpathSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPackageFixture } from "./helpers/package-fixture";

const HARNESSES = [
  {
    id: "hermes",
    runtimeFile: "hermes-wrapper.py",
  },
  {
    id: "langchain-deepagents-code",
    runtimeFile: "dcode-wrapper.sh",
  },
  {
    id: "openclaw",
    runtimeFile: "openclaw-runtime/package-lock.json",
  },
] as const;

type HarnessPackage = {
  readonly id: string;
  readonly rootDir: string;
  readonly manifestPath: string;
  readonly source: "bundled" | "installed";
};

type HarnessRegistry = {
  readonly listHarnessPackages: (env: NodeJS.ProcessEnv) => HarnessPackage[];
  readonly resolveHarnessPackage: (id: string, env: NodeJS.ProcessEnv) => HarnessPackage | null;
};

describe("published harness packages", () => {
  let fixtureRoot: string;
  let packagedRoot: string;
  let packedPaths: ReadonlySet<string>;
  let openClawPackedPaths: ReadonlySet<string>;
  let registry: HarnessRegistry;
  let environment: NodeJS.ProcessEnv;

  beforeAll(() => {
    fixtureRoot = createPackageFixture({
      prefix: "nemoclaw-harness-packages-",
      entries: [
        "agents",
        "dist/lib/adapters/fs/regular-file.js",
        "dist/lib/agent/manifest-readers.js",
        "dist/lib/agent/state-file-restore-reader.js",
        "dist/lib/core/json-types.js",
        "dist/lib/harness",
        "dist/lib/onboard/custom-build-context.js",
        "dist/lib/validation.js",
        "node_modules/argparse",
        "node_modules/js-yaml",
        "packages",
      ],
    });

    packagedRoot = realpathSync(fixtureRoot);
    const report = JSON.parse(
      execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
        cwd: fixtureRoot,
        encoding: "utf8",
      }),
    ) as Array<{ files?: Array<{ path?: string }> }>;
    packedPaths = new Set(
      (report[0]?.files ?? [])
        .map((entry) => entry.path)
        .filter((entry): entry is string => typeof entry === "string"),
    );
    const openClawReport = JSON.parse(
      execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
        cwd: path.join(fixtureRoot, "packages", "nemoclaw-openclaw"),
        encoding: "utf8",
      }),
    ) as Array<{ files?: Array<{ path?: string }> }>;
    openClawPackedPaths = new Set(
      (openClawReport[0]?.files ?? [])
        .map((entry) => entry.path)
        .filter((entry): entry is string => typeof entry === "string"),
    );

    const fixtureRequire = createRequire(path.join(fixtureRoot, "package.json"));
    registry = fixtureRequire(
      path.join(fixtureRoot, "dist/lib/harness/package-registry.js"),
    ) as HarnessRegistry;
    environment = { HOME: path.join(fixtureRoot, "home") };
  }, 120_000);

  afterAll(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  it.each(HARNESSES)("ships the $id harness package metadata and runtime", (harness) => {
    const packageRoot = `packages/nemoclaw-${harness.id}`;

    expect(packedPaths).toContain(`${packageRoot}/package.json`);
    expect(packedPaths).toContain(`${packageRoot}/manifest.yaml`);
    expect(packedPaths).toContain(`${packageRoot}/${harness.runtimeFile}`);
  });

  it.each([
    "Dockerfile",
    "Dockerfile.base",
    "start.sh",
    "policy-additions.yaml",
    "policy-permissive.yaml",
    "policy-permissive-default.yaml",
  ])("ships OpenClaw package artifact %s", (artifact) => {
    expect(packedPaths).toContain(`packages/nemoclaw-openclaw/${artifact}`);
  });

  it.each(["scripts/backup-workspace.sh", "scripts/lib/openclaw-npm-remediation.mts"])(
    "ships executable OpenClaw package helper %s",
    (artifact) => {
      expect(packedPaths).toContain(`packages/nemoclaw-openclaw/${artifact}`);
      expect(openClawPackedPaths).toContain(artifact);
      expect(
        statSync(path.join(packagedRoot, "packages", "nemoclaw-openclaw", artifact)).mode & 0o111,
      ).not.toBe(0);
    },
  );

  it.each([
    "Dockerfile",
    "Dockerfile.base",
    "scripts/nemoclaw-start.sh",
    "nemoclaw-blueprint/policies/openclaw-sandbox.yaml",
    "nemoclaw-blueprint/policies/openclaw-sandbox-permissive.yaml",
  ])("omits former OpenClaw path %s", (legacyPath) => {
    expect(packedPaths).not.toContain(legacyPath);
  });

  it.each(HARNESSES)("omits the legacy agents/$id package tree", ({ id }) => {
    expect([...packedPaths].some((packedPath) => packedPath.startsWith(`agents/${id}/`))).toBe(
      false,
    );
  });

  it("omits generated Python caches", () => {
    expect(
      [...packedPaths].filter((packedPath) =>
        /(?:^|\/)__pycache__(?:\/|$)|\.pyc$/u.test(packedPath),
      ),
    ).toEqual([]);
  });

  it("omits OpenClaw plugin dependencies from both published packages", () => {
    expect(
      [...packedPaths].filter((packedPath) =>
        packedPath.startsWith("packages/nemoclaw-openclaw/plugin/node_modules/"),
      ),
    ).toEqual([]);
    expect(
      [...openClawPackedPaths].filter((packedPath) =>
        packedPath.startsWith("plugin/node_modules/"),
      ),
    ).toEqual([]);
  });

  it("lists the three harnesses through the compiled registry", () => {
    expect(registry.listHarnessPackages(environment).map((entry) => entry.id)).toEqual(
      HARNESSES.map((harness) => harness.id),
    );
  });

  it.each(HARNESSES)("resolves the $id harness through the compiled registry", (harness) => {
    expect(registry.resolveHarnessPackage(harness.id, environment)).toEqual(
      expect.objectContaining({
        id: harness.id,
        manifestPath: path.join(
          packagedRoot,
          "packages",
          `nemoclaw-${harness.id}`,
          "manifest.yaml",
        ),
        rootDir: path.join(packagedRoot, "packages", `nemoclaw-${harness.id}`),
        source: "bundled",
      }),
    );
  });
});
